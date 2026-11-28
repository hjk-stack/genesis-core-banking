import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {cryptoLedgerAccount} from '../src/crypto/rolling-ledger.mjs';
import {FinTerminal} from '../src/fin-terminal.mjs';
import {createBankServer} from '../server.mjs';
import {finTerminalOwner} from './helpers/fin-example.mjs';
import {startFinTerminal} from '../public/fin-terminal.mjs';
import {buildFinMessage,normalizeForm} from '../public/fin-message.mjs';
import {exampleForm} from './helpers/fin-example.mjs';

// Requested by the bank owner with the FinTerminal ISO 20022 specification, screen 1 "FIN - ISO 20022 Composer": "live two-way
// XML synchronization", XSD validation, the UETR made and a duplicate refused, drafts. The window talks to the real bank server.
const admin={id:'fin-composer-admin',username:'fin-composer',admin:true};
let pool,db,server,base,cookie,commonEur,commonUsd,nostroEur,nostroUsd,walletUsdc;
const sent=[];
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 // Step 3's accounts: Common accounts in euros and dollars, a NOSTRO account in each, and wallets of the wallet scroller.
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 [commonEur,commonUsd]=(await bank.openAccount(admin,{accountType:'COMMON',fullName:'Example Common',currencies:['EUR','USD']},randomUUID())).managedAccounts;
 nostroEur=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:'EXMPCHZZXXX',accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 nostroUsd=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example Dollar NOSTRO',bic:'EXMPUS33XXX',accountNumber:'NOSTRO-EXAMPLE-2',currency:'USD'},randomUUID());
 const holder=(await bank.openCustomer(admin,{fullName:'Example Holder',accountType:'PERSONAL',currencies:['EUR']},randomUUID())).userId;
 walletUsdc=await cryptoLedgerAccount(pool,{userId:holder,currency:'USDC',network:'ETHEREUM'});
 await cryptoLedgerAccount(pool,{userId:holder,currency:'AG',network:'ETHEREUM'});
 server=createBankServer({pool,authenticate:async()=>admin,finTerminalAccess:async()=>finTerminalOwner,secureCookies:false});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
 assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
});
after(async()=>{await new Promise(resolve=>server.close(resolve));if(db)await db.close();else await pool.end();});

const until=async(ready,what='the composer')=>{const end=Date.now()+8000;while(!ready()){if(Date.now()>end)assert.fail('waited for '+what);await new Promise(resolve=>setTimeout(resolve,20));}};
async function composer(){
 const html=await readFile(new URL('../public/fin-terminal.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:base+'/fin-terminal'}),doc=dom.window.document;
 // The window's own requests, as the browser sends them: the bank's sign-in cookie, from its own address.
 let held=null;
 const fetcher=async(path,init={})=>{
  sent.push({path,method:init.method||'GET',headers:init.headers||{}});
  if(held&&path==='/api/fin-terminal/validate')await held;
  return fetch(base+path,{...init,headers:{...init.headers,cookie,origin:base}});
 };
 const terminal=await startFinTerminal({root:doc,fetcher,windowApi:{BroadcastChannel:class{close(){}},addEventListener(){},close(){}}});
 const $=selector=>doc.querySelector(selector),field=name=>$('[data-fin-field="'+name+'"]');
 // No action under way: Transact is not counted, as it waits for a message to transact (paintTransact).
 const idle=()=>![...doc.querySelectorAll('.fin-actions button:not([data-fin-transact])')].some(button=>button.disabled);
 const page={dom,doc,$,field,terminal,xml:$('[data-fin-xml]'),verdict:()=>$('[data-fin-xsd]').textContent,state:()=>$('[data-fin-draft-state]').textContent,
  errors:()=>[...doc.querySelectorAll('[data-fin-errors] li')].map(item=>item.textContent),
  type(name,value){const input=field(name);input.value=value;input.dispatchEvent(new dom.window.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));},
  fill(form){for(const [name,value] of Object.entries(form))if(name!=='uetr'&&field(name).value!==value)page.type(name,value);},
  async writeXml(text){page.xml.value=text;page.xml.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,360));},
  async press(selector){await until(idle);$(selector).click();await new Promise(resolve=>setTimeout(resolve,0));await until(idle,selector);},
  // The schema check waits until released: what happens while a check is under way.
  holdChecks(){let release;held=new Promise(resolve=>{release=resolve});return ()=>{held=null;release();};},
  idle:()=>until(idle),
  pick(name,value){const select=$('[data-fin-choice="'+name+'"]');select.value=value;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));},
  async choose(draftId){await until(idle);const list=$('[data-fin-drafts]');list.value=draftId;list.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,0));await until(idle,'the draft');},
  close(){dom.window.close();}};
 await until(()=>!$('[data-fin-terminal]').hidden&&page.xml.value,'the terminal');
 return page;
}
const uetrOf=xml=>/<UETR>([^<]*)<\/UETR>/.exec(xml)?.[1];

