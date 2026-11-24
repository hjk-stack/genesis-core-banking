import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {SovereignCore,money} from '../src/core.mjs';
import {PaymentServer} from '../src/payments.mjs';
import {CheckoutIpControl} from '../src/checkout-ip.mjs';

const admin={id:'settlement-admin',admin:true},checkout={id:'checkout-service',posService:true};
const handler={id:'authenticated-ip-handler',ipHandlerService:true};
const pdf=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const sha=value=>createHash('sha256').update(value).digest('hex');
let pool,db,ip,core,payments;
const rows=async(sql,args=[])=>(await pool.query(sql,args)).rows;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){
  assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
 }else{
  db=new PGlite();let connections=Promise.resolve();
  pool={query:(...args)=>db.query(...args),connect:async()=>{
   const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
   return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
  }};
 }
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 ip=new CheckoutIpControl(pool);core=new SovereignCore(pool);payments=new PaymentServer(pool);
});
after(async()=>{if(db)await db.close();else await pool.end()});

async function cashAccount(currency='EUR',accountNumber='NOSTRO-'+randomUUID()){
 return {...await payments.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Settlement Bank',
  bic:'CHASUS33XXX',accountNumber,currency},randomUUID()),accountNumber,currency};
}
async function fixture({owner='COMMON_POOL',currency='EUR',amount='150.123456789012345678',cash=null,optional=false}={}){
 cash=cash||await cashAccount(currency);
 const receiving=await core.system(pool,owner,currency,'RECEIVE:'+randomUUID(),'LIABILITY');
 const request={requestId:randomUUID(),checkoutKind:'MILESTONE',checkoutReference:'checkout-'+randomUUID(),title:'Incoming settlement',
  source:'industrial',amount,currency,bankName:'Origin Bank',ip:'192.0.2.10',authorized:'Bank operator',account:'SENDER-001',accountName:'Origin Customer'};
 await ip.register(checkout,request);
 await ip.setActive(admin,{requestId:request.requestId,active:true,receivingAccountId:receiving,...(optional?{}:{nostroCashAccountId:cash.id})});
 const context=await ip.context(handler,{requestId:request.requestId});
 const value={requestId:request.requestId,handlerTransferId:randomUUID(),revision:1,transactionReference:randomUUID(),handlerStatus:'SETTLED',
  bankName:'Origin Bank',bankServerSentAmount:amount,nostroIban:context.routing.nostroIban,receivingAbiqIban:context.routing.receivingAbiqIban,
  amountCleared:amount,beneficiaryName:'Selected local Common',beneficiaryAccount:'LOCAL-'+randomUUID(),franchiseAllocatedPercent:'0',
  operationCompleted:false,manualReport100Digits:null};
 const evidence={journalId:randomUUID(),bankTransactionId:'BANK-'+randomUUID(),statementId:'STATEMENT-'+randomUUID(),currency,amount,
  nostroAccount:cash.accountNumber,statementHash:sha('authenticated bank XML '+request.requestId),bookedDate:'2026-11-24',bookedAt:null};
 return {request,cash,receiving,context,value,evidence};
}
async function claim(f,routing=f.context.routing){
 return ip.claim(handler,{requestId:f.request.requestId,handlerTransferId:f.value.handlerTransferId,transactionReference:f.value.transactionReference,...routing});
}
const publish=(f,overrides={})=>ip.processing(handler,{...f.value,settlementEvidence:f.evidence,...overrides});
const complete=(f,overrides={})=>publish(f,{revision:2,operationCompleted:true,manualReport100Digits:'1234567890'.repeat(10),
 proof:{fileName:'payment-proof.pdf',pdfBase64:pdf.toString('base64')},...overrides});
async function snapshot(){return {
 accounts:await rows('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts ORDER BY account_id'),
 entries:await rows('SELECT * FROM avis_core_v2.ledger_entries ORDER BY entry_id'),
 settlements:await rows('SELECT * FROM avis_core_v2.checkout_ip_settlements ORDER BY request_id')
};}
async function assertNoPosting(work,expected){const before=await snapshot();await assert.rejects(work,expected);assert.deepEqual(await snapshot(),before);}

