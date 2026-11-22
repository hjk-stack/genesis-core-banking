import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {PaymentServer} from '../src/payments.mjs';
import {nostroRegisterTable,nostroMovementsTable,intermediaryBankTable} from '../public/nostro-clearing.mjs';

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

test('external bank register retains bank address, account name, ABA, reference and existing ledger after edits',async()=>{
 const source=await core.registerCashAccount(admin,{
  institutionType:'CORRESPONDENT_BANK',institutionName:'Initial institution',
  bankName:'First Registered Bank',bankAddress:'100 Treasury Avenue, New York, NY, USA',
  accountName:'AVISPay PLC NOSTRO',aba:'021000021',reference:'EXT-BANK-REG-1',
  bic:'CHASUS33XXX',accountNumber:'US-NOSTRO-987',currency:'USD'
 },key());
 const row=(await core.list(admin,'nostroclearing')).find(x=>x.cash_account_id===source.id);
 assert.equal(row.institution_name,'First Registered Bank');
 assert.equal(row.bank_address,'100 Treasury Avenue, New York, NY, USA');
 assert.equal(row.account_name,'AVISPay PLC NOSTRO');
 assert.equal(row.aba,'021000021');
 assert.equal(row.bank_reference,'EXT-BANK-REG-1');
 assert.match(nostroRegisterTable([row]),/AVISPay PLC NOSTRO/);
 const before=(await pool.query('SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[source.accountId])).rows[0];
 const update={cashAccountId:source.id,bankName:'First Registered Bank - Main',bankAddress:'100 Treasury Avenue, New York, NY, USA',
  accountName:'AVISPay PLC settlement',aba:'021000021',reference:'EXT-BANK-REG-2'};
 const saved=await core.updateCashAccountDetails(admin,update,key());
 assert.equal(saved.cashAccountId,source.id);
 const amended=(await core.list(admin,'nostroclearing')).find(x=>x.cash_account_id===source.id);
 assert.equal(amended.account_name,'AVISPay PLC settlement');
 assert.equal(amended.bank_reference,'EXT-BANK-REG-2');
 assert.equal(amended.institution_name,'First Registered Bank - Main');
 assert.deepEqual((await pool.query('SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[source.accountId])).rows[0],before);
 await assert.rejects(core.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Bad ABA',
  bic:'CHASUS33XXX',accountNumber:'BAD-ABA',currency:'USD',aba:'123456789'},key()),e=>e.code==='INVALID_FIELD'&&e.field==='aba');
 await assert.rejects(core.updateCashAccountDetails({id:'public',admin:false},update,key()),e=>e.code==='FORBIDDEN');
});

test('intermediary banks register under the selected NOSTRO without creating or altering balances',async()=>{
 const cashBefore=await balance(cash.accountId);
 const input={cashAccountId:cash.id,bankName:'Global Intermediary',bankAddress:'45 Clearing Square, London, UK',
  accountName:'AVISPay PLC transit',aba:'021000021',reference:'INT-TRANSIT-001',
  bic:'CHASUS33XXX',accountNumber:'INT-ACC-0001'};
 const request=key();
 const saved=await core.registerIntermediaryBank(admin,input,request);
 assert.equal(saved.cashAccountId,cash.id);
 assert.deepEqual(await core.registerIntermediaryBank(admin,input,request),saved);
 let rows=await core.list(admin,'nostrointermediaries'),record=rows.find(r=>r.intermediary_id===saved.id);
 assert.equal(record.bank_name,input.bankName);
 assert.equal(record.parent_bank_name,'Clearing Regression Bank');
 assert.equal(record.account_name,input.accountName);
 assert.equal(record.aba,input.aba);
 assert.equal(record.reference,input.reference);
 assert.match(intermediaryBankTable([record]),/Global Intermediary/);
 assert.ok(!intermediaryBankTable([{...record,bank_name:'<img src=x>'}]).includes('<img src=x>'));
 assert.equal(await balance(cash.accountId),cashBefore);
 const changes={intermediaryId:saved.id,bankName:'Global Intermediary II',
  bankAddress:'46 Clearing Square, London, UK',accountName:'AVISPay correspondent',
  aba:'',reference:'INT-TRANSIT-002',bic:'',accountNumber:''};
 const edit=await core.updateIntermediaryBank(admin,changes,key());
 assert.equal(edit.id,saved.id);
 rows=await core.list(admin,'nostrointermediaries');record=rows.find(r=>r.intermediary_id===saved.id);
 assert.equal(record.bank_name,'Global Intermediary II');
 assert.equal(record.aba,null);
 assert.equal(record.bic_code,null);
 assert.equal(record.account_number,null);
 assert.equal(record.reference,'INT-TRANSIT-002');
 assert.equal(await balance(cash.accountId),cashBefore);
 const duplicate={...changes,cashAccountId:cash.id};
 await assert.rejects(core.registerIntermediaryBank(admin,duplicate,key()),/duplicate key/i);
 await assert.rejects(core.list({id:'guest',admin:false},'nostrointermediaries'),e=>e.code==='FORBIDDEN');
 await assert.rejects(core.registerIntermediaryBank({id:'guest',admin:false},input,key()),e=>e.code==='FORBIDDEN');
});


test('combined NOSTRO registration creates its incoming intermediary in one atomic operation and renders it under the account',async()=>{
 const before=(await pool.query('SELECT count(*)::int AS count FROM avis_core_v2.external_cash_accounts')).rows[0].count;
 const input={institutionType:'CORRESPONDENT_BANK',institutionName:'Combined Test NOSTRO',
  bic:'CHASUS33XXX',accountNumber:'COMBINED-NOSTRO-77',currency:'USD',
  bankAddress:'1 Clearing Road',accountName:'AVISPay PLC NOSTRO',reference:'NOSTRO-COMB-77',
  intermediary:{bankName:'Inbound Transit Bank',bankAddress:'2 Transit Road',accountName:'AVISPay PLC',
   aba:'021000021',reference:'TRANSIT-77',bic:'CHASUS33XXX',accountNumber:'TRANSIT-ACC-77'}};
 const token=key();
 const opened=await core.registerCashAccount(admin,input,token);
 assert.deepEqual(await core.registerCashAccount(admin,input,token),opened);
 const rows=await core.list(admin,'nostroclearing');
 const row=rows.find(x=>x.cash_account_id===opened.id);
 assert.ok(row,'NOSTRO visible in registry');
 assert.equal(row.intermediaries.length,1);
 assert.equal(row.intermediaries[0].intermediaryId,opened.intermediaryId);
 assert.equal(row.intermediaries[0].bankName,'Inbound Transit Bank');
 assert.equal(row.intermediaries[0].reference,'TRANSIT-77');
 const html=nostroRegisterTable([row]);
 assert.match(html,/Incoming intermediary bank/);
 assert.match(html,/Inbound Transit Bank/);
 assert.match(html,/TRANSIT-77/);
 assert.equal((await pool.query('SELECT count(*)::int AS count FROM avis_core_v2.external_cash_accounts')).rows[0].count,before+1);
 assert.equal(await balance(opened.accountId),'0.000000000000000000');
 const snapshot=(await pool.query('SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[opened.accountId])).rows[0];
 const edit={cashAccountId:opened.id,bankName:'Combined Test NOSTRO Corrected',bankAddress:'Updated clearing road',
  accountName:'AVISPay PLC NOSTRO',aba:'',reference:'NOSTRO-COMB-77',
  intermediary:{...input.intermediary,intermediaryId:opened.intermediaryId,bankAddress:'Updated transit road'}};
 const saved=await core.updateCashAccountDetails(admin,edit,key());
 assert.equal(saved.intermediaryId,opened.intermediaryId);
 const updated=(await core.list(admin,'nostroclearing')).find(x=>x.cash_account_id===opened.id);
 assert.equal(updated.institution_name,'Combined Test NOSTRO Corrected');
 assert.equal(updated.intermediaries.length,1);
 assert.equal(updated.intermediaries[0].bankAddress,'Updated transit road');
 assert.deepEqual((await pool.query('SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[opened.accountId])).rows[0],snapshot);
 const badCount=(await pool.query('SELECT count(*)::int AS count FROM avis_core_v2.external_cash_accounts')).rows[0].count;
 await assert.rejects(core.registerCashAccount(admin,{...input,accountNumber:'REJECTED-NOSTRO-77',
  intermediary:{...input.intermediary,aba:'123456789'}},key()),e=>e.code==='INVALID_FIELD'&&e.field==='intermediaryAba');
 assert.equal((await pool.query('SELECT count(*)::int AS count FROM avis_core_v2.external_cash_accounts')).rows[0].count,badCount);
 await assert.rejects(core.updateCashAccountDetails(admin,{...edit,bankName:'MUST ROLLBACK',
  intermediary:{...edit.intermediary,intermediaryId:randomUUID()}},key()),e=>e.code==='INTERMEDIARY_NOT_FOUND');
 assert.equal((await core.list(admin,'nostroclearing')).find(x=>x.cash_account_id===opened.id).institution_name,'Combined Test NOSTRO Corrected');
});
