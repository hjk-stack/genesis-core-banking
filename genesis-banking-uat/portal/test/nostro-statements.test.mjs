import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {PaymentServer} from '../src/payments.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {NostroStatements,NOSTRO_STATEMENT_PAGE_SIZE} from '../src/nostro-statements.mjs';
import {createBankServer} from '../server.mjs';

const admin={id:'nostro-statement-admin',admin:true},key=()=>randomUUID();
let db,pool,core,statements,cash,other,profile,imported;
const register=name=>core.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:name,
 bic:'TESTGB2LXXX',accountNumber:'EXTERNAL-'+name,currency:'EUR'},key());
const snapshot=async()=>Object.fromEntries(await Promise.all([
 ['external_cash_accounts','cash_account_id'],['ledger_accounts','account_id'],['ledger_journals','journal_id'],
 ['ledger_entries','entry_id'],['nostro_manual_mirrors','mirror_id'],['clearing_statements','statement_id'],
 ['clearing_statement_entries','statement_id,bank_reference'],['operation_audit','audit_id']
].map(async([table,order])=>[table,(await pool.query('SELECT * FROM avis_core_v2.'+table+' ORDER BY '+order)).rows])));

before(async()=>{
 if(process.env.TEST_DATABASE_URL){
  const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
 }else{
  db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release(){}})};
 }
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 core=new PaymentServer(pool);statements=new NostroStatements(pool);
 cash=await register('Statement Bank');other=await register('Other Statement Bank');
 profile=await core.registerBankConnector(admin,{profileId:'STATEMENT_FIXTURE',name:'Statement fixture',cashAccountId:cash.id,
  protocol:'BANK_API',localBic:'TESTDEFFXXX',peerBic:'TESTGB2LXXX',endpoint:'https://bank.example.test/iso20022',credentialReference:'AVIS_CONNECTOR_STATEMENT_FIXTURE'},key());
 await core.mirrorNostroMovement(admin,{cashAccountId:cash.id,currency:'EUR',direction:'CREDIT',rail:'BANK_API',
  externalReference:'INTERNAL-MIRROR-ONLY',amount:'10000'},key());
 imported=await core.reconcileStatement(admin,{profileId:profile.id,reference:'BANK-STATEMENT-EXACT',currency:'EUR',
  openingBalance:'100.000000000000000001',closingBalance:'103.000000000000000001',
  entries:[{bankReference:'BANK-CREDIT',direction:'CREDIT',amount:'7.500000000000000001'},
   {bankReference:'BANK-DEBIT',direction:'DEBIT',amount:'4.500000000000000001'}]},key());
});
after(async()=>{if(db)await db.close();else await pool.end()});

test('external statement reads retain bank values and directions without showing or changing internal ledgers',async()=>{
 const before=await snapshot(),queries=[];
 const reader=new NostroStatements({query:(sql,params)=>{queries.push(sql);return pool.query(sql,params)}});
 const page=await reader.list(admin,{cashAccountId:cash.id});
 assert.deepEqual(page.account,{cashAccountId:cash.id,institutionName:'Statement Bank',accountNumber:'EXTERNAL-Statement Bank',bic:'TESTGB2LXXX',currency:'EUR'});
 assert.equal(page.statements.length,1);assert.equal(page.nextCursor,null);
 const detail=await reader.read(admin,{cashAccountId:cash.id,statementId:imported.id});
 assert.deepEqual(detail.statement,page.statements[0]);assert.equal(detail.statement.reference,'BANK-STATEMENT-EXACT');
 assert.equal(detail.statement.openingBalance,'100.000000000000000001');assert.equal(detail.statement.closingBalance,'103.000000000000000001');
 assert.equal(detail.statement.entryCount,2);assert.match(detail.statement.importedAt,/^\d{4}-\d{2}-\d{2}T/);
 assert.deepEqual(detail.entries,[{bankReference:'BANK-CREDIT',direction:'CREDIT',amount:'7.500000000000000001'},
  {bankReference:'BANK-DEBIT',direction:'DEBIT',amount:'4.500000000000000001'}]);
 const payload=JSON.stringify(detail);
 for(const forbidden of ['INTERNAL-MIRROR-ONLY','10000','ledgerAccountId','runningBalance','available_balance','locked_balance','bookingDate'])assert.ok(!payload.includes(forbidden),forbidden);
 assert.ok(queries.every(sql=>/^SELECT\b/.test(sql)));assert.ok(queries.every(sql=>!/(ledger_accounts|ledger_entries|ledger_journals|nostro_manual_mirrors)/.test(sql)));
 assert.deepEqual(await snapshot(),before);
});

test('statement access rejects unauthenticated and customer workspaces before reading data',async()=>{
 let queries=0;const reader=new NostroStatements({query:async()=>{queries++;throw Error('Authorization must precede data reads')}});
 for(const actor of [null,{}, {id:'customer',admin:false},{id:'operator',admin:true,customerUserId:'2'}]){
  await assert.rejects(reader.list(actor,{cashAccountId:cash.id}),{code:'FORBIDDEN',status:403});
  await assert.rejects(reader.read(actor,{cashAccountId:cash.id,statementId:imported.id}),{code:'FORBIDDEN',status:403});
 }
 assert.equal(queries,0);
});

