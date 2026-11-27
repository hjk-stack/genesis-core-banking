import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {FinPeers,buildSessionMessage,readPeerAnswer} from '../src/fin-peer.mjs';
import {FinListener} from '../src/fin-listener.mjs';
import {connectorCredentials,frame} from '../src/payment-transport.mjs';
import {buildFinMessage} from '../public/fin-message.mjs';
import {createBankServer} from '../server.mjs';
import {exampleForm} from './helpers/fin-example.mjs';

// Requested by the bank owner (FinTerminal step 5): "listening with an time selector keeping port open for white listed IPs or I can
// connect to servers that have our IP white listed", "The listening port should be same just not both working at the same time".
// Real TLS on this machine: the bank's listening port, peers connecting from whitelisted and other addresses with their own
// certificates, and peer servers the bank connects out to.
const admin={id:'fin-listener-admin',username:'fin-listener',admin:true},guest={id:'guest',admin:false};
const BANK='EXMPDEFFXXX',PEER_A='SMPLFRPPXXX',PEER_B='SMPLGB2LXXX';
let pool,db,dir,certs,env,peers,listener,peerServer,oldServer;
const refused=(code,status)=>error=>error.code===code&&(status===undefined||error.status===status);
const certificate=async(name,san)=>{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN='+name,...(san?['-addext','subjectAltName='+san]:[]),
  '-addext','extendedKeyUsage=serverAuth,clientAuth','-keyout',join(dir,name+'.key'),'-out',join(dir,name+'.pem')],{stdio:'ignore'});
 return {cert:await readFile(join(dir,name+'.pem'),'utf8'),key:await readFile(join(dir,name+'.key'),'utf8')};
};
// A peer's own session message, from the peer's BIC to the bank's.
const fromPeer=(event,{text='HELLO EXAMPLE BANK',from=PEER_A,id='PEERMSG'+randomUUID().slice(0,8).toUpperCase()}={})=>
 buildSessionMessage({localBic:from,peerBic:BANK,businessMessageId:id,event,text,at:new Date()});
