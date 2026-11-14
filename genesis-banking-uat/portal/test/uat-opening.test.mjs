import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {SovereignCore} from '../src/core.mjs';
import {applyAuthorizedUatOpening,OPENING_REQUEST} from '../src/uat-opening.mjs';
let db,pool,core,original,receipt;
const env={CONTAINER_APP_NAME:'genesis-banking-uat',CONTAINER_APP_ENV_DNS_SUFFIX:'orangemushroom-9faae382.italynorth.azurecontainerapps.io',PGDATABASE:'fineract_default'};
const actor={id:'opening-fixture',admin:true};
const accounts=async()=>(await pool.query('SELECT account_id,available_balance::text,locked_balance::text,wallet_scope FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};}
 const c=await pool.connect();try{await migrate(c);}finally{c.release();}core=new SovereignCore(pool);await core.openCustomer(actor,{fullName:'AVISPay PLC',accountType:'BUSINESS',currencies:['CHF']},'existing-chf-holder');original=await accounts();
});
after(async()=>{if(db)await db.close();else await pool.end();});
test('opening operation rejects any other application, environment or database without posting',async()=>{
 for(const changed of [{CONTAINER_APP_NAME:'production'},{CONTAINER_APP_ENV_DNS_SUFFIX:'other.azurecontainerapps.io'},{PGDATABASE:'production'}])
  await assert.rejects(applyAuthorizedUatOpening(pool,{...env,...changed}),/UAT_OPENING_TARGET_MISMATCH/);
 assert.deepEqual(await accounts(),original);
});
test('a changed holder identity rejects the entire seven-account opening batch',async()=>{
 await pool.query("UPDATE avis_core_v2.sovereign_users SET full_name='Different holder' WHERE user_id=2");
 await assert.rejects(applyAuthorizedUatOpening(pool,env),/UAT_OPENING_ACCOUNT_SET/);assert.deepEqual(await accounts(),original);
 await pool.query("UPDATE avis_core_v2.sovereign_users SET full_name='Frontend user' WHERE user_id=2");
});
test('an existing reservation prevents all opening entries without altering balances',async()=>{
 const target=original.find(r=>r.wallet_scope==='FUNDING');await pool.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=1 WHERE account_id=$1',[target.account_id]);
 const before=await accounts();await assert.rejects(applyAuthorizedUatOpening(pool,env),/UAT_OPENING_ACCOUNT_NOT_EMPTY/);assert.deepEqual(await accounts(),before);
 await pool.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=0 WHERE account_id=$1',[target.account_id]);
});
test('authorized opening credits exactly seven funding accounts and balances each currency',async()=>{
 const results=process.env.TEST_DATABASE_URL?await Promise.all([applyAuthorizedUatOpening(pool,env),applyAuthorizedUatOpening(pool,env)]):[await applyAuthorizedUatOpening(pool,env)];
 receipt=results[0];for(const r of results)assert.deepEqual(r,receipt);assert.equal(receipt.accounts.length,7);
 const rows=await accounts();assert.equal(rows.length,original.length+4);
 for(const r of original){const current=rows.find(a=>a.account_id===r.account_id);assert.equal(current.available_balance,r.wallet_scope==='FUNDING'?'1000.000000000000000000':r.available_balance);assert.equal(current.locked_balance,r.locked_balance);}
 const entries=(await pool.query('SELECT e.direction,e.amount::text,a.currency_code,a.owner_type FROM avis_core_v2.ledger_entries e JOIN avis_core_v2.ledger_accounts a USING(account_id) WHERE journal_id=$1',[receipt.journalId])).rows;
 assert.equal(entries.length,11);for(const currency of ['EUR','USD','GBP','CHF']){const group=entries.filter(e=>e.currency_code===currency),n=currency==='CHF'?1:2;assert.equal(group.filter(e=>e.direction==='DEBIT'&&Number(e.amount)===n*1000).length,1);assert.equal(group.filter(e=>e.direction==='CREDIT'&&e.amount==='1000.000000000000000000').length,n);}
 assert.equal((await pool.query('SELECT count(*)::int n FROM avis_core_v2.operation_audit WHERE operation=$1',['AUTHORIZED_UAT_OPENING'])).rows[0].n,1);
});
test('replay after a customer transfer does not replenish, reset or duplicate the opening balances',async()=>{
 const a=receipt.accounts.filter(a=>a.currency==='EUR');await core.transfer(actor,{from:a[0].abiq,to:a[1].abiq,currency:'EUR',amount:'10',reference:'Transfer after opening'},'after-opening');
 const before=await accounts();assert.deepEqual(await applyAuthorizedUatOpening(pool,env),receipt);assert.deepEqual(await accounts(),before);
 assert.equal((await pool.query('SELECT count(*)::int n FROM avis_core_v2.ledger_journals WHERE reference_id=$1',[OPENING_REQUEST])).rows[0].n,1);
});
test('PostgreSQL concurrent opening replays retain one journal',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const before=await accounts(),results=await Promise.all([applyAuthorizedUatOpening(pool,env),applyAuthorizedUatOpening(pool,env)]);
 assert.deepEqual(results,[receipt,receipt]);assert.deepEqual(await accounts(),before);
});
