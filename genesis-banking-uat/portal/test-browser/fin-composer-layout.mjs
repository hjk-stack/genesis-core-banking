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
 wallet=await cryptoLedgerAccount(pool,{userId:holder,currency:'EURC',network:'SOLANA'});await cryptoLedgerAccount(pool,{userId:holder,currency:'AG',network:'ETHEREUM'});
 // The FIAT Converter loads a "+" wallet with a receiving address on its chain.
 await pool.query("INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address,is_primary) VALUES($1,'SOLANA','ExampleSolanaBrowserAddress555555555555555',true)",[holder]);
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
  // The form writes the XML. A credit transfer has no mandate: its fields are a Debit's only (test-browser/fin-wire-layout.mjs).
  for(const [name,value] of Object.entries(exampleForm()))if(!['uetr','businessMessageId','createdAt','settlementAccount','mandateId','mandateSignatureDate'].includes(name))await (SELECTS.has(name)?field(name).selectOption(value):field(name).fill(value));
  assert.deepEqual(await page.locator('[data-fin-mandate]').isVisible(),false);
  assert.match(await xml.inputValue(),/<Nm>Example Creditor SARL<\/Nm>/);assert.match(await xml.inputValue(),/<IntrBkSttlmAmt Ccy="EUR">1250000\.00<\/IntrBkSttlmAmt>/);
  // The accounts: the Common account is the debtor's, the NOSTRO account settles the transfer - never writing the Receiver BIC (the
  // bank owner: "the nostro is selected by the currency not by the BIC"). The money leaves: no FIAT Converter, no bank fee.
  const choice=name=>page.locator('[data-fin-choice="'+name+'"]');
  await page.waitForFunction(()=>document.querySelector('[data-fin-choice="tokenWalletId"]').options.length>1);
  assert.deepEqual([await page.locator('[data-fin-converter-row]').isVisible(),await page.locator('[data-fin-fee-row]').isVisible()],[false,false]);
  await choice('bookingAccountId').selectOption(common.id);await choice('nostroAccountId').selectOption(nostro.id);
  assert.deepEqual([await field('debtorIban').inputValue(),await field('receiverBic').inputValue(),await field('settlement').inputValue(),await field('settlementAccount').inputValue()],
   [common.abiqIban,'SMPLFRPPXXX','INDA','NOSTRO-EXAMPLE-1']);
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
  // Each section's header in its own row inside its box, never on its border (the bank owner: "The Headers ... are all half into the
  // background as the headers all are too small in height").
  const headers=await page.locator('.fin-panel:visible').evaluateAll(sets=>sets.map(set=>{const box=set.getBoundingClientRect(),legend=set.querySelector(':scope>legend').getBoundingClientRect(),
   first=[...set.children].find(child=>child.tagName!=='LEGEND').getBoundingClientRect();
   return {name:set.querySelector(':scope>legend').textContent,inside:legend.top>=box.top+1&&legend.left>=box.left&&legend.right<=box.right,above:legend.bottom<=first.top+0.5,height:legend.height};}));
  assert.equal(headers.length,8,'every section of a credit transfer');
  for(const header of headers)assert.deepEqual({inside:header.inside,above:header.above,tall:header.height>=17},{inside:true,above:true,tall:true},header.name+', '+width);
  await page.screenshot({path:'test-results/fin-composer-'+width+'.png'});
  // Saved, and opened again after the window was reloaded.
  await page.getByRole('button',{name:'Save Draft'}).click();await page.waitForFunction(()=>document.querySelector('[data-fin-draft-state]').textContent==='Draft saved · revision 1');
  const uetr=await field('uetr').inputValue(),draftId=await page.locator('[data-fin-drafts]').inputValue();
  await page.reload();await page.locator('[data-fin-composer]').waitFor();await page.waitForFunction(id=>[...document.querySelector('[data-fin-drafts]').options].some(option=>option.value===id),draftId);
  assert.notEqual(await field('uetr').inputValue(),uetr);
  await page.locator('[data-fin-drafts]').selectOption(draftId);
  await page.waitForFunction(()=>document.querySelector('[data-fin-xsd]').textContent==='XSD: PASSED');
  assert.equal(await field('uetr').inputValue(),uetr);assert.equal(await field('amount').inputValue(),'990.50');assert.equal(await state.textContent(),'Draft saved · revision 1');
  assert.deepEqual([await choice('bookingAccountId').inputValue(),await choice('nostroAccountId').inputValue()],[common.id,nostro.id]);
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

