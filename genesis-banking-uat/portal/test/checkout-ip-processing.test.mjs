import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,createHash,sign} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {PaymentServer} from '../src/payments.mjs';
import {CheckoutIpControl} from '../src/checkout-ip.mjs';
import {CheckoutIpHandlerAuthenticator,CheckoutPosAuthenticator} from '../src/checkout-pos-auth.mjs';
import {IP_PROOF_MAX_BYTES} from '../src/checkout-ip-processing.mjs';
import {createBankServer} from '../server.mjs';

const admin={id:'ip-processing-admin',username:'ip-admin',admin:true},guest={id:'guest',admin:false};
const checkout={id:'service:avis-land-checkout',posService:true},handler={id:'service:avis-land-ip-handler',ipHandlerService:true};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const originalPdf=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const {privateKey,publicKey}=generateKeyPairSync('ed25519'),kid='ip-handler-test-key';
const fetcher=async()=>Response.json({keys:[{...publicKey.export({format:'jwk'}),kid,alg:'Ed25519',use:'sig'}]});
let pool,db,ip,common,nostro,abiq;
const request=()=>({requestId:randomUUID(),checkoutKind:'MILESTONE',checkoutReference:'AVIS-TN-'+randomUUID(),title:'Payment processing',
 source:'industrial',amount:'150.123456789012345678',currency:'EUR',bankName:'Sending Bank',ip:'192.0.2.14',
 authorized:'Bank operator',account:'SENDER-123',accountName:'Sender Holdings'});
async function activeRequest(){const input=request();await ip.register(checkout,input);await ip.setActive(admin,{requestId:input.requestId,active:true,receivingAccountId:common,nostroCashAccountId:nostro.id});return input;}
function processing(input,overrides={}){return {requestId:input.requestId,handlerTransferId:randomUUID(),revision:1,
 transactionReference:'TX-'+input.requestId,handlerStatus:'REGISTERED',bankName:input.bankName,
 bankServerSentAmount:input.amount,nostroIban:'NOSTRO-123',receivingAbiqIban:abiq,amountCleared:null,
 beneficiaryName:'Beneficiary Holdings',beneficiaryAccount:'BE-ACCOUNT-123',franchiseAllocatedPercent:'12.50',
 operationCompleted:false,manualReport100Digits:null,...overrides};}
function completed(input,overrides={}){return processing(input,{handlerStatus:'SETTLED',amountCleared:'150.123456789012345678',
 operationCompleted:true,manualReport100Digits:'0123456789'.repeat(10),proof:{fileName:'original-handler-proof.pdf',pdfBase64:originalPdf.toString('base64')},...overrides});}
async function claimPayload(value){return {requestId:value.requestId,handlerTransferId:value.handlerTransferId,
 transactionReference:value.transactionReference,...(await ip.context(handler,{requestId:value.requestId})).routing};}
