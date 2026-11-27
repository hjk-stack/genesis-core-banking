import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {JSDOM} from 'jsdom';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {FinPeers} from '../src/fin-peer.mjs';
import {connectorCredentials,frame} from '../src/payment-transport.mjs';
import {createBankServer} from '../server.mjs';
import {startFinTerminal} from '../public/fin-terminal.mjs';

// Requested by the bank owner with the FinTerminal specification (v3), screen A: "Peer Server Handshake & Direct IP Interaction"
// with the "Outgoing Welcome / Session Message", "Send to Peer Server" and the "Peer Server Response / ACK Stream" - only real
// answers. The window talks to the real bank server, and the bank to a real peer server over mutual TLS.
const admin={id:'fin-peer-ui-admin',username:'fin-peer-ui',admin:true};
const NS='urn:iso:std:iso:20022:tech:xsd:',CREDENTIAL='AVIS_CONNECTOR_EXAMPLE_PEER';
let pool,db,dir,env,server,base,cookie,peerServer,closedPort,reply,received;
const peerEvent=(code='INIT',text='WELCOME ACCEPTED // CHANNEL READY')=>`<?xml version="1.0" encoding="UTF-8"?><Envelope><AppHdr xmlns="${NS}head.001.001.02">`+
 `<Fr><FIId><FinInstnId><BICFI>SMPLFRPPXXX</BICFI></FinInstnId></FIId></Fr><To><FIId><FinInstnId><BICFI>EXMPDEFFXXX</BICFI></FinInstnId></FIId></To>`+
 `<BizMsgIdr>PEERMSG0001</BizMsgIdr><MsgDefIdr>admi.004.001.02</MsgDefIdr><CreDt>2026-11-27T10:06:11Z</CreDt></AppHdr><Document xmlns="${NS}admi.004.001.02">`+
 `<SysEvtNtfctn><EvtInf><EvtCd>${code}</EvtCd>${code==='INIT'?'<EvtParam>READY</EvtParam>':''}<EvtDesc>${text}</EvtDesc></EvtInf></SysEvtNtfctn></Document></Envelope>`;
