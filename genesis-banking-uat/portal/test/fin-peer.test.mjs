import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import https from 'node:https';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateXML} from 'xmllint-wasm';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {FinPeers} from '../src/fin-peer.mjs';
import {connectorCredentials,frame,signRequest} from '../src/payment-transport.mjs';
import {createBankServer} from '../server.mjs';

// Requested by the bank owner with the FinTerminal specification (v3), screen A "Peer Server Handshake & Direct IP Interaction":
// the welcome/session message to a peer bank's server and its answers - "No simulators only active live software ready to connect
// and transact". The peers here are real servers on this machine: mutual TLS, framed TLS and HTTPS with the bank's signature.
const admin={id:'fin-peer-admin',username:'fin-peer',admin:true},guest={id:'guest',admin:false};
const NS='urn:iso:std:iso:20022:tech:xsd:',CREDENTIAL='AVIS_CONNECTOR_EXAMPLE_PEER';
let pool,db,dir,env,peers,tlsServer,httpsServer,closedPort,reply,received;
const refused=(code,status)=>error=>error.code===code&&(status===undefined||error.status===status);
const header=(from,to,type)=>`<AppHdr xmlns="${NS}head.001.001.02"><Fr><FIId><FinInstnId><BICFI>${from}</BICFI></FinInstnId></FIId></Fr><To><FIId><FinInstnId><BICFI>${to}</BICFI></FinInstnId></FIId></To>`+
 `<BizMsgIdr>PEERMSG0001</BizMsgIdr><MsgDefIdr>${type}</MsgDefIdr><CreDt>2026-11-27T10:06:11Z</CreDt></AppHdr>`;
// The peer's own system event notification, and its message reject.
const peerEvent=({from='SMPLFRPPXXX',to='EXMPDEFFXXX',code='INIT',parameters=['READY'],text='WELCOME ACCEPTED // CHANNEL READY'}={})=>`<?xml version="1.0" encoding="UTF-8"?><Envelope>${header(from,to,'admi.004.001.02')}`+
 `<Document xmlns="${NS}admi.004.001.02"><SysEvtNtfctn><EvtInf><EvtCd>${code}</EvtCd>${parameters.map(p=>'<EvtParam>'+p+'</EvtParam>').join('')}${text?'<EvtDesc>'+text+'</EvtDesc>':''}<EvtTm>2026-11-27T10:06:11Z</EvtTm></EvtInf></SysEvtNtfctn></Document></Envelope>`;
const peerReject=ref=>`<?xml version="1.0" encoding="UTF-8"?><Document xmlns="${NS}admi.002.001.01"><admi.002.001.01><RltdRef><Ref>${ref}</Ref></RltdRef>`+
 `<Rsn><RjctgPtyRsn>SESSION_CLOSED</RjctgPtyRsn><RsnDesc>No session is open for this sender</RsnDesc></Rsn></admi.002.001.01></Document>`;
const schema=async type=>({fileName:type+'.xsd',contents:await readFile(new URL('../schemas/'+type+'.xsd',import.meta.url),'utf8')});
// What the peer received checked as the peer would: the envelope of the official header and system event notification schemas.
async function official(xml){
 const envelope=`<?xml version="1.0" encoding="UTF-8"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:h="${NS}head.001.001.02" xmlns:d="${NS}admi.004.001.02">`+
  `<xs:import namespace="${NS}head.001.001.02" schemaLocation="head.001.001.02.xsd"/><xs:import namespace="${NS}admi.004.001.02" schemaLocation="admi.004.001.02.xsd"/>`+
  `<xs:element name="Envelope"><xs:complexType><xs:sequence><xs:element ref="h:AppHdr"/><xs:element ref="d:Document"/></xs:sequence></xs:complexType></xs:element></xs:schema>`;
 return (await validateXML({xml:{fileName:'received.xml',contents:xml},schema:{fileName:'envelope.xsd',contents:envelope},preload:[await schema('head.001.001.02'),await schema('admi.004.001.02')]})).valid;
}
const value=(xml,name)=>new RegExp('<'+name+'>([^<]*)</'+name+'>').exec(xml)?.[1];
const values=(xml,name)=>[...xml.matchAll(new RegExp('<'+name+'>([^<]*)</'+name+'>','g'))].map(match=>match[1]);

