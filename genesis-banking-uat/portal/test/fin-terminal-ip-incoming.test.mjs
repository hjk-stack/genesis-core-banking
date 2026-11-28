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
// transfer over IP-to-IP (TLS 1.3 on the listening port) is booked at once - on the bank's NOSTRO the transfer names as its
// settlement account, in any currency, and on AVISPay PLC's account its creditor's IBAN names - and answered pacs.002 ACSC; the same
// transfer again is answered as before and booked once. One the bank cannot book is answered RJCT with the reason, and nothing is
// booked; one naming no NOSTRO of the bank waits for the operator's Register incoming.
const admin={id:'fin-ip-admin',username:'fin-ip',admin:true};
const BANK='EXMPDEFFXXX',PEER='SMPLFRPPXXX';
let pool,db,dir,certs,peers,listener,fin,suspense,nostro,account;
const certificate=async(name,san)=>{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN='+name,...(san?['-addext','subjectAltName='+san]:[]),
  '-addext','extendedKeyUsage=serverAuth,clientAuth','-keyout',join(dir,name+'.key'),'-out',join(dir,name+'.pem')],{stdio:'ignore'});
 return {cert:await readFile(join(dir,name+'.pem'),'utf8'),key:await readFile(join(dir,name+'.key'),'utf8')};
};
// The peer's connection to the port, from its IP address: each message in a frame, its answer awaited.
function exchange(messages,localAddress='127.0.0.1'){
 return new Promise(resolve=>{
  const answers=[];let data=Buffer.alloc(0),next=0;
  const socket=tls.connect({host:'127.0.0.1',port:listener.boundPort(),servername:'localhost',ca:certs.bank.cert,cert:certs.peer.cert,key:certs.peer.key,localAddress});
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
const robotic=on=>pool.query('UPDATE avis_core_v2.fin_terminal_mode SET robotic_stp=$1 WHERE mode_id=1',[on]);
// A batch: the transfer twice in one message.
const batch=xml=>{const tx=/<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>/.exec(xml)[0];return xml.replace(tx,tx+tx).replace('<NbOfTxs>1</NbOfTxs>','<NbOfTxs>2</NbOfTxs>');};
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
 // ROBOTIC STP active: a transfer is booked at once ("Automated Robotic Mode").
 await robotic(true);
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
 // The same UETR with another field changed is another payment, not this one again (review finding).
 const [altered]=await exchange([buildFinMessage({...form,endToEndId:'ALTERED-E2E-0001'})]);
 assert.deepEqual([value(altered,'TxSts'),value(altered,'Cd')],['RJCT','DUPL']);assert.deepEqual(await balances(),['1250000.00','1250000.00']);
 // Delivered twice at once, a new transfer is booked once and both deliveries are answered ACSC (review finding).
 const twice=transfer(),[[first],[second]]=await Promise.all([exchange([buildFinMessage(twice)]),exchange([buildFinMessage(twice)])]);
 assert.deepEqual([value(first,'TxSts'),value(second,'TxSts')],['ACSC','ACSC']);assert.deepEqual(await balances(),['2500000.00','2500000.00']);
 await delivered();
 // Its status names a transfer by the transfer's own message id, which the header need not repeat.
 const own=transfer(),xml=buildFinMessage(own).replace('<MsgId>'+own.businessMessageId+'</MsgId>','<MsgId>PEERGROUP0001</MsgId>');
 assert.notEqual(xml,buildFinMessage(own));
 const [status]=await exchange([xml]);
 assert.deepEqual([value(status,'TxSts'),value(status,'OrgnlMsgId'),value(status,'OrgnlUETR')],['ACSC','PEERGROUP0001',own.uetr]);
 await delivered();
});

test('a transfer the bank cannot book is answered RJCT with the reason, and nothing is booked',async()=>{
 // Booked with any account number of the debtor's (the bank owner: "Accept all account numbers").
 const before=await balances(),booked=transfer({debtorIban:'0012-345678-90'});
 // A UETR another draft of the terminal has already.
 const taken=transfer();await fin.save(admin,{form:{...taken,senderBic:BANK,receiverBic:PEER}});
 for(const [form,reason] of [[transfer({creditorIban:exampleIban('FR','00000000000000000000999')}),'AC03'],[transfer({creditorAgentBic:PEER}),'AC03'],
  [transfer({currency:'USD'}),'AC03'],[taken,'DUPL'],
  [transfer({amount:'0.00'}),'NARR']]){
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
 // A batch is refused as a message: one credit transfer per message (review finding).
 const [several]=await exchange([batch(buildFinMessage(transfer()))]);
 assert.deepEqual([value(several,'MsgDefIdr'),value(several,'RjctgPtyRsn')],['admi.002.001.01','BATCH']);
 // A transfer to another bank is not the bank's: refused as a message (admi.002), not as a payment.
 const [other]=await exchange([buildFinMessage(transfer({receiverBic:'OTHRDEFFXXX'}))]);
 assert.deepEqual([value(other,'MsgDefIdr'),value(other,'RjctgPtyRsn')],['admi.002.001.01','HEADER']);
 await delivered();
});

test('under MANUAL INTERVENTION a peer\'s transfer is held for the operator and answered ACTC; nothing is booked until the operator registers it',async()=>{
 await robotic(false);
 try{
  const form=transfer(),message=buildFinMessage(form),before=await balances();
  const [answer]=await exchange([message]);
  assert.deepEqual([value(answer,'TxSts'),value(answer,'OrgnlUETR'),value(answer,'Cd')],['ACTC',form.uetr,undefined]);
  assert.deepEqual(await balances(),before);
  // Kept as an incoming draft on AVISPay PLC's account and the NOSTRO it names, not registered.
  const held=(await fin.drafts(admin)).find(item=>item.uetr===form.uetr),opened=await fin.draft(admin,held.draftId);
  assert.deepEqual([held.direction,held.registered,held.updatedBy],['INCOMING',false,'listener:EXAMPLE_PEER']);
  assert.deepEqual(opened.selection,{bookingAccountId:suspense.id,nostroAccountId:nostro.id,tokenWalletId:null});
  await delivered();const [kept,sent]=(await rows()).slice(-2);
  assert.deepEqual([kept.event_text,sent.event_code,sent.event_text],['RECEIVED 1250000.00 EUR -> HELD FOR MANUAL INTERVENTION','ACTC','HELD FOR MANUAL INTERVENTION']);
  assert.match(streamLine((await peers.messages(admin,'EXAMPLE_PEER')).messages.at(-1)),/^>>> .* ANSWER pacs\.002 ACTC SENT \(Seq #\d{6}\) · HELD FOR MANUAL INTERVENTION$/);
  // Again: held still.
  assert.equal(value((await exchange([message]))[0],'TxSts'),'ACTC');assert.deepEqual(await balances(),before);
  // The operator registers it: booked now; delivered again, it is answered as booked.
  assert.equal((await fin.register(admin,{form:opened.form,selection:opened.selection,draftId:opened.draftId,revision:opened.revision})).registered,true);
  assert.deepEqual(await balances(),before.map(figure=>(Number(figure)+1250000).toFixed(2)));
  assert.equal(value((await exchange([message]))[0],'TxSts'),'ACSC');
  await delivered();
 }finally{await robotic(true);}
});

// The bank owner: "Remove from the Peer register the NOSTRO account as the nostro account is the job of the incoming transfer
// registration", and "attention could be received many other currencies".
test('a transfer in another currency is booked on the bank\'s NOSTRO it names in that currency and on AVISPay PLC\'s account in it',async()=>{
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 const cash=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example Peer Bank',bic:PEER,accountNumber:'NOSTRO-EXAMPLE-USD',currency:'USD'},randomUUID());
 const opened=(await bank.openAccount(admin,{accountType:'SUSPENSE',fullName:'AVISPay PLC',currencies:['USD']},randomUUID())).managedAccounts[0];
 const dollars=(await fin.accounts(admin)).bookingAccounts.find(item=>item.accountId===opened.id);
 const ledger=(await pool.query('SELECT ledger_account_id FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1',[cash.id])).rows[0].ledger_account_id;
 const form=transfer({currency:'USD',amount:'5000.00',settlementAccount:'NOSTRO-EXAMPLE-USD',receiverBic:dollars.bic,creditorIban:dollars.iban,creditorAgentBic:dollars.bic});
 const before=await balances(),[answer]=await exchange([buildFinMessage(form)]);
 assert.deepEqual([value(answer,'TxSts'),value(answer,'OrgnlUETR')],['ACSC',form.uetr]);
 assert.deepEqual([await balance(ledger),await balance(opened.id),await balances()],['5000.00','5000.00',before]);
 const draft=(await pool.query('SELECT booking_account_id,nostro_cash_account_id FROM avis_core_v2.fin_terminal_drafts WHERE uetr=$1',[form.uetr])).rows[0];
 assert.deepEqual(draft,{booking_account_id:opened.id,nostro_cash_account_id:cash.id});
 await delivered();assert.equal((await rows()).at(-1).event_text,'CORE_BANKING_&_NOSTRO:+5000.00 USD');
});

test('a transfer naming no NOSTRO of the bank - another settlement account, or not settled INGA - is held for Register incoming and answered ACTC; the operator registers it on the NOSTRO chosen there',async()=>{
 const before=await balances(),forms=[transfer({settlementAccount:'NOSTRO-OTHER-9'}),transfer({settlement:'INDA'})];
 for(const form of forms){
  const [answer]=await exchange([buildFinMessage(form)]);
  assert.deepEqual([value(answer,'TxSts'),value(answer,'OrgnlUETR'),value(answer,'Cd')],['ACTC',form.uetr,undefined]);
  await delivered();assert.equal((await rows()).at(-1).event_text,'HELD FOR MANUAL INTERVENTION');
 }
 assert.deepEqual(await balances(),before);
 // Kept on AVISPay PLC's account without a NOSTRO; delivered again, held still.
 const held=(await fin.drafts(admin)).find(item=>item.uetr===forms[0].uetr),opened=await fin.draft(admin,held.draftId);
 assert.deepEqual([held.direction,held.registered,opened.selection],['INCOMING',false,{bookingAccountId:suspense.id,nostroAccountId:null,tokenWalletId:null}]);
 assert.equal(value((await exchange([buildFinMessage(forms[0])]))[0],'TxSts'),'ACTC');await delivered();
 // Register incoming: the NOSTRO chosen writes its account into the message (fin-composer.mjs), and the transfer is booked on it.
 const registered=await fin.register(admin,{form:{...opened.form,settlementAccount:'NOSTRO-EXAMPLE-1'},selection:{...opened.selection,nostroAccountId:nostro.id},
  draftId:opened.draftId,revision:opened.revision});
 assert.equal(registered.registered,true);
 assert.deepEqual(await balances(),before.map(figure=>(Number(figure)+1250000).toFixed(2)));
});

test('a peer server registered without a NOSTRO, as the FinTerminal\'s register keeps it: its IP address is whitelisted, and its transfer is booked on the NOSTRO it names',async()=>{
 await pool.query(`INSERT INTO avis_core_v2.platform_connectors(connector_code,display_name,is_enabled,endpoint_url,credential_reference)
  VALUES('EXAMPLE_BIC_PEER','EXAMPLE-BIC',true,'tls://localhost:1','AVIS_CONNECTOR_PEER')`);
 await pool.query("INSERT INTO avis_core_v2.bank_connector_profiles(profile_id,cash_account_id,protocol,local_bic,peer_bic,operations) VALUES('EXAMPLE_BIC_PEER',NULL,'IP_TO_IP',$1,$2,'{}')",[BANK,PEER]);
 await peers.addAddress(admin,'EXAMPLE_BIC_PEER',{address:'127.0.0.2'});await listener.refresh();
 const form=transfer({amount:'700.00'}),before=await balances(),[answer]=await exchange([buildFinMessage(form)],'127.0.0.2');
 assert.deepEqual([value(answer,'TxSts'),value(answer,'OrgnlUETR')],['ACSC',form.uetr]);
 assert.deepEqual(await balances(),before.map(figure=>(Number(figure)+700).toFixed(2)));
 const draft=(await pool.query('SELECT created_by,nostro_cash_account_id FROM avis_core_v2.fin_terminal_drafts WHERE uetr=$1',[form.uetr])).rows[0];
 assert.deepEqual(draft,{created_by:'listener:EXAMPLE_BIC_PEER',nostro_cash_account_id:nostro.id});
 const answered=()=>until(async()=>(await pool.query("SELECT count(*)::int AS n FROM avis_core_v2.fin_terminal_peer_messages WHERE status='SENDING'")).rows[0].n===0,'the answers delivered');
 await answered();
 // A NOSTRO the register keeps without its bank's BIC is named only by the peer registered with it before: from another peer the
 // transfer is held for Register incoming.
 await pool.query('UPDATE avis_core_v2.external_cash_accounts SET bic_code=NULL WHERE cash_account_id=$1',[nostro.id]);
 try{
  const at=await balances(),other=transfer({amount:'800.00'}),own=transfer({amount:'900.00'});
  assert.equal(value((await exchange([buildFinMessage(other)],'127.0.0.2'))[0],'TxSts'),'ACTC');
  assert.equal(value((await exchange([buildFinMessage(own)]))[0],'TxSts'),'ACSC');
  assert.deepEqual(await balances(),at.map(figure=>(Number(figure)+900).toFixed(2)));
  await answered();
 }finally{await pool.query('UPDATE avis_core_v2.external_cash_accounts SET bic_code=$2 WHERE cash_account_id=$1',[nostro.id,PEER]);}
});