test('authenticated booked evidence credits the approved Common or Suspense and debits its core NOSTRO exactly once',async()=>{
 for(const owner of ['COMMON_POOL','SUSPENSE_INBOUND']){
  const f=await fixture({owner});await claim(f);
  const first=await publish(f),saved=first.processing.settlement;
  assert.equal(saved.booked,true);assert.notEqual(saved.journalId,f.evidence.journalId);
  assert.equal(saved.handlerJournalId,f.evidence.journalId);assert.equal(saved.cashAccountId,f.cash.id);assert.equal(saved.receivingAccountId,f.receiving);
  assert.equal(saved.amount,f.request.amount);assert.equal(saved.bookedDate,'2026-11-24');assert.equal(saved.bookedAt,null);
  assert.deepEqual(await rows('SELECT account_id,direction,amount::text FROM avis_core_v2.ledger_entries WHERE journal_id=$1 ORDER BY direction',[saved.journalId]),[
   {account_id:f.receiving,direction:'CREDIT',amount:f.request.amount},{account_id:f.cash.accountId,direction:'DEBIT',amount:f.request.amount}
  ]);
  const accounts=await rows('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=ANY($1::uuid[])',[[f.receiving,f.cash.accountId]]);
  assert.equal(accounts.length,2);assert.ok(accounts.every(a=>a.available_balance===f.request.amount));
  const before=await snapshot();assert.deepEqual(await publish(f),first);
  const completed=await complete(f);assert.equal(completed.processing.settlement.journalId,saved.journalId);assert.equal(completed.processing.proof.available,true);
  assert.deepEqual(await complete(f),completed);assert.deepEqual(await snapshot(),before);
  assert.equal((await ip.context(handler,{requestId:f.request.requestId})).request.processing.settlement.journalId,saved.journalId);
  await assert.rejects(pool.query('UPDATE avis_core_v2.checkout_ip_settlements SET amount=1 WHERE request_id=$1',[f.request.requestId]),/APPEND_ONLY_RECORD/);
  await assert.rejects(pool.query('DELETE FROM avis_core_v2.checkout_ip_settlements WHERE request_id=$1',[f.request.requestId]),/APPEND_ONLY_RECORD/);
 }
});

test('legacy SETTLED and completion reports remain report-only and preserve historical retry fingerprints',async()=>{
 const f=await fixture();await claim(f);const before=await snapshot();
 const value={...f.value},saved=await ip.processing(handler,value);
 assert.equal(saved.processing.settlement,null);assert.deepEqual(await ip.processing(handler,value),saved);
 const completed=await complete(f,{settlementEvidence:null});assert.equal(completed.processing.settlement,null);
 assert.deepEqual(await complete(f,{settlementEvidence:null}),completed);assert.deepEqual(await snapshot(),before);
 const event=(await rows('SELECT report_snapshot FROM avis_core_v2.checkout_ip_processing_events WHERE request_id=$1 AND revision=1',[f.request.requestId]))[0];
 assert.equal(Object.hasOwn(event.report_snapshot,'settlementEvidence'),false);
});

test('browser actors, acknowledgement states and unclaimed reports cannot book core balances',async()=>{
 const f=await fixture();
 for(const actor of [admin,checkout,{id:'guest'}, {...handler,customerUserId:'1'}])
  await assertNoPosting(()=>ip.processing(actor,{...f.value,settlementEvidence:f.evidence}),e=>e.code==='FORBIDDEN');
 for(const status of ['ACK','ACSP','SENT','REGISTERED'])
  await assertNoPosting(()=>publish(f,{handlerStatus:status}),e=>e.code==='CHECKOUT_IP_COMPLETION');
 await assertNoPosting(()=>publish(f),e=>e.code==='CHECKOUT_IP_CLAIM_REQUIRED');
});

