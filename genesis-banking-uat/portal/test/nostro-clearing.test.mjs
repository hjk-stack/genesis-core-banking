import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFile,mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {PaymentServer} from '../src/payments.mjs';
import {nostroRegisterTable,nostroMovementsTable,intermediaryBankTable} from '../public/nostro-clearing.mjs';

const admin={id:'nostro-clearing-regression',admin:true},key=()=>randomUUID();
let db,pool,core,cash,legacyIntermediary,upgradeSnapshot;
const balance=async account=>(await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[account])).rows[0].available_balance;
const directoryFields={bankName:'bank_name',bankAddress:'bank_address',accountName:'account_name',aba:'aba',reference:'reference',bic:'bic_code',accountNumber:'account_number'};
const intermediary=async id=>(await pool.query('SELECT * FROM avis_core_v2.nostro_intermediary_banks WHERE intermediary_id=$1',[id])).rows[0];
const ledgerSnapshot=async()=>({
 accounts:(await pool.query('SELECT * FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows,
 journals:(await pool.query('SELECT * FROM avis_core_v2.ledger_journals ORDER BY journal_id')).rows,
 entries:(await pool.query('SELECT * FROM avis_core_v2.ledger_entries ORDER BY entry_id')).rows
});
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
 // Populate a real pre-044 database so the additive upgrade is verified against
 // existing intermediary values, IDs, cash-account links and ledger records.
 const directory=new URL('../migrations/',import.meta.url),prior=await mkdtemp(join(tmpdir(),'nostro-optional-upgrade-'));
 const conn=await pool.connect();
 try{
  for(const name of (await readdir(directory)).filter(name=>/^\d{3}_[a-z_]+\.sql$/.test(name)&&name<'044_'))
   await copyFile(new URL(name,directory),join(prior,name));
  await migrate(conn,pathToFileURL(prior+'/'));
 }finally{conn.release();await rm(prior,{recursive:true,force:true});}
 core=new PaymentServer(pool);
 cash=await core.registerCashAccount(admin,{
  institutionType:'CORRESPONDENT_BANK',institutionName:'Clearing Regression Bank',
  bic:'TESTGB2LXXX',accountNumber:'EXTERNAL-NOSTRO-001',currency:'EUR'
 },key());
 legacyIntermediary=await core.registerIntermediaryBank(admin,{cashAccountId:cash.id,bankName:'TBA',bankAddress:'NA',
  accountName:'Existing transit account',reference:'EXISTING-INTERMEDIARY',aba:'021000021',bic:'CHASUS33XXX',accountNumber:'RETAINED-ACCOUNT'},key());
 upgradeSnapshot={intermediary:await intermediary(legacyIntermediary.id),ledger:await ledgerSnapshot(),
  cash:(await pool.query('SELECT * FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1',[cash.id])).rows[0]};
 const upgraded=await pool.connect();try{await migrate(upgraded);}finally{upgraded.release();}
});
after(async()=>{if(db)await db.close();else await pool.end();});

test('NOSTRO register exposes the external account directory and associations without internal balances or additional funds',async()=>{
 const rows=await core.list(admin,'nostroclearing');
 const account=rows.find(r=>r.cash_account_id===cash.id);
 assert.equal(account.ledger_account_id,cash.accountId);
 assert.equal(Object.hasOwn(account,'available_balance'),false);
 assert.equal(Object.hasOwn(account,'locked_balance'),false);
 assert.equal(await balance(cash.accountId),'0.000000000000000000');
 assert.equal(account.iban_or_account_no,'EXTERNAL-NOSTRO-001');
 assert.match(nostroRegisterTable(rows),/NOSTRO Clearing/);
 assert.match(nostroRegisterTable(rows),/data-nostro-mirror/);
 assert.ok(!nostroRegisterTable([{...account,institution_name:'<script>'}]).includes('<script>'),'UI escapes provider names');
 await assert.rejects(core.list({id:'customer',admin:false},'nostroclearing'),/FORBIDDEN/);
});