before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 // The bank connector's certificate, as Azure keeps it for the connector (App Service setting or Key Vault): made here for this test.
 dir=await mkdtemp(join(tmpdir(),'avis-fin-peer-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-addext','extendedKeyUsage=serverAuth,clientAuth','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
 const credentials={key:await readFile(join(dir,'key.pem'),'utf8'),cert:await readFile(join(dir,'cert.pem'),'utf8'),hmacSecret:'isolated-fin-peer-fixture-secret-32-bytes'};credentials.ca=credentials.cert;
 env={[CREDENTIAL]:JSON.stringify(credentials)};
 received=[];reply=()=>peerEvent();
 // A peer server on framed TLS and one on HTTPS, each asking for the bank's certificate; the HTTPS peer checks the bank's signature.
 tlsServer=tls.createServer({...credentials,requestCert:true,rejectUnauthorized:true},socket=>{
  let data=Buffer.alloc(0);
  socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length<2||data.length!==2+data.readUInt16BE())return;
   const xml=data.subarray(2).toString();received.push({peer:'TLS',xml,authorized:socket.authorized});const answer=reply(xml);
   if(answer===null)socket.end();else socket.end(frame(answer));});
 });
 httpsServer=https.createServer({...credentials,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),xml=body.toString();
  const signed=signRequest('POST',req.url,body,credentials.hmacSecret,req.headers['x-avis-time'],req.headers['x-avis-nonce'])['x-avis-signature']===req.headers['x-avis-signature'];
  received.push({peer:'HTTPS',xml,authorized:req.socket.authorized,signed,path:req.url});const answer=reply(xml);
  if(typeof answer==='number'){res.writeHead(answer);res.end();}else res.end(answer);
 });
 await new Promise(resolve=>tlsServer.listen(0,'127.0.0.1',resolve));await new Promise(resolve=>httpsServer.listen(0,'127.0.0.1',resolve));
 const gone=tls.createServer();await new Promise(resolve=>gone.listen(0,'127.0.0.1',resolve));closedPort=gone.address().port;await new Promise(resolve=>gone.close(resolve));
 // The peers as the bank registers them (Administration, "Add bank connector"); a SWIFT gateway and a disabled connector are no IP-to-IP peers.
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 const nostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:'SMPLFRPPXXX',accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 const connector=(profileId,name,endpoint,{protocol='IP_TO_IP',peerBic='SMPLFRPPXXX',credentialReference=CREDENTIAL}={})=>bank.registerBankConnector(admin,
  {profileId,name,cashAccountId:nostro.id,protocol,localBic:'EXMPDEFFXXX',peerBic,endpoint,credentialReference},randomUUID());
 await connector('EXAMPLE_TLS_PEER','EXAMPLE-GW01','tls://localhost:'+tlsServer.address().port);
 await connector('EXAMPLE_HTTPS_PEER','EXAMPLE-GW02','https://localhost:'+httpsServer.address().port+'/session?channel=iso20022',{peerBic:'SMPLGB2L'});
 await connector('EXAMPLE_CLOSED_PEER','EXAMPLE-GW03','tls://localhost:'+closedPort);
 await connector('EXAMPLE_NO_CERT','EXAMPLE-GW04','tls://localhost:'+tlsServer.address().port,{credentialReference:'AVIS_CONNECTOR_EXAMPLE_MISSING'});
 await connector('EXAMPLE_SWIFT','EXAMPLE-SWIFT','https://localhost:'+httpsServer.address().port+'/swift',{protocol:'SWIFT_ISO20022'});
 await connector('EXAMPLE_OFF','EXAMPLE-OFF','tls://localhost:'+tlsServer.address().port);
 await pool.query("UPDATE avis_core_v2.platform_connectors SET is_enabled=false WHERE connector_code='EXAMPLE_OFF'");
 peers=new FinPeers(pool,{credentials:reference=>connectorCredentials(reference,env)});
});
after(async()=>{
 await new Promise(resolve=>tlsServer?.close(resolve));if(httpsServer){httpsServer.closeAllConnections();await new Promise(resolve=>httpsServer.close(resolve));}
 if(dir)await rm(dir,{recursive:true,force:true});if(db)await db.close();else await pool?.end();
});
const rows=async profileId=>(await pool.query('SELECT * FROM avis_core_v2.fin_terminal_peer_messages WHERE profile_id=$1 ORDER BY sequence',[profileId])).rows;

