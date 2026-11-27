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
import {connectorCredentials,frame} from '../src/payment-transport.mjs';
import {createBankServer} from '../server.mjs';

// Requested by the bank owner with the FinTerminal specification (v3), screen A "Peer Server Handshake & Direct IP Interaction",
// in the dark blue and orange they approved; checked on a phone (also in the two-thirds window the Payments switch opens there),
// an iPad and a computer, the bank talking to a real peer server over mutual TLS.
const admin={id:'fin-peer-browser',username:'fin-peer-browser',admin:true},NS='urn:iso:std:iso:20022:tech:xsd:';
const answer=`<?xml version="1.0" encoding="UTF-8"?><Envelope><AppHdr xmlns="${NS}head.001.001.02"><Fr><FIId><FinInstnId><BICFI>SMPLFRPPXXX</BICFI></FinInstnId></FIId></Fr>`+
 `<To><FIId><FinInstnId><BICFI>EXMPDEFFXXX</BICFI></FinInstnId></FIId></To><BizMsgIdr>PEERMSG0001</BizMsgIdr><MsgDefIdr>admi.004.001.02</MsgDefIdr><CreDt>2026-11-27T10:06:11Z</CreDt></AppHdr>`+
 `<Document xmlns="${NS}admi.004.001.02"><SysEvtNtfctn><EvtInf><EvtCd>INIT</EvtCd><EvtParam>READY</EvtParam><EvtDesc>WELCOME ACCEPTED // CHANNEL READY</EvtDesc></EvtInf></SysEvtNtfctn></Document></Envelope>`;
let db,dir,server,peer,browser,base;
before(async()=>{
 db=new PGlite();let connections=Promise.resolve();
 const pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 dir=await mkdtemp(join(tmpdir(),'avis-fin-peer-browser-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-addext','extendedKeyUsage=serverAuth,clientAuth','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
 const credentials={key:await readFile(join(dir,'key.pem'),'utf8'),cert:await readFile(join(dir,'cert.pem'),'utf8'),hmacSecret:'isolated-fin-peer-browser-secret-32-bytes'};credentials.ca=credentials.cert;
 const env={AVIS_CONNECTOR_EXAMPLE_PEER:JSON.stringify(credentials)};
 peer=tls.createServer({...credentials,requestCert:true,rejectUnauthorized:true},socket=>{
  let data=Buffer.alloc(0);socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length>=2&&data.length===2+data.readUInt16BE())socket.end(frame(answer));});
 });
 await new Promise(resolve=>peer.listen(0,'127.0.0.1',resolve));
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 const nostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:'SMPLFRPPXXX',accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 await bank.registerBankConnector(admin,{profileId:'EXAMPLE_TLS_PEER',name:'EXAMPLE-FRANKFURT-GW01',cashAccountId:nostro.id,protocol:'IP_TO_IP',localBic:'EXMPDEFFXXX',peerBic:'SMPLFRPPXXX',
  endpoint:'tls://localhost:'+peer.address().port,credentialReference:'AVIS_CONNECTOR_EXAMPLE_PEER'},randomUUID());
 server=createBankServer({pool,authenticate:async()=>admin,secureCookies:false,transferOptions:{transport:{credentials:reference=>connectorCredentials(reference,env)}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve));await new Promise(resolve=>peer?.close(resolve));await db?.close();if(dir)await rm(dir,{recursive:true,force:true});});

for(const width of [260,390,820,1440])test('screen A on '+(width<500?'a phone':width<1000?'an iPad':'a computer')+' ('+width+'px): the session message sent to the peer server, its acknowledgement in the stream, the link ready',async()=>{
 const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  assert.equal((await context.request.post(base+'/api/login',{headers:{origin:base},data:{username:admin.username,password:'fixture'}})).status(),200);
  await page.goto(base+'/fin-terminal');
  await page.waitForFunction(()=>document.querySelector('[data-fin-peer-server]').options[0]?.value==='EXAMPLE_TLS_PEER');
  assert.equal(await page.locator('[data-fin-peer-node]').textContent(),'EXAMPLE-FRANKFURT-GW01');
  // The stream as it stands (the widths before this one sent theirs), then this one's message and the peer's answer.
  await page.waitForFunction(()=>document.querySelector('[data-fin-peer-link]').textContent!=='Peer link: NOT CONNECTED'||document.querySelector('[data-fin-peer-stream]').children.length===0);
  const before=await page.locator('[data-fin-peer-stream] li').count();
  await page.getByRole('button',{name:'Send to Peer Server'}).click();
  await page.waitForFunction(count=>document.querySelectorAll('[data-fin-peer-stream] li').length===count+2&&!document.querySelector('[data-fin-peer-send]').disabled,before);
  assert.equal(await page.locator('[data-fin-peer-link]').getAttribute('data-state'),'READY');
  const lines=await page.locator('[data-fin-peer-stream] li').allTextContents();
  assert.match(lines.at(-2),/^>>> \[.+ UTC\] INIT_SESSION SENT \(Seq #\d{6}\) · HELLO EXAMPLE-FRANKFURT-GW01 \/\/ SESSION INIT EXMPDEFFXXX -> SMPLFRPPXXX/);
  assert.match(lines.at(-1),/^<<< \[.+ UTC\] PEER_ACK: admi\.004\.001\.02 INIT READY · WELCOME ACCEPTED \/\/ CHANNEL READY$/);
  const look=await page.evaluate(()=>{
   const css=element=>getComputedStyle(document.querySelector(element)),box=element=>document.querySelector(element).getBoundingClientRect().toJSON();
   return {stream:css('[data-fin-peer-stream]').backgroundColor,ack:css('[data-fin-peer-stream] [data-status=ack]').color,send:css('[data-fin-peer-send]').backgroundColor,
    ready:css('[data-fin-peer-link]').color,sideways:document.documentElement.scrollWidth>innerWidth,panel:box('[data-fin-peer]'),out:box('.fin-peer-out'),in:box('.fin-peer-in'),form:box('[data-fin-form]')};
  });
  assert.deepEqual({stream:look.stream,ack:look.ack,send:look.send,ready:look.ready,sideways:look.sideways},
   {stream:'rgb(4, 8, 15)',ack:'rgb(52, 211, 153)',send:'rgb(245, 159, 11)',ready:'rgb(52, 211, 153)',sideways:false});
  assert.ok(look.panel.left>=0&&look.panel.right<=width+1,'the panel inside the window');
  // Above the composer, as in the specification; the stream beside the message where there is room, under it on a phone.
  assert.ok(look.form.top>=look.panel.bottom-1,'composer under the panel');
  if(width>640)assert.ok(look.in.left>=look.out.right-1,'stream beside the message');else assert.ok(look.in.top>=look.out.bottom-1,'stream under the message');
  await page.screenshot({path:'test-results/fin-peer-'+width+'.png'});
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