const value=(xml,name)=>new RegExp('<'+name+'>([^<]*)</'+name+'>').exec(xml)?.[1];
// A peer's connection to the port: each message in a frame, its answer awaited; a connection the bank refuses ends without one.
function exchange(messages,{identity=certs.peerA,localAddress='127.0.0.1',maxVersion='TLSv1.3',keep=false}={}){
 return new Promise(resolve=>{
  const answers=[];let data=Buffer.alloc(0),next=0,protocol=null;
  const socket=tls.connect({host:'127.0.0.1',port:listener.boundPort()||1,servername:'localhost',ca:certs.bank.cert,cert:identity?.cert,key:identity?.key,localAddress,maxVersion});
  const finish=()=>resolve({answers,protocol,socket});
  const send=()=>{if(next<messages.length)socket.write(frame(messages[next++]));else if(keep)finish();else socket.end();};
  socket.on('secureConnect',()=>{protocol=socket.getProtocol();send();});
  socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);while(data.length>=2&&data.length>=2+data.readUInt16BE()){const size=data.readUInt16BE();answers.push(data.subarray(2,2+size).toString());data=data.subarray(2+size);send();}});
  socket.on('error',()=>{});socket.on('close',finish);socket.setTimeout(5000,()=>socket.destroy());
 });
}
const rows=async(profileId='EXAMPLE_PEER_A')=>(await pool.query('SELECT * FROM avis_core_v2.fin_terminal_peer_messages WHERE profile_id=$1 ORDER BY sequence',[profileId])).rows;
const count=async()=>(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.fin_terminal_peer_messages')).rows[0].n;
const until=async(ready,what,wait=5000)=>{const end=Date.now()+wait;while(!(await ready())){if(Date.now()>end)assert.fail('waited for '+what);await new Promise(resolve=>setTimeout(resolve,25));}};
const delivered=async()=>until(async()=>(await rows()).every(row=>row.status!=='SENDING'),'the answers delivered');

before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 // The bank's own certificate on the port, and each peer's own (its own issuer), as Azure keeps them: made here for this test.
 dir=await mkdtemp(join(tmpdir(),'avis-fin-listener-'));
 certs={bank:await certificate('localhost','DNS:localhost,IP:127.0.0.1'),peerA:await certificate('peer-a','DNS:localhost,IP:127.0.0.1'),peerB:await certificate('peer-b'),stranger:await certificate('stranger')};
 const own=issuer=>JSON.stringify({cert:certs.bank.cert,key:certs.bank.key,ca:issuer,hmacSecret:'isolated-fin-listener-fixture-secret-32b'});
 env={AVIS_CONNECTOR_LISTENER:JSON.stringify({cert:certs.bank.cert,key:certs.bank.key}),AVIS_CONNECTOR_PEER_A:own(certs.peerA.cert),AVIS_CONNECTOR_PEER_B:own(certs.peerB.cert)};
 // Peer A's own server the bank connects out to (TLS 1.3), and an old one speaking TLS 1.2 only.
 const serve=(options,answer)=>tls.createServer({...certs.peerA,ca:certs.bank.cert,requestCert:true,rejectUnauthorized:true,...options},socket=>{
  let data=Buffer.alloc(0);socket.on('error',()=>{});
  socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length>=2&&data.length===2+data.readUInt16BE())socket.end(frame(answer(data.subarray(2).toString())));});
 });
 const acknowledge=xml=>buildSessionMessage({localBic:PEER_A,peerBic:BANK,businessMessageId:'PEERMSG0001',event:'INIT',text:'WELCOME',at:new Date()});
 peerServer=serve({},acknowledge);oldServer=serve({maxVersion:'TLSv1.2'},acknowledge);
 await new Promise(resolve=>peerServer.listen(0,'127.0.0.1',resolve));await new Promise(resolve=>oldServer.listen(0,'127.0.0.1',resolve));
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 const nostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:PEER_A,accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 const connector=(profileId,name,peerBic,port,credentialReference)=>bank.registerBankConnector(admin,
  {profileId,name,cashAccountId:nostro.id,protocol:'IP_TO_IP',localBic:BANK,peerBic,endpoint:'tls://localhost:'+port,credentialReference},randomUUID());
 await connector('EXAMPLE_PEER_A','EXAMPLE-GW-A',PEER_A,peerServer.address().port,'AVIS_CONNECTOR_PEER_A');
 await connector('EXAMPLE_PEER_B','EXAMPLE-GW-B',PEER_B,peerServer.address().port,'AVIS_CONNECTOR_PEER_B');
 await connector('EXAMPLE_PEER_OLD','EXAMPLE-GW-OLD',PEER_A,oldServer.address().port,'AVIS_CONNECTOR_PEER_A');
 peers=new FinPeers(pool,{credentials:reference=>connectorCredentials(reference,env)});
 listener=new FinListener(pool,peers,{env,port:0,host:'127.0.0.1'});
});
after(async()=>{
 await listener?.stop();for(const server of [peerServer,oldServer])await new Promise(resolve=>server?server.close(resolve):resolve());
 if(dir)await rm(dir,{recursive:true,force:true});if(db)await db.close();else await pool?.end();
});

