import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import https from 'node:https';
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
import {SovereignCore} from '../src/core.mjs';
import {FinTerminal,validateFinMessage} from '../src/fin-terminal.mjs';
import {FinAccess} from '../src/fin-access.mjs';
import {FinPeers,buildPaymentStatus,buildReject} from '../src/fin-peer.mjs';
import {ServerDOMParser} from '../src/fin-xml.mjs';
import {connectorCredentials,frame,signRequest} from '../src/payment-transport.mjs';
import {readFinMessage,newUetr} from '../public/fin-message.mjs';
import {streamLine} from '../public/fin-peer.mjs';
import {startFinTerminal} from '../public/fin-terminal.mjs';
import {createBankServer} from '../server.mjs';
import {exampleIban,finTerminalOwner} from './helpers/fin-example.mjs';

// The FinTerminal specification v3 (FinTerminal_Unified_NOSTRO_Crypto_System_v3), Screen B's Cash Wire (NOSTRO) and its "Execute &
// Dispatch". The bank owner: "pacs.008 sent; the paying account and the NOSTRO are debited; the pacs.002 answer shows in the message
// stream", through any peer server registered with "Add bank connector" ("4.a) is correct as selector"), with PIN 1 and PIN 2 while
// 4-Eyes is on. The peers are real servers on this machine - mutual TLS 1.3 and signed HTTPS - answering as a peer's own FinTerminal
// answers a transfer (buildPaymentStatus).
const admin={id:'fin-wire-admin',username:'fin-wire',admin:true},guest={id:'guest',admin:false};
const BANK='EXMPDEFFXXX',PEER='SMPLFRPPXXX',CREDENTIAL='AVIS_CONNECTOR_EXAMPLE_WIRE',BENEFICIARY=exampleIban('FR','00000000000000000000123');
const owner=finTerminalOwner,officer={principal:'portal:officer',name:'Example Officer',owner:false,finTerminal:true,administrators:owner.administrators};
let pool,db,dir,env,tlsServer,httpsServer,closedPort,reply,received,peers,access,account,nostro;
const refused=(code,status)=>error=>error.code===code&&(status===undefined||error.status===status);
// The peer's status of the transfer it received, as its own FinTerminal writes it: named by the transfer's message, end-to-end id and UETR.
const status=(xml,code,{reason=null,text=null,uetr=null}={})=>{
 const {form}=readFinMessage(xml,ServerDOMParser);
 return buildPaymentStatus({localBic:PEER,peerBic:BANK,businessMessageId:'PEERSTS0001',at:new Date(),original:form.businessMessageId,endToEndId:form.endToEndId,
  uetr:uetr||form.uetr,status:code,reason,description:text});
};
const ledger=async accountId=>(await pool.query('SELECT available_balance::numeric(20,2)::text AS available,locked_balance::numeric(20,2)::text AS locked FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[accountId])).rows[0];
// The paying account, the NOSTRO, the NOSTRO's cash reserved for wires not settled yet, and the wires' suspense account.
const money=async()=>{
 const paying=await ledger(account.accountId),correspondent=await ledger(nostro.ledger);
 const suspense=(await pool.query("SELECT available_balance::numeric(20,2)::text AS b FROM avis_core_v2.ledger_accounts WHERE owner_type='SUSPENSE_OUTBOUND' AND sub_account_code='FIN:WIRES' AND currency_code='EUR'")).rows[0]?.b||'0.00';
 return {account:paying.available,nostro:correspondent.available,held:correspondent.locked,suspense};
};
const moved=(from,to)=>Object.fromEntries(Object.keys(from).map(key=>[key,(Number(to[key])-Number(from[key])).toFixed(2)]));
const wire=(changes={})=>({uetr:newUetr(),bookingAccountId:account.accountId,amount:'250000.00',creditorName:'Example Creditor SARL',creditorIban:BENEFICIARY,...changes});
const kept=async uetr=>(await pool.query('SELECT * FROM avis_core_v2.fin_terminal_wires WHERE uetr=$1',[uetr])).rows[0];
const count=async table=>(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.'+table)).rows[0].n;
const journals=async uetr=>(await pool.query(`SELECT event_type,actor_id,reverses_journal_id IS NOT NULL AS reverses FROM avis_core_v2.ledger_journals
 WHERE idempotency_key IN ('fin-outgoing:'||$1,'fin-outgoing-settled:'||$1,'fin-outgoing-returned:'||$1) ORDER BY event_type`,[uetr])).rows;
const attempts=async()=>(await pool.query('SELECT slot,failed_attempts FROM avis_core_v2.fin_terminal_pins ORDER BY slot')).rows.map(row=>[Number(row.slot),Number(row.failed_attempts)]);

before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 // The bank connector's certificate, as Azure keeps it for the connector: made here for this test.
 dir=await mkdtemp(join(tmpdir(),'avis-fin-wire-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-addext','extendedKeyUsage=serverAuth,clientAuth','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
 const credentials={key:await readFile(join(dir,'key.pem'),'utf8'),cert:await readFile(join(dir,'cert.pem'),'utf8'),hmacSecret:'isolated-fin-wire-fixture-secret-32-bytes'};credentials.ca=credentials.cert;
 env={[CREDENTIAL]:JSON.stringify(credentials)};received=[];reply=xml=>status(xml,'ACSC');
 tlsServer=tls.createServer({...credentials,requestCert:true,rejectUnauthorized:true},socket=>{
  let data=Buffer.alloc(0);
  socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length<2||data.length!==2+data.readUInt16BE())return;
   const xml=data.subarray(2).toString();received.push({peer:'TLS',xml,authorized:socket.authorized,protocol:socket.getProtocol()});const answer=reply(xml);
   if(answer===null)socket.end();else socket.end(frame(answer));});
 });
 httpsServer=https.createServer({...credentials,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),xml=body.toString();
  const signed=signRequest('POST',req.url,body,credentials.hmacSecret,req.headers['x-avis-time'],req.headers['x-avis-nonce'])['x-avis-signature']===req.headers['x-avis-signature'];
  received.push({peer:'HTTPS',xml,authorized:req.socket.authorized,signed});const answer=reply(xml);
  if(typeof answer==='number'){res.writeHead(answer);res.end();}else res.end(answer);
 });
 await new Promise(resolve=>tlsServer.listen(0,'127.0.0.1',resolve));await new Promise(resolve=>httpsServer.listen(0,'127.0.0.1',resolve));
 const gone=tls.createServer();await new Promise(resolve=>gone.listen(0,'127.0.0.1',resolve));closedPort=gone.address().port;await new Promise(resolve=>gone.close(resolve));
 // AVISPay PLC's account, the bank's NOSTRO at the peer in euros (and one in dollars), and the peer servers of every type.
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 const opened=(await bank.openAccount(admin,{accountType:'SUSPENSE',fullName:'AVISPay PLC',currencies:['EUR']},randomUUID())).managedAccounts[0];
 const cash=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example Peer Bank',bic:PEER,accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 const dollars=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example Peer Bank',bic:PEER,accountNumber:'NOSTRO-EXAMPLE-USD',currency:'USD'},randomUUID());
 const connector=(profileId,name,endpoint,{protocol='IP_TO_IP',cashAccountId=cash.id,credentialReference=CREDENTIAL}={})=>bank.registerBankConnector(admin,
  {profileId,name,cashAccountId,protocol,localBic:BANK,peerBic:PEER,endpoint,credentialReference},randomUUID());
 await connector('EXAMPLE_TLS_PEER','EXAMPLE-GW01','tls://localhost:'+tlsServer.address().port);
 await connector('EXAMPLE_API_PEER','EXAMPLE-API','https://localhost:'+httpsServer.address().port+'/pacs008',{protocol:'BANK_API'});
 await connector('EXAMPLE_ISO_PEER','EXAMPLE-ISO','tls://localhost:'+closedPort,{protocol:'SWIFT_ISO20022'});
 await connector('EXAMPLE_USD_PEER','EXAMPLE-USD','tls://localhost:'+tlsServer.address().port,{cashAccountId:dollars.id});
 await connector('EXAMPLE_NO_CERT','EXAMPLE-GW04','tls://localhost:'+tlsServer.address().port,{credentialReference:'AVIS_CONNECTOR_EXAMPLE_MISSING'});
 nostro={id:cash.id,ledger:(await pool.query('SELECT ledger_account_id FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1',[cash.id])).rows[0].ledger_account_id};
 const fin=new FinTerminal(pool);account=(await fin.accounts(admin)).bookingAccounts.find(item=>item.accountId===opened.id);
 // A million euros arrived on the NOSTRO for AVISPay PLC's account, as an incoming transfer books them.
 await new SovereignCore(pool).post(pool,admin,'fin-wire-fixture','FIN_INCOMING_BOOKED','FIXTURE',
  [{accountId:nostro.ledger,direction:'DEBIT',amount:'1000000.00'},{accountId:account.accountId,direction:'CREDIT',amount:'1000000.00'}]);
 access=new FinAccess(pool);
 peers=new FinPeers(pool,{terminal:fin,access,credentials:reference=>connectorCredentials(reference,env)});
});
after(async()=>{
 await new Promise(resolve=>tlsServer?.close(resolve));if(httpsServer){httpsServer.closeAllConnections();await new Promise(resolve=>httpsServer.close(resolve));}
 if(dir)await rm(dir,{recursive:true,force:true});if(db)await db.close();else await pool?.end();
});

