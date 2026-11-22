import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {PaymentServer} from '../src/payments.mjs';
import {nostroRegisterTable,nostroMovementsTable} from '../public/nostro-clearing.mjs';

const admin={id:'nostro-clearing-regression',admin:true},key=()=>randomUUID();
let db,pool,core,cash;
const balance=async account=>(await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[account])).rows[0].available_balance;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){
  const url=new URL(process.env.TEST_DATABASE_URL);
  assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});
  await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
 }else{
  db=new PGlite();
  pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};
 }
 const conn=await pool.connect();try{await migrate(conn);}finally{conn.release();}
 core=new PaymentServer(pool);
 cash=await core.registerCashAccount(admin,{
  institutionType:'CORRESPONDENT_BANK',institutionName:'Clearing Regression Bank',
  bic:'TESTGB2LXXX',accountNumber:'EXTERNAL-NOSTRO-001',currency:'EUR'
 },key());
});
after(async()=>{if(db)await db.close();else await pool.end();});

test('NOSTRO register exposes existing external-account ledger and bank/card associations without creating additional funds',async()=>{
 const rows=await core.list(admin,'nostroclearing');
 const account=rows.find(r=>r.cash_account_id===cash.id);
 assert.equal(account.ledger_account_id,cash.accountId);
 assert.equal(account.available_balance,'0.000000000000000000');
 assert.equal(account.iban_or_account_no,'EXTERNAL-NOSTRO-001');
 assert.match(nostroRegisterTable(rows),/NOSTRO Clearing/);
 assert.match(nostroRegisterTable(rows),/data-nostro-mirror/);
 assert.ok(!nostroRegisterTable([{...account,institution_name:'<script>'}]).includes('<script>'),'UI escapes provider names');
 await assert.rejects(core.list({id:'customer',admin:false},'nostroclearing'),/FORBIDDEN/);
});