test('the peers are the bank\'s IP-to-IP connectors to peer banks, shown to bank administrators only',async()=>{
 const port=name=>String(name==='TLS'?tlsServer.address().port:httpsServer.address().port);
 assert.deepEqual(await peers.list(admin),[
  {profileId:'EXAMPLE_TLS_PEER',name:'EXAMPLE-GW01',address:'localhost:'+port('TLS'),transport:'TLS',localBic:'EXMPDEFFXXX',peerBic:'SMPLFRPPXXX',addresses:[]},
  {profileId:'EXAMPLE_HTTPS_PEER',name:'EXAMPLE-GW02',address:'localhost:'+port('HTTPS'),transport:'HTTPS',localBic:'EXMPDEFFXXX',peerBic:'SMPLGB2L',addresses:[]},
  {profileId:'EXAMPLE_CLOSED_PEER',name:'EXAMPLE-GW03',address:'localhost:'+closedPort,transport:'TLS',localBic:'EXMPDEFFXXX',peerBic:'SMPLFRPPXXX',addresses:[]},
  {profileId:'EXAMPLE_NO_CERT',name:'EXAMPLE-GW04',address:'localhost:'+port('TLS'),transport:'TLS',localBic:'EXMPDEFFXXX',peerBic:'SMPLFRPPXXX',addresses:[]}]);
 // A peer nothing was sent to yet is not connected.
 const first=await peers.messages(admin,'EXAMPLE_CLOSED_PEER');
 assert.deepEqual(first.messages,[]);assert.equal(first.link.state,'NOT_CONNECTED');assert.equal(first.link.since,null);assert.equal(first.link.error,null);
 for(const profileId of ['EXAMPLE_SWIFT','EXAMPLE_OFF','EXAMPLE_UNKNOWN','example_tls_peer',null])
  await assert.rejects(peers.messages(admin,profileId),refused('CONNECTOR_NOT_FOUND',404));
 await assert.rejects(peers.list(guest),refused('FORBIDDEN',403));await assert.rejects(peers.messages(guest,'EXAMPLE_TLS_PEER'),refused('FORBIDDEN',403));
 await assert.rejects(peers.send(guest,'EXAMPLE_TLS_PEER',{event:'INIT',text:'HELLO'}),refused('FORBIDDEN',403));
 assert.deepEqual(received,[]);
});