test('the port opens for a chosen time, with the bank\'s certificate in place and a peer\'s address whitelisted; administrators only',async()=>{
 for(const work of [()=>listener.status(guest),()=>listener.open(guest,{minutes:15}),()=>listener.close(guest),()=>peers.addAddress(guest,'EXAMPLE_PEER_A',{address:'127.0.0.1'})])
  await assert.rejects(work(),refused('FORBIDDEN',403));
 assert.deepEqual({...(await listener.status(admin)),now:undefined},{open:false,until:null,now:undefined,port:0,listening:false,error:null});
 await assert.rejects(listener.open(admin,{minutes:15}),refused('FIN_LISTENER_NO_PEER',409));
 // Single IP addresses, an IPv4 one written as itself; no ranges, names or zones.
 for(const address of ['not-an-address','127.0.0.0/8','localhost','fe80::1%eth0','',42])
  await assert.rejects(peers.addAddress(admin,'EXAMPLE_PEER_A',{address}),error=>error.code==='INVALID_FIELD'&&error.field==='address');
 await assert.rejects(peers.addAddress(admin,'EXAMPLE_UNKNOWN',{address:'127.0.0.1'}),refused('CONNECTOR_NOT_FOUND',404));
 assert.deepEqual(await peers.addAddress(admin,'EXAMPLE_PEER_A',{address:' ::ffff:127.0.0.1 '}),{addresses:['127.0.0.1']});
 assert.deepEqual(await peers.addAddress(admin,'EXAMPLE_PEER_A',{address:'2001:DB8::7'}),{addresses:['127.0.0.1','2001:db8::7']});
 assert.deepEqual(await peers.removeAddress(admin,'EXAMPLE_PEER_A',{address:'2001:db8::7'}),{addresses:['127.0.0.1']});
 assert.deepEqual((await peers.list(admin)).map(peer=>[peer.profileId,peer.addresses]),[['EXAMPLE_PEER_A',['127.0.0.1']],['EXAMPLE_PEER_B',[]],['EXAMPLE_PEER_OLD',[]]]);
 for(const minutes of [30,'15',0,null])await assert.rejects(listener.open(admin,{minutes}),error=>error.code==='INVALID_FIELD'&&error.field==='minutes');
 // Without the bank's own certificate in Azure the port does not open.
 await assert.rejects(new FinListener(pool,peers,{env:{...env,AVIS_CONNECTOR_LISTENER:undefined},port:0}).open(admin,{minutes:15}),refused('LISTENER_CONFIGURATION',503));
 const opened=await listener.open(admin,{minutes:15});
 assert.equal(opened.open,true);assert.equal(opened.listening,true);assert.equal(opened.error,null);
 const left=Date.parse(opened.until)-Date.parse(opened.now);assert.ok(left>14.9*60000&&left<=15*60000,String(left));
 assert.ok(listener.boundPort()>0);
 const closed=await listener.close(admin);assert.deepEqual([closed.open,closed.listening,closed.until],[false,false,null]);assert.equal(listener.boundPort(),null);
});

test('a whitelisted peer with its own certificate is answered over TLS 1.3: INIT_SESSION, HEARTBEAT and END_SESSION each with the bank\'s same event',async()=>{
 await peers.addAddress(admin,'EXAMPLE_PEER_A',{address:'127.0.0.1'});await listener.open(admin,{minutes:15});
 const init=fromPeer('INIT'),{answers,protocol}=await exchange([init]);
 assert.equal(protocol,'TLSv1.3');assert.equal(answers.length,1);
 // The bank's answer as the peer reads it: its acknowledgement of INIT_SESSION, from the bank to the peer, passing the schemas.
 const read=await readPeerAnswer(answers[0],{localBic:PEER_A,peerBic:BANK,event:'INIT',businessMessageId:value(init,'BizMsgIdr')});
 assert.deepEqual([read.status,read.code,read.parameters,read.text],['ACK','INIT',['READY'],'WELCOME ACCEPTED // SESSION READY']);
 await delivered();
 let kept=await rows();
 assert.deepEqual(kept.map(row=>[row.direction,row.status,row.event_code,row.answer_to===kept[0].message_id]),[['IN','RECEIVED','INIT',false],['OUT','DELIVERED','INIT',true]]);
 assert.equal(kept[0].content,init);assert.equal(kept[1].content,answers[0]);assert.equal(kept[0].event_text,'HELLO EXAMPLE BANK');assert.equal(kept[1].created_by,'listener');
 const ready=await peers.messages(admin,'EXAMPLE_PEER_A');
 assert.equal(ready.link.state,'READY');assert.equal(ready.link.since,new Date(kept[1].updated_at).toISOString());
 assert.deepEqual(ready.messages.map(message=>[message.direction,message.status,message.event,Boolean(message.answerTo)]),[['IN','RECEIVED','INIT',false],['OUT','DELIVERED','INIT',true]]);
 // Several messages on one connection, each answered in turn; the session stays ready, then closes.
 const more=await exchange([fromPeer('HEARTBEAT',{text:''}),fromPeer('HEARTBEAT',{text:''})]);
 assert.deepEqual(more.answers.map(answer=>value(answer,'EvtCd')),['HBT','HBT']);await delivered();
 const beat=await peers.messages(admin,'EXAMPLE_PEER_A');assert.equal(beat.link.state,'READY');assert.equal(beat.link.since,ready.link.since);
 const end=await exchange([fromPeer('END',{text:'GOOD NIGHT'})]);assert.equal(value(end.answers[0],'EvtCd'),'END');assert.equal(value(end.answers[0],'EvtDesc'),'SESSION CLOSED');
 await delivered();assert.equal((await peers.messages(admin,'EXAMPLE_PEER_A')).link.state,'CLOSED');
 await listener.close(admin);
});

