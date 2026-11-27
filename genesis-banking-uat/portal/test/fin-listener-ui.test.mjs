import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import net from 'node:net';
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
import {buildSessionMessage} from '../src/fin-peer.mjs';
import {connectorCredentials,frame} from '../src/payment-transport.mjs';
import {createBankServer} from '../server.mjs';
import {finTerminalOwner} from './helpers/fin-example.mjs';
import {startFinTerminal} from '../public/fin-terminal.mjs';

// Requested by the bank owner (FinTerminal step 5): "listening with an time selector keeping port open for white listed IPs", "not
// both working at the same time". The window against the real bank server, its listening port open to a real peer over TLS 1.3.
const admin={id:'fin-listener-ui-admin',username:'fin-listener-ui',admin:true},BANK='EXMPDEFFXXX',PEER='SMPLFRPPXXX';
let pool,db,dir,certs,server,base,cookie,port;
const STAMP=String.raw`\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\]`;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 dir=await mkdtemp(join(tmpdir(),'avis-fin-listener-ui-'));
 const certificate=async(name,san)=>{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN='+name,...(san?['-addext','subjectAltName='+san]:[]),
   '-addext','extendedKeyUsage=serverAuth,clientAuth','-keyout',join(dir,name+'.key'),'-out',join(dir,name+'.pem')],{stdio:'ignore'});
  return {cert:await readFile(join(dir,name+'.pem'),'utf8'),key:await readFile(join(dir,name+'.key'),'utf8')};
 };
 certs={bank:await certificate('localhost','DNS:localhost,IP:127.0.0.1'),peer:await certificate('peer')};
 const env={AVIS_CONNECTOR_LISTENER:JSON.stringify(certs.bank),AVIS_CONNECTOR_PEER:JSON.stringify({...certs.bank,ca:certs.peer.cert,hmacSecret:'isolated-fin-listener-ui-secret-32-bytes'})};
 // A free port for the bank's listening port in this test.
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 const nostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:PEER,accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 await bank.registerBankConnector(admin,{profileId:'EXAMPLE_PEER',name:'EXAMPLE-GW01',cashAccountId:nostro.id,protocol:'IP_TO_IP',localBic:BANK,peerBic:PEER,
  endpoint:'tls://localhost:1',credentialReference:'AVIS_CONNECTOR_PEER'},randomUUID());
 server=createBankServer({pool,authenticate:async()=>admin,finTerminalAccess:async()=>finTerminalOwner,secureCookies:false,
  transferOptions:{transport:{credentials:reference=>connectorCredentials(reference,env)},finListener:{env,port,host:'127.0.0.1'}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
 assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
});
after(async()=>{await new Promise(resolve=>server?.close(resolve));if(dir)await rm(dir,{recursive:true,force:true});if(db)await db.close();else await pool?.end();});

const until=async(ready,what,wait=8000)=>{const end=Date.now()+wait;while(!ready()){if(Date.now()>end)assert.fail('waited for '+what);await new Promise(resolve=>setTimeout(resolve,20));}};
async function terminal(){
 const html=await readFile(new URL('../public/fin-terminal.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:base+'/fin-terminal'}),doc=dom.window.document;
 const fetcher=(path,init={})=>fetch(base+path,{...init,headers:{...init.headers,cookie,origin:base}});
 await startFinTerminal({root:doc,fetcher,windowApi:{BroadcastChannel:class{close(){}},addEventListener(){},close(){}}});
 const $=selector=>doc.querySelector(selector),page={dom,doc,$,
  state:()=>$('[data-fin-listen-state]').textContent,addresses:()=>[...doc.querySelectorAll('[data-fin-peer-addresses] li span')].map(item=>item.textContent),
  lines:()=>[...doc.querySelectorAll('[data-fin-peer-stream] li')].map(item=>item.textContent),problem:()=>$('[data-fin-peer-problem]'),
  pick(selector,value){const select=$(selector);select.value=value;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));},
  async press(selector){const button=$(selector);button.click();await new Promise(resolve=>setTimeout(resolve,0));await until(()=>!button.disabled||selector==='[data-fin-peer-send]',selector);await new Promise(resolve=>setTimeout(resolve,50));},
  close(){dom.window.close();}};
 await until(()=>!$('[data-fin-listen]').disabled&&$('[data-fin-peer-server]').value==='EXAMPLE_PEER','the terminal');
 return page;
}
// The peer: connected to the bank's listening port over TLS 1.3 with its own certificate, its INIT_SESSION answered.
function peerSays(message){
 return new Promise((resolve,reject)=>{
  const socket=tls.connect({host:'127.0.0.1',port,servername:'localhost',ca:certs.bank.cert,cert:certs.peer.cert,key:certs.peer.key,minVersion:'TLSv1.3'});
  let data=Buffer.alloc(0);
  socket.on('secureConnect',()=>socket.write(frame(message)));
  socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length>=2&&data.length>=2+data.readUInt16BE()){socket.end();resolve(data.subarray(2,2+data.readUInt16BE()).toString());}});
  socket.on('error',reject);socket.on('close',()=>resolve(null));
 });
}