test('the session message reaches the peer server as an ISO 20022 system event notification; the session is ready with the peer\'s acknowledgement',async()=>{
 received.length=0;reply=()=>peerEvent();
 const result=await peers.send(admin,'EXAMPLE_TLS_PEER',{event:'INIT',text:'  HELLO EXAMPLE-GW01 // SESSION INIT EXMPDEFFXXX -> SMPLFRPPXXX // READY\r\nFOR MANUAL PACS.008 DISPATCH  '});
 // The peer received it over mutual TLS, and it passes the official schemas as the peer checks them.
 assert.equal(received.length,1);const [{xml,authorized}]=received;assert.equal(authorized,true);assert.equal(await official(xml),true);
 assert.deepEqual(values(xml,'BICFI'),['EXMPDEFFXXX','SMPLFRPPXXX']);assert.equal(value(xml,'MsgDefIdr'),'admi.004.001.02');
 assert.equal(value(xml,'EvtCd'),'INIT');assert.deepEqual(values(xml,'EvtParam'),['READY']);
 assert.equal(value(xml,'EvtDesc'),'HELLO EXAMPLE-GW01 // SESSION INIT EXMPDEFFXXX -&gt; SMPLFRPPXXX // READY\nFOR MANUAL PACS.008 DISPATCH');
 assert.match(value(xml,'BizMsgIdr'),/^FT\d{14}[A-Z0-9]{4}$/);assert.equal(value(xml,'CreDt'),value(xml,'EvtTm'));
 // What was sent, and what the peer answered, as it came.
 const [out,answer]=result.messages;
 assert.deepEqual({...out,messageId:undefined,at:undefined,sequence:undefined,businessMessageId:undefined},{messageId:undefined,direction:'OUT',answerTo:null,at:undefined,type:'admi.004.001.02',businessMessageId:undefined,
  event:'INIT',parameters:['READY'],text:'HELLO EXAMPLE-GW01 // SESSION INIT EXMPDEFFXXX -> SMPLFRPPXXX // READY\nFOR MANUAL PACS.008 DISPATCH',status:'DELIVERED',error:null,answered:true,sequence:undefined});
 assert.equal(out.businessMessageId,value(xml,'BizMsgIdr'));
 assert.deepEqual({...answer,messageId:undefined,at:undefined,sequence:undefined},{messageId:undefined,direction:'IN',answerTo:out.messageId,at:undefined,type:'admi.004.001.02',businessMessageId:'PEERMSG0001',
  event:'INIT',parameters:['READY'],text:'WELCOME ACCEPTED // CHANNEL READY',status:'ACK',error:null,answered:false,sequence:undefined});
 assert.ok(answer.sequence>out.sequence);
 assert.deepEqual(result.peer,(await peers.list(admin))[0]);
 assert.equal(result.link.state,'READY');assert.equal(result.link.since,answer.at);assert.equal(result.link.lastAnswerAt,answer.at);assert.equal(result.link.error,null);
 assert.ok(Date.parse(result.link.now)>=Date.parse(result.link.since));
 // Kept: the message the peer received, by whom it was sent, and the peer's answer as it came.
 const kept=await rows('EXAMPLE_TLS_PEER');
 assert.equal(kept[0].content,xml);assert.equal(kept[0].created_by,admin.id);assert.equal(kept[1].content,peerEvent());assert.equal(kept[1].created_by,null);
 // A heartbeat the peer acknowledges keeps the session as it is.
 reply=()=>peerEvent({code:'HBT',parameters:[],text:null});
 const beat=await peers.send(admin,'EXAMPLE_TLS_PEER',{event:'HEARTBEAT'});
 assert.equal(value(received[1].xml,'EvtCd'),'HBT');assert.equal(value(received[1].xml,'EvtDesc'),undefined);assert.equal(await official(received[1].xml),true);
 assert.equal(beat.link.state,'READY');assert.equal(beat.link.since,result.link.since);assert.equal(beat.messages.length,4);
 assert.deepEqual(beat.messages.slice(2).map(m=>[m.direction,m.event,m.status,m.text]),[['OUT','HBT','DELIVERED',null],['IN','HBT','ACK',null]]);
});