async function claim(value){return ip.claim(handler,await claimPayload(value));}
async function processingEvidence(requestIds){
 const evidence={};
 for(const table of ['checkout_ip_processing','checkout_ip_settlement_claims','checkout_ip_processing_events','checkout_ip_proofs'])
  evidence[table]=(await pool.query(`SELECT * FROM avis_core_v2.${table} WHERE request_id=ANY($1::uuid[]) ORDER BY request_id,${table==='checkout_ip_processing_events'?'revision':'request_id'}`,[requestIds])).rows;
 return evidence;
}
async function ledgerSnapshot(){return {
 accounts:(await pool.query('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows,
 entries:(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries')).rows[0].n
};}
async function identityActions(value){const payload=await claimPayload(value);return {
 publish:()=>ip.processing(handler,value),claim:()=>ip.claim(handler,payload)
};}
function token(path,body,{profile='handler',claims={},header={}}={}){
 const now=Math.floor(Date.now()/1000),isHandler=profile==='handler';
 const head=Buffer.from(JSON.stringify({alg:'Ed25519',typ:isHandler?'AVIS-IP-HANDLER-REQUEST+JWT':'AVIS-POS-REQUEST+JWT',kid,...header})).toString('base64url');
 const payload=Buffer.from(JSON.stringify({iss:isHandler?'https://avis.land/ip-handler':'https://avis.land/checkout',
  aud:isHandler?'AVIS_BANK_IP_HANDLER_V1':'AVIS_BANK_POS_V1',method:'POST',path,body_sha256:sha(body),iat:now,exp:now+50,jti:sha(randomUUID()),...claims})).toString('base64url');
 const signed=head+'.'+payload;
 return (isHandler?'Ip-JWS ':'Pos-JWS ')+signed+'.'+sign(null,Buffer.from(signed),privateKey).toString('base64url');
}
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 ip=new CheckoutIpControl(pool);const accounts=new AccountManagement(pool);
 common=(await accounts.openAccount(admin,{accountType:'COMMON',fullName:'Common collection',currencies:['EUR']},randomUUID())).id;
 abiq=(await ip.accounts(admin)).find(row=>row.account_id===common).abiq_iban;
 nostro=await new PaymentServer(pool).registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Handler NOSTRO',
  bic:'CHASUS33XXX',accountNumber:'NOSTRO-123',currency:'EUR',bankAddress:'London',accountName:'AVISPay PLC',reference:'BANK-IP-REPORT'},randomUUID());
});
after(async()=>{if(db)await db.close();else await pool.end()});

test('only the dedicated handler reads processing context and writes approved routing reports',async()=>{
 const input=request();await ip.register(checkout,input);
 for(const actor of [guest,admin,checkout])await assert.rejects(ip.context(actor,{requestId:input.requestId}),e=>e.code==='FORBIDDEN');
 for(const actor of [guest,admin,checkout])await assert.rejects(ip.processing(actor,processing(input)),e=>e.code==='FORBIDDEN');
 await assert.rejects(ip.processing(handler,processing(input)),e=>e.code==='CHECKOUT_IP_STATE');
 await ip.setActive(admin,{requestId:input.requestId,active:true,receivingAccountId:common,nostroCashAccountId:nostro.id});
 const context=await ip.context(handler,{requestId:input.requestId});
 assert.equal(context.request.requestId,input.requestId);assert.equal(context.request.processing,null);
 assert.equal(context.routing.receivingAbiqIban,abiq);assert.equal(context.routing.nostroIban,'NOSTRO-123');
 await assert.rejects(ip.processing(handler,processing(input,{receivingAbiqIban:'OTHER-ACCOUNT'})),e=>e.code==='CHECKOUT_IP_ACCOUNT');
 await assert.rejects(ip.processing(handler,processing(input,{nostroIban:'OTHER-NOSTRO'})),e=>e.code==='CHECKOUT_IP_ACCOUNT');
 assert.equal((await ip.status(checkout,{requestId:input.requestId})).receivingAbiqIban,undefined);
});