test('the peer servers offered are every connector the bank registered - IP-to-IP, Bank API and ISO 20022 - with their NOSTRO\'s currency',async()=>{
 assert.deepEqual((await peers.list(admin)).map(peer=>[peer.profileId,peer.protocol,peer.currency]),[['EXAMPLE_API_PEER','BANK_API','EUR'],['EXAMPLE_TLS_PEER','IP_TO_IP','EUR'],
  ['EXAMPLE_NO_CERT','IP_TO_IP','EUR'],['EXAMPLE_ISO_PEER','SWIFT_ISO20022','EUR'],['EXAMPLE_USD_PEER','IP_TO_IP','USD']]);
});

test('Execute & Dispatch: the pacs.008 reaches the peer, settled on the NOSTRO; ACSC debits the paying account and the NOSTRO, and the pacs.002 shows in the stream',async()=>{
 received.length=0;reply=xml=>status(xml,'ACSC');
 const start=await money(),order=wire(),result=await peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',order);
 // The peer received one credit transfer over mutual TLS 1.3, passing both official schemas as the peer checks them.
 assert.equal(received.length,1);const [{xml,authorized,protocol}]=received;assert.deepEqual([authorized,protocol],[true,'TLSv1.3']);
 assert.deepEqual(await validateFinMessage(xml),{valid:true,errors:[]});
 const {form}=readFinMessage(xml,ServerDOMParser);
 assert.deepEqual([form.senderBic,form.receiverBic,form.uetr,form.amount,form.currency,form.settlement,form.settlementAccount,form.debtorName,form.debtorIban,form.debtorAgentBic,
  form.creditorName,form.creditorIban,form.creditorAgentBic,form.unstructuredRemittance],
  [BANK,PEER,order.uetr,'250000.00','EUR','INDA','NOSTRO-EXAMPLE-1',account.institution,account.iban,account.bic,'Example Creditor SARL',BENEFICIARY,PEER,'INTERBANK-IP-DISPATCH']);
 // Settled: the money left the paying account and the NOSTRO; nothing stays reserved.
 assert.deepEqual(moved(start,await money()),{account:'-250000.00',nostro:'-250000.00',held:'0.00',suspense:'0.00'});
 assert.deepEqual(result.wire,{uetr:order.uetr,status:'SETTLED',peerStatus:'ACSC',reason:null,amount:'250000.00',currency:'EUR',creditorName:'Example Creditor SARL',
  creditorIban:BENEFICIARY,fourEyes:false,checkers:[]});
 assert.equal((await kept(order.uetr)).suspense_account_id,(await pool.query("SELECT account_id FROM avis_core_v2.ledger_accounts WHERE sub_account_code='FIN:WIRES'")).rows[0].account_id);
 assert.deepEqual(await journals(order.uetr),[{event_type:'FIN_OUTGOING_RESERVED',actor_id:admin.id,reverses:false},{event_type:'FIN_OUTGOING_SETTLED',actor_id:admin.id,reverses:false}]);
 // What was sent and the peer's answer, as the stream writes them, on Screen A too.
 const [out,answer]=result.messages;
 assert.deepEqual([out.direction,out.type,out.businessMessageId,out.status,out.parameters,out.text,out.answered],
  ['OUT','pacs.008.001.08',form.businessMessageId,'DELIVERED',[order.uetr],'250000.00 EUR -> '+BENEFICIARY+' · NOSTRO & Core Synced',true]);
 assert.deepEqual([answer.direction,answer.answerTo,answer.type,answer.businessMessageId,answer.status,answer.event,answer.parameters],
  ['IN',out.messageId,'pacs.002.001.10','PEERSTS0001','ACK','ACSC',[order.uetr]]);
 assert.match(streamLine(out),new RegExp('^>>> \\[[^\\]]+ UTC\\] IP pacs\\.008 SENT \\(Seq #\\d{6}\\) · 250000\\.00 EUR -> '+BENEFICIARY+' · NOSTRO & Core Synced$'));
 assert.match(streamLine(answer),/^<<< \[[^\]]+ UTC\] PEER pacs\.002 ACSC$/);
 assert.deepEqual((await peers.messages(admin,'EXAMPLE_TLS_PEER')).messages.slice(-2),result.messages);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM avis_core_v2.operation_audit WHERE operation='FIN_OUTGOING_DISPATCHED' AND resource_id=$1",[order.uetr])).rows[0].n,1);
 // The same Execute again is the same wire: refused, nothing sent or booked again.
 const again=await money();
 await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',order),refused('FIN_UETR_DUPLICATE',409));
 assert.equal(received.length,1);assert.deepEqual(moved(again,await money()),{account:'0.00',nostro:'0.00',held:'0.00',suspense:'0.00'});
});