test('statement details stay bound to their correspondent and empty accounts stay empty',async()=>{
 const page=await statements.list(admin,{cashAccountId:other.id});assert.deepEqual(page.statements,[]);assert.equal(page.nextCursor,null);
 await assert.rejects(statements.read(admin,{cashAccountId:other.id,statementId:imported.id}),{code:'NOSTRO_STATEMENT_NOT_FOUND',status:404});
 await assert.rejects(statements.read(admin,{cashAccountId:cash.id,statementId:key()}),{code:'NOSTRO_STATEMENT_NOT_FOUND',status:404});
 await assert.rejects(statements.list(admin,{cashAccountId:cash.accountId}),{code:'NOSTRO_ACCOUNT_NOT_FOUND',status:404});
 await assert.rejects(statements.list(admin,{cashAccountId:'not-an-account'}),{code:'INVALID_FIELD',field:'cashAccountId'});
 await assert.rejects(statements.read(admin,{cashAccountId:cash.id,statementId:'not-a-statement'}),{code:'INVALID_FIELD',field:'statementId'});
});

test('statement pagination is deterministic at identical database timestamps and validates account-bound cursors',async()=>{
 const paged=await register('Paged Statement Bank'),ids=Array.from({length:NOSTRO_STATEMENT_PAGE_SIZE+2},key).sort().reverse();
 await pool.query(`INSERT INTO avis_core_v2.clearing_statements
  (statement_id,cash_account_id,provider_reference,currency_code,opening_balance,closing_balance,payload_hash,imported_at)
  SELECT id,$1,'PAGE-'||id,'EUR',0,0,'fixture','2026-11-23T12:00:00.123456Z' FROM unnest($2::uuid[]) AS source(id)`,[paged.id,ids]);
 const first=await statements.list(admin,{cashAccountId:paged.id});assert.equal(first.statements.length,NOSTRO_STATEMENT_PAGE_SIZE);assert.ok(first.nextCursor);
 const second=await statements.list(admin,{cashAccountId:paged.id,before:first.nextCursor});assert.equal(second.statements.length,2);assert.equal(second.nextCursor,null);
 assert.deepEqual([...first.statements,...second.statements].map(row=>row.statementId),ids);
 assert.ok([...first.statements,...second.statements].every(row=>row.entryCount===0));
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 for(const before of [key(),'e30','W10=','a'.repeat(257),encode([other.id,ids[0]]),encode([paged.id,key()]),encode([paged.id,"'; DROP TABLE bank; --"])])
  await assert.rejects(statements.list(admin,{cashAccountId:paged.id,before}),{code:'INVALID_FIELD',field:'before'});
 await assert.rejects(statements.list(admin,{cashAccountId:other.id,before:first.nextCursor}),{code:'INVALID_FIELD',field:'before'});
});

test('the maximum imported statement is returned completely with exact decimal amounts',async()=>{
 const entries=Array.from({length:500},(_,i)=>({bankReference:'ENTRY-'+String(i).padStart(3,'0'),direction:'CREDIT',amount:'0.000000000000000001'}));
 const receipt=await core.reconcileStatement(admin,{profileId:profile.id,reference:'BANK-STATEMENT-500',currency:'EUR',openingBalance:'0',closingBalance:'0.000000000000000500',entries},key());
 const detail=await statements.read(admin,{cashAccountId:cash.id,statementId:receipt.id});
 assert.equal(detail.statement.entryCount,500);assert.deepEqual(detail.entries,entries);assert.equal(detail.statement.closingBalance,'0.000000000000000500');
});

test('HTTP statement routes enforce session, admin workspace, correspondent ownership and read-only methods',async()=>{
 const accounts=new AccountManagement(pool),user=await accounts.openAccount(admin,{accountType:'PERSONAL',fullName:'External statement access customer',currencies:['EUR']},key());
 await accounts.bindCustomerLogin(admin,{fineractUserId:'494',userId:user.userId},key());
 const server=createBankServer({pool,secureCookies:false,authenticate:async username=>username==='operator'?{...admin,username}:{id:'fineract:494',admin:false,username}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const path='/api/nostro/'+cash.id+'/statements',detailPath=path+'/'+imported.id;
 const login=async username=>{const response=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username,password:'fixture'})});assert.equal(response.status,200);return {cookie:response.headers.get('set-cookie').split(';')[0],...await response.json()}};
 try{
  assert.equal((await fetch(base+path)).status,401);
  const customer=await login('customer');assert.equal((await fetch(base+path,{headers:{cookie:customer.cookie}})).status,403);
  assert.equal((await fetch(base+detailPath,{headers:{cookie:customer.cookie}})).status,403);
  const operator=await login('operator'),headers={cookie:operator.cookie},before=await snapshot();
  const listResponse=await fetch(base+path,{headers});assert.equal(listResponse.status,200);assert.deepEqual(await listResponse.json(),await statements.list(admin,{cashAccountId:cash.id}));
  const detailResponse=await fetch(base+detailPath,{headers});assert.equal(detailResponse.status,200);assert.deepEqual(await detailResponse.json(),await statements.read(admin,{cashAccountId:cash.id,statementId:imported.id}));
  assert.equal((await fetch(base+'/api/nostro/'+other.id+'/statements/'+imported.id,{headers})).status,404);
  assert.equal((await fetch(base+path+'?before=not-a-cursor',{headers})).status,422);
  assert.equal((await fetch(base+path,{method:'POST',headers:{...headers,origin:base,'content-type':'application/json','x-csrf-token':operator.csrf},body:'{}'})).status,405);
  assert.equal((await fetch(base+detailPath,{method:'DELETE',headers})).status,405);
  const workspace=await fetch(base+'/api/workspace',{method:'POST',headers:{...headers,origin:base,'content-type':'application/json','x-csrf-token':operator.csrf},body:JSON.stringify({userId:user.userId})});assert.equal(workspace.status,200);
  assert.equal((await fetch(base+path,{headers})).status,403);assert.equal((await fetch(base+detailPath,{headers})).status,403);
  assert.deepEqual(await snapshot(),before);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