// The bank owner: "missing the button with clear statement for "FIAT Converter" activation and then the wallet selector is active",
// "install a second row below the selected accounts the live change rate", and the bank fee for the transfers not converted.
for(const width of [260,390,820,1440])test('the FIAT Converter on '+(width<500?'a phone':width<1000?'an iPad':'a computer')+' ('+width+'px): with the Bank fee off, the "+" wallet and the live rate under the accounts on, inside the window',async()=>{
 const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  assert.equal((await context.request.post(base+'/api/login',{headers:{origin:base},data:{username:admin.username,password:'fixture'}})).status(),200);
  await page.goto(base+'/fin-terminal');await page.locator('[data-fin-composer]').waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-fin-choice="tokenWalletId"]').options.length>1);
  await page.locator('[data-fin-direction]').selectOption('INCOMING');await page.locator('[data-fin-field="amount"]').fill('1000.00');
  const inside=async()=>page.evaluate(()=>{
   const parts=['[data-fin-choice="bookingAccountId"]','[data-fin-convert-switch]','[data-fin-choice="tokenWalletId"]','[data-fin-rate]','[data-fin-fee]'];
   return {sideways:document.documentElement.scrollWidth>innerWidth,parts:parts.flatMap(part=>{const node=document.querySelector(part);if(!node.offsetParent)return [];
    const box=node.getBoundingClientRect();return [{part,top:box.top,bottom:box.bottom,left:box.left,right:box.right,height:box.height}];})};
  });
  // Off: the Bank fee, in the message's currency, under the accounts.
  const fee=page.locator('[data-fin-fee]'),converter=page.locator('[data-fin-convert-switch]');
  await fee.scrollIntoViewIfNeeded();
  assert.deepEqual([await converter.textContent(),await converter.getAttribute('aria-pressed'),await page.locator('[data-fin-fee-currency]').textContent()],['FIAT Converter','false','EUR']);
  let seen=await inside();
  assert.deepEqual(seen.parts.map(part=>part.part),['[data-fin-choice="bookingAccountId"]','[data-fin-convert-switch]','[data-fin-fee]']);
  for(const part of seen.parts)assert.ok(part.left>=0&&part.right<=width+0.5&&part.height>=28,JSON.stringify(part)+' '+width);
  assert.ok(seen.parts[2].top>=seen.parts[0].bottom,'the fee under the accounts, '+width);assert.equal(seen.sideways,false);
  await page.screenshot({path:'test-results/fin-converter-off-'+width+'.png'});
  // On: pressed, the "+" wallet beside it; the live rate in the row under the accounts.
  await converter.click();assert.equal(await converter.getAttribute('aria-pressed'),'true');
  await page.locator('[data-fin-choice="tokenWalletId"]').selectOption(wallet);
  await page.waitForFunction(()=>!document.querySelector('[data-fin-rate]').hidden);
  assert.equal(await page.locator('[data-fin-rate]').textContent(),'1 EUR = 1 EURC · MiCA 1:1 · 1,000.00 EUR → 999.5000 EURC');
  const look=await page.evaluate(()=>({pressed:getComputedStyle(document.querySelector('[data-fin-convert-switch]')).backgroundColor,rate:getComputedStyle(document.querySelector('[data-fin-rate]')).color}));
  assert.deepEqual(look,{pressed:'rgb(245, 159, 11)',rate:'rgb(52, 211, 153)'});
  seen=await inside();
  assert.deepEqual(seen.parts.map(part=>part.part),['[data-fin-choice="bookingAccountId"]','[data-fin-convert-switch]','[data-fin-choice="tokenWalletId"]','[data-fin-rate]']);
  for(const part of seen.parts)assert.ok(part.left>=0&&part.right<=width+0.5,JSON.stringify(part)+' '+width);
  assert.ok(seen.parts[3].top>=Math.max(seen.parts[0].bottom,seen.parts[2].bottom),'the rate under the accounts, '+width);assert.equal(seen.sideways,false);
  await page.locator('[data-fin-rate]').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/fin-converter-on-'+width+'.png'});
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