test('the beneficiary\'s account is any account number: an IBAN whose check digits do not match, or a bank\'s own number, goes as written (Othr)',async()=>{
 // The bank owner: "Sender - Receiver IBAN is only an option most banks have not IBAN numbers. Accept all account numbers".
 const wrongDigits=BENEFICIARY.slice(0,2)+(BENEFICIARY.slice(2,4)==='00'?'01':'00')+BENEFICIARY.slice(4);
 for(const number of [wrongDigits,'0012-345678-90']){
  received.length=0;reply=xml=>status(xml,'ACSC');
  const result=await peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire({amount:'10.00',creditorIban:' '+number+' '}));
  assert.deepEqual([result.wire.status,result.wire.creditorIban],['SETTLED',number]);
  const [{xml}]=received;assert.ok(xml.replace(/\n\s*/g,'').includes('<CdtrAcct><Id><Othr><Id>'+number+'</Id></Othr></Id></CdtrAcct>'),xml);
  assert.deepEqual(await validateFinMessage(xml),{valid:true,errors:[]});
 }
});

test('a transfer the peer refuses - its pacs.002 RJCT with the reason, or its reject of the message - goes back to the paying account; the NOSTRO keeps its money',async()=>{
 const rejected=xml=>buildReject({localBic:PEER,peerBic:BANK,businessMessageId:'PEERREJ0001',at:new Date(),reference:readFinMessage(xml,ServerDOMParser).form.businessMessageId,
  reason:'SCHEMA',description:'The message does not pass its official schema.'});
 for(const [answerWith,reason,line] of [[xml=>status(xml,'RJCT',{reason:'AC01',text:'Incorrect account number'}),'AC01',/^<<< \[[^\]]+ UTC\] PEER pacs\.002 RJCT AC01 · Incorrect account number$/],
  [rejected,'SCHEMA',/^<<< \[[^\]]+ UTC\] PEER_NAK: admi\.002\.001\.01 SCHEMA · The message does not pass its official schema\. \(ref FT\w+\)$/]]){
  reply=answerWith;const start=await money(),order=wire({amount:'1000.00'}),result=await peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',order);
  assert.deepEqual([result.wire.status,result.wire.reason],['RETURNED',reason]);
  assert.deepEqual(moved(start,await money()),{account:'0.00',nostro:'0.00',held:'0.00',suspense:'0.00'});
  assert.deepEqual((await journals(order.uetr)).map(row=>[row.event_type,row.reverses]),[['FIN_OUTGOING_RESERVED',false],['FIN_OUTGOING_RETURNED',true]]);
  assert.equal(result.messages[0].text,'1000.00 EUR -> '+BENEFICIARY+' · returned to the account');assert.match(streamLine(result.messages[1]),line);
 }
});

