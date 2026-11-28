import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {SovereignCore} from '../src/core.mjs';
import {FinAccess} from '../src/fin-access.mjs';
import {buildPaymentStatus} from '../src/fin-peer.mjs';
import {ServerDOMParser} from '../src/fin-xml.mjs';
import {connectorCredentials,frame} from '../src/payment-transport.mjs';
import {readFinMessage} from '../public/fin-message.mjs';
import {createBankServer} from '../server.mjs';
import {exampleIban,finTerminalOwner} from '../test/helpers/fin-example.mjs';

// Requested by the bank owner with the FinTerminal specification (v3), Screen B's Cash Wire (NOSTRO) and its "Execute & Dispatch",
// in the dark blue and orange they approved; checked on a phone, an iPad and a computer, the bank sending to a real peer server over
// mutual TLS that answers as a peer's FinTerminal does (pacs.002 ACSC).
const admin={id:'fin-wire-browser',username:'fin-wire-browser',admin:true},BENEFICIARY=exampleIban('FR','00000000000000000000123');
let db,pool,dir,server,peer,browser,base;
before(async()=>{
 db=new PGlite();let connections=Promise.resolve();
 pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 dir=await mkdtemp(join(tmpdir(),'avis-fin-wire-browser-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-addext','extendedKeyUsage=serverAuth,clientAuth','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
 const credentials={key:await readFile(join(dir,'key.pem'),'utf8'),cert:await readFile(join(dir,'cert.pem'),'utf8'),hmacSecret:'isolated-fin-wire-browser-secret-32-bytes'};credentials.ca=credentials.cert;
 const env={AVIS_CONNECTOR_EXAMPLE_PEER:JSON.stringify(credentials)};
 peer=tls.createServer({...credentials,requestCert:true,rejectUnauthorized:true},socket=>{
  let data=Buffer.alloc(0);socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length<2||data.length!==2+data.readUInt16BE())return;
   const {form}=readFinMessage(data.subarray(2).toString(),ServerDOMParser);
   socket.end(frame(buildPaymentStatus({localBic:'SMPLFRPPXXX',peerBic:'EXMPDEFFXXX',businessMessageId:'PEERSTS0001',at:new Date(),original:form.businessMessageId,endToEndId:form.endToEndId,uetr:form.uetr,status:'ACSC'})));});
 });
 await new Promise(resolve=>peer.listen(0,'127.0.0.1',resolve));
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 const opened=(await bank.openAccount(admin,{accountType:'SUSPENSE',fullName:'AVISPay PLC',currencies:['EUR']},randomUUID())).managedAccounts[0];
 const nostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:'SMPLFRPPXXX',accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 const ledger=(await pool.query('SELECT ledger_account_id FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1',[nostro.id])).rows[0].ledger_account_id;
 for(const [profileId,name,protocol] of [['EXAMPLE_TLS_PEER','EXAMPLE-FRANKFURT-GW01','IP_TO_IP'],['EXAMPLE_API_PEER','EXAMPLE-PARIS-API','BANK_API'],['EXAMPLE_ISO_PEER','EXAMPLE-ZURICH-ISO20022','SWIFT_ISO20022']])
  await bank.registerBankConnector(admin,{profileId,name,cashAccountId:nostro.id,protocol,localBic:'EXMPDEFFXXX',peerBic:'SMPLFRPPXXX',
   endpoint:'tls://localhost:'+peer.address().port,credentialReference:'AVIS_CONNECTOR_EXAMPLE_PEER'},randomUUID());
 await new SovereignCore(pool).post(pool,admin,'fin-wire-browser-fixture','FIN_INCOMING_BOOKED','FIXTURE',
  [{accountId:ledger,direction:'DEBIT',amount:'1000000.00'},{accountId:opened.id,direction:'CREDIT',amount:'1000000.00'}]);
 server=createBankServer({pool,authenticate:async()=>admin,finTerminalAccess:async()=>finTerminalOwner,secureCookies:false,
  transferOptions:{transport:{credentials:reference=>connectorCredentials(reference,env)}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve));await new Promise(resolve=>peer?.close(resolve));await db?.close();if(dir)await rm(dir,{recursive:true,force:true});});

