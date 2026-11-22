import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {CustomerAccess} from '../src/customer-access.mjs';
import {createBankServer} from '../server.mjs';
import {ABIQ_PARTITIONS,parseAbiqIban,resolveAbiqAccount} from '../src/avispay-core-accounts.mjs';
import {processAbiqRequest} from '../src/abiq-interface.mjs';
let pool,db,core,common,suspense,server,base;
const admin={id:'fineract:999',admin:true},customer={id:'fineract:101',admin:false,customerUserId:'2'},key=()=>randomUUID();
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const u=new URL(process.env.TEST_DATABASE_URL);assert.equal(u.pathname,'/avispay_ci');pool=new pg.Pool({connectionString:u.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};}
 const c=await pool.connect();try{await migrate(c);}finally{c.release();}core=new AccountManagement(pool);
});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(db)await db.close();else await pool.end();});
test('Common and Suspense account types create zero-balance backoffice accounts without changing customer records',async()=>{
 const accounts=await core.list(admin,'accounts'),ledger=await core.list(admin,'ledger'),body={accountType:'COMMON',fullName:'Settlement common',currencies:['EUR','EUR']},k=key();
 common=await core.openAccount(admin,body,k);assert.deepEqual(await core.openAccount(admin,body,k),common);assert.equal(common.managedAccounts.length,1);
 suspense=await core.openAccount(admin,{accountType:'SUSPENSE',fullName:'Review suspense',currencies:['EUR']},key());
 assert.deepEqual(await core.list(admin,'accounts'),accounts);
 const now=await core.list(admin,'ledger');for(const row of ledger)assert.deepEqual(now.find(a=>a.account_id===row.account_id),row);
 const managed=await core.list(admin,'backofficeaccounts');assert.equal(managed.length,2);assert.ok(managed.every(a=>Number(a.available_balance)===0));assert.ok(managed.some(a=>a.account_type==='COMMON'&&a.display_name==='Settlement common'));assert.ok(managed.some(a=>a.account_type==='SUSPENSE'));
 for(const opened of [common,suspense]){
  const row=managed.find(a=>a.account_id===opened.id);assert.equal(row.abiq_iban,opened.managedAccounts[0].abiqIban);assert.equal(row.account_reference,row.abiq_iban);assert.equal(parseAbiqIban(row.abiq_iban).currency,row.currency_code);assert.equal(row.sub_account_code,undefined);
 }
 assert.equal(new Set(managed.map(a=>a.abiq_iban)).size,2);
 assert.equal((await core.list(admin,'transactions')).length,0);
 await assert.rejects(core.openAccount(admin,{...body,accountType:'TREASURY'},key()),/INVALID_FIELD/);
 await assert.rejects(core.openAccount(admin,{...body,currencies:['FAKE']},key()),/INVALID_FIELD/);
 const countBefore=(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_accounts')).rows[0].n;
 for(const accountType of ['COMMON','SUSPENSE','PERSONAL','BUSINESS'])for(const currency of ['BTC','AG','AGi'])await assert.rejects(core.openAccount(admin,{...body,accountType,currencies:[currency]},key()),/INVALID_FIELD/);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_accounts')).rows[0].n,countBefore);
});
test('Personal and Business choices retain automatic ABIQ provisioning',async()=>{
 for(const accountType of ['PERSONAL','BUSINESS']){const r=await core.openAccount(admin,{accountType,fullName:'Account type fixture '+accountType,currencies:['EUR']},key());assert.match(r.accounts[0].abiqIban,/^TN\d{2}AVIP/);}
});
test('Open account selects an existing registered holder, retaining identity, balances and ABIQ routing',async()=>{
 const holder=await core.openAccount(admin,{accountType:'BUSINESS',fullName:'Registered holder fixture',currencies:['EUR']},key());
 const beforeCount=(await core.list(admin,'customers')).length;
 const beforeEur=(await core.list(admin,'accounts')).find(a=>String(a.user_id)===holder.userId&&a.currency_code==='EUR');
 const input={accountType:'BUSINESS',userId:holder.userId,currencies:['USD']},replay=key();
 const opened=await core.openAccount(admin,input,replay);
 assert.deepEqual(await core.openAccount(admin,input,replay),opened);
 assert.equal(opened.userId,holder.userId);assert.equal(opened.fullName,'Registered holder fixture');
 assert.equal(parseAbiqIban(opened.accounts[0].abiqIban).currency,'USD');
 const customers=await core.list(admin,'customers');
 assert.equal(customers.length,beforeCount);
 assert.equal(customers.filter(u=>String(u.user_id)===holder.userId).length,1);
 assert.deepEqual((await core.list(admin,'accounts')).find(a=>a.abiq_iban===beforeEur.abiq_iban),beforeEur);
 const funded=(await core.list(admin,'accounts')).filter(a=>String(a.user_id)===holder.userId&&a.currency_code==='USD');
 assert.equal(funded.length,1);assert.equal(funded[0].abiq_iban,opened.accounts[0].abiqIban);
 const ledgers=(await core.list(admin,'ledger')).filter(a=>String(a.user_id)===holder.userId&&a.currency_code==='USD');
 for(const scope of ['FUNDING','CUSTODY','MARGIN'])assert.ok(ledgers.some(a=>a.wallet_scope===scope));
 const reopened=await core.openAccount(admin,input,key());
 assert.equal(reopened.accounts[0].abiqIban,opened.accounts[0].abiqIban);
 await assert.rejects(core.openAccount(admin,{...input,accountType:'PERSONAL'},key()),/ACCOUNT_HOLDER_NOT_FOUND/);
 await assert.rejects(core.openAccount(admin,{...input,userId:'9999999999'},key()),/ACCOUNT_HOLDER_NOT_FOUND/);
 await assert.rejects(core.openAccount(admin,{...input,fullName:'New identity'},key()),/INVALID_FIELD/);
 await assert.rejects(core.openAccount(admin,{...input,userId:'invalid'},key()),/INVALID_FIELD/);
 await assert.rejects(core.openAccount({...admin,customerUserId:'2'},input,key()),/FORBIDDEN/);
 assert.equal((await core.list(admin,'customers')).length,beforeCount);
});

test('funding, margin and securities custody accounts have distinct ABIQ numbers without changing payment eligibility',async()=>{
 const access=new CustomerAccess(core),summaries=await access.list(customer,'accountsummaries'),funding=await access.list(customer,'accounts');
 assert.equal(summaries.length,funding.length*3);assert.ok(summaries.every(a=>String(a.user_id)==='2'&&a.network===null));
 assert.equal(new Set(summaries.map(a=>a.abiq_iban)).size,summaries.length);
 const ledger=await access.list(customer,'ledger');
 for(const account of summaries){
  assert.equal(parseAbiqIban(account.abiq_iban).currency,account.currency_code);assert.equal(account.account_reference,account.abiq_iban);
  assert.equal(ledger.find(a=>a.account_id===account.account_id).abiq_iban,account.abiq_iban);
  const detail=await access.invoke(customer,'accountDetails',{accountId:account.account_id});assert.equal(detail.account.abiq_iban,account.abiq_iban);assert.equal(detail.account.wallet_scope,account.wallet_scope);
  const route=await resolveAbiqAccount(pool,{identifier:account.abiq_iban,currency:account.currency_code});
  if(account.wallet_scope==='FUNDING'){assert.equal(route.ledger_account_id,account.account_id);assert.ok(funding.some(a=>a.abiq_iban===account.abiq_iban));}
  else{assert.equal(route,null);assert.ok(!funding.some(a=>a.abiq_iban===account.abiq_iban));}
 }
 const other=(await core.list(admin,'accountsummaries')).find(a=>String(a.user_id)==='1'&&a.wallet_scope==='CUSTODY');
 await assert.rejects(access.invoke(customer,'accountDetails',{accountId:other.account_id}),/FORBIDDEN/);
 for(const account of [...summaries,...await core.list(admin,'backofficeaccounts')]){
  const result=await processAbiqRequest(core,admin,{fitREQUEST:{HEADER:{requestID:key().replaceAll('-',''),function:'IBANCHECK'},ABIQ_INFO:{abiqIBAN:account.abiq_iban}}});
  assert.equal(result.fitRESPONSE.RESPONSE_INFO.responseCODE,'00');
 }
 for(const account of await core.list(admin,'backofficeaccounts'))assert.equal(await resolveAbiqAccount(pool,{identifier:account.abiq_iban,currency:account.currency_code}),null);
});
test('crypto wallet and crypto suspense ledger entries never become bank accounts or receive ABIQ numbers',async()=>{
 const cryptoIds=[await core.system(pool,'SUSPENSE_INBOUND','BTC','CRYPTO_REVIEW'),await core.system(pool,'COMMON_POOL','AGi','CRYPTO_COMMON'),await core.networkAccount(pool,'USER','AG','ETHEREUM','CRYPTO_EXCLUSION','2')];
 const before=(await pool.query('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=ANY($1::uuid[]) ORDER BY account_id',[cryptoIds])).rows;
 for(const view of ['backofficeaccounts','accountsummaries']){
  const rows=await core.list(admin,view);assert.ok(rows.every(a=>a.network===null&&Object.hasOwn(ABIQ_PARTITIONS,a.currency_code)));assert.ok(rows.every(a=>!cryptoIds.includes(a.account_id)));
 }
 const ledger=await core.list(admin,'ledger');for(const id of cryptoIds){assert.equal(ledger.find(a=>a.account_id===id).abiq_iban,null);await assert.rejects(core.accountDetails(admin,{accountId:id}),/ACCOUNT_NOT_FOUND/);}
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.abiq_account_identifiers WHERE ledger_account_id=ANY($1::uuid[])',[cryptoIds])).rows[0].n,0);
 assert.deepEqual((await pool.query('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=ANY($1::uuid[]) ORDER BY account_id',[cryptoIds])).rows,before);
});
test('backoffice statements include only the selected account, paginate all entries and keep exact totals',async()=>{
 await core.operation(admin,'STATEMENT_FIXTURE',{},key(),async(d,k)=>{
  const offset=await core.system(d,'TREASURY','EUR','STATEMENT_FIXTURE','ASSET');
  for(let i=0;i<101;i++)await core.post(d,admin,k+':'+i,'FIXTURE','Common '+i,[{accountId:offset,direction:'DEBIT',amount:'1'},{accountId:common.id,direction:'CREDIT',amount:'1'}]);
  const journalId=await core.post(d,admin,k+':suspense','FIXTURE','Suspense only',[{accountId:common.id,direction:'DEBIT',amount:'2'},{accountId:suspense.id,direction:'CREDIT',amount:'2'}]);return {journalId};
 });
 const a=await core.accountStatement(admin,{accountId:common.id});assert.equal(a.entries.length,100);assert.ok(a.nextCursor);assert.equal(a.totals.incoming,'101.000000000000000000');assert.equal(a.totals.outgoing,'2.000000000000000000');assert.equal(a.account.available_balance,'99.000000000000000000');
 const b=await core.accountStatement(admin,{accountId:common.id,before:a.nextCursor});assert.equal(b.entries.length,2);assert.equal(b.nextCursor,null);assert.equal(new Set([...a.entries,...b.entries].map(e=>String(e.entry_id))).size,102);
 const s=await core.accountStatement(admin,{accountId:suspense.id});assert.equal(s.entries.length,1);assert.equal(s.entries[0].reference_id,'Suspense only');assert.equal(s.account.available_balance,'2.000000000000000000');
 await assert.rejects(core.accountStatement(admin,{accountId:common.id,before:'9999999999999999999'}),/INVALID_FIELD/);
 const userAccount=(await pool.query("SELECT ledger_account_id FROM avis_core_v2.abiq_routing_bridge WHERE user_id=2 LIMIT 1")).rows[0].ledger_account_id;
 await assert.rejects(core.accountStatement(admin,{accountId:userAccount}),/ACCOUNT_NOT_FOUND/);
 const automatic=await core.system(pool,'SUSPENSE_OUTBOUND','USD','EXISTING_AUTOMATIC');assert.ok((await core.list(admin,'backofficeaccounts')).some(a=>a.account_id===automatic));
});
test('portfolio aggregates institutional holdings once and scopes customer holdings separately',async()=>{
 const first=await core.networkAccount(pool,'USER','AG','ETHEREUM','CRYPTO','1'),second=await core.networkAccount(pool,'USER','AG','ETHEREUM','SECOND','1'),own=await core.networkAccount(pool,'USER','AG','ETHEREUM','CRYPTO','2');
 await core.operation(admin,'PORTFOLIO_FIXTURE',{},key(),async(d,k)=>{
  const asset=(await d.query("INSERT INTO avis_core_v2.ledger_accounts(owner_type,sub_account_code,currency_code,network,account_category) VALUES('HOT_WALLET','PORTFOLIO_FIXTURE','AG','ETHEREUM','ASSET') RETURNING account_id")).rows[0].account_id;
  return {journalId:await core.post(d,admin,k,'FIXTURE','Portfolio holdings',[{accountId:asset,direction:'DEBIT',amount:'22'},{accountId:first,direction:'CREDIT',amount:'12'},{accountId:second,direction:'CREDIT',amount:'3'},{accountId:own,direction:'CREDIT',amount:'7'}])};
 });
 const institutional=await core.list(admin,'portfolio');assert.equal(institutional.length,1);assert.equal(institutional[0].available_balance,'15.000000000000000000');assert.deepEqual(Object.keys(institutional[0]).sort(),['available_balance','currency_code','locked_balance','network']);
 const scoped=await new CustomerAccess(core).list(customer,'portfolio');assert.equal(scoped[0].available_balance,'7.000000000000000000');
});
test('account summaries and row details expose exact credit/debit/reference for each permitted account',async()=>{
 const before=await core.list(admin,'accounts'),own=(await core.list({...admin,customerUserId:'2'},'accountsummaries')).find(a=>a.currency_code==='EUR');
 await core.operation(admin,'ACCOUNT_ROWS_FIXTURE',{},key(),async(d,k)=>{
  const offset=await core.system(d,'TREASURY','EUR','ROW_FIXTURE','ASSET');return {journalId:await core.post(d,admin,k,'FIXTURE','Row reference',[{accountId:offset,direction:'DEBIT',amount:'12.34'},{accountId:own.account_id,direction:'CREDIT',amount:'12.34'}])};
 });
 const summary=(await new CustomerAccess(core).list(customer,'accountsummaries')).find(a=>a.account_id===own.account_id);assert.equal(summary.credit,'12.340000000000000000');assert.equal(summary.debit,'0');assert.equal(summary.reference_id,'Row reference');
 const details=await new CustomerAccess(core).invoke(customer,'accountDetails',{accountId:own.account_id});assert.equal(details.entries.length,1);assert.equal(details.account.abiq_bic,'AVIPTN64XXX');
 const movement=await new CustomerAccess(core).invoke(customer,'movementDetails',{accountId:own.account_id,entryId:String(details.entries[0].entry_id)});assert.equal(movement.entry.reference_id,'Row reference');assert.equal(movement.entry.amount,'12.340000000000000000');assert.ok(movement.entry.journal_id);assert.equal(movement.entry.request_payload,undefined);
 await assert.rejects(core.movementDetails(admin,{accountId:common.id,entryId:String(details.entries[0].entry_id)}),/NOT_FOUND/);
 await assert.rejects(new CustomerAccess(core).invoke(customer,'accountDetails',{accountId:common.id}),/FORBIDDEN/);
 assert.equal((await core.list(admin,'accounts')).length,before.length);
 const commonSummary=(await core.list(admin,'backofficeaccounts')).find(a=>a.account_id===common.id);assert.equal(commonSummary.credit,'101.000000000000000000');assert.equal(commonSummary.debit,'2.000000000000000000');assert.equal(commonSummary.reference_id,'Suspense only');
});
test('customer sessions cannot list, create or read Common/Suspense accounts or statements',async()=>{
 const access=new CustomerAccess(core);await assert.rejects(access.list(customer,'backofficeaccounts'),/FORBIDDEN/);await assert.rejects(access.invoke(customer,'accountStatement',{accountId:common.id}),/FORBIDDEN/);await assert.rejects(core.openAccount({...customer,admin:true},{accountType:'COMMON'},key()),/FORBIDDEN/);
 await core.bindCustomerLogin(admin,{fineractUserId:'101',userId:'2'},key());
 server=createBankServer({pool,secureCookies:false,authenticate:async u=>u==='admin'?{...admin,username:u}:{id:'fineract:101',username:u,admin:false}});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 const login=async username=>{const r=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username,password:'fixture'})});return {cookie:r.headers.get('set-cookie')?.split(';')[0],...await r.json()};};
 const request=async(s,path,body)=>{const r=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{cookie:s.cookie,origin:base,'content-type':'application/json','x-csrf-token':s.csrf,'idempotency-key':key()},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
 const user=await login('user');for(const path of ['views/backofficeaccounts','backoffice-accounts/'+common.id+'/statement'])assert.equal((await request(user,path)).status,403);
 assert.equal((await request(user,'accounts/open',{accountType:'COMMON',fullName:'Forbidden',currencies:['EUR']})).status,403);assert.equal((await request(user,'views/portfolio')).body.rows[0].available_balance,'7.000000000000000000');
 const operator=await login('admin');assert.equal((await request(operator,'backoffice-accounts/'+common.id+'/statement')).status,200);assert.equal((await request(operator,'views/backofficeaccounts')).status,200);assert.equal((await request(operator,'views/portfolio')).body.rows[0].available_balance,'15.000000000000000000');
 const own=(await request(user,'views/accountsummaries')).body.rows.find(a=>a.currency_code==='EUR');assert.equal(own.user_id.toString(),'2');const detail=await request(user,'accounts/'+own.account_id);assert.equal(detail.status,200);const entryId=String(detail.body.entries[0].entry_id);assert.equal((await request(user,'accounts/'+own.account_id+'/movements/'+entryId)).status,200);assert.equal((await request(user,'accounts/'+common.id)).status,403);assert.equal((await request(user,'accounts/'+common.id+'/movements/'+entryId)).status,403);
 const existingHttp=await request(operator,'accounts/open',{accountType:'PERSONAL',userId:'2',currencies:['SGD']});
 assert.equal(existingHttp.status,200);assert.equal(existingHttp.body.userId,'2');
 assert.equal(parseAbiqIban(existingHttp.body.accounts[0].abiqIban).currency,'SGD');
 const badHttp=await request(operator,'accounts/open',{accountType:'BUSINESS',userId:'2',currencies:['EUR']});
 assert.equal(badHttp.status,404);
 const duplicateHttp=await request(user,'accounts/open',{accountType:'PERSONAL',userId:'2',currencies:['SGD']});
 assert.equal(duplicateHttp.status,403);
 const created=await request(operator,'accounts/open',{accountType:'SUSPENSE',fullName:'HTTP creation',currencies:['GBP']});assert.equal(created.status,200);assert.equal(created.body.accountType,'SUSPENSE');assert.equal(parseAbiqIban(created.body.managedAccounts[0].abiqIban).currency,'GBP');
});