test('a peer server not reached gives the money back at once; one that took the transfer without settling it holds the money in the wires\' suspense account',async()=>{
 // Not reached: nothing left the bank.
 let start=await money(),order=wire({amount:'1000.00'}),result=await peers.dispatch(admin,owner,'EXAMPLE_ISO_PEER',order);
 assert.equal(result.wire.status,'RETURNED');assert.deepEqual(moved(start,await money()),{account:'0.00',nostro:'0.00',held:'0.00',suspense:'0.00'});
 assert.deepEqual(result.messages.map(message=>[message.status,message.error]),[['FAILED','ECONNREFUSED']]);
 assert.match(streamLine(result.messages[0]),/^>>> \[[^\]]+ UTC\] IP pacs\.008 NOT DELIVERED \(Seq #\d{6}\) · connection refused \(ECONNREFUSED\) · 1000\.00 EUR -> \S+ · returned to the account$/);
 // Taken, then: no answer, technically accepted only (ACTC), or an answer about another transfer - held, its NOSTRO cash reserved.
 for(const [answerWith,peerStatus] of [[()=>null,null],[xml=>status(xml,'ACTC'),'ACTC'],[xml=>status(xml,'ACSC',{uetr:newUetr()}),null]]){
  reply=answerWith;start=await money();order=wire({amount:'1000.00'});result=await peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',order);
  assert.deepEqual([result.wire.status,result.wire.peerStatus],['HELD',peerStatus]);
  assert.deepEqual(moved(start,await money()),{account:'-1000.00',nostro:'0.00',held:'1000.00',suspense:'1000.00'});
  assert.equal(result.messages[0].text,'1000.00 EUR -> '+BENEFICIARY+' · held in suspense');
 }
});

test('a wire whose finishing failed after it left is finished at the next Execute & Dispatch from what came back - held when nothing was kept - and never sent again (review finding)',async()=>{
 received.length=0;reply=xml=>status(xml,'ACSC');
 // The bank's database fails once while a wire is finished, after the peer settled it.
 let fail=true;
 class Failing extends FinTerminal{async finishWire(...args){if(fail){fail=false;throw new Error('DATABASE_GONE');}return super.finishWire(...args);}}
 const failing=new FinPeers(pool,{terminal:new Failing(pool),access,credentials:reference=>connectorCredentials(reference,env)});
 const age=async uetr=>{const row=await kept(uetr);
  await pool.query("UPDATE avis_core_v2.fin_terminal_wires SET updated_at=now()-interval '2 minutes' WHERE uetr=$1",[uetr]);
  await pool.query("UPDATE avis_core_v2.fin_terminal_peer_messages SET updated_at=now()-interval '2 minutes' WHERE message_id=$1",[row.message_id]);};
 const start=await money(),first=wire({amount:'100.00'});
 await assert.rejects(failing.dispatch(admin,owner,'EXAMPLE_TLS_PEER',first),/DATABASE_GONE/);
 let row=await kept(first.uetr);
 assert.deepEqual([row.status,received.length,row.delivery_error],['SENDING',1,null]);assert.match(row.answer,/<TxSts>ACSC<\/TxSts>/);
 assert.deepEqual(moved(start,await money()),{account:'-100.00',nostro:'0.00',held:'100.00',suspense:'100.00'});
 // A minute on, the next Execute finishes it from the answer kept - settled - before its own wire goes.
 await age(first.uetr);
 const second=await failing.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire({amount:'10.00'}));
 row=await kept(first.uetr);assert.deepEqual([second.wire.status,row.status,row.peer_status,received.length],['SETTLED','SETTLED','ACSC',2]);
 assert.deepEqual(moved(start,await money()),{account:'-110.00',nostro:'-110.00',held:'0.00',suspense:'0.00'});
 assert.deepEqual((await journals(first.uetr)).map(entry=>[entry.event_type,entry.actor_id]),[['FIN_OUTGOING_RESERVED',admin.id],['FIN_OUTGOING_SETTLED',admin.id]]);
 const stream=(await peers.messages(admin,'EXAMPLE_TLS_PEER')).messages,out=stream.find(message=>message.messageId===row.message_id);
 assert.deepEqual([out.status,out.text,stream.find(message=>message.answerTo===out.messageId)?.event],['DELIVERED','100.00 EUR -> '+BENEFICIARY+' · NOSTRO & Core Synced','ACSC']);
 // Nothing kept of what came back (the bank stopped as it left): held, its money in suspense, shown without result.
 fail=true;const third=wire({amount:'20.00'});
 await assert.rejects(failing.dispatch(admin,owner,'EXAMPLE_TLS_PEER',third),/DATABASE_GONE/);
 await pool.query('UPDATE avis_core_v2.fin_terminal_wires SET answer=NULL,delivery_error=NULL,delivered_at=NULL WHERE uetr=$1',[third.uetr]);await age(third.uetr);
 const before=await money();await failing.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire({amount:'10.00'}));
 row=await kept(third.uetr);assert.deepEqual([row.status,row.settle_journal_id],['HELD',null]);
 assert.deepEqual(moved(before,await money()),{account:'-10.00',nostro:'-10.00',held:'0.00',suspense:'0.00'});
 const held=(await peers.messages(admin,'EXAMPLE_TLS_PEER')).messages.find(message=>message.messageId===row.message_id);
 assert.match(streamLine(held),/^>>> \[[^\]]+ UTC\] IP pacs\.008 NO RESULT \(Seq #\d{6}\) · 20\.00 EUR -> \S+ · held in suspense$/);
 // Neither goes twice.
 for(const order of [first,third])await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',order),refused('FIN_UETR_DUPLICATE',409));
 assert.equal(received.length,4);
});