for(const width of [260,390,820,1440])test('Screen B\'s Cash Wire on '+(width<500?'a phone':width<1000?'an iPad':'a computer')+' ('+width+'px): every control in the window, Execute & Dispatch, the pacs.008 and pacs.002 under it',async()=>{
 const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  assert.equal((await context.request.post(base+'/api/login',{headers:{origin:base},data:{username:admin.username,password:'fixture'}})).status(),200);
  await page.goto(base+'/fin-terminal');
  await page.getByRole('tab',{name:'2 · Interbank Direct IP-to-IP Composer'}).click();
  const panel=page.locator('[data-fin-wire]'),send=panel.locator('[data-fin-wire-send]');
  await page.waitForFunction(()=>document.querySelectorAll('[data-fin-wire-peer] option').length===3&&!document.querySelector('[data-fin-wire-send]').disabled);
  // The three types, each with its peer server (the bank owner: "Peer service selector is missing IP to IP, API, ISO20022").
  assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('[data-fin-wire-peer] optgroup')].map(group=>[group.label,[...group.children].map(option=>option.textContent)])),
   [['IP-to-IP',['EXAMPLE-FRANKFURT-GW01 · SMPLFRPPXXX · EUR']],['API',['EXAMPLE-PARIS-API · SMPLFRPPXXX · EUR']],['ISO 20022',['EXAMPLE-ZURICH-ISO20022 · SMPLFRPPXXX · EUR']]]);
  await panel.locator('[data-fin-wire-amount]').fill('2500.00');await panel.locator('[data-fin-wire-name]').fill('Example Creditor SARL');
  await panel.locator('[data-fin-wire-iban]').fill(BENEFICIARY);
  await send.click();await panel.locator('[data-fin-wire-stream] li').nth(1).waitFor();
  const lines=await panel.locator('[data-fin-wire-stream] li').allTextContents();
  assert.match(lines[0],/IP pacs\.008 SENT .* 2500\.00 EUR -> FR\S+ · NOSTRO & Core Synced$/);assert.match(lines[1],/PEER pacs\.002 ACSC$/);
  // Every control and the stream inside the window, nothing sideways, the controls a finger can hit.
  const boxes=await page.evaluate(()=>[...document.querySelectorAll('[data-fin-wire] :is(select,input:not([type=password]),button,li)')].map(node=>{const box=node.getBoundingClientRect();
   return {name:node.dataset.finWireSend!==undefined?'send':node.tagName,left:box.left,right:box.right,height:box.height};}));
  for(const box of boxes)assert.ok(box.left>=0&&box.right<=width+0.5,JSON.stringify(box)+' inside '+width);
  assert.ok(boxes.find(box=>box.name==='send').height>=32,'Execute & Dispatch a finger can hit');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways scrolling');
  assert.deepEqual(await page.evaluate(()=>{const button=getComputedStyle(document.querySelector('[data-fin-wire-send]'));return [button.backgroundColor,button.color];}),
   ['rgb(245, 159, 11)','rgb(26, 18, 5)']);
  await page.screenshot({path:'test-results/fin-wire-'+width+'.png',fullPage:true});
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('4-Eyes on: PIN 1 and PIN 2 with their holders, inside the window - one under the other on a phone, side by side on a computer',async()=>{
 const access=new FinAccess(pool),officer={principal:'portal:officer',name:'Example Officer',owner:false,finTerminal:true,administrators:finTerminalOwner.administrators};
 await access.setPin(admin,finTerminalOwner,{slot:1,pin:'135790'});await access.setPin(admin,officer,{slot:2,pin:'246802'});await access.fourEyes(admin,finTerminalOwner,{on:true});
 try{
  for(const width of [390,1440]){
   const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   try{
    assert.equal((await context.request.post(base+'/api/login',{headers:{origin:base},data:{username:admin.username,password:'fixture'}})).status(),200);
    await page.goto(base+'/fin-terminal');await page.getByRole('tab',{name:'2 · Interbank Direct IP-to-IP Composer'}).click();
    const pins=page.locator('[data-fin-wire-pin]');await pins.first().waitFor();
    assert.deepEqual(await pins.evaluateAll(inputs=>inputs.map(input=>input.placeholder)),['PIN 1 · Example Owner','PIN 2 · Example Officer']);
    const boxes=await pins.evaluateAll(inputs=>inputs.map(input=>{const box=input.getBoundingClientRect();return {left:box.left,right:box.right,top:box.top};}));
    for(const box of boxes)assert.ok(box.left>=0&&box.right<=width+0.5,JSON.stringify(box));
    if(width>=800)assert.equal(boxes[0].top,boxes[1].top,'side by side');else assert.ok(boxes[1].top>boxes[0].top,'one under the other');
    await page.screenshot({path:'test-results/fin-wire-pins-'+width+'.png',fullPage:true});
    assert.deepEqual(errors,[]);
   }finally{await context.close();}
  }
 }finally{await access.fourEyes(admin,finTerminalOwner,{on:false});}
});