test('a new message: its own UETR and message ID, the spec\'s defaults, and its XML beside it',async()=>{
 const page=await composer();try{
  const uetr=page.field('uetr').value;
  assert.match(uetr,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert.equal(page.field('uetr').readOnly,true);
  assert.equal(uetrOf(page.xml.value),uetr);assert.match(page.field('businessMessageId').value,/^FT\d{14}[A-Z0-9]{4}$/);
  // Its NOSTRO by default (the bank owner: "the nostro is selected by the currency not by the BIC and default we are using
  // Tunisia"): here the only one in euros, the message settled through it.
  await until(()=>page.$('[data-fin-choice="nostroAccountId"]').value===nostroEur.id,'the default NOSTRO');
  assert.deepEqual(['messageType','priority','currency','chargeBearer','settlement','settlementAccount','endToEndId'].map(name=>page.field(name).value),
   ['pacs.008.001.08','HIGH/URGP','EUR','SHAR','INDA','NOSTRO-EXAMPLE-1','NOTPROVIDED']);
  assert.equal(page.verdict(),'XSD: not checked');assert.equal(page.state(),'New message');
  // Every field of the form is written in the XML from the start, the form and the XML the same message.
  assert.equal(page.xml.value,buildFinMessage(Object.fromEntries([...page.doc.querySelectorAll('[data-fin-field]')].map(input=>[input.dataset.finField,input.value]))));
  // One press makes a new UETR, in the form and in the XML.
  page.$('[data-fin-new-uetr]').click();
  assert.notEqual(page.field('uetr').value,uetr);assert.equal(uetrOf(page.xml.value),page.field('uetr').value);
  // Only what is real: with no peer bank registered here, no connection or session is shown (screen A, step 4), and nothing is
  // dispatched - Execute & Dispatch (step 3b, fin-cash-wire.test.mjs) waits for a peer server; the 4-Eyes switch has its own (3a,
  // fin-terminal-access.test.mjs).
  assert.equal(page.$('[data-fin-peer-link]').textContent,'Peer link: NOT CONNECTED');
  assert.doesNotMatch(page.doc.body.textContent,/(?<!NOT )CONNECTED|mTLS|PEER_ACK|UNLOCKED|pacs\.008 SENT|NOSTRO & Core Synced/i);
  const wirePeer=page.$('[data-fin-wire-peer]');await until(()=>wirePeer.querySelectorAll('optgroup').length===3,'the Cash Wire panel');
  assert.equal(page.$('[data-fin-wire-send]').disabled,true);assert.deepEqual([wirePeer.value,wirePeer.selectedOptions[0]?.textContent],['','None registered']);
  assert.deepEqual([...wirePeer.querySelectorAll('optgroup')].map(group=>group.label+': '+group.textContent),['IP-to-IP: None registered','API: None registered','ISO 20022: None registered']);
 }finally{page.close();}
});

test('the form and the XML are kept in step both ways: typed in one, it is in the other',async()=>{
 const page=await composer();try{
  page.fill(exampleForm());
  assert.equal(page.xml.value,buildFinMessage({...exampleForm(),uetr:page.field('uetr').value,businessMessageId:page.field('businessMessageId').value,createdAt:page.field('createdAt').value}));
  assert.equal(page.state(),'New message · not saved');
  // Typed in the XML, a moment later in the form.
  await page.writeXml(page.xml.value.replace('>1250000.00<','>990.50<').replace('<Nm>Example Creditor SARL</Nm>','<Nm>Another Creditor &amp; Co</Nm>'));
  assert.equal(page.field('amount').value,'990.50');assert.equal(page.field('creditorName').value,'Another Creditor & Co');
  // A choice the list does not have is shown as it is in the XML.
  await page.writeXml(page.xml.value.replace('<ChrgBr>SHAR</ChrgBr>','<ChrgBr>OTHR</ChrgBr>'));
  assert.equal(page.field('chargeBearer').value,'OTHR');
  page.type('chargeBearer','DEBT');assert.match(page.xml.value,/<ChrgBr>DEBT<\/ChrgBr>/);assert.equal(page.field('chargeBearer').querySelector('[data-fin-extra]'),null);
  // XML that does not read leaves the form as it is and says why; written right again, it goes on.
  const good=page.xml.value;
  await page.writeXml(good.replace('</Envelope>',''));
  assert.match(page.verdict(),/^XML: /);assert.equal(page.field('amount').value,'990.50');
  await page.writeXml(good.replace('>990.50<','>991.00<'));
  assert.equal(page.verdict(),'XSD: not checked');assert.equal(page.field('amount').value,'991.00');
  // Left, the XML is set out again as the form gives it; written in small letters, the codes are in capitals.
  await page.writeXml(page.xml.value.replace(/<BICFI>EXMPDEFFXXX<\/BICFI>/g,'<BICFI>exmpdeffxxx</BICFI>').replace(/\n\s+/g,''));
  page.xml.dispatchEvent(new page.dom.window.Event('blur'));
  assert.equal(page.xml.value,buildFinMessage(Object.fromEntries([...page.doc.querySelectorAll('[data-fin-field]')].map(input=>[input.dataset.finField,input.value]))));
  assert.match(page.xml.value,/<BICFI>EXMPDEFFXXX<\/BICFI>/);
 }finally{page.close();}
});

test('Validate XML: the official schemas\' findings, and a field\'s own finding at that field',async()=>{
 const page=await composer();try{
  page.fill(exampleForm());
  await page.press('[data-fin-validate]');
  assert.equal(page.verdict(),'XSD: PASSED');assert.deepEqual(page.errors(),[]);assert.equal(page.$('[data-fin-xsd]').dataset.state,'passed');
  page.type('senderBic','BAD');page.type('amount','0.00');const iban=exampleForm().debtorIban;page.type('debtorIban',iban.slice(0,-1)+((Number(iban.at(-1))+1)%10));
  assert.equal(page.verdict(),'XSD: not checked');
  await page.press('[data-fin-validate]');
  assert.equal(page.verdict(),'XSD: FAILED');
  assert.ok(page.errors().includes('Interbank Settlement Amount: The amount is a number above zero with at most five decimals.'),page.errors().join('\n'));
  assert.ok(page.errors().some(error=>/^AppHdr: Element 'BICFI': \[facet 'pattern'\] The value 'BAD'/.test(error)),page.errors().join('\n'));
  // Any account number is taken (the bank owner: "Accept all account numbers"): an IBAN whose check digits do not match is no finding.
  assert.ok(!page.errors().some(error=>/Debtor Account|IBAN/.test(error)),page.errors().join('\n'));
  assert.equal(page.field('amount').getAttribute('aria-invalid'),'true');assert.equal(page.field('debtorIban').hasAttribute('aria-invalid'),false);
  // Only part of a message - the transfer without its header - is no message (reported directly: "XSD: PASSED" for a part).
  page.type('senderBic','EXMPDEFFXXX');page.type('debtorIban',iban);page.type('amount',exampleForm().amount);const whole=page.xml.value;
  await page.writeXml(whole.slice(whole.indexOf('<Document'),whole.indexOf('</Document>')+'</Document>'.length));
  await page.press('[data-fin-validate]');
  assert.equal(page.verdict(),'XSD: FAILED');
  assert.deepEqual(page.errors(),["XML: Element 'Document': Not the message's envelope. Expected is ( Envelope ), with the AppHdr and the Document inside."]);
  // Every change asks the window's own requests to carry the bank's CSRF token.
  assert.ok(sent.filter(request=>request.method==='POST').every(request=>request.headers['x-csrf-token']));
 }finally{page.close();}
});

// The bank owner's amendments: "Remove LEI register ... instead must be address", "Authority Country both fields must be selectors",
// "Reporting codes are a selector", "Accept all account numbers".
test('addresses instead of LEIs, any account number, and the Authority Country\'s two selectors: every country and the 26 reporting codes',async()=>{
 const page=await composer();try{
  const label=name=>page.field(name).closest('label').querySelector('span').textContent;
  assert.deepEqual(['debtorIban','creditorIban','intermediaryAddress','ultimateDebtorAddress','ultimateCreditorAddress'].map(label),
   ['Debtor Account','Creditor Account','Intermediary Agent Address','Ultimate Debtor Address','Ultimate Creditor Address']);
  assert.equal(page.doc.querySelector('[data-fin-field$="Lei"]'),null);
  const country=page.field('regulatoryCountry'),code=page.field('regulatoryCode');
  assert.deepEqual([country.tagName,code.tagName,country.options.length,code.options.length],['SELECT','SELECT',251,27]);
  assert.deepEqual([...code.options].slice(0,3).map(option=>option.textContent),['—','SALA · Salary Payment','PENS · Pension Payment']);
  assert.equal(code.options[26].textContent,'OTHR · Other');
  assert.deepEqual(['CH','TN','XK'].map(value=>[...country.options].find(option=>option.value===value).textContent),['CH · Switzerland','TN · Tunisia','XK · Kosovo']);
  page.fill({...exampleForm(),regulatoryCountry:'CH',regulatoryCode:'TREA',creditorIban:'0012-345678-90'});
  const flat=page.xml.value.replace(/\n\s*/g,'');
  assert.ok(flat.includes('<Authrty><Ctry>CH</Ctry></Authrty><Dtls><Cd>TREA</Cd>'),flat);
  assert.ok(flat.includes('<CdtrAcct><Id><Othr><Id>0012-345678-90</Id></Othr></Id></CdtrAcct>'),flat);
  assert.ok(flat.includes('<UltmtDbtr><Nm>Example Holding AG</Nm><PstlAdr><AdrLine>Examplestrasse 2, 8000 Example Town, Switzerland</AdrLine></PstlAdr></UltmtDbtr>'),flat);
  await page.press('[data-fin-validate]');assert.equal(page.verdict(),'XSD: PASSED',page.errors().join('\n'));
  // A code the XML holds that the list does not offer is shown as it is.
  await page.writeXml(page.xml.value.replace('<Cd>TREA</Cd>','<Cd>INF</Cd>'));
  assert.deepEqual([code.value,code.selectedOptions[0].textContent],['INF','INF']);
 }finally{page.close();}
});

test('the settlement account is the chosen NOSTRO\'s only: read-only, written by the NOSTRO account chosen and gone with it; the Receiver BIC is never the NOSTRO\'s',async()=>{
 // The bank owner: "Nostro accounts are registered and must select via the listed NOSTROS and no need any further check", and "the
 // nostro is selected by the currency not by the BIC".
 const page=await composer();try{
  const nostro=page.$('[data-fin-choice="nostroAccountId"]'),values=()=>['receiverBic','settlement','settlementAccount'].map(name=>page.field(name).value);
  await until(()=>nostro.value===nostroEur.id,'the default NOSTRO');
  assert.equal(page.field('settlementAccount').readOnly,true);assert.deepEqual(values(),['','INDA','NOSTRO-EXAMPLE-1']);
  // Another settlement method written lets the NOSTRO go with its account; chosen again, it writes them, the Receiver BIC as written.
  page.fill(exampleForm());assert.deepEqual([nostro.value,...values()],['','SMPLFRPPXXX','CLRG/TGT','']);
  page.pick('nostroAccountId',nostroEur.id);
  assert.deepEqual(values(),['SMPLFRPPXXX','INDA','NOSTRO-EXAMPLE-1']);
  page.pick('nostroAccountId','');
  assert.deepEqual(values(),['SMPLFRPPXXX','INDA','']);assert.doesNotMatch(page.xml.value,/NOSTRO-EXAMPLE-1|<SttlmAcct>/);
  assert.equal(page.state(),'New message · not saved');
  // Written in the XML instead, another settlement account lets the NOSTRO go and goes with it (review finding).
  page.pick('nostroAccountId',nostroEur.id);
  await page.writeXml(page.xml.value.replace('<Id>NOSTRO-EXAMPLE-1</Id>','<Id>NOSTRO-OTHER-9</Id>'));
  assert.deepEqual([nostro.value,page.field('settlementAccount').value],['','']);assert.doesNotMatch(page.xml.value,/NOSTRO-OTHER-9|<SttlmAcct>/);
  // Written without any NOSTRO chosen, it does not stay either.
  await page.writeXml(page.xml.value.replace('<SttlmMtd>INDA</SttlmMtd>','<SttlmMtd>INDA</SttlmMtd><SttlmAcct><Id><Othr><Id>NOSTRO-OTHER-9</Id></Othr></Id></SttlmAcct>'));
  assert.equal(page.field('settlementAccount').value,'');assert.doesNotMatch(page.xml.value,/NOSTRO-OTHER-9/);
 }finally{page.close();}
});

test('a check that answers after the message was changed is not shown as this message\'s (review finding)',async()=>{
 const page=await composer();try{
  page.fill(exampleForm());
  const release=page.holdChecks();
  page.$('[data-fin-validate]').click();await new Promise(resolve=>setTimeout(resolve,50));
  // Written while the check is under way: the message shown is no longer the one checked.
  page.type('amount','2.00');assert.equal(page.verdict(),'XSD: not checked');
  release();await page.idle();
  assert.equal(page.verdict(),'XSD: not checked');assert.equal(page.$('[data-fin-xsd]').dataset.state,'unchecked');
  await page.press('[data-fin-validate]');assert.equal(page.verdict(),'XSD: PASSED');
 }finally{page.close();}
});

test('drafts: saved, saved again with its revision, listed, opened again - and a message is kept before another replaces it',async()=>{
 const page=await composer();try{
  page.fill(exampleForm());
  await page.press('[data-fin-save]');
  assert.equal(page.state(),'Draft saved · revision 1');assert.equal(page.verdict(),'XSD: PASSED');
  const list=page.$('[data-fin-drafts]'),draftId=list.value,uetr=page.field('uetr').value;
  assert.match(draftId,/^[0-9a-f-]{36}$/);assert.match(list.selectedOptions[0].textContent,/^XSD ✓ · 1250000\.00 EUR · Example Creditor SARL · .+$/);
  page.type('amount','2000.00');assert.equal(page.state(),'Draft · changes not saved');
  await page.press('[data-fin-save]');assert.equal(page.state(),'Draft saved · revision 2');
  await page.press('[data-fin-new]');
  assert.equal(page.state(),'New message');assert.equal(list.value,'');assert.equal(page.field('amount').value,'');assert.notEqual(page.field('uetr').value,uetr);
  // Written and not saved: choosing the draft keeps this message as a draft of its own first.
  page.fill({...exampleForm(),creditorName:'Second Creditor'});
  await page.choose(draftId);
  assert.equal(page.state(),'Draft saved · revision 2');assert.equal(page.field('uetr').value,uetr);assert.equal(page.field('amount').value,'2000.00');
  assert.equal(page.verdict(),'XSD: PASSED');
  const rows=(await pool.query('SELECT form FROM avis_core_v2.fin_terminal_drafts ORDER BY created_at')).rows.map(row=>row.form.creditorName);
  assert.deepEqual(rows.slice(-2),['Example Creditor SARL','Second Creditor']);
  assert.equal(list.options.length,3);
 }finally{page.close();}
});

test('a UETR another payment or draft already has is refused with its reason at its field; a new UETR saves',async()=>{
 const page=await composer();try{
  page.fill(exampleForm());await page.press('[data-fin-save]');
  const taken=page.field('uetr').value,draftId=page.$('[data-fin-drafts]').value;
  await page.press('[data-fin-new]');page.fill(exampleForm());
  // The UETR written in the XML is the form's UETR.
  await page.writeXml(page.xml.value.replace(/<UETR>[^<]+<\/UETR>/,'<UETR>'+taken+'</UETR>'));
  assert.equal(page.field('uetr').value,taken);
  await page.press('[data-fin-save]');
  assert.equal(page.verdict(),'This UETR is already used by another payment or draft. Make a new UETR.');
  assert.equal(page.field('uetr').getAttribute('aria-invalid'),'true');assert.equal(page.state(),'New message · not saved');
  // A message that cannot be kept is not replaced by another; asked for that other once more, it is.
  await page.choose(draftId);
  assert.equal(page.state(),'New message · not saved');assert.equal(page.field('uetr').value,taken);assert.match(page.verdict(),/already used/);
  await page.choose(draftId);
  assert.equal(page.state(),'Draft saved · revision 1');assert.equal(page.$('[data-fin-drafts]').value,draftId);assert.equal(page.field('uetr').getAttribute('aria-invalid'),null);
  // Made new with one press, the UETR saves.
  await page.press('[data-fin-new]');page.fill(exampleForm());
  await page.writeXml(page.xml.value.replace(/<UETR>[^<]+<\/UETR>/,'<UETR>'+taken+'</UETR>'));
  page.$('[data-fin-new-uetr]').click();assert.notEqual(page.field('uetr').value,taken);assert.equal(uetrOf(page.xml.value),page.field('uetr').value);
  await page.press('[data-fin-save]');assert.equal(page.state(),'Draft saved · revision 1');assert.equal(page.verdict(),'XSD: PASSED');
  assert.notEqual(page.$('[data-fin-drafts]').value,draftId);
 }finally{page.close();}
});

test('Accounts: a Common or Suspense account and a NOSTRO account write the message\'s fields, the "+" wallet is kept, all three with the draft',async()=>{
 const page=await composer();try{
  const select=name=>page.$('[data-fin-choice="'+name+'"]'),texts=name=>[...select(name).options].map(item=>item.textContent);
  const chosen=()=>['bookingAccountId','nostroAccountId','tokenWalletId'].map(name=>select(name).value);
  await until(()=>select('bookingAccountId').options.length>1,'the accounts');
  // In euros: the euro accounts; every "+" wallet but AG and AGi.
  assert.deepEqual(texts('bookingAccountId'),['—','Example Common · '+commonEur.abiqIban+' · EUR']);
  assert.deepEqual(texts('nostroAccountId'),['—','Example NOSTRO · NOSTRO-EXAMPLE-1 · EUR']);
  assert.deepEqual(texts('tokenWalletId'),['—','Example Holder · USDC · ETHEREUM']);
  page.fill(exampleForm());
  page.pick('bookingAccountId',commonEur.id);
  const account=(await new FinTerminal(pool).accounts(admin)).bookingAccounts.find(item=>item.accountId===commonEur.id);
  assert.deepEqual(['debtorName','debtorIban','debtorAgentBic'].map(name=>page.field(name).value),[account.institution,account.iban,account.bic]);
  assert.ok(page.xml.value.includes('<IBAN>'+account.iban+'</IBAN>'));
  page.pick('nostroAccountId',nostroEur.id);
  assert.deepEqual(['receiverBic','settlement','settlementAccount'].map(name=>page.field(name).value),['SMPLFRPPXXX','INDA','NOSTRO-EXAMPLE-1']);
  assert.ok(page.xml.value.replace(/\n\s*/g,'').includes('<SttlmInf><SttlmMtd>INDA</SttlmMtd><SttlmAcct><Id><Othr><Id>NOSTRO-EXAMPLE-1</Id></Othr></Id></SttlmAcct></SttlmInf>'));
  page.pick('tokenWalletId',walletUsdc);
  assert.equal(page.state(),'New message · not saved');
  await page.press('[data-fin-save]');assert.equal(page.state(),'Draft saved · revision 1');assert.equal(page.verdict(),'XSD: PASSED');
  const draftId=page.$('[data-fin-drafts]').value;
  // A new message has the NOSTRO by default only; nothing is written in it, so the draft opened next replaces it as it is.
  await page.press('[data-fin-new]');assert.deepEqual([...chosen(),page.state()],['',nostroEur.id,'','New message']);
  await page.choose(draftId);assert.deepEqual(chosen(),[commonEur.id,nostroEur.id,walletUsdc]);
  // A field that names a chosen account, written otherwise, lets that account go; the others stay (review finding).
  page.type('debtorAgentBic','EXMPDEFFXXX');assert.deepEqual(chosen(),['',nostroEur.id,walletUsdc]);
  await page.writeXml(page.xml.value.replace('<Id>NOSTRO-EXAMPLE-1</Id>','<Id>NOSTRO-OTHER-9</Id>'));assert.deepEqual(chosen(),['','',walletUsdc]);
  page.pick('bookingAccountId',commonEur.id);page.pick('nostroAccountId',nostroEur.id);assert.deepEqual(chosen(),[commonEur.id,nostroEur.id,walletUsdc]);
  // Another currency: the accounts chosen in euros are let go with the fields they wrote, the dollar ones are offered and the
  // dollar NOSTRO chosen by default; the wallet stays (review finding).
  page.type('currency','USD');
  assert.deepEqual(chosen(),['',nostroUsd.id,walletUsdc]);
  assert.deepEqual(['debtorName','debtorIban','debtorAgentBic','receiverBic','settlementAccount','settlement'].map(name=>page.field(name).value),['','','','SMPLFRPPXXX','NOSTRO-EXAMPLE-2','INDA']);
  assert.doesNotMatch(page.xml.value,/NOSTRO-EXAMPLE-1|EXMPCHZZXXX/);
  assert.deepEqual(texts('bookingAccountId'),['—','Example Common · '+commonUsd.abiqIban+' · USD']);
  assert.deepEqual(texts('nostroAccountId'),['—','Example Dollar NOSTRO · NOSTRO-EXAMPLE-2 · USD']);
 }finally{page.close();}
});

// The bank owner: "We now register an incoming transfer so AVISPay PLC is the receiver".
test('Incoming: the chosen account is the creditor; the NOSTRO is where the bank books it and writes nothing in the message; registered, the transfer is kept as it is',async()=>{
 const page=await composer();try{
  const select=name=>page.$('[data-fin-choice="'+name+'"]'),turn=page.$('[data-fin-direction]'),register=page.$('[data-fin-register]'),save=page.$('[data-fin-save]');
  const values=names=>names.map(name=>page.field(name).value);
  await until(()=>select('bookingAccountId').options.length>1,'the accounts');
  assert.deepEqual([turn.value,register.hidden],['OUTGOING',true]);
  page.fill(exampleForm());page.pick('bookingAccountId',commonEur.id);page.pick('nostroAccountId',nostroEur.id);
  const account=(await new FinTerminal(pool).accounts(admin)).bookingAccounts.find(item=>item.accountId===commonEur.id);
  // Turned to incoming, the chosen accounts go to the other side; what they wrote as the debtor's is emptied for the sender's own.
  // The NOSTRO stays chosen and lets go of the settlement account it wrote: the sender and its settlement are the sender's.
  turn.value='INCOMING';turn.dispatchEvent(new page.dom.window.Event('change',{bubbles:true}));
  assert.equal(register.hidden,false);
  assert.deepEqual(values(['creditorName','creditorIban','creditorAgentBic','receiverBic']),[account.institution,account.iban,account.bic,account.bic]);
  assert.deepEqual(values(['senderBic','settlement','settlementAccount']),['EXMPDEFFXXX','INDA','']);
  assert.deepEqual(values(['debtorName','debtorIban','debtorAgentBic']),['','','']);
  assert.deepEqual([select('bookingAccountId').value,select('nostroAccountId').value],[commonEur.id,nostroEur.id]);
  page.fill({debtorName:'Example Debtor GmbH',debtorIban:exampleForm().debtorIban,debtorAgentBic:'EXMPDEFFXXX'});
  await page.press('[data-fin-register]');
  assert.deepEqual([page.state(),page.verdict()],['Incoming booked · ACSC','XSD: PASSED']);
  assert.deepEqual([register.hidden,save.hidden,turn.disabled],[true,true,true]);
  const list=page.$('[data-fin-drafts]'),draftId=list.value;
  assert.match(list.selectedOptions[0].textContent,/^XSD ✓ · Incoming booked · 1250000\.00 EUR · Example Debtor GmbH · /);
  // A new message is outgoing again; the registered transfer opens as it was kept.
  await page.press('[data-fin-new]');
  assert.deepEqual([turn.value,turn.disabled,register.hidden,save.hidden],['OUTGOING',false,true,false]);
  await page.choose(draftId);
  assert.deepEqual([turn.value,page.state(),register.hidden,save.hidden],['INCOMING','Incoming booked · ACSC',true,true]);
  assert.deepEqual(values(['creditorIban','senderBic','settlement']),[account.iban,'EXMPDEFFXXX','INDA']);
 }finally{page.close();}
});

test('the bank serves the composer\'s programs from its own address under its own policy',async()=>{
 for(const file of ['fin-composer.mjs','fin-message.mjs']){
  const response=await fetch(base+'/'+file);assert.equal(response.status,200,file);assert.match(response.headers.get('content-type'),/^text\/javascript/);
  assert.match(response.headers.get('content-security-policy'),/script-src 'self'; style-src 'self'/);
  assert.equal(await response.text(),await readFile(new URL('../public/'+file,import.meta.url),'utf8'));
 }
 assert.equal(normalizeForm(exampleForm()).debtorIban,exampleForm().debtorIban);
});

// The bank owner: "the nostro is selected by the currency not by the BIC and default we are using Tunisia".
test('the NOSTRO by default: the currency\'s only one, or of several the one at the Tunisian bank - none of several elsewhere; one let go by hand stays let go',async()=>{
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 const nostro=(institutionName,bic,accountNumber,currency)=>bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName,bic,accountNumber,currency},randomUUID());
 await nostro('Example Pound NOSTRO','EXMPGB2LXXX','NOSTRO-EXAMPLE-GBP-1','GBP');const tunis=await nostro('Example Tunis NOSTRO','EXMPTNTTXXX','NOSTRO-EXAMPLE-GBP-2','GBP');
 await nostro('Example Franc NOSTRO','EXMPCHZZXXX','NOSTRO-EXAMPLE-CHF-1','CHF');await nostro('Example Other Franc NOSTRO','EXMPDEFFXXX','NOSTRO-EXAMPLE-CHF-2','CHF');
 const page=await composer();try{
  const select=page.$('[data-fin-choice="nostroAccountId"]'),values=()=>[select.value,...['receiverBic','settlement','settlementAccount'].map(name=>page.field(name).value)];
  await until(()=>select.value===nostroEur.id,'the default NOSTRO');
  // In pounds, of two the one at the Tunisian bank: the message settled through it, the Receiver BIC as written.
  page.type('receiverBic','SMPLFRPPXXX');page.type('currency','GBP');
  assert.deepEqual(values(),[tunis.id,'SMPLFRPPXXX','INDA','NOSTRO-EXAMPLE-GBP-2']);
  // In Swiss francs, two and none in Tunisia: none is chosen.
  page.type('currency','CHF');assert.deepEqual(values(),['','SMPLFRPPXXX','INDA','']);
  // Back in euros, the one there; let go by hand, it stays let go.
  page.type('currency','EUR');assert.equal(select.value,nostroEur.id);
  page.pick('nostroAccountId','');page.type('amount','10.00');assert.equal(select.value,'');
 }finally{page.close();}
});