test('a refusal, an answer that cannot be read and a peer that does not answer end the session; a new acknowledged INIT_SESSION opens it again',async()=>{
 const send=async(event,answer)=>{reply=typeof answer==='function'?answer:()=>answer;return peers.send(admin,'EXAMPLE_TLS_PEER',{event});};
 const opened=await send('INIT',peerEvent());assert.equal(opened.link.state,'READY');
 // The peer's message reject names the message it refused.
 const nak=await send('HEARTBEAT',xml=>peerReject(value(xml,'BizMsgIdr')));
 const [refusedOut,reject]=nak.messages.slice(-2);
 assert.deepEqual([reject.status,reject.type,reject.event,reject.text,reject.parameters,reject.answerTo],['NAK','admi.002.001.01','SESSION_CLOSED','No session is open for this sender',[refusedOut.businessMessageId],refusedOut.messageId]);
 assert.equal(nak.link.state,'REFUSED');assert.equal(nak.link.since,null);assert.equal(nak.link.lastAnswerAt,reject.at);
 const again=await send('INIT',peerEvent());assert.equal(again.link.state,'READY');assert.ok(again.link.since>opened.link.since);
 // Not ISO 20022, another bank's header, or a message its schema refuses: kept as it came, not read, and no session.
 for(const [answer,reason] of [['OK',  'NOT_ISO20022'],[peerEvent({from:'OTHRDEFFXXX'}),'HEADER'],[peerEvent({to:'OTHRDEFFXXX'}),'HEADER'],[peerEvent({code:'TOOLONG'}),'SCHEMA'],
  ['<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Document xmlns="'+NS+'admi.004.001.02"/>','NOT_ISO20022'],
  // The schemas take any element they declare as a whole message: a header alone, or an envelope without its header, is no answer.
  [header('SMPLFRPPXXX','EXMPDEFFXXX','admi.004.001.02').replace('<AppHdr ','<AppHdr xmlns:d="'+NS+'admi.004.001.02" '),'SCHEMA'],
  [peerEvent().replace(/<AppHdr[\s\S]*<\/AppHdr>/,''),'SCHEMA']]){
  const result=await send('INIT',answer),last=result.messages.at(-1);assert.equal(result.messages.at(-2).status,'DELIVERED');
  assert.deepEqual([last.direction,last.status,last.error,last.event],['IN','UNREAD',reason,null]);
  assert.equal((await rows('EXAMPLE_TLS_PEER')).at(-1).content,answer);
  assert.equal(result.link.state,'NO_SESSION');assert.equal(result.link.since,null);
 }
 // Said by the peer, but not of the message sent (Codex review finding): another event, INIT_SESSION without READY, or a refusal
 // naming another message. Kept as it came, shown as it is, and the session ends.
 for(const [event,answer,reason,code] of [['INIT',peerEvent({code:'END',parameters:[],text:'SESSION CLOSED'}),'OTHER_EVENT','END'],
  ['INIT',peerEvent({code:'HBT',parameters:[],text:null}),'OTHER_EVENT','HBT'],['INIT',peerEvent({parameters:[]}),'OTHER_EVENT','INIT'],
  ['HEARTBEAT',peerEvent(),'OTHER_EVENT','INIT'],['END',peerEvent(),'OTHER_EVENT','INIT'],['HEARTBEAT',peerReject('FT20261127000000ABCD'),'OTHER_MESSAGE','SESSION_CLOSED']]){
  assert.equal((await send('INIT',peerEvent())).link.state,'READY');
  const result=await send(event,answer),last=result.messages.at(-1);
  assert.deepEqual([last.direction,last.status,last.error,last.event,last.answerTo],['IN','UNREAD',reason,code,result.messages.at(-2).messageId]);
  assert.deepEqual([result.link.state,result.link.since],['NO_SESSION',null]);
 }
 // A peer that takes the message and closes without an answer: not delivered, not connected.
 const cut=await send('INIT',null),last=cut.messages.at(-1);
 assert.deepEqual([last.direction,last.status,last.error,last.answered],['OUT','FAILED','INCOMPLETE_BANK_RESPONSE',false]);
 assert.equal(cut.link.state,'NOT_CONNECTED');assert.equal(cut.link.error,'INCOMPLETE_BANK_RESPONSE');
 // The end of a session the peer acknowledged closes it.
 await send('INIT',peerEvent());const closed=await send('END',peerEvent({code:'END',parameters:[],text:'SESSION CLOSED'}));
 assert.equal(value(received.at(-1).xml,'EvtCd'),'END');assert.equal(closed.link.state,'CLOSED');assert.equal(closed.link.since,null);
});