test('optional intermediary migration preserves existing supplied values, identities, bindings and ledger data',async()=>{
 assert.deepEqual(await intermediary(legacyIntermediary.id),upgradeSnapshot.intermediary);
 assert.deepEqual((await pool.query('SELECT * FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1',[cash.id])).rows[0],upgradeSnapshot.cash);
 assert.deepEqual(await ledgerSnapshot(),upgradeSnapshot.ledger);
 const columns=(await pool.query(`SELECT column_name,is_nullable,column_default FROM information_schema.columns
  WHERE table_schema='avis_core_v2' AND table_name='nostro_intermediary_banks'
  AND column_name=ANY($1::text[])`,[Object.values(directoryFields)])).rows;
 assert.equal(columns.length,7);
 assert.ok(columns.every(column=>column.is_nullable==='YES'&&column.column_default===null));
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

test('omitted, empty and whitespace-only intermediary details save without creating a blank directory record',async()=>{
 const blank={bankName:' ',bankAddress:'',accountName:null,reference:'\t ',aba:' ',bic:' ',accountNumber:'  '};
 const count=async()=>(await pool.query('SELECT count(*)::int AS count FROM avis_core_v2.nostro_intermediary_banks')).rows[0].count;
 const before=await count(),journals=(await pool.query('SELECT count(*)::int AS count FROM avis_core_v2.ledger_journals')).rows[0].count;
 for(const details of [undefined,null,{},blank]){
  const input={institutionType:'CORRESPONDENT_BANK',institutionName:'Optional intermediary bank',
   bic:'TESTGB2LXXX',accountNumber:randomUUID(),currency:'EUR',...(details===undefined?{}:{intermediary:details})};
  const token=key(),saved=await core.registerCashAccount(admin,input,token);
  assert.equal(saved.intermediaryId,null);
  assert.deepEqual(await core.registerCashAccount(admin,input,token),saved);
  assert.deepEqual((await core.list(admin,'nostroclearing')).find(row=>row.cash_account_id===saved.id).intermediaries,[]);
 }
 const ledger=await ledgerSnapshot();
 for(const details of [{},blank]){
  const input={cashAccountId:cash.id,...details},token=key();
  const saved=await core.registerIntermediaryBank(admin,input,token);
  assert.deepEqual(saved,{id:null,cashAccountId:cash.id});
  assert.deepEqual(await core.registerIntermediaryBank(admin,input,token),saved);
 }
 assert.equal(await count(),before);
 assert.deepEqual(await ledgerSnapshot(),ledger);
 assert.equal((await pool.query('SELECT count(*)::int AS count FROM avis_core_v2.ledger_journals')).rows[0].count,journals);
 await assert.rejects(core.registerIntermediaryBank(admin,{cashAccountId:randomUUID()},key()),e=>e.code==='NOSTRO_ACCOUNT_NOT_FOUND');
 await assert.rejects(core.registerIntermediaryBank({id:'customer',admin:false},{cashAccountId:cash.id},key()),e=>e.code==='FORBIDDEN');
});

test('every intermediary detail can be supplied independently through combined and standalone registration',async()=>{
 const samples={bankName:'Partial bank',bankAddress:'18 Transit Road',accountName:'Transit holder',
  aba:'021000021',reference:'PARTIAL-REFERENCE',bic:'CHASUS33XXX',accountNumber:'PARTIAL-ACCOUNT'};
 for(const [field,value]of Object.entries(samples)){
  const details={[field]:'  '+value+'  '};
  const ledger=await ledgerSnapshot();
  const standalone=await core.registerIntermediaryBank(admin,{cashAccountId:cash.id,...details},key());
  assert.ok(standalone.id);
  assert.deepEqual(await ledgerSnapshot(),ledger);
  const combined=await core.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Partial details '+field,
   bic:'TESTGB2LXXX',accountNumber:randomUUID(),currency:'EUR',intermediary:details},key());
  assert.ok(combined.intermediaryId);
  for(const [id,cashId]of [[standalone.id,cash.id],[combined.intermediaryId,combined.id]]){
   const row=await intermediary(id);
   assert.equal(row.cash_account_id,cashId);
   for(const [name,column]of Object.entries(directoryFields))assert.equal(row[column],name===field?value:null,column);
  }
 }
});

test('omitted intermediary edits preserve records while explicit blank edits keep the selected identity and binding',async()=>{
 const opened=await core.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Optional edit bank',
  bic:'TESTGB2LXXX',accountNumber:randomUUID(),currency:'EUR'},key());
 const details={bankName:'Keep identity',bankAddress:'9 Correspondent Street',accountName:'Transit account',
  reference:'KEEP-BINDING',aba:'021000021',bic:'CHASUS33XXX',accountNumber:'INT-BOUND'};
 const selected=await core.registerIntermediaryBank(admin,{cashAccountId:opened.id,...details},key());
 const unselected=await core.registerIntermediaryBank(admin,{cashAccountId:opened.id,bankName:'Unselected',reference:'KEEP-OTHER'},key());
 const original=await intermediary(selected.id),otherBefore=await intermediary(unselected.id),ledger=await ledgerSnapshot();
 const edit={cashAccountId:opened.id,bankName:'Optional edit bank',bankAddress:'1 NOSTRO Street',accountName:'NOSTRO holder',reference:'EXTERNAL-ACCOUNT'};
 for(const incoming of [undefined,null,{},Object.fromEntries(Object.keys(directoryFields).map(name=>[name,' ']))]){
  await core.updateCashAccountDetails(admin,{...edit,...(incoming===undefined?{}:{intermediary:incoming})},key());
  assert.deepEqual(await intermediary(selected.id),original);
 }
 const blank=Object.fromEntries(Object.keys(directoryFields).map(name=>[name,' ']));
 const saved=await core.updateCashAccountDetails(admin,{...edit,intermediary:{intermediaryId:selected.id,...blank}},key());
 assert.equal(saved.intermediaryId,selected.id);
 let row=await intermediary(selected.id);
 assert.equal(row.intermediary_id,selected.id);
 assert.equal(row.cash_account_id,opened.id);
 assert.equal(row.created_by,original.created_by);
 assert.deepEqual(row.created_at,original.created_at);
 assert.ok(Object.values(directoryFields).every(column=>row[column]===null));
 assert.deepEqual(await intermediary(unselected.id),otherBefore);
 const amended=await core.updateIntermediaryBank(admin,{intermediaryId:selected.id,accountName:'Only account name'},key());
 assert.deepEqual(amended,{id:selected.id,cashAccountId:opened.id});
 row=await intermediary(selected.id);
 assert.equal(row.account_name,'Only account name');
 assert.ok(Object.entries(directoryFields).filter(([name])=>name!=='accountName').every(([,column])=>row[column]===null));
 const token=key(),input={intermediaryId:selected.id,...blank};
 const cleared=await core.updateIntermediaryBank(admin,input,token);
 assert.deepEqual(await core.updateIntermediaryBank(admin,input,token),cleared);
 row=await intermediary(selected.id);
 assert.ok(Object.values(directoryFields).every(column=>row[column]===null));
 assert.equal(row.cash_account_id,opened.id);
 assert.deepEqual(await intermediary(unselected.id),otherBefore);
 assert.deepEqual(await ledgerSnapshot(),ledger);
});