test('over a Bank API connector the transfer goes signed over HTTPS; ACCC settles it, a refusal before it was taken (HTTP 4xx) returns it',async()=>{
 received.length=0;reply=xml=>status(xml,'ACCC');
 let start=await money(),order=wire({amount:'1234.56',creditorIban:BENEFICIARY.toLowerCase().replace(/(.{4})/g,'$1 ').trim()});
 let result=await peers.dispatch(admin,owner,'EXAMPLE_API_PEER',order);
 assert.deepEqual(received.map(item=>[item.peer,item.authorized,item.signed]),[['HTTPS',true,true]]);
 assert.deepEqual([result.wire.status,result.wire.peerStatus,result.wire.creditorIban],['SETTLED','ACCC',BENEFICIARY]);
 assert.deepEqual(moved(start,await money()),{account:'-1234.56',nostro:'-1234.56',held:'0.00',suspense:'0.00'});
 reply=()=>401;start=await money();order=wire({amount:'10.00'});result=await peers.dispatch(admin,owner,'EXAMPLE_API_PEER',order);
 assert.deepEqual([result.wire.status,result.messages[0].error],['RETURNED','BANK_HTTP_401']);assert.deepEqual(moved(start,await money()),{account:'0.00',nostro:'0.00',held:'0.00',suspense:'0.00'});
});

test('a status report naming the message within the transfer\'s own status, or only the message\'s status, is read as well (pacs.002.001.10)',async()=>{
 // The original message named in the transfer's own block, the report's group block left out: ACSC settles.
 const within=xml=>{const message=readFinMessage(xml,ServerDOMParser).form.businessMessageId;
  return status(xml,'ACSC').replace(/<OrgnlGrpInfAndSts>[\s\S]*?<\/OrgnlGrpInfAndSts>\s*/,'')
   .replace('<TxInfAndSts>','<TxInfAndSts><OrgnlGrpInf><OrgnlMsgId>'+message+'</OrgnlMsgId><OrgnlMsgNmId>pacs.008.001.08</OrgnlMsgNmId></OrgnlGrpInf>');};
 // Only the message's status, refused with its reason: the money goes back.
 const whole=xml=>status(xml,'ACSC').replace(/<TxInfAndSts>[\s\S]*?<\/TxInfAndSts>\s*/,'')
  .replace('</OrgnlMsgNmId>','</OrgnlMsgNmId><GrpSts>RJCT</GrpSts><StsRsnInf><Rsn><Cd>AM04</Cd></Rsn><AddtlInf>Insufficient funds at the peer</AddtlInf></StsRsnInf>');
 for(const [answerWith,expected,change] of [[within,['SETTLED','ACSC',null],{account:'-10.00',nostro:'-10.00'}],[whole,['RETURNED','RJCT','AM04'],{account:'0.00',nostro:'0.00'}]]){
  reply=answerWith;const start=await money(),result=await peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire({amount:'10.00'}));
  assert.deepEqual([result.wire.status,result.messages[1].event,result.wire.reason],expected);
  assert.deepEqual(moved(start,await money()),{...change,held:'0.00',suspense:'0.00'});
 }
});