test('currency, exact amount, NOSTRO identity and approved receiving account are validated before any journal',async()=>{
 const f=await fixture();await claim(f);
 const cases=[
  [{settlementEvidence:{...f.evidence,currency:'USD'}},'CURRENCY_MISMATCH'],
  [{settlementEvidence:{...f.evidence,amount:'150.123456789012345679'}},'CHECKOUT_IP_SETTLEMENT_AMOUNT'],
  [{amountCleared:'149'},'CHECKOUT_IP_SETTLEMENT_AMOUNT'],
  [{bankServerSentAmount:'151'},'CHECKOUT_IP_SETTLEMENT_AMOUNT'],
  [{settlementEvidence:{...f.evidence,nostroAccount:'DIFFERENT'}},'CHECKOUT_IP_ACCOUNT'],
  [{receivingAbiqIban:'OTHER-ACCOUNT'},'CHECKOUT_IP_ACCOUNT'],
  [{settlementEvidence:{...f.evidence,statementHash:'ACK'}},'INVALID_FIELD'],
  [{settlementEvidence:{...f.evidence,bookedDate:'2026-02-30'}},'INVALID_FIELD'],
  [{settlementEvidence:{...f.evidence,bookedAt:'2026-02-30T00:00:00Z'}},'INVALID_FIELD']
 ];
 for(const [overrides,code] of cases)await assertNoPosting(()=>publish(f,overrides),e=>e.code===code);
 const result=await publish(f,{settlementEvidence:{...f.evidence,receivingAccountId:randomUUID(),cashAccountId:randomUUID()}});
 assert.equal(result.processing.settlement.receivingAccountId,f.receiving);assert.equal(result.processing.settlement.cashAccountId,f.cash.id);
});

