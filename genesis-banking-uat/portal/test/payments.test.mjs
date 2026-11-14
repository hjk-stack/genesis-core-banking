import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {PaymentServer} from '../src/payments.mjs';
import {buildPacs008,buildPacs002,readIso20022} from '../src/iso20022.mjs';
import {signRequest,authenticateMessage,dispatchPayment,recoverPaymentDeliveries,frame} from '../src/payment-transport.mjs';
let db,pool,core,user,cash,profile,account,seq=0;
const actor={id:'payment-tests',admin:true},key=()=>`payment-${++seq}`;
const bankIban='DE89370400440532013000',externalIban='GB82WEST12345698765432';
const message=(extra={})=>({messageId:'MSG-'+key(),uetr:randomUUID(),endToEndId:'INVOICE-1',amount:'12.50',currency:'EUR',senderBic:'TESTGB2LXXX',receiverBic:'TESTDEFFXXX',debtorName:'Sender',debtorIban:externalIban,creditorName:'Receiver',creditorIban:bankIban,reference:'Invoice',...extra});
const status=(t,s,extra={})=>buildPacs002(message({uetr:t.uetr,status:s,...extra}));
const balance=async id=>(await pool.query('SELECT available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[id])).rows[0];
const outbound=amount=>core.initiatePayment(actor,{from:account.abiqIban,profileId:profile.id,currency:'EUR',amount,creditorIban:externalIban,creditorName:'External receiver',reference:'Invoice-'+key()},key());
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else {db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};}
 const c=await pool.connect();try{await migrate(c);}finally{c.release();}core=new PaymentServer(pool);
 user=await core.openCustomer(actor,{fullName:'Payment Customer',accountType:'PERSONAL',currencies:['EUR']},key());account=user.accounts[0];
 cash=await core.registerCashAccount(actor,{institutionType:'CORRESPONDENT_BANK',institutionName:'Fixture Bank',bic:'TESTGB2LXXX',accountNumber:'EXTERNAL-REGISTER-1',currency:'EUR'},key());
 profile=await core.registerBankConnector(actor,{profileId:'PAYMENT_FIXTURE',name:'Fixture peer',cashAccountId:cash.id,protocol:'IP_TO_IP',localBic:'TESTDEFFXXX',peerBic:'TESTGB2LXXX',endpoint:'https://bank.invalid/iso20022',credentialReference:'AVIS_CONNECTOR_FIXTURE'},key());
 await core.linkBankAccount(actor,{abiqIban:account.abiqIban,currency:'EUR',bankRoute:{accountType:'IBAN',accountNumber:bankIban,country:'DE',bic:'TESTDEFFXXX',connectorCode:profile.id,providerAccountId:'fixture-1',providerReference:'fixture-confirmation'}},key());
});
after(async()=>{if(db)await db.close();else await pool.end();});
test('ISO 20022 messages validate against official XSD and reject altered or unsafe content',async()=>{
 const xml=await buildPacs008(message());assert.equal((await readIso20022(xml)).amount,'12.500000');
 for(const value of [xml.replace('<NbOfTxs>1','<NbOfTxs>2'),xml.replace('<IntrBkSttlmAmt','<WrongAmount'),xml.replace('</Document>','<!DOCTYPE x></Document>')])await assert.rejects(readIso20022(value));
 await assert.rejects(buildPacs008(message({amount:'1.0000001'})),/INVALID_AMOUNT/);
});
test('received payment does not credit customer until authenticated settlement; then ABIQ allocation is balanced once',async()=>{
 const p=message({amount:'100'}),xml=await buildPacs008(p),receipt=await core.receive(profile.id,xml);
 assert.equal(receipt.status,'ACTC');assert.equal((await balance(account.accountId)).available_balance,'0.000000000000000000');
 assert.deepEqual(await core.receive(profile.id,xml),receipt);
 await assert.rejects(core.receive(profile.id,await buildPacs008({...p,amount:'200'})),/IDEMPOTENCY_CONFLICT/);
 const settled=await status(p,'ACCC'),result=await core.receive(profile.id,settled);assert.equal(result.status,'ACCC');
 assert.equal((await balance(account.accountId)).available_balance,'100.000000000000000000');assert.equal((await balance(cash.accountId)).available_balance,'100.000000000000000000');
 await core.receive(profile.id,settled);await core.receive(profile.id,await status(p,'ACCC'));assert.equal((await balance(account.accountId)).available_balance,'100.000000000000000000');
 await assert.rejects(core.receive(profile.id,await status(p,'RJCT')),/TRANSFER_ALREADY_CLOSED/);
});
test('outbound reserves customer and clearing liquidity; ACSP acknowledgment never settles',async()=>{
 const t=await outbound('30');assert.equal((await balance(account.accountId)).available_balance,'70.000000000000000000');assert.equal((await balance(cash.accountId)).locked_balance,'30.000000000000000000');
 await core.receive(profile.id,await status(t,'ACSP'));assert.equal((await balance(cash.accountId)).available_balance,'100.000000000000000000');
 await core.receive(profile.id,await status(t,'ACCC'));assert.equal((await balance(cash.accountId)).available_balance,'70.000000000000000000');assert.equal((await balance(cash.accountId)).locked_balance,'0.000000000000000000');
 await assert.rejects(core.receive(profile.id,await status(t,'RJCT')),/TRANSFER_ALREADY_CLOSED/);
});
test('bank rejection restores exact funds; insufficient liquidity leaves no partial reservation',async()=>{
 const t=await outbound('20');await core.receive(profile.id,await status(t,'RJCT'));assert.equal((await balance(account.accountId)).available_balance,'70.000000000000000000');
 await assert.rejects(outbound('71'),/INSUFFICIENT_CLEARING_FUNDS/);assert.equal((await balance(cash.accountId)).locked_balance,'0.000000000000000000');
 await assert.rejects(core.receive(profile.id,await status(t,'ACCC',{senderBic:'OTHERB2LXXX'})),/MESSAGE_PARTNER_MISMATCH/);
});
test('statement reconciliation posts matching settlement and rejects duplicate or inconsistent evidence',async()=>{
 const t=await outbound('10'),input={profileId:profile.id,reference:'STATEMENT-1',currency:'EUR',openingBalance:'70',closingBalance:'60',entries:[{uetr:t.uetr,bankReference:'BANK-1',direction:'DEBIT',amount:'10'}]},k=key();
 const r=await core.reconcileStatement(actor,input,k);assert.equal(r.matched,1);assert.deepEqual(await core.reconcileStatement(actor,input,k),r);assert.equal((await balance(cash.accountId)).available_balance,'60.000000000000000000');
 await assert.rejects(core.reconcileStatement(actor,{...input,reference:'ST-2'},key()),/duplicate key/);
 await assert.rejects(core.reconcileStatement(actor,{...input,closingBalance:'59'},key()),/STATEMENT_TOTAL_MISMATCH/);
});
test('message HMAC binds body, path and freshness and persists nonce replay protection',async()=>{
 const secret='a-long-isolated-test-secret-of-32-bytes',path='/network/PAYMENT_FIXTURE/iso20022',body='message',headers=signRequest('POST',path,body,secret);
 await assert.rejects(authenticateMessage(pool,profile.id,'POST',path,body+'changed',headers,secret),/MESSAGE_AUTHENTICATION/);
 await authenticateMessage(pool,profile.id,'POST',path,body,headers,secret);
 await assert.rejects(authenticateMessage(pool,profile.id,'POST',path,body,headers,secret),/MESSAGE_REPLAY/);
 await assert.rejects(authenticateMessage(pool,profile.id,'POST',path,body,signRequest('POST',path,body,secret,String(Date.now()-300000)),secret),/MESSAGE_AUTHENTICATION/);
 assert.equal(frame('hello').readUInt16BE(),5);assert.throws(()=>frame(Buffer.alloc(65536)),/MESSAGE_LENGTH/);
});
test('transport timeout keeps reservation and cannot resubmit the same transfer',async()=>{
 const t=await outbound('5'),k=key();let sends=0;const options={credentials:()=>({}),send:async()=>{sends++;throw new Error('BANK_TIMEOUT');}};
 const r=await dispatchPayment(core,actor,{transferId:t.id},k,options);assert.equal(r.delivery,'UNCERTAIN');await dispatchPayment(core,actor,{transferId:t.id},k,options);assert.equal(sends,1);
 await assert.rejects(dispatchPayment(core,actor,{transferId:t.id},key(),options),/PAYMENT_ALREADY_DISPATCHED/);
 await core.receive(profile.id,await status(t,'ACCC'));assert.equal((await balance(cash.accountId)).locked_balance,'0.000000000000000000');
});
test('transport response must match payment UETR before changing balances',async()=>{
 const t=await outbound('5'),before=await balance(cash.accountId);
 const result=await dispatchPayment(core,actor,{transferId:t.id},key(),{credentials:()=>({}),send:()=>status({uetr:randomUUID()},'ACCC')});
 assert.equal(result.delivery,'UNCERTAIN');assert.deepEqual(await balance(cash.accountId),before);
 await core.receive(profile.id,await status(t,'RJCT'));
});
test('confirmed bank response completes delivery and settlement through one ledger transaction',async()=>{
 const t=await outbound('5');const r=await dispatchPayment(core,actor,{transferId:t.id},key(),{credentials:()=>({}),send:()=>status(t,'ACCC')});assert.equal(r.status,'ACCC');assert.equal(r.delivery,'ACKNOWLEDGED');
 const bad=await pool.query(`SELECT journal_id FROM avis_core_v2.ledger_entries GROUP BY journal_id HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END)<>0`);assert.equal(bad.rows.length,0);
});