test('over HTTPS the peer server checks the bank\'s signature; an empty answer is no session, an HTTP refusal and a closed port are not connected',async()=>{
 received.length=0;reply=()=>'';
 const quiet=await peers.send(admin,'EXAMPLE_HTTPS_PEER',{event:'INIT',text:'HELLO EXAMPLE-GW02'});
 assert.deepEqual(received.map(r=>[r.peer,r.authorized,r.signed,r.path]),[['HTTPS',true,true,'/session?channel=iso20022']]);
 assert.deepEqual(values(received[0].xml,'BICFI'),['EXMPDEFFXXX','SMPLGB2L']);assert.equal(await official(received[0].xml),true);
 assert.deepEqual(quiet.messages.map(m=>[m.direction,m.status,m.answered]),[['OUT','DELIVERED',false]]);assert.equal(quiet.link.state,'NO_SESSION');
 reply=()=>503;
 const busy=await peers.send(admin,'EXAMPLE_HTTPS_PEER',{event:'INIT',text:'HELLO EXAMPLE-GW02'});
 assert.deepEqual(busy.messages.at(-1).status,'FAILED');assert.equal(busy.messages.at(-1).error,'BANK_HTTP_503');
 assert.deepEqual([busy.link.state,busy.link.error],['NOT_CONNECTED','BANK_HTTP_503']);
 // A document alone (no header) comes over the peer's own connection, and is read as its own.
 reply=()=>'<?xml version="1.0" encoding="UTF-8"?>'+peerEvent().replace(/^[\s\S]*<\/AppHdr>/,'').replace('</Envelope>','');
 const bare=await peers.send(admin,'EXAMPLE_HTTPS_PEER',{event:'INIT',text:'HELLO EXAMPLE-GW02'});
 assert.deepEqual([bare.messages.at(-1).status,bare.messages.at(-1).businessMessageId,bare.messages.at(-1).event,bare.link.state],['ACK',null,'INIT','READY']);
 reply=()=>503;await peers.send(admin,'EXAMPLE_HTTPS_PEER',{event:'HEARTBEAT'});
 // The peer's eight-letter BIC is the same bank as its eleven-letter one.
 reply=()=>peerEvent({from:'SMPLGB2LXXX'});
 const ready=await peers.send(admin,'EXAMPLE_HTTPS_PEER',{event:'INIT',text:'HELLO EXAMPLE-GW02'});
 assert.deepEqual([ready.messages.at(-1).status,ready.link.state],['ACK','READY']);
 const closed=await peers.send(admin,'EXAMPLE_CLOSED_PEER',{event:'INIT',text:'HELLO EXAMPLE-GW03'});
 assert.deepEqual(closed.messages.map(m=>[m.direction,m.status,m.error]),[['OUT','FAILED','ECONNREFUSED']]);
 assert.deepEqual([closed.link.state,closed.link.error],['NOT_CONNECTED','ECONNREFUSED']);
});