test('settlement evidence cannot be removed or changed by later reports or a conflicting same-revision retry',async()=>{
 const f=await fixture();await claim(f);await publish(f);
 await assertNoPosting(()=>publish(f,{settlementEvidence:{...f.evidence,statementId:'different'}}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 for(const field of ['statementId','bankTransactionId','journalId','statementHash','bookedDate']){
  const replacement=field==='journalId'?randomUUID():field==='statementHash'?'f'.repeat(64):field==='bookedDate'?'2026-11-25':'different';
  await assertNoPosting(()=>publish(f,{revision:2,settlementEvidence:{...f.evidence,[field]:replacement}}),e=>e.code==='CHECKOUT_IP_SETTLEMENT_CONFLICT');
 }
 await assertNoPosting(()=>publish(f,{revision:2,settlementEvidence:null}),e=>e.code==='CHECKOUT_IP_SETTLEMENT_CONFLICT');
});

test('an omitted approved NOSTRO can be selected uniquely from the same-currency register and is frozen by the claim',async()=>{
 const f=await fixture({optional:true}),differentCurrency=await cashAccount('USD');
 assert.equal(f.context.routing.nostroCashAccountId,null);
 assert.ok(f.context.nostroAccounts.some(a=>a.cashAccountId===f.cash.id&&a.accountNumber===f.cash.accountNumber));
 assert.ok(f.context.nostroAccounts.every(a=>a.currency==='EUR'));assert.equal(f.context.receivingAccount.accountId,f.receiving);
 const selected={...f.context.routing,nostroCashAccountId:f.cash.id,nostroIban:f.cash.accountNumber};
 await assert.rejects(claim(f,{...selected,nostroCashAccountId:differentCurrency.id,nostroIban:differentCurrency.accountNumber}),e=>e.code==='CHECKOUT_IP_ACCOUNT');
 await assert.rejects(claim(f,{...selected,receivingAccountId:randomUUID()}),e=>e.code==='CHECKOUT_IP_ACCOUNT');
 const saved=await claim(f,selected);assert.deepEqual(saved.routing,selected);
 assert.deepEqual((await ip.context(handler,{requestId:f.request.requestId})).routing,selected);
 await assert.rejects(claim(f,{...selected,nostroCashAccountId:randomUUID()}),e=>e.code==='CHECKOUT_IP_PROCESSING_LINK');
 await ip.setActive(admin,{requestId:f.request.requestId,active:false});
 const result=await publish(f,{nostroIban:f.cash.accountNumber});assert.equal(result.processing.settlement.cashAccountId,f.cash.id);
 await assert.rejects(payments.updateCashAccountDetails(admin,{cashAccountId:f.cash.id,currency:'USD',bankName:'Settlement Bank',
  bankAddress:'London',accountName:'AVISPay PLC',reference:'Retained claim'},randomUUID()),e=>e.code==='NOSTRO_CURRENCY_HAS_ACTIVITY');
});

test('ambiguous registered accounts and changes to an explicit approved NOSTRO are rejected',async()=>{
 const f=await fixture({optional:true});await cashAccount('EUR','  '+f.cash.accountNumber.toLowerCase()+'  ');
 await assert.rejects(claim(f,{...f.context.routing,nostroCashAccountId:f.cash.id,nostroIban:f.cash.accountNumber}),e=>e.code==='CHECKOUT_IP_ACCOUNT');
 const explicit=await fixture(),other=await cashAccount();
 await assert.rejects(claim(explicit,{...explicit.context.routing,nostroCashAccountId:other.id,nostroIban:other.accountNumber}),e=>e.code==='CHECKOUT_IP_ACCOUNT');
});

test('one bank entry and one handler journal cannot credit multiple requests, even with changed amounts or statement IDs',async()=>{
 const first=await fixture();await claim(first);await publish(first);
 const second=await fixture({cash:first.cash,amount:'900'});await claim(second);
 await assertNoPosting(()=>publish(second,{settlementEvidence:{...second.evidence,bankTransactionId:first.evidence.bankTransactionId}}),e=>e.code==='NOSTRO_ALREADY_SETTLED');
 await assertNoPosting(()=>publish(second,{settlementEvidence:{...second.evidence,journalId:first.evidence.journalId}}),e=>e.code==='NOSTRO_ALREADY_SETTLED');
});

test('concurrent requests for one bank entry have one journal and one winning beneficiary',async()=>{
 const first=await fixture(),second=await fixture({cash:first.cash});await claim(first);await claim(second);
 second.evidence.bankTransactionId=first.evidence.bankTransactionId;
 const before=(await rows('SELECT count(*)::int AS n FROM avis_core_v2.ledger_journals'))[0].n;
 const results=await Promise.allSettled([publish(first),publish(second)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'NOSTRO_ALREADY_SETTLED');
 assert.equal((await rows('SELECT count(*)::int AS n FROM avis_core_v2.ledger_journals'))[0].n,before+1);
 assert.equal((await rows('SELECT count(*)::int AS n FROM avis_core_v2.checkout_ip_settlements WHERE cash_account_id=$1',[first.cash.id]))[0].n,1);
});

const mirror=(f)=>payments.mirrorNostroMovement(admin,{cashAccountId:f.cash.id,externalReference:f.evidence.bankTransactionId,
 direction:'CREDIT',rail:'IP_TO_IP',amount:f.request.amount,currency:f.request.currency},randomUUID());
test('manual NOSTRO mirrors and checkout settlement cannot book the same bank credit in either order or concurrently',async()=>{
 const first=await fixture();await claim(first);await mirror(first);
 await assertNoPosting(()=>publish(first),e=>e.code==='NOSTRO_ALREADY_SETTLED');
 const second=await fixture();await claim(second);await publish(second);
 await assertNoPosting(()=>mirror(second),e=>e.code==='NOSTRO_ALREADY_SETTLED');
 const third=await fixture();await claim(third);
 const before=(await rows('SELECT count(*)::int AS n FROM avis_core_v2.ledger_journals'))[0].n;
 const results=await Promise.allSettled([publish(third),mirror(third)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'NOSTRO_ALREADY_SETTLED');
 assert.equal((await rows('SELECT count(*)::int AS n FROM avis_core_v2.ledger_journals'))[0].n,before+1);
});

async function retainStatement(f,{amount=f.request.amount,direction='CREDIT'}={}){
 const statementId=randomUUID();
 await pool.query(`INSERT INTO avis_core_v2.clearing_statements(statement_id,cash_account_id,provider_reference,currency_code,opening_balance,closing_balance,payload_hash)
  VALUES($1,$2,$3,$4,'0',$5,$6)`,[statementId,f.cash.id,f.evidence.statementId,f.request.currency,amount,sha('retained statement')]);
 await pool.query('INSERT INTO avis_core_v2.clearing_statement_entries(statement_id,bank_reference,direction,amount) VALUES($1,$2,$3,$4)',
  [statementId,f.evidence.bankTransactionId,direction,amount]);
}
test('retained unmatched statement entries must agree with currency, direction and exact amount',async()=>{
 const good=await fixture();await claim(good);await retainStatement(good);await publish(good);
 for(const mismatch of [{amount:'1'},{direction:'DEBIT'}]){
  const f=await fixture();await claim(f);await retainStatement(f,mismatch);
  await assertNoPosting(()=>publish(f),e=>e.code==='STATEMENT_MATCH_FAILED');
 }
});

async function bankTransfer(f){
 return (await rows(`INSERT INTO avis_core_v2.interbank_ip_transfers(direction,cash_account_id,debtor_iban,creditor_iban,currency_code,amount,iso_status,raw_iso_payload,source_account_id)
  VALUES('INBOUND',$1,'SENDER',$2,$3,$4,'ACTC','{}',$5) RETURNING *`,[f.cash.id,f.context.routing.receivingAbiqIban,f.request.currency,f.request.amount,f.receiving]))[0];
}
async function settleBankTransfer(f,t){
 const client=await pool.connect();try{await client.query('BEGIN');
  await payments.applyStatus(client,admin,randomUUID(),{cash_account_id:f.cash.id,ledger_account_id:f.cash.accountId},t,'ACCC',f.evidence.bankTransactionId);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}
test('ordinary core payment settlement and checkout cannot credit a bank entry twice',async()=>{
 const first=await fixture({amount:'10'});await claim(first);const t1=await bankTransfer(first);await settleBankTransfer(first,t1);
 await assertNoPosting(()=>publish(first),e=>e.code==='NOSTRO_ALREADY_SETTLED');
 const second=await fixture({amount:'10'});await claim(second);const t2=await bankTransfer(second);await publish(second);
 await assertNoPosting(()=>settleBankTransfer(second,t2),e=>e.code==='NOSTRO_ALREADY_SETTLED');
});

test('a later report-write failure rolls back journal, balances and settlement evidence together, then retry succeeds',async()=>{
 const f=await fixture();await claim(f);
 await pool.query(`CREATE FUNCTION avis_core_v2.reject_settlement_test_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.request_id='${f.request.requestId}'::uuid THEN RAISE EXCEPTION 'TEST_REPORT_FAILURE'; END IF; RETURN NEW; END $$`);
 await pool.query(`CREATE TRIGGER reject_settlement_test_report BEFORE INSERT ON avis_core_v2.checkout_ip_processing_events
  FOR EACH ROW EXECUTE FUNCTION avis_core_v2.reject_settlement_test_report()`);
 try{await assertNoPosting(()=>publish(f),/TEST_REPORT_FAILURE/);
  assert.equal((await rows('SELECT * FROM avis_core_v2.checkout_ip_processing WHERE request_id=$1',[f.request.requestId])).length,0);
 }finally{await pool.query('DROP TRIGGER reject_settlement_test_report ON avis_core_v2.checkout_ip_processing_events');await pool.query('DROP FUNCTION avis_core_v2.reject_settlement_test_report()');}
 const result=await publish(f);assert.equal(result.processing.settlement.booked,true);
 assert.equal(money((await rows('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[f.receiving]))[0].available_balance),money(f.request.amount));
});