test('optional intermediary fields retain supplied routing validation, selected-account ownership and atomic rollback',async()=>{
 const saved=await core.registerIntermediaryBank(admin,{cashAccountId:cash.id,bankName:'Protected intermediary'},key());
 const original=await intermediary(saved.id),ledger=await ledgerSnapshot();
 const base={institutionType:'CORRESPONDENT_BANK',institutionName:'Rejected combined account',bic:'TESTGB2LXXX',
  accountNumber:randomUUID(),currency:'EUR'};
 for(const [field,value]of [['aba','123456789'],['bic','bad'],['bankName',false],['accountNumber','a'.repeat(129)]]){
  await assert.rejects(core.registerIntermediaryBank(admin,{cashAccountId:cash.id,[field]:value},key()),e=>e.code==='INVALID_FIELD'&&e.field===field);
  await assert.rejects(core.updateIntermediaryBank(admin,{intermediaryId:saved.id,[field]:value},key()),e=>e.code==='INVALID_FIELD'&&e.field===field);
  const incomingField='intermediary'+field[0].toUpperCase()+field.slice(1);
  await assert.rejects(core.registerCashAccount(admin,{...base,intermediary:{[field]:value}},key()),e=>e.code==='INVALID_FIELD'&&e.field===incomingField);
 }
 for(const id of [undefined,'','not-a-uuid'])await assert.rejects(core.updateIntermediaryBank(admin,{intermediaryId:id},key()),e=>e.code==='INVALID_FIELD'&&e.field==='intermediaryId');
 await assert.rejects(core.updateIntermediaryBank(admin,{intermediaryId:randomUUID()},key()),e=>e.code==='INTERMEDIARY_NOT_FOUND');
 await assert.rejects(core.registerCashAccount(admin,{...base,intermediary:{intermediaryId:'not-a-uuid'}},key()),e=>e.code==='INVALID_FIELD'&&e.field==='intermediaryId');
 const cashCount=(await pool.query('SELECT count(*)::int AS count FROM avis_core_v2.external_cash_accounts')).rows[0].count;
 await assert.rejects(core.registerCashAccount(admin,{...base,intermediary:{intermediaryId:saved.id}},key()),e=>e.code==='INTERMEDIARY_NOT_FOUND');
 assert.equal((await pool.query('SELECT count(*)::int AS count FROM avis_core_v2.external_cash_accounts')).rows[0].count,cashCount);
 const otherCash=(await pool.query('SELECT cash_account_id FROM avis_core_v2.external_cash_accounts WHERE cash_account_id<>$1 LIMIT 1',[cash.id])).rows[0].cash_account_id;
 const foreign=await core.registerIntermediaryBank(admin,{cashAccountId:otherCash,accountNumber:'FOREIGN-BOUND-ACCOUNT'},key());
 const foreignBefore=await intermediary(foreign.id);
 const parent=(await pool.query('SELECT * FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1',[cash.id])).rows[0];
 await assert.rejects(core.updateCashAccountDetails(admin,{cashAccountId:cash.id,bankName:'Must roll back',bankAddress:'Address',
  accountName:'Account',reference:'Ref',intermediary:{intermediaryId:foreign.id}},key()),e=>e.code==='INTERMEDIARY_NOT_FOUND');
 assert.deepEqual((await pool.query('SELECT * FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1',[cash.id])).rows[0],parent);
 assert.deepEqual(await intermediary(saved.id),original);
 assert.deepEqual(await intermediary(foreign.id),foreignBefore);
 assert.deepEqual(await ledgerSnapshot(),ledger);
});