const peerReject=ref=>`<?xml version="1.0" encoding="UTF-8"?><Document xmlns="${NS}admi.002.001.01"><admi.002.001.01><RltdRef><Ref>${ref}</Ref></RltdRef>`+
 `<Rsn><RjctgPtyRsn>SESSION_CLOSED</RjctgPtyRsn><RsnDesc>No session is open for this sender</RsnDesc></Rsn></admi.002.001.01></Document>`;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 dir=await mkdtemp(join(tmpdir(),'avis-fin-peer-ui-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-addext','extendedKeyUsage=serverAuth,clientAuth','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
 const credentials={key:await readFile(join(dir,'key.pem'),'utf8'),cert:await readFile(join(dir,'cert.pem'),'utf8'),hmacSecret:'isolated-fin-peer-ui-fixture-secret-32b'};credentials.ca=credentials.cert;
 env={[CREDENTIAL]:JSON.stringify(credentials)};received=[];reply=()=>peerEvent();
 peerServer=tls.createServer({...credentials,requestCert:true,rejectUnauthorized:true},socket=>{
  let data=Buffer.alloc(0);
  socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length<2||data.length!==2+data.readUInt16BE())return;const xml=data.subarray(2).toString();received.push(xml);socket.end(frame(reply(xml)));});
 });
 await new Promise(resolve=>peerServer.listen(0,'127.0.0.1',resolve));
 const gone=tls.createServer();await new Promise(resolve=>gone.listen(0,'127.0.0.1',resolve));closedPort=gone.address().port;await new Promise(resolve=>gone.close(resolve));
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 const nostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:'SMPLFRPPXXX',accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 const connector=(profileId,name,endpoint,credentialReference=CREDENTIAL)=>bank.registerBankConnector(admin,
  {profileId,name,cashAccountId:nostro.id,protocol:'IP_TO_IP',localBic:'EXMPDEFFXXX',peerBic:'SMPLFRPPXXX',endpoint,credentialReference},randomUUID());
 await connector('EXAMPLE_TLS_PEER','EXAMPLE-GW01','tls://localhost:'+peerServer.address().port);
 await connector('EXAMPLE_CLOSED_PEER','EXAMPLE-GW02','tls://localhost:'+closedPort);
 await connector('EXAMPLE_NO_CERT','EXAMPLE-GW03','tls://localhost:'+peerServer.address().port,'AVIS_CONNECTOR_EXAMPLE_MISSING');
 server=createBankServer({pool,authenticate:async()=>admin,secureCookies:false,transferOptions:{transport:{credentials:reference=>connectorCredentials(reference,env)}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
 assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
});
after(async()=>{await new Promise(resolve=>server?.close(resolve));await new Promise(resolve=>peerServer?.close(resolve));if(dir)await rm(dir,{recursive:true,force:true});if(db)await db.close();else await pool?.end();});

const until=async(ready,what,wait=8000)=>{const end=Date.now()+wait;while(!ready()){if(Date.now()>end)assert.fail('waited for '+what);await new Promise(resolve=>setTimeout(resolve,20));}};
async function terminal(){
 const html=await readFile(new URL('../public/fin-terminal.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:base+'/fin-terminal'}),doc=dom.window.document,asked=[];
 const fetcher=async(path,init={})=>{asked.push({path,method:init.method||'GET',headers:init.headers||{}});return fetch(base+path,{...init,headers:{...init.headers,cookie,origin:base}});};
 await startFinTerminal({root:doc,fetcher,windowApi:{BroadcastChannel:class{close(){}},addEventListener(){},close(){}}});
 const $=selector=>doc.querySelector(selector),panel={dom,doc,$,asked,
  peers:()=>[...doc.querySelectorAll('[data-fin-peer-server] option')].map(option=>option.textContent),
  lines:()=>[...doc.querySelectorAll('[data-fin-peer-stream] li')].map(item=>item.textContent),
  link:()=>$('[data-fin-peer-link]').textContent,text:$('[data-fin-peer-text]'),problem:$('[data-fin-peer-problem]'),button:$('[data-fin-peer-send]'),
  pick(selector,value){const select=$(selector);select.value=value;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));},
  async send(count){panel.button.click();await until(()=>!panel.button.disabled&&(count===undefined||panel.lines().length===count),'the answer');},
  close(){dom.window.close();}};
 await until(()=>panel.peers().length===3,'the peers');
 return panel;
}
const STAMP=String.raw`\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\]`;

test('screen A offers the registered peers; INIT_SESSION goes to the peer, its acknowledgement comes back and the link is ready, counting its uptime',async()=>{
 const page=await terminal();try{
  const port=peerServer.address().port;
  assert.deepEqual(page.peers(),['EXAMPLE-GW01 · localhost:'+port+' · SMPLFRPPXXX','EXAMPLE-GW02 · localhost:'+closedPort+' · SMPLFRPPXXX','EXAMPLE-GW03 · localhost:'+port+' · SMPLFRPPXXX']);
  assert.equal(page.$('[data-fin-peer-node]').textContent,'EXAMPLE-GW01');assert.equal(page.$('#fin-peer-title').textContent,'Peer Server Handshake & Direct IP Interaction — NODE: EXAMPLE-GW01');
  assert.equal(page.text.value,'HELLO EXAMPLE-GW01 // SESSION INIT EXMPDEFFXXX -> SMPLFRPPXXX // READY FOR MANUAL PACS.008 DISPATCH');
  assert.equal(page.link(),'Peer link: NOT CONNECTED');assert.deepEqual(page.lines(),[]);assert.equal(page.button.disabled,false);
  // The message each event starts with; one written by hand stays as written.
  page.pick('[data-fin-peer-event]','HEARTBEAT');assert.equal(page.text.value,'HEARTBEAT EXMPDEFFXXX -> SMPLFRPPXXX');
  page.text.value='HELLO GW01 // MANUAL SESSION';page.pick('[data-fin-peer-event]','END');assert.equal(page.text.value,'HELLO GW01 // MANUAL SESSION');
  page.pick('[data-fin-peer-event]','INIT');
  received.length=0;reply=()=>peerEvent();await page.send(2);
  assert.equal(received.length,1);assert.match(received[0],/<EvtCd>INIT<\/EvtCd>\s*<EvtParam>READY<\/EvtParam>\s*<EvtDesc>HELLO GW01 \/\/ MANUAL SESSION<\/EvtDesc>/);
  const [out,answer]=page.lines();
  assert.match(out,new RegExp('^>>> '+STAMP+' INIT_SESSION SENT \\(Seq #\\d{6}\\) · HELLO GW01 // MANUAL SESSION$'));
  assert.match(answer,new RegExp('^<<< '+STAMP+' PEER_ACK: admi\\.004\\.001\\.02 INIT READY · WELCOME ACCEPTED // CHANNEL READY$'));
  assert.match(page.link(),new RegExp('^Peer link: READY · up 00:00:0\\d · last answer \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d UTC$'));
  assert.equal(page.$('[data-fin-peer-link]').dataset.state,'READY');
  assert.deepEqual([...page.doc.querySelectorAll('[data-fin-peer-stream] li')].map(item=>[item.dataset.direction,item.dataset.status]),[['out','delivered'],['in','ack']]);
  // The uptime counts on.
  const shown=page.link();await until(()=>page.link()!==shown,'the uptime',3000);assert.match(page.link(),/^Peer link: READY · up 00:00:0[1-9] · /);
  // Sent with the bank's CSRF token.
  assert.ok(page.asked.filter(request=>request.method==='POST').every(request=>request.headers['x-csrf-token']));
 }finally{page.close();}
});

test('a refusal, an unreachable peer and a connector without its certificate are shown as they are; nothing is made up',async()=>{
 const page=await terminal();try{
  await until(()=>page.lines().length>0,'the stream');
  reply=xml=>peerReject(/<BizMsgIdr>([^<]+)<\/BizMsgIdr>/.exec(xml)[1]);page.pick('[data-fin-peer-event]','HEARTBEAT');
  const before=page.lines().length;await page.send(before+2);
  assert.match(page.lines().at(-2),new RegExp('^>>> '+STAMP+' HEARTBEAT SENT \\(Seq #\\d{6}\\) · HEARTBEAT EXMPDEFFXXX -> SMPLFRPPXXX$'));
  assert.match(page.lines().at(-1),new RegExp('^<<< '+STAMP+' PEER_NAK: admi\\.002\\.001\\.01 SESSION_CLOSED · No session is open for this sender \\(ref FT\\d{14}[A-Z0-9]{4}\\)$'));
  assert.match(page.link(),new RegExp('^Peer link: REFUSED · last answer '));
  // Another peer: its own stream, its own link.
  page.pick('[data-fin-peer-server]','EXAMPLE_CLOSED_PEER');assert.deepEqual(page.lines(),[]);assert.equal(page.link(),'Peer link: NOT CONNECTED');
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(page.$('[data-fin-peer-node]').textContent,'EXAMPLE-GW02');assert.equal(page.link(),'Peer link: NOT CONNECTED');
  await page.send(1);
  assert.match(page.lines()[0],new RegExp('^>>> '+STAMP+' HEARTBEAT NOT DELIVERED \\(Seq #\\d{6}\\) · connection refused \\(ECONNREFUSED\\) · HEARTBEAT EXMPDEFFXXX -> SMPLFRPPXXX$'));
  assert.equal(page.link(),'Peer link: NOT CONNECTED · connection refused (ECONNREFUSED)');
  // A connector whose certificate is not in place sends nothing and says why.
  page.pick('[data-fin-peer-server]','EXAMPLE_NO_CERT');await until(()=>page.lines().length===0,'the third stream');
  received.length=0;await page.send();
  assert.equal(page.problem.hidden,false);assert.equal(page.problem.textContent,'Check the credential reference in connector administration.');
  assert.deepEqual(page.lines(),[]);assert.deepEqual(received,[]);assert.equal(page.link(),'Peer link: NOT CONNECTED');
  page.pick('[data-fin-peer-server]','EXAMPLE_TLS_PEER');assert.equal(page.problem.hidden,true);
 }finally{page.close();}
});

test('what another operator sends to the peer shows in the stream within seconds',async()=>{
 const page=await terminal();try{
  await until(()=>page.lines().length>0,'the stream');const before=page.lines().length;
  reply=()=>peerEvent();
  await new FinPeers(pool,{credentials:reference=>connectorCredentials(reference,env)}).send({id:'second-operator',admin:true},'EXAMPLE_TLS_PEER',{event:'INIT',text:'HELLO FROM THE SECOND OPERATOR'});
  await until(()=>page.lines().length===before+2,'the second operator\'s message',8000);
  assert.match(page.lines().at(-2),/INIT_SESSION SENT .* · HELLO FROM THE SECOND OPERATOR$/);assert.match(page.link(),/^Peer link: READY · /);
 }finally{page.close();}
});
