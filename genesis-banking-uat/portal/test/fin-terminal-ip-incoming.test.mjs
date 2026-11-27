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
import {FinTerminal} from '../src/fin-terminal.mjs';
import {FinPeers} from '../src/fin-peer.mjs';
import {FinListener} from '../src/fin-listener.mjs';
import {ServerDOMParser} from '../src/fin-xml.mjs';
import {connectorCredentials,frame} from '../src/payment-transport.mjs';
import {buildFinMessage,readFinMessage,normalizeForm,newUetr,newMessageId} from '../public/fin-message.mjs';
import {streamLine} from '../public/fin-peer.mjs';
import {exampleForm,exampleIban} from './helpers/fin-example.mjs';

// The FinTerminal specification v3 (FinTerminal_Unified_NOSTRO_Crypto_System_v3), receive_ip2ip_pacs008: a peer bank's credit
// transfer over IP-to-IP (TLS 1.3 on the listening port) is booked at once - on the bank's NOSTRO at that peer and on AVISPay
// PLC's account its creditor's IBAN names - and answered pacs.002 ACSC; the same transfer again is answered as before and booked
// once. One the bank cannot book is answered RJCT with the reason, and nothing is booked.
const admin={id:'fin-ip-admin',username:'fin-ip',admin:true};
const BANK='EXMPDEFFXXX',PEER='SMPLFRPPXXX';
let pool,db,dir,certs,peers,listener,fin,suspense,nostro,account;
const certificate=async(name,san)=>{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN='+name,...(san?['-addext','subjectAltName='+san]:[]),
  '-addext','extendedKeyUsage=serverAuth,clientAuth','-keyout',join(dir,name+'.key'),'-out',join(dir,name+'.pem')],{stdio:'ignore'});
 return {cert:await readFile(join(dir,name+'.pem'),'utf8'),key:await readFile(join(dir,name+'.key'),'utf8')};
};
// The peer's connection to the port: each message in a frame, its answer awaited.
function exchange(messages){
 return new Promise(resolve=>{
  const answers=[];let data=Buffer.alloc(0),next=0;
  const socket=tls.connect({host:'127.0.0.1',port:listener.boundPort(),servername:'localhost',ca:certs.bank.cert,cert:certs.peer.cert,key:certs.peer.key,localAddress:'127.0.0.1'});
  const send=()=>{if(next<messages.length)socket.write(frame(messages[next++]));else socket.end();};
  socket.on('secureConnect',send);
  socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);while(data.length>=2&&data.length>=2+data.readUInt16BE()){const size=data.readUInt16BE();answers.push(data.subarray(2,2+size).toString());data=data.subarray(2+size);send();}});
  socket.on('error',()=>{});socket.on('close',()=>resolve(answers));socket.setTimeout(5000,()=>socket.destroy());
 });
}
const value=(xml,name)=>new RegExp('<'+name+'>([^<]*)</'+name+'>').exec(xml)?.[1];
const from=xml=>/<Fr><FIId><FinInstnId><BICFI>([^<]*)</.exec(xml.replace(/\s+/g,''))?.[1],to=xml=>/<To><FIId><FinInstnId><BICFI>([^<]*)</.exec(xml.replace(/\s+/g,''))?.[1];
const rows=async()=>(await pool.query("SELECT * FROM avis_core_v2.fin_terminal_peer_messages WHERE profile_id='EXAMPLE_PEER' ORDER BY sequence")).rows;
const until=async(ready,what)=>{const end=Date.now()+5000;while(!(await ready())){if(Date.now()>end)assert.fail('waited for '+what);await new Promise(resolve=>setTimeout(resolve,25));}};
const delivered=()=>until(async()=>(await rows()).every(row=>row.status!=='SENDING'),'the answers delivered');
const balance=async accountId=>(await pool.query('SELECT available_balance::numeric(20,2)::text AS b FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[accountId])).rows[0].b;
const balances=async()=>[await balance(nostro.ledger),await balance(suspense.id)];
// The peer's transfer to AVISPay PLC's account: sent by the peer, settled on the bank's NOSTRO there (INGA).
const transfer=(overrides={})=>normalizeForm({...exampleForm(),uetr:newUetr(),businessMessageId:newMessageId(),senderBic:PEER,receiverBic:account.bic,
 settlement:'INGA',settlementAccount:'NOSTRO-EXAMPLE-1',debtorAgentBic:PEER,creditorName:'AVISPay PLC',creditorIban:account.iban,creditorAgentBic:account.bic,...overrides});

before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 dir=await mkdtemp(join(tmpdir(),'avis-fin-ip-incoming-'));
 certs={bank:await certificate('localhost','DNS:localhost,IP:127.0.0.1'),peer:await certificate('peer','DNS:localhost,IP:127.0.0.1')};
 const env={AVIS_CONNECTOR_LISTENER:JSON.stringify({cert:certs.bank.cert,key:certs.bank.key}),
  AVIS_CONNECTOR_PEER:JSON.stringify({cert:certs.bank.cert,key:certs.bank.key,ca:certs.peer.cert,hmacSecret:'isolated-fin-ip-incoming-secret-32b'})};
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 suspense=(await bank.openAccount(admin,{accountType:'SUSPENSE',fullName:'AVISPay PLC',currencies:['EUR']},randomUUID())).managedAccounts[0];
 const cash=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example Peer Bank',bic:PEER,accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 nostro={id:cash.id,ledger:(await pool.query('SELECT ledger_account_id FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1',[cash.id])).rows[0].ledger_account_id};
 await bank.registerBankConnector(admin,{profileId:'EXAMPLE_PEER',name:'EXAMPLE-GW',cashAccountId:cash.id,protocol:'IP_TO_IP',localBic:BANK,peerBic:PEER,
  endpoint:'tls://localhost:1',credentialReference:'AVIS_CONNECTOR_PEER'},randomUUID());
 fin=new FinTerminal(pool);account=(await fin.accounts(admin)).bookingAccounts.find(item=>item.accountId===suspense.id);
 peers=new FinPeers(pool,{credentials:reference=>connectorCredentials(reference,env)});
 listener=new FinListener(pool,peers,{env,port:0,host:'127.0.0.1'});
 await peers.addAddress(admin,'EXAMPLE_PEER',{address:'127.0.0.1'});await listener.open(admin,{minutes:15});
});
after(async()=>{await listener?.close(admin).catch(()=>{});await listener?.stop();if(dir)await rm(dir,{recursive:true,force:true});if(db)await db.close();else await pool?.end();});

