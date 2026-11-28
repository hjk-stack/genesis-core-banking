import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {cryptoLedgerAccount} from '../src/crypto/rolling-ledger.mjs';
import {createBankServer} from '../server.mjs';
import {exampleForm,finTerminalOwner} from '../test/helpers/fin-example.mjs';

// Requested by the bank owner with the FinTerminal ISO 20022 specification, screen 1 "FIN - ISO 20022 Composer", in the
// dark blue and orange they approved; checked on a phone (also in the two-thirds window the Payments switch opens there),
// an iPad and a computer against the real bank server.
const admin={id:'fin-composer-browser',username:'fin-composer-browser',admin:true};
let db,server,browser,base,common,nostro,wallet;
before(async()=>{
 db=new PGlite();let connections=Promise.resolve();
 const pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 // Step 3's accounts: a Common account and a NOSTRO account in euros, and "+" wallets of a holder (with AG, never offered).
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 common=(await bank.openAccount(admin,{accountType:'COMMON',fullName:'Example Common',currencies:['EUR']},randomUUID())).managedAccounts[0];
 nostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:'EXMPCHZZXXX',accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 const holder=(await bank.openCustomer(admin,{fullName:'Example Holder',accountType:'PERSONAL',currencies:['EUR']},randomUUID())).userId;
 wallet=await cryptoLedgerAccount(pool,{userId:holder,currency:'USDC',network:'ETHEREUM'});await cryptoLedgerAccount(pool,{userId:holder,currency:'AG',network:'ETHEREUM'});
 server=createBankServer({pool,authenticate:async()=>admin,finTerminalAccess:async()=>finTerminalOwner,secureCookies:false});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve));await db?.close();});