test('refused before any message is read: an address not whitelisted, no certificate, another issuer, another peer\'s certificate, TLS 1.2',async()=>{
 // Peer B's certificate from peer A's address: B's issuer is trusted on the port, but not for A.
 await peers.addAddress(admin,'EXAMPLE_PEER_A',{address:'127.0.0.1'});
 assert.deepEqual(await peers.addAddress(admin,'EXAMPLE_PEER_B',{address:'127.0.0.2'}),{addresses:['127.0.0.2']});
 await listener.open(admin,{minutes:15});
 const before=await count();
 for(const options of [{localAddress:'127.0.0.3'},{identity:null},{identity:certs.stranger},{identity:certs.peerB},{maxVersion:'TLSv1.2'}]){
  const {answers}=await exchange([fromPeer('INIT')],options);
  assert.deepEqual(answers,[],JSON.stringify({...options,identity:options.identity?.cert?'certificate':options.identity}));
 }
 assert.equal(await count(),before);
 // Peer B from its own whitelisted address, with its own certificate, is answered.
 const {answers}=await exchange([fromPeer('INIT',{from:PEER_B})],{identity:certs.peerB,localAddress:'127.0.0.2'});
 assert.equal(value(answers[0],'EvtCd'),'INIT');assert.deepEqual(value(answers[0],'BICFI'),BANK);
 await until(async()=>(await rows('EXAMPLE_PEER_B')).every(row=>row.status!=='SENDING'),'peer B\'s answer');
 assert.deepEqual((await rows('EXAMPLE_PEER_B')).map(row=>[row.direction,row.status]),[['IN','RECEIVED'],['OUT','DELIVERED']]);
 await listener.close(admin);
});

test('a message the bank does not take is refused with a message reject naming it, and the reason',async()=>{
 await peers.addAddress(admin,'EXAMPLE_PEER_A',{address:'127.0.0.1'});await listener.open(admin,{minutes:15});
 const other=fromPeer('INIT',{id:'PEERMSGOTHER'}).replace('<EvtCd>INIT</EvtCd>','<EvtCd>XYZ</EvtCd>');
 for(const [message,reason,reference] of [['HELLO','NOT_ISO20022','NONE'],[fromPeer('INIT',{from:'OTHRDEFFXXX',id:'PEERMSGHEADER'}),'HEADER','PEERMSGHEADER'],
  [fromPeer('INIT').replace('<EvtCd>INIT</EvtCd>','<EvtCd>TOOLONG</EvtCd>'),'SCHEMA','NONE'],[other,'OTHER_EVENT','PEERMSGOTHER'],[buildFinMessage(exampleForm()),'NOT_SUPPORTED','NONE']]){
  const {answers}=await exchange([message]);
  const read=await readPeerAnswer(answers[0],{localBic:PEER_A,peerBic:BANK,event:'INIT',businessMessageId:reference});
  assert.deepEqual([read.status,read.type,read.code],['NAK','admi.002.001.01',reason],reason);
  await delivered();const [kept,answer]=(await rows()).slice(-2);
  assert.deepEqual([kept.direction,kept.status,kept.error_code,kept.content],['IN','UNREAD',reason,message]);
  assert.deepEqual([answer.direction,answer.status,answer.message_type,answer.event_code,answer.event_parameters],['OUT','DELIVERED','admi.002.001.01',reason,[reference]]);
  assert.equal((await peers.messages(admin,'EXAMPLE_PEER_A')).link.state,'NO_SESSION');
 }
 assert.equal((await rows()).at(-2).message_type,'pacs.008.001.08');
 await listener.close(admin);
});