test('the port opens for the chosen time to the whitelisted address, a peer\'s INIT_SESSION and the bank\'s answer come into the stream, nothing is sent meanwhile',async()=>{
 const page=await terminal();try{
  assert.equal(page.state(),'Port '+port+' closed');assert.equal(page.$('[data-fin-listen]').textContent,'Open Port '+port);
  // Without a whitelisted address the port does not open, and says why.
  await page.press('[data-fin-listen]');
  assert.equal(page.problem().textContent,'Whitelist a peer bank\'s IP address before opening the port.');assert.equal(page.state(),'Port '+port+' closed');
  // An address that is no single IP address is refused at its field; one that is is whitelisted for the chosen peer.
  page.$('[data-fin-peer-address]').value='nowhere';await page.press('[data-fin-peer-address-add]');
  assert.equal(page.problem().textContent,'Check this field.');assert.equal(page.$('[data-fin-peer-address]').getAttribute('aria-invalid'),'true');assert.deepEqual(page.addresses(),[]);
  page.$('[data-fin-peer-address]').value='127.0.0.1';await page.press('[data-fin-peer-address-add]');
  assert.deepEqual(page.addresses(),['127.0.0.1']);assert.equal(page.problem().hidden,true);assert.equal(page.$('[data-fin-peer-address]').value,'');
  // Open for 15 minutes: listening, with its time left; sending out waits until it is closed.
  page.pick('[data-fin-listen-time]','15');await page.press('[data-fin-listen]');
  assert.match(page.state(),new RegExp('^Listening on port '+port+' until \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d UTC · 00:1[45]:\\d\\d left$'));
  assert.equal(page.$('[data-fin-listen-state]').dataset.state,'LISTENING');assert.equal(page.$('[data-fin-listen]').textContent,'Close Port '+port);
  assert.equal(page.$('[data-fin-peer-send]').disabled,true);assert.equal(page.$('[data-fin-listen-time]').disabled,true);
  const answer=await peerSays(buildSessionMessage({localBic:PEER,peerBic:BANK,businessMessageId:'PEERMSG0001',event:'INIT',text:'HELLO EXAMPLE BANK',at:new Date()}));
  assert.match(answer,/<EvtCd>INIT<\/EvtCd>\s*<EvtParam>READY<\/EvtParam>/);
  await until(()=>page.lines().length===2,'the peer\'s message in the stream');
  assert.match(page.lines()[0],new RegExp('^<<< '+STAMP+' PEER INIT_SESSION RECEIVED \\(Seq #\\d{6}\\) · HELLO EXAMPLE BANK$'));
  assert.match(page.lines()[1],new RegExp('^>>> '+STAMP+' ANSWER INIT_SESSION SENT \\(Seq #\\d{6}\\) · WELCOME ACCEPTED // SESSION READY$'));
  await until(()=>/^Peer link: READY · up /.test(page.$('[data-fin-peer-link]').textContent),'the session ready');
  // Closed: the port is closed and sending is open again.
  await page.press('[data-fin-listen]');
  assert.equal(page.state(),'Port '+port+' closed');assert.equal(page.$('[data-fin-peer-send]').disabled,false);assert.equal(page.$('[data-fin-listen-time]').disabled,false);
  assert.equal(await peerSays('HELLO').catch(()=>null),null);
  // The address taken off the whitelist.
  await page.press('[data-fin-peer-addresses] li button');assert.deepEqual(page.addresses(),[]);
 }finally{page.close();}
});