test('restart recovery preserves reservations and never resends an expired delivery lease',async()=>{
 for(const started of [null,'DELIVERY_STARTED']) {
  const t=await outbound('2');
  await pool.query("UPDATE avis_core_v2.payment_outbox SET status='SENDING',attempts=1,lease_until=now()-interval '1 second',last_error_code=$2 WHERE transfer_id=$1",[t.id,started]);
  const customerBefore=await balance(account.accountId),cashBefore=await balance(cash.accountId);
  const recovered=await recoverPaymentDeliveries(core,actor);assert.equal(recovered.recovered,1);
  assert.deepEqual(await balance(account.accountId),customerBefore);assert.deepEqual(await balance(cash.accountId),cashBefore);
  const delivery=(await pool.query('SELECT status,attempts,last_error_code FROM avis_core_v2.payment_outbox WHERE transfer_id=$1',[t.id])).rows[0];
  assert.deepEqual(delivery,{status:'UNCERTAIN',attempts:1,last_error_code:'DELIVERY_LEASE_EXPIRED'});
  let sends=0;await assert.rejects(dispatchPayment(core,actor,{transferId:t.id},key(),{credentials:()=>({}),send:async()=>{sends++;}}),/PAYMENT_ALREADY_DISPATCHED/);assert.equal(sends,0);
  await core.receive(profile.id,await status(t,'RJCT'));
  assert.equal((await pool.query('SELECT status FROM avis_core_v2.payment_outbox WHERE transfer_id=$1',[t.id])).rows[0].status,'ACKNOWLEDGED');
 }
});
test('recovery leaves an active delivery lease intact',async()=>{
 const t=await outbound('2');await pool.query("UPDATE avis_core_v2.payment_outbox SET status='SENDING',attempts=1,lease_until=now()+interval '1 minute',last_error_code='DELIVERY_STARTED' WHERE transfer_id=$1",[t.id]);
 assert.equal((await recoverPaymentDeliveries(core,actor)).recovered,0);
 assert.equal((await pool.query('SELECT status FROM avis_core_v2.payment_outbox WHERE transfer_id=$1',[t.id])).rows[0].status,'SENDING');
 await core.receive(profile.id,await status(t,'RJCT'));
});
test('authenticated settlement racing a lost response cannot regress delivery or post twice',async()=>{
 const t=await outbound('2'),k=key();let sends=0;
 const options={credentials:()=>({}),send:async()=>{sends++;await core.receive(profile.id,await status(t,'ACCC'));throw new Error('ECONNRESET');}};
 const result=await dispatchPayment(core,actor,{transferId:t.id},k,options);assert.equal(result.delivery,'ACKNOWLEDGED');assert.equal(result.status,'ACCC');
 const settled=await balance(cash.accountId);assert.equal((await dispatchPayment(core,actor,{transferId:t.id},k,options)).delivery,'ACKNOWLEDGED');assert.equal(sends,1);assert.deepEqual(await balance(cash.accountId),settled);
 // Recover an earlier release's gap between committed bank settlement and outbox acknowledgment.
 await pool.query("UPDATE avis_core_v2.payment_outbox SET status='SENDING',lease_until=now()-interval '1 second' WHERE transfer_id=$1",[t.id]);
 assert.equal((await recoverPaymentDeliveries(core,actor)).recovered,1);assert.deepEqual(await balance(cash.accountId),settled);
 assert.equal((await pool.query('SELECT status FROM avis_core_v2.payment_outbox WHERE transfer_id=$1',[t.id])).rows[0].status,'ACKNOWLEDGED');
});
test('a connector failure after the claim becomes an auditable delivery outcome',async()=>{
 const t=await outbound('2'),original=core.profile;let calls=0,sends=0;
 core.profile=async function(...args){if(++calls===2)throw new Error('CONNECTOR_CONFIGURATION');return original.apply(this,args);};
 try {
  const result=await dispatchPayment(core,actor,{transferId:t.id},key(),{credentials:()=>({}),send:async()=>{sends++;}});assert.equal(result.delivery,'UNCERTAIN');assert.equal(sends,0);
 }finally{core.profile=original;}
 await core.receive(profile.id,await status(t,'RJCT'));
});
test('PostgreSQL concurrent recovery workers claim each expired delivery once',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const t=await outbound('2');await pool.query("UPDATE avis_core_v2.payment_outbox SET status='SENDING',attempts=1,lease_until=now()-interval '1 second' WHERE transfer_id=$1",[t.id]);
 const before=await balance(cash.accountId),results=await Promise.all([recoverPaymentDeliveries(core,actor),recoverPaymentDeliveries(core,actor)]);
 assert.equal(results.reduce((sum,r)=>sum+r.recovered,0),1);assert.deepEqual(await balance(cash.accountId),before);
 await core.receive(profile.id,await status(t,'RJCT'));
});