test('nothing is sent or booked without the money, with a wrong field, to a peer without a EUR NOSTRO, while the listening port is open, or for anyone but a FinTerminal administrator',async()=>{
 received.length=0;reply=xml=>status(xml,'ACSC');
 const start=await money(),wires=await count('fin_terminal_wires'),messages=await count('fin_terminal_peer_messages');
 for(const [changes,code,field] of [[{amount:'1000000000.00'},'INSUFFICIENT_FUNDS','amount'],[{amount:'0.00'},'FIN_WIRE_AMOUNT','amount'],[{amount:'1.234'},'FIN_WIRE_AMOUNT','amount'],
  [{amount:'-5'},'FIN_WIRE_AMOUNT','amount'],[{amount:'1e5'},'FIN_WIRE_AMOUNT','amount'],[{amount:5},'FIN_WIRE_AMOUNT','amount'],[{creditorName:'  '},'FIN_WIRE_BENEFICIARY','creditorName'],
  [{creditorName:'Example\nCreditor'},'FIN_WIRE_BENEFICIARY','creditorName'],[{creditorName:'x'.repeat(141)},'FIN_WIRE_BENEFICIARY','creditorName'],
  [{creditorIban:''},'FIN_WIRE_ACCOUNT','creditorIban'],[{creditorIban:'x'.repeat(35)},'FIN_WIRE_ACCOUNT','creditorIban'],[{creditorIban:'0012\n345'},'FIN_WIRE_ACCOUNT','creditorIban'],
  [{uetr:'not-a-uetr'},'INVALID_FIELD','uetr'],
  [{bookingAccountId:nostro.ledger},'FIN_BOOKING_ACCOUNT','bookingAccountId'],[{bookingAccountId:'x'},'FIN_BOOKING_ACCOUNT','bookingAccountId']])
  await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire(changes)),error=>error.code===code&&error.field===field,code+' '+JSON.stringify(changes));
 await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_USD_PEER',wire()),refused('FIN_WIRE_NOSTRO',409));
 await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_NO_CERT',wire()),refused('CONNECTOR_CONFIGURATION',503));
 await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_UNKNOWN',wire()),refused('CONNECTOR_NOT_FOUND',404));
 await assert.rejects(peers.dispatch(guest,owner,'EXAMPLE_TLS_PEER',wire()),refused('FORBIDDEN',403));
 await assert.rejects(peers.dispatch(admin,{...owner,finTerminal:false},'EXAMPLE_TLS_PEER',wire()),refused('FIN_TERMINAL_ACCESS',403));
 // The NOSTRO's own free cash: what is reserved for other wires is not paid out twice.
 const free=Number((await ledger(nostro.ledger)).available)-Number((await ledger(nostro.ledger)).locked)-100;
 const reserve=amount=>pool.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=locked_balance+$2::numeric WHERE account_id=$1',[nostro.ledger,amount.toFixed(2)]);
 await reserve(free);
 try{await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire({amount:'200.00'})),refused('INSUFFICIENT_CLEARING_FUNDS',409));}finally{await reserve(-free);}
 // The listening port open: nothing goes out ("not both working at the same time").
 await pool.query(`INSERT INTO avis_core_v2.fin_terminal_listener(listener_id,open_until,changed_by) VALUES(1,now()+interval '15 minutes','fin-wire-test')
  ON CONFLICT(listener_id) DO UPDATE SET open_until=EXCLUDED.open_until`);
 try{await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire()),refused('FIN_LISTENING',409));}
 finally{await pool.query('UPDATE avis_core_v2.fin_terminal_listener SET open_until=NULL');}
 assert.deepEqual(moved(start,await money()),{account:'0.00',nostro:'0.00',held:'0.00',suspense:'0.00'});
 assert.deepEqual([await count('fin_terminal_wires'),await count('fin_terminal_peer_messages'),received.length],[wires,messages,0]);
});

