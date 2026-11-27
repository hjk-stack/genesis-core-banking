import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {createBankServer} from '../server.mjs';
import {startFinTerminal} from '../public/fin-terminal.mjs';
import {buildFinMessage,normalizeForm} from '../public/fin-message.mjs';
import {exampleForm} from './helpers/fin-example.mjs';

// Requested by the bank owner with the FinTerminal ISO 20022 specification, screen 1 "FIN - ISO 20022 Composer": "live two-way
// XML synchronization", XSD validation, the UETR made and a duplicate refused, drafts. The window talks to the real bank server.
const admin={id:'fin-composer-admin',username:'fin-composer',admin:true};
let pool,db,server,base,cookie;
const sent=[];
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 server=createBankServer({pool,authenticate:async()=>admin,secureCookies:false});
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
 const fetcher=(path,init={})=>{sent.push({path,method:init.method||'GET',headers:init.headers||{}});return fetch(base+path,{...init,headers:{...init.headers,cookie,origin:base}});};
 const terminal=await startFinTerminal({root:doc,fetcher,windowApi:{BroadcastChannel:class{close(){}},addEventListener(){},close(){}}});
 const $=selector=>doc.querySelector(selector),field=name=>$('[data-fin-field="'+name+'"]');
 const idle=()=>![...doc.querySelectorAll('.fin-actions button')].some(button=>button.disabled);
 const page={dom,doc,$,field,terminal,xml:$('[data-fin-xml]'),verdict:()=>$('[data-fin-xsd]').textContent,state:()=>$('[data-fin-draft-state]').textContent,
  errors:()=>[...doc.querySelectorAll('[data-fin-errors] li')].map(item=>item.textContent),
  type(name,value){const input=field(name);input.value=value;input.dispatchEvent(new dom.window.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));},
  fill(form){for(const [name,value] of Object.entries(form))if(name!=='uetr'&&field(name).value!==value)page.type(name,value);},
  async writeXml(text){page.xml.value=text;page.xml.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,360));},
  async press(selector){await until(idle);$(selector).click();await new Promise(resolve=>setTimeout(resolve,0));await until(idle,selector);},
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
  assert.deepEqual(['messageType','priority','currency','chargeBearer','settlement','endToEndId'].map(name=>page.field(name).value),['pacs.008.001.08','HIGH/URGP','EUR','SHAR','CLRG/TGT','NOTPROVIDED']);
  assert.equal(page.verdict(),'XSD: not checked');assert.equal(page.state(),'New message');
  // Every field of the form is written in the XML from the start, the form and the XML the same message.
  assert.equal(page.xml.value,buildFinMessage(Object.fromEntries([...page.doc.querySelectorAll('[data-fin-field]')].map(input=>[input.dataset.finField,input.value]))));
  // One press makes a new UETR, in the form and in the XML.
  page.$('[data-fin-new-uetr]').click();
  assert.notEqual(page.field('uetr').value,uetr);assert.equal(uetrOf(page.xml.value),page.field('uetr').value);
  // Only what is real: no connection, peer or 4-eyes state is shown before their steps.
  assert.doesNotMatch(page.doc.body.textContent,/CONNECTED|mTLS|Peer|ACK|4-Eyes|Dispatch/i);
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
  page.type('senderBic','BAD');const iban=exampleForm().debtorIban;page.type('debtorIban',iban.slice(0,-1)+((Number(iban.at(-1))+1)%10));
  assert.equal(page.verdict(),'XSD: not checked');
  await page.press('[data-fin-validate]');
  assert.equal(page.verdict(),'XSD: FAILED');
  assert.ok(page.errors().includes('Debtor IBAN: The IBAN\'s check digits do not match.'),page.errors().join('\n'));
  assert.ok(page.errors().some(error=>/^AppHdr: Element 'BICFI': \[facet 'pattern'\] The value 'BAD'/.test(error)),page.errors().join('\n'));
  assert.equal(page.field('debtorIban').getAttribute('aria-invalid'),'true');assert.equal(page.field('creditorIban').hasAttribute('aria-invalid'),false);
  // Every change asks the window's own requests to carry the bank's CSRF token.
  assert.ok(sent.filter(request=>request.method==='POST').every(request=>request.headers['x-csrf-token']));
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

test('the bank serves the composer\'s programs from its own address under its own policy',async()=>{
 for(const file of ['fin-composer.mjs','fin-message.mjs']){
  const response=await fetch(base+'/'+file);assert.equal(response.status,200,file);assert.match(response.headers.get('content-type'),/^text\/javascript/);
  assert.match(response.headers.get('content-security-policy'),/script-src 'self'; style-src 'self'/);
  assert.equal(await response.text(),await readFile(new URL('../public/'+file,import.meta.url),'utf8'));
 }
 assert.equal(normalizeForm(exampleForm()).debtorIban,exampleForm().debtorIban);
});
