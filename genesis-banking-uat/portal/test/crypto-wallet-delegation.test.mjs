import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {CryptoWorkspace} from '../src/crypto-workspace.mjs';

let db,pool,core,account;
const owner={id:'wallet-allocation-test',admin:true};
const customer={id:'customer-one',admin:true,customerUserId:'1'};
before(async()=>{
 db=new PGlite();
 pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:s=>db.exec(s),release(){}})};
 const connection=await pool.connect();await migrate(connection);connection.release();
 core=new CryptoWorkspace(pool);
 account=await core.networkAccount(pool,'USER','BTC','BITCOIN','CRYPTO','1');
 await pool.query(`INSERT INTO avis_core_v2.ledger_accounts(owner_type,currency_code,network,sub_account_code,account_category)
 VALUES('MIGRATION_OFFSET','BTC','BITCOIN','ROBOT_TEST_OPENING','ASSET')`);
 const offset=(await pool.query(`SELECT account_id FROM avis_core_v2.ledger_accounts WHERE owner_type='MIGRATION_OFFSET'
 AND currency_code='BTC' AND network='BITCOIN' AND sub_account_code='ROBOT_TEST_OPENING'`)).rows[0].account_id;
 await core.post(pool,owner,'wallet-delegation-test-fixture','TEST_OPENING','unit-only',[
  {accountId:offset,direction:'DEBIT',amount:'5'},
  {accountId:account,direction:'CREDIT',amount:'5'}
 ]);
});
after(async()=>{await db.close();});
const balances=async()=> (await pool.query('SELECT available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[account])).rows[0];

test('owner cannot freeze more than the free wallet quantity or allocate without exact consent',async()=>{
 await assert.rejects(core.delegateWalletTrading(customer,{accountId:account,amount:'1',consent:false},'without-consent'),/CRYPTO_TRADING_CONSENT/);
 await assert.rejects(core.delegateWalletTrading(customer,{accountId:account,amount:'6',consent:true},'too-large'),/INSUFFICIENT_FUNDS/);
 const b=await balances();assert.equal(Number(b.available_balance),5);assert.equal(Number(b.locked_balance),0);
});
test('exact owner approval freezes only the designated portion and is idempotent',async()=>{
 const input={accountId:account,amount:'1.250000000000000001',consent:true},receipt=await core.delegateWalletTrading(customer,input,'wallet-freeze-once');
 assert.equal(receipt.delegated,'1.250000000000000001');
 assert.deepEqual(await core.delegateWalletTrading(customer,input,'wallet-freeze-once'),receipt);
 let b=await balances();assert.equal(Number(b.available_balance),5);assert.equal(b.locked_balance,'1.250000000000000001');
 assert.equal(receipt.available,'3.749999999999999999');
 const rows=await core.list(customer,'walletdelegations');
 assert.equal(rows.length,1);assert.equal(rows[0].state,'ACTIVE');assert.equal(rows[0].quantity,'1.250000000000000001');
 const ledger=await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_journals WHERE event_type=$1',['CRYPTO_ROBOT_DELEGATE']);
 assert.equal(ledger.rows[0].n,0,'reservation changes locked balance only, without inventing a transfer journal');
});
test('another user cannot allocate an institution wallet and second freeze cannot spend locked funds',async()=>{
 await assert.rejects(core.delegateWalletTrading({...customer,customerUserId:'2'},{accountId:account,amount:'0.1',consent:true},'wrong-owner'),/FORBIDDEN/);
 await assert.rejects(core.delegateWalletTrading(customer,{accountId:account,amount:'4',consent:true},'locked-wallet'),/INSUFFICIENT_FUNDS/);
 const b=await balances();assert.equal(b.locked_balance,'1.250000000000000001');
});