test('the server reads a transfer\'s XML into the form as the composer does',()=>{
 const form=transfer({debtorName:'Example & Sons <Debtor>',unstructuredRemittance:'Invoice "EX-1" & more'});
 assert.deepEqual(readFinMessage(buildFinMessage(form),ServerDOMParser),{form});
});

test('a peer\'s credit transfer over IP is booked at once on the NOSTRO and AVISPay PLC\'s account, and answered pacs.002 ACSC; again, it is booked once',async()=>{
 const form=transfer(),message=buildFinMessage(form);
 assert.deepEqual(await balances(),['0.00','0.00']);
 const [answer]=await exchange([message]);
 // The transfer's status, from the bank as the peer named it (its ABIQ code) to the peer.
 assert.deepEqual([value(answer,'MsgDefIdr'),value(answer,'TxSts'),value(answer,'OrgnlUETR'),value(answer,'OrgnlMsgId'),value(answer,'OrgnlEndToEndId'),value(answer,'OrgnlMsgNmId'),from(answer),to(answer)],
  ['pacs.002.001.10','ACSC',form.uetr,form.businessMessageId,form.endToEndId,'pacs.008.001.08',account.bic,PEER]);
 assert.deepEqual(await balances(),['1250000.00','1250000.00']);
 // Kept as a registered incoming transfer, booked by the listener for this peer.
 const draft=(await pool.query(`SELECT d.direction,d.created_by,d.booking_account_id,d.nostro_cash_account_id,j.event_type,j.actor_id FROM avis_core_v2.fin_terminal_drafts d
  JOIN avis_core_v2.ledger_journals j ON j.journal_id=d.registered_journal_id WHERE d.uetr=$1`,[form.uetr])).rows[0];
 assert.deepEqual(draft,{direction:'INCOMING',created_by:'listener:EXAMPLE_PEER',booking_account_id:suspense.id,nostro_cash_account_id:nostro.id,
  event_type:'FIN_INCOMING_BOOKED',actor_id:'listener:EXAMPLE_PEER'});
 // The stream, as the specification writes it.
 await delivered();
 const [kept,sent]=(await rows()).slice(-2);
 assert.deepEqual([kept.direction,kept.status,kept.message_type,kept.business_message_id,kept.event_parameters,kept.event_text,kept.content],
  ['IN','RECEIVED','pacs.008.001.08',form.businessMessageId,[form.uetr],'RECEIVED 1250000.00 EUR -> CORE_BANKING_&_NOSTRO:+1250000.00 EUR',message]);
 assert.deepEqual([sent.direction,sent.status,sent.message_type,sent.event_code,sent.event_parameters,sent.event_text,sent.content],
  ['OUT','DELIVERED','pacs.002.001.10','ACSC',[form.uetr],'CORE_BANKING_&_NOSTRO:+1250000.00 EUR',answer]);
 const lines=(await peers.messages(admin,'EXAMPLE_PEER')).messages.slice(-2).map(streamLine);
 assert.match(lines[0],/^<<< \[[0-9: -]+ UTC\] PEER pacs\.008 \(Seq #\d{6}\) · RECEIVED 1250000\.00 EUR -> CORE_BANKING_&_NOSTRO:\+1250000\.00 EUR$/);
 assert.match(lines[1],/^>>> \[[0-9: -]+ UTC\] ANSWER pacs\.002 ACSC SENT \(Seq #\d{6}\) · CORE_BANKING_&_NOSTRO:\+1250000\.00 EUR$/);
 // The same transfer again: answered as before, booked once.
 const [again]=await exchange([message]);
 assert.deepEqual([value(again,'TxSts'),value(again,'OrgnlUETR')],['ACSC',form.uetr]);
 assert.deepEqual(await balances(),['1250000.00','1250000.00']);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM avis_core_v2.ledger_journals WHERE event_type='FIN_INCOMING_BOOKED'")).rows[0].n,1);
 // Its status names a transfer by the transfer's own message id, which the header need not repeat.
 const own=transfer(),xml=buildFinMessage(own).replace('<MsgId>'+own.businessMessageId+'</MsgId>','<MsgId>PEERGROUP0001</MsgId>');
 assert.notEqual(xml,buildFinMessage(own));
 const [status]=await exchange([xml]);
 assert.deepEqual([value(status,'TxSts'),value(status,'OrgnlMsgId'),value(status,'OrgnlUETR')],['ACSC','PEERGROUP0001',own.uetr]);
 await delivered();
});

test('a transfer the bank cannot book is answered RJCT with the reason, and nothing is booked',async()=>{
 const before=await balances(),booked=transfer();
 // A UETR another draft of the terminal has already.
 const taken=transfer();await fin.save(admin,{form:{...taken,senderBic:BANK,receiverBic:PEER}});
 for(const [form,reason] of [[transfer({creditorIban:exampleIban('FR','00000000000000000000999')}),'AC03'],[transfer({creditorAgentBic:PEER}),'AC03'],
  [transfer({settlementAccount:'NOSTRO-OTHER-9'}),'NARR'],[transfer({settlement:'INDA'}),'NARR'],[transfer({currency:'USD'}),'AC03'],[taken,'DUPL'],
  [transfer({debtorIban:'DE00000000000000000000'}),'NARR']]){
  const [answer]=await exchange([buildFinMessage(form)]);
  assert.deepEqual([value(answer,'TxSts'),value(answer,'Cd'),value(answer,'OrgnlUETR')],['RJCT',reason,form.uetr],reason+' '+form.uetr);
  assert.ok(value(answer,'AddtlInf').length>0);
  await delivered();const [kept,sent]=(await rows()).slice(-2);
  assert.deepEqual([kept.status,kept.event_text,sent.event_code,sent.event_parameters],['RECEIVED','RECEIVED '+form.amount+' '+form.currency+' -> RJCT '+reason,'RJCT',[form.uetr,reason]]);
  assert.match(streamLine((await peers.messages(admin,'EXAMPLE_PEER')).messages.at(-1)),new RegExp('^>>> .* ANSWER pacs\\.002 RJCT '+reason+' SENT '));
 }
 assert.deepEqual(await balances(),before);
 // Booked once, a UETR is not booked again for another amount.
 assert.deepEqual([value((await exchange([buildFinMessage(booked)]))[0],'TxSts'),value((await exchange([buildFinMessage({...booked,amount:'5.00'})]))[0],'Cd')],['ACSC','DUPL']);
 // A transfer to another bank is not the bank's: refused as a message (admi.002), not as a payment.
 const [other]=await exchange([buildFinMessage(transfer({receiverBic:'OTHRDEFFXXX'}))]);
 assert.deepEqual([value(other,'MsgDefIdr'),value(other,'RjctgPtyRsn')],['admi.002.001.01','HEADER']);
 await delivered();
});