const SELECTS=new Set(['messageType','priority','chargeBearer','settlement','regulatoryCountry','regulatoryCode']);
for(const width of [260,390,820,1440])test('the composer on '+(width<500?'a phone':width<1000?'an iPad':'a computer')+' ('+width+'px): form and XML in step, accounts chosen, checked, saved, opened again, a used UETR refused',async()=>{
 const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  assert.equal((await context.request.post(base+'/api/login',{headers:{origin:base},data:{username:admin.username,password:'fixture'}})).status(),200);
  await page.goto(base+'/fin-terminal');
  const field=name=>page.locator('[data-fin-field="'+name+'"]'),xml=page.locator('[data-fin-xml]'),verdict=page.locator('[data-fin-xsd]'),state=page.locator('[data-fin-draft-state]');
  await page.locator('[data-fin-composer]').waitFor();await page.waitForFunction(()=>document.querySelector('[data-fin-xml]').value.includes('<UETR>'));
  // The form writes the XML.
  for(const [name,value] of Object.entries(exampleForm()))if(!['uetr','businessMessageId','createdAt','settlementAccount'].includes(name))await (SELECTS.has(name)?field(name).selectOption(value):field(name).fill(value));
  assert.match(await xml.inputValue(),/<Nm>Example Creditor SARL<\/Nm>/);assert.match(await xml.inputValue(),/<IntrBkSttlmAmt Ccy="EUR">1250000\.00<\/IntrBkSttlmAmt>/);
  // The accounts: the Common account is the debtor's, the NOSTRO account settles the transfer, the "+" wallet is kept.
  const choice=name=>page.locator('[data-fin-choice="'+name+'"]');
  await page.waitForFunction(()=>document.querySelector('[data-fin-choice="tokenWalletId"]').options.length>1);
  assert.deepEqual(await choice('tokenWalletId').locator('option').allTextContents(),['—','Example Holder · USDC · ETHEREUM']);
  await choice('bookingAccountId').selectOption(common.id);await choice('nostroAccountId').selectOption(nostro.id);await choice('tokenWalletId').selectOption(wallet);
  assert.deepEqual([await field('debtorIban').inputValue(),await field('receiverBic').inputValue(),await field('settlement').inputValue(),await field('settlementAccount').inputValue()],
   [common.abiqIban,'EXMPCHZZXXX','INDA','NOSTRO-EXAMPLE-1']);
  // The XML writes the form.
  await xml.fill((await xml.inputValue()).replace('>1250000.00<','>990.50<'));
  await page.waitForFunction(()=>document.querySelector('[data-fin-field="amount"]').value==='990.50');
  await page.getByRole('button',{name:'Validate XML'}).click();await page.waitForFunction(()=>document.querySelector('[data-fin-xsd]').textContent==='XSD: PASSED');
  const look=await page.evaluate(()=>{
   const css=element=>getComputedStyle(document.querySelector(element));
   const box=element=>document.querySelector(element).getBoundingClientRect().toJSON();
   return {ground:css('body').backgroundColor,primary:css('.fin-primary').backgroundColor,passed:css('[data-fin-xsd]').color,
    sideways:document.documentElement.scrollWidth>innerWidth,form:box('[data-fin-form]'),xml:box('.fin-xml'),actions:box('.fin-actions')};
  });
  assert.deepEqual({ground:look.ground,primary:look.primary,passed:look.passed,sideways:look.sideways},{ground:'rgb(10, 18, 32)',primary:'rgb(245, 159, 11)',passed:'rgb(52, 211, 153)',sideways:false});
  // A computer shows the XML beside the form, as in the specification; a phone and an iPad one under the other.
  if(width>=1000)assert.ok(look.xml.left>=look.form.right-1,'XML beside the form');else assert.ok(look.xml.top>=look.form.bottom-1,'XML under the form');
  assert.ok(look.actions.right<=width+1&&look.actions.left>=0,'actions inside the window');
  await page.screenshot({path:'test-results/fin-composer-'+width+'.png'});
  // Saved, and opened again after the window was reloaded.
  await page.getByRole('button',{name:'Save Draft'}).click();await page.waitForFunction(()=>document.querySelector('[data-fin-draft-state]').textContent==='Draft saved · revision 1');
  const uetr=await field('uetr').inputValue(),draftId=await page.locator('[data-fin-drafts]').inputValue();
  await page.reload();await page.locator('[data-fin-composer]').waitFor();await page.waitForFunction(id=>[...document.querySelector('[data-fin-drafts]').options].some(option=>option.value===id),draftId);
  assert.notEqual(await field('uetr').inputValue(),uetr);
  await page.locator('[data-fin-drafts]').selectOption(draftId);
  await page.waitForFunction(()=>document.querySelector('[data-fin-xsd]').textContent==='XSD: PASSED');
  assert.equal(await field('uetr').inputValue(),uetr);assert.equal(await field('amount').inputValue(),'990.50');assert.equal(await state.textContent(),'Draft saved · revision 1');
  assert.deepEqual([await choice('bookingAccountId').inputValue(),await choice('nostroAccountId').inputValue(),await choice('tokenWalletId').inputValue()],[common.id,nostro.id,wallet]);
  // A new message given the saved message's UETR is refused, the UETR marked.
  await page.getByRole('button',{name:'New',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-fin-draft-state]').textContent==='New message');
  await field('debtorName').fill('Example Debtor GmbH');
  await xml.fill((await xml.inputValue()).replace(/<UETR>[^<]+<\/UETR>/,'<UETR>'+uetr+'</UETR>'));await page.waitForFunction(id=>document.querySelector('[data-fin-field="uetr"]').value===id,uetr);
  await page.getByRole('button',{name:'Save Draft'}).click();
  await page.waitForFunction(()=>document.querySelector('[data-fin-xsd]').textContent.startsWith('This UETR is already used'));
  assert.equal(await field('uetr').getAttribute('aria-invalid'),'true');assert.equal(await verdict.getAttribute('data-state'),'error');
  await page.screenshot({path:'test-results/fin-composer-refused-'+width+'.png'});
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