test('idempotent manual NOSTRO mirroring updates only the external asset and a dedicated offset, preserving customer ledgers',async()=>{
 const input={cashAccountId:cash.id,currency:'EUR',direction:'CREDIT',rail:'BANK_API',
  externalReference:'EXT-CREDIT-001',amount:'125.250000000000000001',memo:'Confirmed external credit'};
 const request=key();
 const beforeAccounts=(await pool.query("SELECT account_id,available_balance::text FROM avis_core_v2.ledger_accounts WHERE owner_type='USER' ORDER BY account_id")).rows;
 const credited=await core.mirrorNostroMovement(admin,input,request);
 assert.equal(credited.amount,'125.250000000000000001');
 assert.deepEqual(await core.mirrorNostroMovement(admin,input,request),credited);
 assert.equal(await balance(cash.accountId),'125.250000000000000001');
 assert.equal((await pool.query('SELECT count(*)::int AS count FROM avis_core_v2.nostro_manual_mirrors')).rows[0].count,1);
 const offset=(await pool.query("SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE owner_type='COMMON_POOL' AND sub_account_code=$1",['NOSTRO_MIRROR:'+cash.id])).rows[0];
 assert.equal(offset.available_balance,'125.250000000000000001');
 assert.deepEqual((await pool.query("SELECT account_id,available_balance::text FROM avis_core_v2.ledger_accounts WHERE owner_type='USER' ORDER BY account_id")).rows,beforeAccounts);
 await assert.rejects(core.mirrorNostroMovement(admin,{...input,amount:'200'},request),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(core.mirrorNostroMovement(admin,input,key()),/duplicate key/i);
 const events=await core.list(admin,'nostromovements');
 assert.equal(events[0].source,'MANUAL');
 assert.equal(events[0].external_reference,'EXT-CREDIT-001');
 assert.match(nostroMovementsTable(events),/EXT-CREDIT-001/);
});

test('outgoing manual card settlement debits the same Nostro asset, respects exact balance and captures reference',async()=>{
 const input={cashAccountId:cash.id,currency:'EUR',direction:'DEBIT',rail:'CARD',
  externalReference:'EXT-CARD-SETTLED-001',amount:'25.250000000000000001'};
 const outgoing=await core.mirrorNostroMovement(admin,input,key());
 assert.equal(outgoing.currency,'EUR');
 assert.equal(await balance(cash.accountId),'100.000000000000000000');
 const events=await core.list(admin,'nostromovements');
 const card=events.find(x=>x.external_reference==='EXT-CARD-SETTLED-001');
 assert.equal(card.direction,'CREDIT');
 assert.equal(card.rail,'CARD');assert.equal(card.source,'MANUAL');
 await assert.rejects(core.mirrorNostroMovement(admin,{...input,externalReference:'EXT-TOO-MUCH',amount:'101'},key()),e=>e.code==='INSUFFICIENT_CLEARING_FUNDS');
 assert.equal(await balance(cash.accountId),'100.000000000000000000');
 await assert.rejects(core.mirrorNostroMovement(admin,{...input,externalReference:'EXT-BAD-CURRENCY',currency:'USD'},key()),e=>e.code==='CURRENCY_MISMATCH');
 await assert.rejects(core.mirrorNostroMovement({id:'customer',admin:false},input,key()),e=>e.code==='FORBIDDEN');
});

test('card scheme gateway mapping is linked to one registered NOSTRO and visible in the account register',async()=>{
 const gateway='AVIS_PROPRIETARY_LOOP';
 const input={gatewayCode:gateway,cashAccountId:cash.id},k=key();
 const first=await core.linkNostroGateway(admin,input,k);
 assert.deepEqual(await core.linkNostroGateway(admin,input,k),first);
 assert.equal((await core.list(admin,'nostrogateways')).find(x=>x.gateway_code===gateway).clearing_account_id,cash.id);
 assert.match((await core.list(admin,'nostroclearing')).find(x=>x.cash_account_id===cash.id).card_gateways,/AVIS Card Switch/);
 const other=await core.registerCashAccount(admin,{
  institutionType:'CARD_SCHEME_SETTLEMENT',institutionName:'Second scheme',bic:'TESTGB2LXXX',accountNumber:'EXTERNAL-CARD-2',currency:'EUR'
 },key());
 await assert.rejects(core.linkNostroGateway(admin,{gatewayCode:gateway,cashAccountId:other.id},key()),e=>e.code==='NOSTRO_GATEWAY_ALREADY_LINKED');
});

test('provider-reconciled references cannot be mirrored again and manual mirror register is append-only',async()=>{
 const statement=randomUUID(),reference='SETTLED-EXTERNAL-002';
 await pool.query('INSERT INTO avis_core_v2.clearing_statements(statement_id,cash_account_id,provider_reference,currency_code,opening_balance,closing_balance,payload_hash) VALUES($1,$2,$3,$4,0,0,$5)',[statement,cash.id,'EXT-STMT-002','EUR','not-an-actual-hash']);
 await pool.query("INSERT INTO avis_core_v2.clearing_statement_entries(statement_id,bank_reference,direction,amount) VALUES($1,$2,'CREDIT',1)",[statement,reference]);
 await assert.rejects(core.mirrorNostroMovement(admin,{cashAccountId:cash.id,currency:'EUR',direction:'CREDIT',rail:'ISO20022',externalReference:reference,amount:'1'},key()),e=>e.code==='NOSTRO_ALREADY_SETTLED');
 const row=(await pool.query('SELECT mirror_id FROM avis_core_v2.nostro_manual_mirrors LIMIT 1')).rows[0];
 await assert.rejects(pool.query('DELETE FROM avis_core_v2.nostro_manual_mirrors WHERE mirror_id=$1',[row.mirror_id]),/APPEND_ONLY_RECORD/);
 const invalid=(await pool.query("SELECT count(*)::int AS count FROM avis_core_v2.ledger_journals WHERE event_type='NOSTRO_MANUAL_MIRROR'")).rows[0].count;
 assert.equal(invalid,2);
});