test('the port closes when closed and by itself at the end of its time; while it is open the terminal does not connect out, and connects out over TLS 1.3 only',async()=>{
 await peers.addAddress(admin,'EXAMPLE_PEER_A',{address:'127.0.0.1'});await listener.open(admin,{minutes:15});
 const before=await count();
 await assert.rejects(peers.send(admin,'EXAMPLE_PEER_A',{event:'INIT',text:'HELLO'}),refused('FIN_LISTENING',409));
 assert.equal(await count(),before);
 await listener.close(admin);
 assert.deepEqual((await exchange([fromPeer('INIT')])).answers,[]);
 // Closed, the terminal connects out again - over TLS 1.3: a peer server on TLS 1.2 is not reached.
 assert.equal((await peers.send(admin,'EXAMPLE_PEER_A',{event:'INIT',text:'HELLO'})).messages.at(-1).status,'ACK');
 const old=await peers.send(admin,'EXAMPLE_PEER_OLD',{event:'INIT',text:'HELLO'});
 assert.equal(old.messages.at(-1).status,'FAILED');assert.match(old.messages.at(-1).error,/^ERR_SSL_|PROTOCOL|VERSION/);assert.equal(old.link.state,'NOT_CONNECTED');
 // Opened for a moment: at its end the port closes by itself.
 await listener.open(admin,{minutes:15});
 await pool.query("UPDATE avis_core_v2.fin_terminal_listener SET open_until=now()+interval '1 second'");await listener.reconcile();
 assert.ok(listener.boundPort()>0);
 await until(async()=>listener.boundPort()===null,'the port to close by itself',4000);
 assert.equal((await listener.status(admin)).open,false);assert.deepEqual((await exchange([fromPeer('INIT')])).answers,[]);
});

test('an address taken off the whitelist ends its connection at once; an address added while the port is open is let in',async()=>{
 await peers.removeAddress(admin,'EXAMPLE_PEER_B',{address:'127.0.0.2'});
 await listener.open(admin,{minutes:15});
 assert.deepEqual((await exchange([fromPeer('INIT',{from:PEER_B})],{identity:certs.peerB,localAddress:'127.0.0.2'})).answers,[]);
 await peers.addAddress(admin,'EXAMPLE_PEER_B',{address:'127.0.0.2'});await listener.refresh();
 const open=await exchange([fromPeer('INIT',{from:PEER_B})],{identity:certs.peerB,localAddress:'127.0.0.2',keep:true});
 assert.equal(open.answers.length,1);assert.equal(open.socket.destroyed,false);
 const ended=new Promise(resolve=>open.socket.once('close',resolve));
 await peers.removeAddress(admin,'EXAMPLE_PEER_B',{address:'127.0.0.2'});await listener.refresh();
 await ended;assert.equal(open.socket.destroyed,true);
 await listener.close(admin);
});

test('the bank serves the port\'s state, opens and closes it and keeps the whitelist with the CSRF token, for administrators',async()=>{
 const server=createBankServer({pool,authenticate:async()=>admin,secureCookies:false,transferOptions:{transport:{credentials:reference=>connectorCredentials(reference,env)},finListener:{env,port:0,host:'127.0.0.1'}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
  const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  const ask=(path,body,token=csrf)=>fetch(base+path,body===undefined?{headers:{origin:base,cookie}}:{method:'POST',headers:{origin:base,cookie,'content-type':'application/json',...(token?{'x-csrf-token':token}:{})},body:JSON.stringify(body)});
  assert.equal((await (await ask('/api/fin-terminal/listener')).json()).open,false);
  assert.equal((await ask('/api/fin-terminal/listener',{open:true,minutes:15},'')).status,403);
  assert.equal((await ask('/api/fin-terminal/listener',{minutes:15})).status,422);
  const opened=await (await ask('/api/fin-terminal/listener',{open:true,minutes:60})).json();
  assert.deepEqual([opened.open,opened.listening],[true,true]);assert.ok(Date.parse(opened.until)-Date.parse(opened.now)>59*60000);
  assert.equal((await ask('/api/fin-terminal/peers/EXAMPLE_PEER_A/messages',{event:'INIT',text:'HELLO'})).status,409);
  assert.equal((await (await ask('/api/fin-terminal/listener',{open:false})).json()).open,false);
  assert.deepEqual(await (await ask('/api/fin-terminal/peers/EXAMPLE_PEER_B/addresses',{address:'198.51.100.7'})).json(),{addresses:['198.51.100.7']});
  assert.equal((await ask('/api/fin-terminal/peers/EXAMPLE_PEER_B/addresses',{address:'198.51.100.8'},'')).status,403);
  assert.deepEqual(await (await ask('/api/fin-terminal/peers/EXAMPLE_PEER_B/addresses/remove',{address:'198.51.100.7'})).json(),{addresses:[]});
  assert.equal((await ask('/api/fin-terminal/peers/EXAMPLE_PEER_B/addresses',{address:'nowhere'})).status,422);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