// One sign-in for the tests below, at every width: the bank answers more than eight sign-ins a minute with 429 (server.mjs).
let signedIn=null;
async function signedContext(viewport){
 if(!signedIn){
  const context=await browser.newContext();
  try{assert.equal((await context.request.post(base+'/api/login',{headers:{origin:base},data:{username:admin.username,password:'fixture'}})).status(),200);signedIn=await context.storageState();}
  finally{await context.close();}
 }
 return browser.newContext({viewport,storageState:signedIn});
}

// The bank owner: "the header referencing PIN make it in a klap menu, with default closed".
test('the PIN menu on a phone, an iPad and a computer: closed when the terminal opens, the PINs folding out under it inside the window',async()=>{
 const context=await signedContext({width:1440,height:900}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  const open=page.locator('[data-fin-pins-open]'),pins=page.locator('[data-fin-pins]');
  for(const width of [260,390,820,1440]){
   await page.setViewportSize({width,height:900});await page.goto(base+'/fin-terminal');
   await page.waitForFunction(()=>document.querySelector('[data-fin-access]')?.hidden===false&&document.querySelectorAll('[data-fin-pins] form[data-fin-pin]').length===2);
   assert.equal(await open.getAttribute('aria-expanded'),'false');assert.equal(await pins.isVisible(),false,'closed when the terminal opens, '+width);
   const place=await page.evaluate(()=>{
    const box=document.querySelector('[data-fin-pins-open]').getBoundingClientRect(),bar=document.querySelector('.fin-terminal-bar').getBoundingClientRect();
    return {left:box.left,right:box.right,top:box.top,under:box.top>=bar.bottom};
   });
   assert.ok(place.left>=0&&place.right<=width+0.5&&place.under,'inside the window, under the bar: never in an upper corner, '+width);
   await open.click();await pins.waitFor({state:'visible'});
   assert.equal(await open.getAttribute('aria-expanded'),'true');
   const boxes=await page.locator('[data-fin-pins] input,[data-fin-pins] button').evaluateAll(nodes=>nodes.map(node=>{const box=node.getBoundingClientRect();return {left:box.left,right:box.right,top:box.top};}));
   assert.ok(boxes.length>=4);
   for(const box of boxes)assert.ok(box.left>=0&&box.right<=width+0.5&&box.top>place.top,JSON.stringify(box)+' inside '+width+', under the menu');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways scrolling, '+width);
   await page.screenshot({path:'test-results/fin-pins-'+width+'.png'});
   await open.click();
   assert.equal(await open.getAttribute('aria-expanded'),'false');assert.equal(await pins.isVisible(),false,'closed again, '+width);
  }
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// The bank owner: "When the transaction is filled, then add a button for press Transact for the transaction executed and all buttons
// must be interactive, showing that they are pressed".
// The bank owner: "Move the transact button on the right side of the send to peer server".
test('Transact sits right of Send to Peer Server inside the window, and the message state shows beside the XSD check; every button shows it is pressed while held, and while what it started runs',async()=>{
 const context=await signedContext({width:1440,height:900}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 const look=locator=>locator.evaluate(node=>{const style=getComputedStyle(node);return {transform:style.transform,shadow:style.boxShadow,filter:style.filter,opacity:style.opacity};});
 try{
  const transact=page.locator('[data-fin-transact]'),validate=page.locator('[data-fin-validate]');
  for(const width of [260,390,820,1440]){
   await page.setViewportSize({width,height:900});await page.goto(base+'/fin-terminal');await transact.waitFor();
   assert.deepEqual([await transact.textContent(),await transact.isDisabled()],['Transact',true],'nothing to transact yet, '+width);
   const row=await page.locator('.fin-peer-send button:visible').evaluateAll(nodes=>nodes.map(node=>{const box=node.getBoundingClientRect();return {name:node.textContent,left:box.left,right:box.right,top:box.top};}));
   assert.deepEqual(row.map(box=>box.name),['Send to Peer Server','Transact'],'after Send to Peer Server, '+width);
   // Beside it on a phone, an iPad and a computer; under it only where the row is too narrow for both.
   if(width>260)assert.ok(row[1].left>=row[0].right&&Math.abs(row[1].top-row[0].top)<1,'beside it, '+width+' '+JSON.stringify(row));
   else assert.ok(row[1].left>=row[0].right||row[1].top>row[0].top,JSON.stringify(row));
   // With four eyes, its two PINs come between them, in reading order, inside the window.
   const pins=await page.evaluate(()=>{const box=document.querySelector('[data-fin-transact-pins]');box.hidden=false;
    const seen=[...document.querySelectorAll('.fin-peer-send :is(button,input)')].map(node=>{const at=node.getBoundingClientRect();return {name:node.getAttribute('aria-label')||node.textContent,left:at.left,right:at.right,top:at.top};});
    box.hidden=true;return seen;});
   assert.deepEqual(pins.map(box=>box.name),['Send to Peer Server','PIN 1','PIN 2','Transact'],'PINs before Transact, '+width);
   for(let at=1;at<pins.length;at++)assert.ok(pins[at].left>=pins[at-1].right&&Math.abs(pins[at].top-pins[at-1].top)<1||pins[at].top>pins[at-1].top,'in reading order, '+width+' '+JSON.stringify(pins));
   for(const box of pins)assert.ok(box.left>=0&&box.right<=width+0.5,JSON.stringify(box)+' inside '+width);
   await page.locator('.fin-peer-send').evaluate(node=>node.scrollIntoView({block:'center'}));await page.screenshot({path:'test-results/fin-transact-'+width+'.png'});
   const boxes=await page.locator('.fin-actions button:visible,.fin-peer-send button:visible').evaluateAll(nodes=>nodes.map(node=>{const box=node.getBoundingClientRect();return {name:node.textContent,left:box.left,right:box.right,height:box.height};}));
   assert.ok(boxes.some(box=>box.name==='Transact')&&!(await page.locator('.fin-actions [data-fin-transact]').count()),'Transact shown, not under the composer, '+width);
   for(const box of boxes)assert.ok(box.left>=0&&box.right<=width+0.5&&box.height>=32,JSON.stringify(box)+' inside '+width);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways scrolling, '+width);
  }
  // The XSD check and the message state are never under the composer's buttons (the bank owner: "half into the background as the
  // headers all are too small in height"): on a computer's screen all is seen at once, the buttons too; a short window scrolls to them.
  for(const [width,height] of [[1440,900],[1440,640],[960,600]]){
   await page.setViewportSize({width,height});await page.goto(base+'/fin-terminal');await page.locator('[data-fin-draft-state]').waitFor();
   const seen=await page.evaluate(scroll=>[...document.querySelectorAll('[data-fin-xsd],[data-fin-draft-state],[data-fin-validate]')].map(node=>{
    if(scroll)node.scrollIntoView({block:'nearest'});
    const box=node.getBoundingClientRect(),hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);return [node.textContent,node.contains(hit)];}),height<900);
   assert.deepEqual(seen,[['XSD: not checked',true],['New message',true],['Validate XML',true]],'seen, '+width+'x'+height);
  }
  // Held: it sinks.
  await validate.waitFor();const rest=await look(validate),box=await validate.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  const held=await look(validate);await page.mouse.up();
  assert.notEqual(held.transform,'none');assert.notEqual(held.shadow,rest.shadow);assert.notEqual(held.filter,rest.filter);
  // Its action under way (the bank's answer held back): it stays pressed, in full colour, until the answer came.
  let release;const answer=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/fin-terminal/validate',async route=>{await answer;await route.continue();});
  await validate.click();await page.waitForFunction(()=>document.querySelector('[data-fin-validate]').getAttribute('aria-busy')==='true');
  const busy=await look(validate);assert.notEqual(busy.transform,'none');assert.equal(busy.opacity,'1');
  await page.screenshot({path:'test-results/fin-transact-pressed-1440.png'});
  release();await page.waitForFunction(()=>!document.querySelector('[data-fin-validate]').hasAttribute('aria-busy'));
  assert.deepEqual(await look(validate),rest,'back as it was');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// The bank owner: "There is missing a function: Debit. This is when we have authorisation for debiting an external connected account".
test('Debit on a phone, an iPad and a computer: the direct debit\'s mandate inside the window with Transact, shown for a Debit only',async()=>{
 const context=await signedContext({width:1440,height:900}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  const mandate=page.locator('[data-fin-mandate]');
  for(const width of [260,390,820,1440]){
   await page.setViewportSize({width,height:900});await page.goto(base+'/fin-terminal');await page.locator('[data-fin-transact]').waitFor();
   assert.equal(await mandate.isVisible(),false,'no mandate for a credit transfer, '+width);
   await page.selectOption('[data-fin-direction]','DEBIT');await mandate.waitFor();
   assert.equal(await page.inputValue('[data-fin-field="messageType"]'),'pacs.003.001.08');
   await page.fill('[data-fin-field="mandateId"]','MANDATE-EXAMPLE-0001');await page.fill('[data-fin-field="mandateSignatureDate"]','2026-10-01');
   assert.match(await page.inputValue('[data-fin-xml]'),/<MndtId>MANDATE-EXAMPLE-0001<\/MndtId>\s*<DtOfSgntr>2026-10-01<\/DtOfSgntr>/);
   const boxes=await page.locator('[data-fin-mandate] :is(legend,input),[data-fin-transact]:visible').evaluateAll(nodes=>nodes.map(node=>{const box=node.getBoundingClientRect();
    return {name:node.dataset.finField||node.textContent,left:box.left,right:box.right,width:box.width};}));
   assert.deepEqual(boxes.filter(box=>['mandateId','mandateSignatureDate','Transact'].includes(box.name)).map(box=>box.name),['Transact','mandateId','mandateSignatureDate']);
   for(const box of boxes)assert.ok(box.left>=0&&box.right<=width+0.5&&box.width>0,JSON.stringify(box)+' inside '+width);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways scrolling, '+width);
   await mandate.evaluate(node=>node.scrollIntoView({block:'center'}));await page.screenshot({path:'test-results/fin-debit-'+width+'.png'});
   // Back to a credit transfer, the mandate goes with it.
   await page.selectOption('[data-fin-direction]','OUTGOING');
   assert.deepEqual([await mandate.isVisible(),await page.inputValue('[data-fin-field="messageType"]')],[false,'pacs.008.001.08']);
  }
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