test('4-Eyes on: Execute & Dispatch takes PIN 1 and PIN 2; a wrong one counts towards its lock; the holders are kept with the wire, never the PINs',async()=>{
 received.length=0;reply=xml=>status(xml,'ACSC');
 await access.setPin(admin,owner,{slot:1,pin:'135790'});await access.setPin(admin,officer,{slot:2,pin:'246802'});
 await access.fourEyes(admin,owner,{on:true});
 const wires=await count('fin_terminal_wires');
 // Without the PINs, or with a wrong one: refused, nothing sent; the wrong one counted.
 await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire()),error=>error.code==='FIN_PIN'&&error.field==='pin1');
 await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire({pin1:'135790',pin2:'111111'})),error=>error.code==='FIN_CHECK_PIN_WRONG'&&error.field==='pin2');
 assert.deepEqual(await attempts(),[[1,0],[2,1]]);assert.deepEqual([await count('fin_terminal_wires'),received.length],[wires,0]);
 // Both right: sent, with the holders' names; the count starts again.
 const order=wire({pin1:'135790',pin2:'246802'}),result=await peers.dispatch(admin,officer,'EXAMPLE_TLS_PEER',order);
 assert.deepEqual([result.wire.status,result.wire.fourEyes,result.wire.checkers],['SETTLED',true,['Example Owner','Example Officer']]);
 const row=await kept(order.uetr);assert.deepEqual([row.dispatched_by_name,row.four_eyes,row.checkers],['Example Officer',true,['Example Owner','Example Officer']]);
 assert.deepEqual(await attempts(),[[1,0],[2,0]]);
 const stored=JSON.stringify([row,(await pool.query('SELECT * FROM avis_core_v2.operation_audit')).rows,(await pool.query('SELECT * FROM avis_core_v2.fin_terminal_peer_messages')).rows]);
 assert.doesNotMatch(stored,/135790|246802/);
 // Five wrong entries lock the PIN for 15 minutes, even against the right one.
 for(let wrong=1;wrong<5;wrong++)await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire({pin1:'000000',pin2:'246802'})),refused('FIN_CHECK_PIN_WRONG',422));
 await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire({pin1:'000000',pin2:'246802'})),refused('FIN_PIN_LOCKED',423));
 await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire({pin1:'135790',pin2:'246802'})),refused('FIN_PIN_LOCKED',423));
 // Switched on after the PINs were looked at: they are asked first.
 const late=new FinPeers(pool,{access:{check:async()=>({fourEyes:false,checkers:[]})},credentials:reference=>connectorCredentials(reference,env)});
 await assert.rejects(late.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire()),refused('FIN_PIN'));
 // A PIN not made: refused.
 await pool.query('DELETE FROM avis_core_v2.fin_terminal_pins WHERE slot=2');
 await assert.rejects(peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire({pin1:'135790',pin2:'246802'})),refused('FIN_PIN_MISSING',409));
 assert.equal(received.length,1);
 // Off again: no PIN is asked.
 await pool.query('UPDATE avis_core_v2.fin_terminal_pins SET failed_attempts=0,locked_until=NULL');await access.fourEyes(admin,owner,{on:false});
 const plain=await peers.dispatch(admin,owner,'EXAMPLE_TLS_PEER',wire({amount:'10.00'}));assert.deepEqual([plain.wire.status,plain.wire.fourEyes],['SETTLED',false]);
});