test('nothing is sent or kept for a connector without its certificate in place, an unknown event or a message too long',async()=>{
 received.length=0;reply=()=>peerEvent();
 const before=(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.fin_terminal_peer_messages')).rows[0].n;
 await assert.rejects(peers.send(admin,'EXAMPLE_NO_CERT',{event:'INIT',text:'HELLO'}),refused('CONNECTOR_CONFIGURATION',503));
 for(const [body,field] of [[{event:'WELCOME',text:'HELLO'},'event'],[{text:'HELLO'},'event'],[null,'event'],[{event:'INIT',text:'x'.repeat(1001)},'text'],
  [{event:'INIT',text:'HELLO\u0007'},'text'],[{event:'INIT',text:42},'text']])
  await assert.rejects(peers.send(admin,'EXAMPLE_TLS_PEER',body),error=>error.code==='INVALID_FIELD'&&error.field===field);
 await assert.rejects(peers.send(admin,'EXAMPLE_SWIFT',{event:'INIT',text:'HELLO'}),refused('CONNECTOR_NOT_FOUND',404));
 assert.deepEqual(received,[]);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.fin_terminal_peer_messages')).rows[0].n,before);
 // A thousand characters, the system event's longest description, go.
 const longest=await peers.send(admin,'EXAMPLE_TLS_PEER',{event:'INIT',text:'Ü'.repeat(1000)});
 assert.equal(longest.messages.at(-2).text,'Ü'.repeat(1000));assert.equal(await official(received[0].xml),true);
});

test('a message whose sending never finished shows that its result is unknown; one being sent leaves the link as it was',async()=>{
 reply=()=>peerEvent({from:'SMPLGB2LXXX'});const ready=await peers.send(admin,'EXAMPLE_HTTPS_PEER',{event:'INIT',text:'HELLO EXAMPLE-GW02'});assert.equal(ready.link.state,'READY');
 const sending=randomUUID();
 await pool.query(`INSERT INTO avis_core_v2.fin_terminal_peer_messages(message_id,profile_id,direction,message_type,event_code,status,created_by) VALUES($1,'EXAMPLE_HTTPS_PEER','OUT','admi.004.001.02','HBT','SENDING',$2)`,[sending,admin.id]);
 const meanwhile=await peers.messages(admin,'EXAMPLE_HTTPS_PEER');
 assert.equal(meanwhile.messages.at(-1).status,'SENDING');assert.equal(meanwhile.link.state,'READY');assert.equal(meanwhile.link.since,ready.link.since);
 await pool.query("UPDATE avis_core_v2.fin_terminal_peer_messages SET created_at=now()-interval '2 minutes',updated_at=now()-interval '2 minutes' WHERE message_id=$1",[sending]);
 const lost=await peers.messages(admin,'EXAMPLE_HTTPS_PEER');
 assert.equal(lost.messages.at(-1).status,'UNCERTAIN');assert.deepEqual([lost.link.state,lost.link.error,lost.link.since],['NOT_CONNECTED','NO_RESULT',null]);
});

test('the bank serves the peers and their streams to its administrators, and sends only with the CSRF token',async()=>{
 const server=createBankServer({pool,authenticate:async()=>admin,secureCookies:false,transferOptions:{transport:{credentials:reference=>connectorCredentials(reference,env)}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
  const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  const ask=(path,init={})=>fetch(base+path,{...init,headers:{origin:base,cookie,...init.headers}});
  const listed=await ask('/api/fin-terminal/peers');assert.equal(listed.status,200);assert.deepEqual((await listed.json()).peers,await peers.list(admin));
  const stream=await ask('/api/fin-terminal/peers/EXAMPLE_TLS_PEER/messages');assert.equal(stream.status,200);
  assert.deepEqual((await stream.json()).messages.map(m=>m.messageId),(await peers.messages(admin,'EXAMPLE_TLS_PEER')).messages.map(m=>m.messageId));
  assert.equal((await ask('/api/fin-terminal/peers/EXAMPLE_SWIFT/messages')).status,404);
  received.length=0;reply=()=>peerEvent();
  const post=body=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await ask('/api/fin-terminal/peers/EXAMPLE_TLS_PEER/messages',post({event:'INIT',text:'HELLO'}))).status,403);assert.deepEqual(received,[]);
  const sent=await ask('/api/fin-terminal/peers/EXAMPLE_TLS_PEER/messages',{...post({event:'INIT',text:'HELLO'}),headers:{'content-type':'application/json','x-csrf-token':csrf}});
  assert.equal(sent.status,200);const result=await sent.json();assert.equal(result.link.state,'READY');assert.equal(result.messages.at(-1).status,'ACK');assert.equal(received.length,1);
  const missing=await ask('/api/fin-terminal/peers/EXAMPLE_NO_CERT/messages',{...post({event:'INIT',text:'HELLO'}),headers:{'content-type':'application/json','x-csrf-token':csrf}});
  assert.equal(missing.status,503);const why=await missing.json();
  assert.deepEqual([why.code,why.message],['CONNECTOR_CONFIGURATION','Check the credential reference in connector administration.']);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