test('handler revision, transaction identity and exact decimal fields survive readback without moving balances',async()=>{
 const input=await activeRequest(),value=processing(input),before=(await pool.query('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows;
 const ledger=(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries')).rows[0].n;
 const first=await ip.processing(handler,value),retry=await ip.processing(handler,value);
 assert.deepEqual(retry,first);assert.equal(first.processing.bankServerSentAmount,'150.123456789012345678');
 assert.equal(first.processing.franchiseAllocatedPercent,'12.50');assert.equal(first.processing.proof.available,false);
 await assert.rejects(ip.processing(handler,{...value,beneficiaryName:'Changed'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 await assert.rejects(ip.processing(handler,{...value,handlerTransferId:randomUUID()}),e=>e.code==='CHECKOUT_IP_PROCESSING_LINK');
 const second=await ip.processing(handler,{...value,revision:3,handlerStatus:'SENT'});
 assert.equal(second.processing.revision,3);
 await assert.rejects(ip.processing(handler,{...value,revision:2}),e=>e.code==='CHECKOUT_IP_REVISION');
 const other=await activeRequest();await assert.rejects(ip.processing(handler,{...value,requestId:other.requestId}),e=>e.code==='CHECKOUT_IP_PROCESSING_LINK');
 const restored=await new CheckoutIpControl(pool).list(admin),row=restored.find(r=>r.requestId===input.requestId);
 assert.equal(row.processing.handlerStatus,'SENT');assert.equal(row.processing.bankServerSentAmount,input.amount);
 assert.equal(JSON.stringify(row).includes('pdfBase64'),false);
 assert.deepEqual((await pool.query('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows,before);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries')).rows[0].n,ledger);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.checkout_ip_processing_events WHERE request_id=$1',[input.requestId])).rows[0].n,2);
});

test('reports and settlement claims cannot reuse another request\'s transaction reference or handler ID',async()=>{
 const ledger=await ledgerSnapshot();
 for(const firstAction of ['publish','claim'])for(const secondAction of ['publish','claim'])for(const field of ['transactionReference','handlerTransferId']){
  const first=processing(await activeRequest(),{transactionReference:randomUUID()}),second=processing(await activeRequest(),{[field]:first[field]});
  const firstActions=await identityActions(first),secondActions=await identityActions(second);
  const saved=await firstActions[firstAction](),before=await processingEvidence([first.requestId,second.requestId]);
  await assert.rejects(secondActions[secondAction](),e=>e.code==='CHECKOUT_IP_PROCESSING_LINK'&&e.status===409&&e.field===field,
   `${firstAction} must retain ${field} against ${secondAction}`);
  assert.deepEqual(await firstActions[firstAction](),saved,'the owning request may retry exactly');
  assert.deepEqual(await processingEvidence([first.requestId,second.requestId]),before,'rejection and retry preserve both requests\' evidence');
 }
 assert.deepEqual(await ledgerSnapshot(),ledger);
});

test('concurrent publications and claims give each transaction reference and handler ID exactly one owner',async()=>{
 const ledger=await ledgerSnapshot();
 // PGlite serializes connections; TEST_DATABASE_URL exercises the same races
 // on independent PostgreSQL connections in the banking verification job.
 for(const [firstAction,secondAction] of [['publish','publish'],['publish','claim'],['claim','publish'],['claim','claim']])for(const field of ['transactionReference','handlerTransferId']){
  const first=processing(await activeRequest(),{transactionReference:randomUUID()}),second=processing(await activeRequest(),{[field]:first[field]});
  const actions=[(await identityActions(first))[firstAction],(await identityActions(second))[secondAction]];
  const results=await Promise.allSettled(actions.map(action=>action()));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1,`${firstAction}/${secondAction} share ${field}`);
  const rejected=results.find(result=>result.status==='rejected');
  assert.equal(rejected.reason.code,'CHECKOUT_IP_PROCESSING_LINK');assert.equal(rejected.reason.status,409);assert.equal(rejected.reason.field,field);
  const winner=results.findIndex(result=>result.status==='fulfilled'),owner=[first,second][winner],loser=[first,second][1-winner];
  const evidence=await processingEvidence([first.requestId,second.requestId]);
  assert.deepEqual([...new Set(Object.values(evidence).flat().map(row=>row.request_id))],[owner.requestId]);
  assert.equal(evidence.checkout_ip_processing.length,[firstAction,secondAction][winner]==='publish'?1:0);
  assert.equal(evidence.checkout_ip_processing_events.length,evidence.checkout_ip_processing.length);
  assert.equal(evidence.checkout_ip_settlement_claims.length,1-evidence.checkout_ip_processing.length);
  assert.equal(evidence.checkout_ip_proofs.length,0);
  const context=await ip.context(handler,{requestId:loser.requestId});assert.equal(context.request.processing,null);assert.equal(context.claim,null);
  assert.deepEqual(await actions[winner](),results[winner].value);
  assert.deepEqual(await processingEvidence([first.requestId,second.requestId]),evidence);
 }
 assert.deepEqual(await ledgerSnapshot(),ledger);
});

test('distinct identities can publish and claim concurrently while each request retains its own binding',async()=>{
 const ledger=await ledgerSnapshot(),first=processing(await activeRequest()),second=processing(await activeRequest());
 const firstActions=await identityActions(first),secondActions=await identityActions(second);
 const [published,claimed]=await Promise.all([firstActions.publish(),secondActions.claim()]);
 const [firstClaim,secondReport]=await Promise.all([firstActions.claim(),secondActions.publish()]);
 assert.equal(firstClaim.handlerTransferId,published.processing.handlerTransferId);
 assert.equal(secondReport.processing.transactionReference,claimed.transactionReference);
 const before=await processingEvidence([first.requestId,second.requestId]);
 assert.deepEqual(await Promise.all([firstActions.publish(),secondActions.claim()]),[published,claimed]);
 assert.deepEqual(await processingEvidence([first.requestId,second.requestId]),before);
 assert.deepEqual(await ledgerSnapshot(),ledger);
});

test('exact retries preserve reports and claims already stored before cross-table identity enforcement',async()=>{
 const ledger=await ledgerSnapshot(),first=processing(await activeRequest()),second=processing(await activeRequest(),{transactionReference:first.transactionReference});
 const firstActions=await identityActions(first),saved=await firstActions.publish(),payload=await claimPayload(second);
 const {requestId,handlerTransferId,transactionReference,...routing}=payload;
 // The previous claim path accepted this cross-table conflict. Retain that
 // historical record and acknowledge only its exact no-op retries.
 await pool.query(`INSERT INTO avis_core_v2.checkout_ip_settlement_claims(request_id,handler_transfer_id,transaction_reference,routing_snapshot,actor_id)
  VALUES($1,$2,$3,$4::jsonb,$5)`,[requestId,handlerTransferId,transactionReference,JSON.stringify(routing),handler.id]);
 const storedClaim=(await ip.context(handler,{requestId})).claim,before=await processingEvidence([first.requestId,requestId]);
 await ip.setActive(admin,{requestId:first.requestId,active:false});await ip.setActive(admin,{requestId,active:false});
 assert.deepEqual(await firstActions.publish(),saved);
 assert.deepEqual(await ip.claim(handler,payload),storedClaim);
 assert.deepEqual(await processingEvidence([first.requestId,requestId]),before);
 assert.deepEqual(await ledgerSnapshot(),ledger);
});

test('completion validates the 100-digit report, allocations, original PDF and settled status',async()=>{
 const input=await activeRequest(),value=completed(input);
 for(const manualReport100Digits of ['1'.repeat(99),'1'.repeat(101),'1'.repeat(99)+'x'])
  await assert.rejects(ip.processing(handler,{...value,manualReport100Digits}),e=>e.field==='manualReport100Digits');
 for(const franchiseAllocatedPercent of ['-1','100.01','2.111',12.5,'NaN'])
  await assert.rejects(ip.processing(handler,{...value,franchiseAllocatedPercent}),e=>e.field==='franchiseAllocatedPercent');
 for(const bankServerSentAmount of ['-1','1e2','1234567890123456789','0.1234567890123456789',150])
  await assert.rejects(ip.processing(handler,{...value,bankServerSentAmount}),e=>e.field==='bankServerSentAmount');
 await assert.rejects(ip.processing(handler,{...value,handlerStatus:'APPROVED'}),e=>e.code==='CHECKOUT_IP_COMPLETION');
 await assert.rejects(ip.processing(handler,{...value,proof:null}),e=>e.code==='CHECKOUT_IP_PROOF');
 await assert.rejects(ip.processing(handler,{...value,operationCompleted:false}),e=>e.code==='CHECKOUT_IP_PROOF');
 await assert.rejects(ip.processing(handler,{...value,beneficiaryAccount:null}),e=>e.field==='beneficiaryAccount');
 await assert.rejects(ip.processing(handler,{...value,proof:{...value.proof,pdfBase64:Buffer.from('<html>not a PDF</html>').toString('base64')}}),e=>e.code==='CHECKOUT_IP_PROOF');
 await assert.rejects(ip.processing(handler,{...value,proof:{...value.proof,pdfBase64:originalPdf.toString('base64')+'!'}}),e=>e.code==='CHECKOUT_IP_PROOF');
 await assert.rejects(ip.processing(handler,{...value,proof:{...value.proof,fileName:'../different.pdf'}}),e=>e.field==='proof.fileName');
 await assert.rejects(ip.processing(handler,{...value,proof:{...value.proof,pdfBase64:Buffer.alloc(IP_PROOF_MAX_BYTES+1).toString('base64')}}),e=>e.code==='CHECKOUT_IP_PROOF');
 assert.equal((await ip.list(admin)).find(row=>row.requestId===input.requestId).processing,null);
 await assert.rejects(ip.processing(handler,value),e=>e.code==='CHECKOUT_IP_CLAIM_REQUIRED');
 await claim(value);
 const result=await ip.processing(handler,value);
 assert.equal(result.processing.operationCompleted,true);assert.equal(result.processing.proof.sha256,sha(originalPdf));
 assert.equal(result.processing.proof.sizeBytes,originalPdf.length);
 assert.deepEqual((await ip.proof(admin,input.requestId)).bytes,originalPdf);
 for(const actor of [guest,handler,checkout,{...admin,customerUserId:'1'}])await assert.rejects(ip.proof(actor,input.requestId),e=>e.code==='FORBIDDEN');
 await assert.rejects(ip.proof(admin,randomUUID()),e=>e.code==='CHECKOUT_IP_PROOF_NOT_FOUND');
});

test('completed proof, transaction and report remain immutable and retrievable after closure',async()=>{
 const input=await activeRequest(),value=completed(input);await claim(value);await ip.processing(handler,value);
 const preserved=await processingEvidence([input.requestId]),other=processing(await activeRequest(),{transactionReference:value.transactionReference});
 await assert.rejects(ip.processing(handler,other),e=>e.code==='CHECKOUT_IP_PROCESSING_LINK'&&e.field==='transactionReference');
 await assert.rejects(claim(other),e=>e.code==='CHECKOUT_IP_PROCESSING_LINK'&&e.field==='transactionReference');
 assert.deepEqual(await processingEvidence([input.requestId]),preserved,'reused references cannot change a completed report, audit or original PDF');
 await assert.rejects(ip.cancel(checkout,{requestId:input.requestId}),e=>e.code==='CHECKOUT_IP_COMPLETED');
 await assert.rejects(ip.processing(handler,{...value,revision:2}),e=>e.code==='CHECKOUT_IP_COMPLETED');
 await assert.rejects(pool.query('UPDATE avis_core_v2.checkout_ip_processing SET beneficiary_name=$2 WHERE request_id=$1',[input.requestId,'Changed']),/APPEND_ONLY_RECORD/);
 await assert.rejects(pool.query('DELETE FROM avis_core_v2.checkout_ip_proofs WHERE request_id=$1',[input.requestId]),/APPEND_ONLY_RECORD/);
 await assert.rejects(pool.query('DELETE FROM avis_core_v2.checkout_ip_processing_events WHERE request_id=$1',[input.requestId]),/APPEND_ONLY_RECORD/);
 await ip.setActive(admin,{requestId:input.requestId,active:false});
 await assert.rejects(ip.register(checkout,input),e=>e.code==='CHECKOUT_IP_COMPLETED');
 assert.deepEqual((await new CheckoutIpControl(pool).proof(admin,input.requestId)).bytes,originalPdf);
 assert.equal((await ip.processing(handler,value)).processing.proof.sha256,sha(originalPdf),'same signed retry may be acknowledged after closure');
});

test('checkout cancellation closes once, preserves processing evidence and prevents further handler work',async()=>{
 const input=await activeRequest(),value=processing(input);await ip.processing(handler,value);
 const before=(await pool.query('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows;
 for(const actor of [admin,handler,guest])await assert.rejects(ip.cancel(actor,{requestId:input.requestId}),e=>e.code==='FORBIDDEN');
 const closed=await ip.cancel(checkout,{requestId:input.requestId});
 assert.equal(closed.status,'CLOSED');assert.deepEqual(await ip.cancel(checkout,{requestId:input.requestId}),closed);
 assert.equal((await ip.status(checkout,{requestId:input.requestId})).status,'CLOSED');
 assert.equal((await ip.list(admin)).find(row=>row.requestId===input.requestId).processing.handlerTransferId,value.handlerTransferId);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM avis_core_v2.checkout_ip_events WHERE request_id=$1 AND event_type='CLOSE'",[input.requestId])).rows[0].n,1);
 await assert.rejects(ip.processing(handler,{...value,revision:2}),e=>e.code==='CHECKOUT_IP_STATE');
 await assert.rejects(ip.register(checkout,input),e=>e.code==='CHECKOUT_IP_CANCELLED');
 const notRegistered=request(),cancelledBeforeRegistration=await ip.cancel(checkout,{requestId:notRegistered.requestId});
 assert.equal(cancelledBeforeRegistration.cancelled,true);assert.equal(cancelledBeforeRegistration.registered,false);
 assert.deepEqual(await ip.cancel(checkout,{requestId:notRegistered.requestId}),cancelledBeforeRegistration);
 await assert.rejects(ip.register(checkout,notRegistered),e=>e.code==='CHECKOUT_IP_CANCELLED');
 assert.equal((await pool.query('SELECT request_id FROM avis_core_v2.checkout_ip_requests WHERE request_id=$1',[notRegistered.requestId])).rows.length,0);
 await assert.rejects(pool.query('DELETE FROM avis_core_v2.checkout_ip_cancellations WHERE request_id=$1',[notRegistered.requestId]),/APPEND_ONLY_RECORD/);
 assert.deepEqual((await pool.query('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows,before);
 const paid=await activeRequest(),paidReport=processing(paid,{handlerStatus:'SETTLED',amountCleared:'150.123456789012345678'});
 await claim(paidReport);await ip.processing(handler,paidReport);
 await assert.rejects(ip.cancel(checkout,{requestId:paid.requestId}),e=>e.code==='CHECKOUT_IP_COMPLETED','booked settlement is protected before manual completion');
});

test('settlement claim binds transfer, transaction and routing, survives closure and blocks cancellation',async()=>{
 const input=await activeRequest(),value=completed(input),payload=await claimPayload(value);
 for(const actor of [admin,checkout,guest])await assert.rejects(ip.claim(actor,payload),e=>e.code==='FORBIDDEN');
 await assert.rejects(ip.claim(handler,{...payload,receivingAbiqIban:'WRONG'}),e=>e.code==='CHECKOUT_IP_ACCOUNT');
 const first=await ip.claim(handler,payload);assert.equal(first.claimed,true);assert.equal(first.handlerTransferId,value.handlerTransferId);
 assert.deepEqual(await ip.claim(handler,payload),first);
 await assert.rejects(ip.cancel(checkout,{requestId:input.requestId}),e=>e.code==='CHECKOUT_IP_PROCESSING');
 await assert.rejects(ip.claim(handler,{...payload,handlerTransferId:randomUUID()}),e=>e.code==='CHECKOUT_IP_PROCESSING_LINK');
 await assert.rejects(ip.claim(handler,{...payload,transactionReference:'DIFFERENT'}),e=>e.code==='CHECKOUT_IP_PROCESSING_LINK');
 await assert.rejects(ip.claim(handler,{...payload,nostroIban:null}),e=>e.code==='CHECKOUT_IP_PROCESSING_LINK');
 await assert.rejects(ip.processing(handler,{...value,handlerTransferId:randomUUID()}),e=>e.code==='CHECKOUT_IP_PROCESSING_LINK');
 await assert.rejects(pool.query('DELETE FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=$1',[input.requestId]),/APPEND_ONLY_RECORD/);
 await ip.setActive(admin,{requestId:input.requestId,active:false});
 await assert.rejects(ip.register(checkout,input),e=>e.code==='CHECKOUT_IP_PROCESSING');
 assert.deepEqual(await ip.claim(handler,payload),first,'same claim retry survives admin closure');
 const context=await ip.context(handler,{requestId:input.requestId});assert.deepEqual(context.claim,first);assert.deepEqual(context.routing,first.routing);
 assert.equal((await ip.processing(handler,value)).processing.operationCompleted,true,'claimed operation finishes its report after closure');
});

test('concurrent cancellation and settlement claim have exactly one winner and no ledger effects',async()=>{
 const before=(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries')).rows[0].n;
 for(const first of ['claim','cancel']){
  const input=await activeRequest(),value=processing(input),payload=await claimPayload(value);
  const actions={claim:()=>ip.claim(handler,payload),cancel:()=>ip.cancel(checkout,{requestId:input.requestId})};
  const second=first==='claim'?'cancel':'claim';
  const results=await Promise.allSettled([actions[first](),actions[second]()]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const claims=(await pool.query('SELECT request_id FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=$1',[input.requestId])).rows;
  const cancellations=(await pool.query('SELECT request_id FROM avis_core_v2.checkout_ip_cancellations WHERE request_id=$1',[input.requestId])).rows;
  assert.equal(claims.length+cancellations.length,1);
  if(claims.length)await assert.rejects(ip.cancel(checkout,{requestId:input.requestId}),e=>e.code==='CHECKOUT_IP_PROCESSING');
  else{await assert.rejects(ip.claim(handler,payload),e=>e.code==='CHECKOUT_IP_STATE'||e.code==='CHECKOUT_IP_CANCELLED');
   await assert.rejects(ip.processing(handler,completed(input,{handlerTransferId:value.handlerTransferId,transactionReference:value.transactionReference})),e=>e.code==='CHECKOUT_IP_CLAIM_REQUIRED');}
 }
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries')).rows[0].n,before);
});

test('handler signatures reject checkout scope, nonce replay, body changes, unknown paths and expired tokens',async()=>{
 const verifier=new CheckoutIpHandlerAuthenticator(pool,{fetcher}),posVerifier=new CheckoutPosAuthenticator(pool,{fetcher});
 const path='/api/services/checkout-ip/context',body=Buffer.from(JSON.stringify({requestId:randomUUID()}));
 const req=authorization=>({method:'POST',url:path,headers:{authorization}}),good=token(path,body);
 assert.equal((await verifier.authenticate(req(good),body)).ipHandlerService,true);
 await assert.rejects(verifier.authenticate(req(good),body),e=>e.code==='IP_HANDLER_SERVICE_AUTH');
 await assert.rejects(verifier.authenticate(req(token(path,body,{profile:'checkout'})),body),e=>e.code==='IP_HANDLER_SERVICE_AUTH');
 await assert.rejects(posVerifier.authenticate(req(token(path,body)),body),e=>e.code==='POS_SERVICE_AUTH');
 await assert.rejects(verifier.authenticate(req(token(path,body)),Buffer.from('{}')),e=>e.code==='IP_HANDLER_SERVICE_AUTH');
 await assert.rejects(verifier.authenticate(req(token(path,body,{claims:{path:'/api/services/checkout-ip/register'}})),body),e=>e.code==='IP_HANDLER_SERVICE_AUTH');
 await assert.rejects(verifier.authenticate(req(token(path,body,{claims:{exp:1}})),body),e=>e.code==='IP_HANDLER_SERVICE_AUTH');
 await assert.rejects(verifier.authenticate(req(token(path,body,{claims:{aud:'AVIS_BANK_POS_V1'}})),body),e=>e.code==='IP_HANDLER_SERVICE_AUTH');
});

test('HTTP handler feed and admin PDF download enforce sessions, scope and original bytes',async()=>{
 const input=await activeRequest(),value=completed(input);
 const server=createBankServer({pool,authenticate:async()=>admin,secureCookies:false,transferOptions:{ipHandlerServiceFetcher:fetcher,posServiceFetcher:fetcher}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const post=(path,input,authorization)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(authorization?{authorization}:{})},body:JSON.stringify(input)});
 try{
  const path='/api/services/checkout-ip/processing',raw=Buffer.from(JSON.stringify(value));
  assert.equal((await post(path,value)).status,401);
  assert.equal((await post(path,value,token(path,raw,{profile:'checkout'}))).status,401);
  const claimPath='/api/services/checkout-ip/claim',claimBody=await claimPayload(value),claimRaw=Buffer.from(JSON.stringify(claimBody));
  const acquired=await post(claimPath,claimBody,token(claimPath,claimRaw));assert.equal(acquired.status,200);assert.equal((await acquired.json()).claimed,true);
  const published=await post(path,value,token(path,raw));assert.equal(published.status,200);assert.equal((await published.json()).processing.operationCompleted,true);
  const contextPath='/api/services/checkout-ip/context',contextBody=Buffer.from(JSON.stringify({requestId:input.requestId}));
  const context=await post(contextPath,{requestId:input.requestId},token(contextPath,contextBody));assert.equal(context.status,200);
  assert.equal((await context.json()).request.processing.transactionReference,value.transactionReference);
  const pathPdf='/api/checkout-ip/'+input.requestId+'/proof.pdf';
  assert.equal((await fetch(base+pathPdf)).status,401);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'ip-admin',password:'fixture'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const proof=await fetch(base+pathPdf,{headers:{cookie}});
  assert.equal(proof.status,200);assert.equal(proof.headers.get('content-type'),'application/pdf');
  assert.match(proof.headers.get('content-disposition'),/^inline;/);assert.match(proof.headers.get('content-security-policy'),/frame-ancestors 'self'/);
  assert.equal(proof.headers.get('cache-control'),'private, no-store');assert.equal(proof.headers.get('x-content-sha256'),sha(originalPdf));
  assert.deepEqual(Buffer.from(await proof.arrayBuffer()),originalPdf);
  const download=await fetch(base+pathPdf+'?download=1',{headers:{cookie}});assert.match(download.headers.get('content-disposition'),/^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),originalPdf);
  assert.equal((await fetch(base+'/api/checkout-ip/'+randomUUID()+'/proof.pdf',{headers:{cookie}})).status,404);
  const list=await fetch(base+'/api/views/checkoutip',{headers:{cookie}}),listed=await list.json();
  assert.equal(listed.rows.find(row=>row.requestId===input.requestId).processing.proof.available,true);
  assert.equal(JSON.stringify(listed).includes(originalPdf.toString('base64')),false);
  await pool.query('UPDATE avis_core_v2.operator_sessions SET workspace_user_id=1 WHERE actor_id=$1',[admin.id]);
  assert.equal((await fetch(base+pathPdf,{headers:{cookie}})).status,403,'customer workspace cannot read admin proof');
 }finally{await new Promise(resolve=>server.close(resolve))}
});