async function signIn(who){
 const server=createBankServer({pool,authenticate:async()=>admin,finTerminalAccess:async()=>who(),secureCookies:false,transferOptions:{transport:{credentials:reference=>connectorCredentials(reference,env)}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
 assert.equal(login.status,200);return {server,base,cookie:login.headers.get('set-cookie').split(';')[0],csrf:(await login.json()).csrf};
}

test('the terminal dispatches through the bank\'s own address, with its sign-in and CSRF token, for an administrator with FinTerminal access only',async()=>{
 let person=owner;const {server,base,cookie,csrf}=await signIn(()=>person);
 try{
  received.length=0;reply=xml=>status(xml,'ACSC');
  const post=(body,headers={'x-csrf-token':csrf})=>fetch(base+'/api/fin-terminal/peers/EXAMPLE_TLS_PEER/transfers',{method:'POST',
   headers:{origin:base,cookie,'content-type':'application/json',...headers},body:JSON.stringify(body)}).then(async response=>({status:response.status,body:await response.json()}));
  assert.equal((await post(wire({amount:'10.00'}),{})).status,403);assert.equal(received.length,0);
  const sent=await post(wire({amount:'10.00'}));
  assert.equal(sent.status,200);assert.equal(sent.body.wire.status,'SETTLED');assert.deepEqual(sent.body.messages.map(message=>message.type),['pacs.008.001.08','pacs.002.001.10']);
  const wrong=await post(wire({amount:'1.234'}));
  assert.deepEqual([wrong.status,wrong.body.code,wrong.body.field,wrong.body.message],[422,'FIN_WIRE_AMOUNT','amount','Enter the amount in EUR, above zero, with at most two decimals.']);
  person={...owner,finTerminal:false};
  const outside=await post(wire({amount:'10.00'}));assert.deepEqual([outside.status,outside.body.code],[403,'FIN_TERMINAL_ACCESS']);
  assert.equal(received.length,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

const until=async(ready,what,wait=8000)=>{const end=Date.now()+wait;while(!ready()){if(Date.now()>end)assert.fail('waited for '+what);await new Promise(resolve=>setTimeout(resolve,20));}};

test('Screen B\'s Cash Wire: the peer servers of every type and the EUR accounts; Execute & Dispatch shows the pacs.008 and the pacs.002; the PINs only while 4-Eyes is on',async()=>{
 const {server,base,cookie}=await signIn(()=>owner),html=await readFile(new URL('../public/fin-terminal.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:base+'/fin-terminal'}),doc=dom.window.document,asked=[];
 try{
  const fetcher=async(path,init={})=>{asked.push({path,method:init.method||'GET',body:init.body});return fetch(base+path,{...init,headers:{...init.headers,cookie,origin:base}});};
  await startFinTerminal({root:doc,fetcher,windowApi:{BroadcastChannel:class{close(){}},addEventListener(){},close(){}}});
  const $=selector=>doc.querySelector(selector),options=selector=>[...doc.querySelectorAll(selector+' option')].map(option=>option.textContent);
  const lines=()=>[...doc.querySelectorAll('[data-fin-wire-stream] li')].map(item=>item.textContent),button=$('[data-fin-wire-send]');
  const fill=values=>{for(const [selector,value] of Object.entries(values)){const input=$(selector);input.value=value;}};
  await until(()=>options('[data-fin-wire-peer]').length===5&&!button.disabled,'the Cash Wire panel');
  // The three types, each with its peer servers (the bank owner: "Peer service selector is missing IP to IP, API, ISO20022").
  assert.deepEqual([...doc.querySelectorAll('[data-fin-wire-peer] optgroup')].map(group=>[group.label,[...group.children].map(option=>option.textContent)]),
   [['IP-to-IP',['EXAMPLE-GW01 · SMPLFRPPXXX · EUR','EXAMPLE-GW04 · SMPLFRPPXXX · EUR','EXAMPLE-USD · SMPLFRPPXXX · USD']],['API',['EXAMPLE-API · SMPLFRPPXXX · EUR']],
    ['ISO 20022',['EXAMPLE-ISO · SMPLFRPPXXX · EUR']]]);
  assert.equal($('[data-fin-wire-iban]').closest('label').querySelector('span').textContent,'Beneficiary Name & Account');
  assert.deepEqual(options('[data-fin-wire-account]'),[[account.label,account.iban,'EUR'].join(' · ')]);
  assert.equal($('[data-fin-wire-pins]').hidden,true);assert.equal($('[data-fin-wire-stream]').hidden,true);
  // Sent: the pacs.008 and the peer's pacs.002 under the button, and the order's fields cleared.
  received.length=0;reply=xml=>status(xml,'ACSC');
  $('[data-fin-wire-peer]').value='EXAMPLE_TLS_PEER';fill({'[data-fin-wire-amount]':'500.00','[data-fin-wire-name]':'Example Creditor SARL','[data-fin-wire-iban]':BENEFICIARY});
  button.click();await until(()=>lines().length===2&&!button.disabled,'the answer');
  assert.match(lines()[0],new RegExp('^>>> \\[[^\\]]+ UTC\\] IP pacs\\.008 SENT \\(Seq #\\d{6}\\) · 500\\.00 EUR -> '+BENEFICIARY+' · NOSTRO & Core Synced$'));
  assert.match(lines()[1],/^<<< \[[^\]]+ UTC\] PEER pacs\.002 ACSC$/);
  assert.deepEqual(['[data-fin-wire-amount]','[data-fin-wire-name]','[data-fin-wire-iban]'].map(selector=>$(selector).value),['','','']);
  const first=JSON.parse(asked.findLast(request=>request.path.endsWith('/transfers')).body);
  assert.deepEqual(Object.keys(first).sort(),['amount','bookingAccountId','creditorIban','creditorName','uetr']);assert.equal(received.length,1);
  // A refusal shows with its field marked; what was written stays.
  fill({'[data-fin-wire-amount]':'1.234','[data-fin-wire-name]':'Example Creditor SARL','[data-fin-wire-iban]':BENEFICIARY});button.click();
  await until(()=>!$('[data-fin-wire-problem]').hidden&&!button.disabled,'the refusal');
  assert.equal($('[data-fin-wire-problem]').textContent,'Enter the amount in EUR, above zero, with at most two decimals.');
  assert.equal($('[data-fin-wire-amount]').getAttribute('aria-invalid'),'true');assert.equal($('[data-fin-wire-iban]').value,BENEFICIARY);
  // 4-Eyes switched on meanwhile: the PINs are asked, shown with their holders, sent with the order and cleared at once.
  await pool.query('DELETE FROM avis_core_v2.fin_terminal_pins');
  await access.setPin(admin,owner,{slot:1,pin:'135790'});await access.setPin(admin,officer,{slot:2,pin:'246802'});await access.fourEyes(admin,owner,{on:true});
  fill({'[data-fin-wire-amount]':'600.00'});button.click();
  await until(()=>!$('[data-fin-wire-pins]').hidden&&!button.disabled,'the PIN fields');
  assert.equal($('[data-fin-wire-problem]').textContent,'Enter a PIN of 6 to 12 digits.');
  assert.deepEqual([...doc.querySelectorAll('[data-fin-wire-pin]')].map(input=>input.placeholder),['PIN 1 · Example Owner','PIN 2 · Example Officer']);
  fill({'[data-fin-wire-pin="1"]':'135790','[data-fin-wire-pin="2"]':'246802'});button.click();
  assert.deepEqual([...doc.querySelectorAll('[data-fin-wire-pin]')].map(input=>input.value),['','']);
  await until(()=>lines().length===2&&lines()[0].includes('600.00 EUR')&&!button.disabled,'the second answer');
  assert.equal($('[data-fin-wire-problem]').hidden,true);assert.equal(received.length,2);
  const second=JSON.parse(asked.findLast(request=>request.path.endsWith('/transfers')).body);assert.deepEqual([second.pin1,second.pin2],['135790','246802']);
  assert.notEqual(second.uetr,first.uetr);
 }finally{await access.fourEyes(admin,owner,{on:false});dom.window.close();await new Promise(resolve=>server.close(resolve));}
});
