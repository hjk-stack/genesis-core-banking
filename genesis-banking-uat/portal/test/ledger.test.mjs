import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {SovereignCore} from '../src/core.mjs';
import {parseAbiqIban} from '../src/avispay-core-accounts.mjs';

let db,pool,core,sameName,treasury,unmapped;
const actor={id:'ledger-details',admin:true};
const rows=async(sql,args=[])=>(await pool.query(sql,args)).rows;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){
  assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
 }else{
  db=new PGlite();
  pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release(){}})};
 }
 const client=await pool.connect();try{await migrate(client);}finally{client.release();}
 core=new SovereignCore(pool);
 // A name is not an institution role. Keep ordinary businesses classified by their record.
 sameName=await core.openCustomer(actor,{fullName:'AVISPay PLC',accountType:'BUSINESS',currencies:['EUR']},'same-name');
 await core.addCurrencies(actor,{userId:'1',participantCode:'AVIS',currencies:['EUR']},'legacy-participant');
 treasury=await core.system(pool,'TREASURY','EUR','CORPORATE_CAPITAL','ASSET');
 unmapped=(await rows(`INSERT INTO avis_core_v2.ledger_accounts(owner_type,user_id,sub_account_code,currency_code,network,wallet_scope,account_category)
  VALUES('USER',2,'ABIQ:AVIP','EUR','EVM','CUSTODY','LIABILITY') RETURNING account_id`))[0].account_id;
 const reserve=await core.system(pool,'CORRESPONDENT_NOSTRO','EUR','VERIFIED_RESERVE','ASSET');
 await core.post(pool,actor,'ledger-fixture','FIXTURE','Funded customer view',[
  {accountId:reserve,direction:'DEBIT',amount:'123.456'},
  {accountId:sameName.accounts[0].accountId,direction:'CREDIT',amount:'123.456'}
 ]);
});
after(async()=>{if(db)await db.close();else await pool.end();});

test('ledger details resolve the full account reference for each holder, currency, participant and scope',async()=>{
 const accounts=await core.list(actor,'accounts'),ledger=await core.list(actor,'ledger');
 assert.equal(new Set(ledger.map(r=>r.account_id)).size,ledger.length);
 for(const account of accounts){
  const group=ledger.filter(r=>String(r.user_id)===String(account.user_id)&&r.currency_code===account.currency_code&&r.sub_account_code==='ABIQ:'+account.participant_code&&r.network===null);
  assert.deepEqual(group.map(r=>r.wallet_scope),['FUNDING','MARGIN','CUSTODY']);
  assert.equal(new Set(group.map(r=>r.abiq_iban)).size,3);
  for(const row of group){
   if(row.wallet_scope==='FUNDING')assert.equal(row.abiq_iban,account.abiq_iban);
   else assert.notEqual(row.abiq_iban,account.abiq_iban);
   assert.equal(parseAbiqIban(row.abiq_iban).currency,row.currency_code);
   assert.equal(row.account_reference,row.abiq_iban);
   assert.equal(row.account_holder,account.full_name);
   assert.equal(row.owner_class,account.account_role);
  }
 }
 const institution=ledger.filter(r=>String(r.user_id)==='1');
 assert.equal(institution.length,12);
 assert.ok(institution.every(r=>r.owner_class==='INSTITUTION'));
 assert.deepEqual(ledger.slice(0,3).map(r=>[String(r.user_id),r.currency_code,r.wallet_scope]),[
  ['1','EUR','FUNDING'],['1','EUR','MARGIN'],['1','EUR','CUSTODY']
 ]);
 assert.ok(ledger.filter(r=>String(r.user_id)===sameName.userId).every(r=>r.owner_class==='CUSTOMER'));
});

test('system FIAT ledgers use their own ABIQ while network ledgers retain wallet references and accounting categories',async()=>{
 const ledger=await core.list(actor,'ledger');
 const capital=ledger.find(r=>r.account_id===treasury);
 assert.equal(capital.owner_class,'TREASURY');
 assert.equal(capital.account_holder,'AVISPay PLC');
 assert.equal(capital.account_reference,capital.abiq_iban);
 assert.equal(capital.sub_account_code,'CORPORATE_CAPITAL');
 assert.equal(capital.account_category,'ASSET');
 assert.equal(parseAbiqIban(capital.abiq_iban).currency,'EUR');
 const network=ledger.find(r=>r.account_id===unmapped);
 assert.equal(network.abiq_iban,null);
 assert.equal(network.account_reference,'ABIQ:AVIP');
 assert.equal(network.account_category,'LIABILITY');
});

test('reading corrected ledger details preserves stored identities, categories, exact balances and journals',async()=>{
 const before={accounts:await rows('SELECT * FROM avis_core_v2.ledger_accounts ORDER BY account_id'),entries:await rows('SELECT * FROM avis_core_v2.ledger_entries ORDER BY entry_id')};
 const ledger=await core.list(actor,'ledger');
 for(const original of before.accounts){
  const row=ledger.find(r=>r.account_id===original.account_id);
  assert.equal(row.owner_type,original.owner_type);
  assert.equal(row.account_category,original.account_category);
  assert.equal(row.available_balance,original.available_balance);
  assert.equal(row.locked_balance,original.locked_balance);
 }
 assert.equal(ledger.find(r=>r.account_id===sameName.accounts[0].accountId).available_balance,'123.456000000000000000');
 assert.deepEqual(await rows('SELECT * FROM avis_core_v2.ledger_accounts ORDER BY account_id'),before.accounts);
 assert.deepEqual(await rows('SELECT * FROM avis_core_v2.ledger_entries ORDER BY entry_id'),before.entries);
 await assert.rejects(core.list({id:'reader'},'ledger'),/FORBIDDEN/);
});
