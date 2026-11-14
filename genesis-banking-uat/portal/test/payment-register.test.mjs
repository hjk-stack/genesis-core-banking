import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {PaymentRegister} from '../src/payment-register.mjs';
import {buildPacs002,readIso20022} from '../src/iso20022.mjs';
import {createBankServer} from '../server.mjs';
let db,pool,core,sender,receiver,connected,cash,server,base;
const actor={id:'register-tests',admin:true},key=()=>randomUUID();
const address={street:'1 Receiver Street',city:'London',postalCode:'SW1A 1AA',country:'GB'};
const input=extra=>({from:sender.abiqIban,currency:'EUR',amount:'12.50',receiverAccount:'GB82WEST12345698765432',receiverBic:'WESTGB2LXXX',receiverName:'Receiver One',address,reference:'Invoice 42',...extra});
const bal=async a=>(await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[a.accountId])).rows[0].available_balance;
const confirm=(r,k=key(),who=actor)=>core.confirmPayment(who,{requestId:r.id,messageHash:r.messageHash},k);
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const u=new URL(process.env.TEST_DATABASE_URL);assert.equal(u.pathname,'/avispay_ci');pool=new pg.Pool({connectionString:u.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};}
 const c=await pool.connect();try{await migrate(c);}finally{c.release();}
 core=new PaymentRegister(pool,{directory:{env:{}}});
 const open=async name=>(await core.openCustomer(actor,{fullName:name,accountType:'PERSONAL',currencies:['EUR']},key())).accounts[0];
 sender=await open('Register Sender');receiver=await open('Internal Receiver');connected=await open('Connected Sender');
 const owner=(await pool.query('SELECT user_id FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[receiver.accountId])).rows[0];
 await core.saveCustomerProfile(actor,{userId:owner.user_id,address},key());
 cash=await core.registerCashAccount(actor,{institutionType:'CORRESPONDENT_BANK',institutionName:'Register Fixture',bic:'TESTGB2LXXX',accountNumber:'REGISTER-CASH',currency:'EUR'},key());
 await core.registerBankConnector(actor,{profileId:'REGISTER_FIXTURE',name:'Register peer',cashAccountId:cash.id,protocol:'IP_TO_IP',localBic:'TESTDEFFXXX',peerBic:'TESTGB2LXXX',endpoint:'https://bank.invalid/iso20022',credentialReference:'AVIS_CONNECTOR_REGISTER'},key());
 await core.linkBankAccount(actor,{abiqIban:connected.abiqIban,currency:'EUR',bankRoute:{accountType:'IBAN',accountNumber:'DE89370400440532013000',country:'DE',bic:'TESTDEFFXXX',connectorCode:'REGISTER_FIXTURE',providerAccountId:'register-1',providerReference:'register-confirmation'}},key());
 await core.operation(actor,'FIXTURE_FUNDING',{},key(),async(db,k)=>{
  const treasury=await core.system(db,'TREASURY','EUR','REGISTER_FIXTURE','ASSET');
  return {journalId:await core.post(db,actor,k,'FIXTURE_FUNDING','Fixture funds',[
   {accountId:treasury,direction:'DEBIT',amount:'1000'},{accountId:sender.accountId,direction:'CREDIT',amount:'1000'},
   {accountId:cash.accountId,direction:'DEBIT',amount:'1000'},{accountId:connected.accountId,direction:'CREDIT',amount:'1000'}])};
 });
});
after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(db)await db.close();else await pool.end();});
test('review validates the receiver and builds a FIN message without reserving or sending funds',async()=>{
 const before=await bal(sender),count=(await pool.query('SELECT count(*) FROM avis_core_v2.ledger_journals')).rows[0].count;
 const r=await core.preparePayment(actor,input(),key());assert.equal(r.mode,'MANUAL');assert.equal(r.format,'FIN_MT103');
 assert.match(r.message,/:32A:\d{6}EUR12,5/);assert.match(r.message,/:59:\/GB82WEST12345698765432\r\nReceiver One/);assert.match(r.message,/:70:Invoice 42/);
 assert.equal(await bal(sender),before);assert.equal((await pool.query('SELECT count(*) FROM avis_core_v2.ledger_journals')).rows[0].count,count);
 assert.equal((await core.list(actor,'paymentregister')).length,0);
 await assert.rejects(core.preparePayment(actor,input({receiverAccount:'GB00WEST12345698765432'}),key()),/INVALID_RECEIVER_ACCOUNT/);
 await assert.rejects(core.preparePayment(actor,input({receiverBic:'wrong'}),key()),/INVALID_RECEIVER_BIC/);
 await assert.rejects(core.preparePayment(actor,input({amount:'1.001'}),key()),/INVALID_AMOUNT/);
 await assert.rejects(core.preparePayment(actor,input({address:{...address,city:''}}),key()),/INVALID_FIELD/);
});
test('internal numbers autofill BIC, registered name and address and execute only at final confirmation',async()=>{
 const details=await core.checkReceiver(actor,{receiverAccount:receiver.abiqIban.slice(-12),currency:'EUR'});
 assert.equal(details.account,receiver.abiqIban);assert.equal(details.bic,'AVIPTN64XXX');assert.equal(details.receiverName,'Internal Receiver');assert.deepEqual(details.address,address);
 const before=await bal(receiver),r=await core.preparePayment(actor,input({receiverAccount:receiver.abiqIban.slice(-12),receiverBic:'',receiverName:'Wrong supplied name',address:{...address,street:'Wrong supplied address'}}),key());
 assert.equal(r.mode,'INTERNAL');assert.equal(r.instruction.receiverName,'Internal Receiver');assert.deepEqual(r.instruction.address,address);assert.equal(await bal(receiver),before);
 const result=await confirm(r);assert.equal(result.current_status,'COMPLETED');assert.equal(await bal(receiver),'12.500000000000000000');
 await confirm(r);assert.equal(await bal(receiver),'12.500000000000000000');
 assert.equal((await core.list(actor,'transferrequests')).length,0);
 await assert.rejects(core.preparePayment(actor,input({receiverAccount:receiver.abiqIban,receiverBic:'WESTGB2LXXX'}),key()),/RECEIVER_BIC_MISMATCH/);
 await assert.rejects(core.preparePayment(actor,input({receiverAccount:sender.abiqIban,receiverBic:''}),key()),/SAME_ACCOUNT/);
});
test('confirmation binds the reviewed message and actor; manual queue reserves and cancels exactly once',async()=>{
 const before=await bal(sender),r=await core.preparePayment(actor,input(),key());
 await assert.rejects(core.confirmPayment(actor,{requestId:r.id,messageHash:'0'.repeat(64)},key()),/PAYMENT_REVIEW_CHANGED/);
 await assert.rejects(confirm(r,key(),{id:'another-operator',admin:true}),/PAYMENT_REQUEST_NOT_FOUND/);
 assert.equal(await bal(sender),before);
 const first=await confirm(r),held=await bal(sender);assert.equal(first.status,'OUTGOING');assert.notEqual(held,before);
 await confirm(r);assert.equal(await bal(sender),held);
 assert.equal((await core.list(actor,'transferrequests')).find(p=>p.request_id===r.id).status,'OUTGOING');
 assert.equal((await core.paymentRequest(actor,r.id)).message_content,r.message);
 const saved=await core.checkReceiver(actor,input());assert.equal(saved.receiverName,'Receiver One');assert.deepEqual(saved.address,address);
 assert.equal((await core.checkReceiver({id:'another-operator',admin:true},input())).receiverName,'');
 await core.cancelPayment(actor,{requestId:r.id},key());await core.cancelPayment(actor,{requestId:r.id},key());assert.equal(await bal(sender),before);
 await assert.rejects(confirm(r),/PAYMENT_REQUEST_CLOSED/);
});
test('insufficient funds cannot create a submitted request or a partial reservation',async()=>{
 const before=await bal(sender),r=await core.preparePayment(actor,input({amount:'9999'}),key());
 await assert.rejects(confirm(r),/INSUFFICIENT_FUNDS/);assert.equal(await bal(sender),before);assert.equal((await core.paymentRequest(actor,r.id)).status,'REVIEW');
});
test('stored review content cannot be replaced after the operator reviewed it',async()=>{
 const r=await core.preparePayment(actor,input(),key());
 await assert.rejects(pool.query("UPDATE avis_core_v2.payment_requests SET beneficiary_account='1234' WHERE request_id=$1",[r.id]),/PAYMENT_REVIEW_IMMUTABLE/);
 assert.equal((await core.paymentRequest(actor,r.id)).message_content,r.message);
});
test('non-FIN characters retain exact beneficiary content in a schema-valid ISO message',async()=>{
 const r=await core.preparePayment(actor,input({receiverName:'Müller & Sons',address:{...address,street:'Hauptstraße 1'},reference:'Invoice <42> & fee'}),key());
 assert.equal(r.format,'ISO20022');assert.match(r.message,/Müller &amp; Sons/);assert.match(r.message,/Invoice &lt;42&gt; &amp; fee/);
 const parsed=await readIso20022(r.message);assert.equal(parsed.creditorName,'Müller & Sons');assert.equal(parsed.creditorBic,'WESTGB2LXXX');assert.equal(parsed.creditorAddress.StrtNm,'Hauptstraße 1');
 const local=await core.preparePayment(actor,input({receiverAccount:'1234567890',receiverName:'Müller'}),key());assert.equal((await readIso20022(local.message)).creditorIban,'1234567890');
});
test('configured route sends the exact reviewed ISO message once and follows authenticated settlement',async()=>{
 let sends=0,review;core.transport={credentials:()=>({}),send:async(p,xml)=>{
  sends++;assert.equal(xml,review.message);const parsed=await readIso20022(xml);assert.equal(parsed.creditorBic,'WESTGB2LXXX');
  return buildPacs002({messageId:key().replaceAll('-',''),uetr:parsed.uetr,status:'ACCC',senderBic:p.peer_bic,receiverBic:p.local_bic,bankReference:'REGISTER-SETTLED'});
 }};
 review=await core.preparePayment(actor,input({from:connected.abiqIban}),key());assert.equal(review.mode,'CONNECTED');assert.equal(review.format,'ISO20022');assert.equal(sends,0);
 const r=await confirm(review);assert.equal(r.current_status,'COMPLETED');assert.equal(r.delivery,'ACKNOWLEDGED');assert.equal(sends,1);
 await confirm(review);assert.equal(sends,1);core.transport={};
});
test('route changes require a new review and timeout never resends the instruction',async()=>{
 core.transport={credentials:()=>({}),send:async()=>{throw new Error('BANK_TIMEOUT');}};
 const r=await core.preparePayment(actor,input({from:connected.abiqIban}),key()),before=await bal(connected);
 await pool.query("UPDATE avis_core_v2.platform_connectors SET endpoint_url='https://bank.invalid/changed' WHERE connector_code='REGISTER_FIXTURE'");
 await assert.rejects(confirm(r),/PAYMENT_REVIEW_CHANGED/);assert.equal(await bal(connected),before);
 await pool.query("UPDATE avis_core_v2.platform_connectors SET endpoint_url='https://bank.invalid/iso20022' WHERE connector_code='REGISTER_FIXTURE'");
 let sends=0;core.transport.send=async()=>{sends++;throw new Error('BANK_TIMEOUT');};
 assert.equal((await confirm(r)).delivery,'UNCERTAIN');const held=await bal(connected);await confirm(r);assert.equal(sends,1);assert.equal(await bal(connected),held);core.transport={};
});
test('bank directory checks are authenticated and never invent receiver identity',async()=>{
 let seen;core.directory={env:{AVIS_SWIFTREF_TOKEN:'fixture-token'},fetcher:async(url,options)=>{seen={url,options};return {ok:true,status:200};}};
 const r=await core.checkReceiver({id:'directory-test',admin:true},input());assert.equal(r.validationSource,'SWIFTREF');assert.equal(r.receiverName,'');assert.equal(r.address,null);
 assert.equal(JSON.parse(seen.options.body).bic,'WESTGB2LXXX');assert.equal(seen.options.headers.authorization,'Bearer fixture-token');
 core.directory.fetcher=async()=>({ok:false,status:404});await assert.rejects(core.checkReceiver(actor,input()),/RECEIVER_BANK_VALIDATION/);core.directory={env:{}};
});
test('a route change after reservation cannot send the reviewed message to a different endpoint',async()=>{
 let sends=0,calls=0;const original=core.profile;
 core.transport={credentials:()=>({}),send:async()=>{sends++;throw new Error('UNEXPECTED_SEND');}};
 const r=await core.preparePayment(actor,input({from:connected.abiqIban}),key());
 core.profile=async function(...args){const p=await original.apply(this,args);if(++calls===4)return {...p,endpoint_url:'https://changed.invalid/payments'};return p;};
 try{const result=await confirm(r);assert.equal(result.delivery,'UNCERTAIN');assert.equal(sends,0);}
 finally{core.profile=original;core.transport={};}
});
test('PostgreSQL concurrent confirmations with different keys post only once',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const r=await core.preparePayment(actor,input({amount:'1'}),key());await Promise.all([confirm(r),confirm(r)]);
 const journals=(await pool.query("SELECT count(*)::int AS n FROM avis_core_v2.ledger_journals WHERE journal_id=(SELECT reservation_journal_id FROM avis_core_v2.payment_requests WHERE request_id=$1)",[r.id])).rows[0].n;assert.equal(journals,1);
 await core.cancelPayment(actor,{requestId:r.id},key());
});
test('authenticated HTTP exposes the wizard, receiver lookup, register and field-level validation',async()=>{
 server=createBankServer({pool,authenticate:async()=>({...actor,username:'fixture'}),secureCookies:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'fixture',password:'fixture'})});
 const session=await login.json(),headers={origin:base,'content-type':'application/json',cookie:login.headers.get('set-cookie').split(';')[0],'x-csrf-token':session.csrf,'idempotency-key':key()};
 const lookup=await fetch(base+'/api/payments/check-receiver',{method:'POST',headers,body:JSON.stringify({receiverAccount:receiver.abiqIban,currency:'EUR'})});assert.equal(lookup.status,200);assert.equal((await lookup.json()).receiverName,'Internal Receiver');
 const invalid=await fetch(base+'/api/payments/check-receiver',{method:'POST',headers,body:JSON.stringify(input({receiverAccount:'invalid'}))});assert.equal(invalid.status,422);assert.equal((await invalid.json()).field,'receiverAccount');
 assert.equal((await fetch(base+'/api/views/transferrequests',{headers})).status,200);assert.equal((await fetch(base+'/api/views/transferrequests')).status,401);
 const module=await fetch(base+'/payment-wizard.mjs');assert.equal(module.status,200);assert.match(module.headers.get('content-type'),/javascript/);
 assert.equal((await pool.query(`SELECT journal_id FROM avis_core_v2.ledger_entries GROUP BY journal_id HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END)<>0`)).rows.length,0);
});
