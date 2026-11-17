import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {CryptoWorkspace} from '../src/crypto-workspace.mjs';
import {CustomerAccess} from '../src/customer-access.mjs';

let db,pool,core;const accounts={};let serial=0;
const key=()=>`multicoin-${++serial}`;
const admin={id:'multicoin-test-admin',admin:true};
const user={id:'multicoin-test-user',admin:true,customerUserId:'1'};
const foreign={id:'multicoin-other-user',admin:true,customerUserId:'2'};
before(async()=>{
 db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:s=>db.exec(s),release(){}})};
 const connection=await pool.connect();await migrate(connection);connection.release();core=new CryptoWorkspace(pool);
 for(const [currency,network]of [['AG','ETHEREUM'],['AGi','ETHEREUM'],['BTC','BITCOIN']]){
  const account=await core.networkAccount(pool,'USER',currency,network,'MULTICOIN_TEST','1');accounts[currency]=account;
  await pool.query(`INSERT INTO avis_core_v2.ledger_accounts(owner_type,currency_code,network,sub_account_code,account_category)
   VALUES('MIGRATION_OFFSET',$1,$2,'MULTICOIN_TEST','ASSET')`,[currency,network]);
  const offset=(await pool.query(`SELECT account_id FROM avis_core_v2.ledger_accounts
   WHERE owner_type='MIGRATION_OFFSET' AND currency_code=$1 AND network=$2 AND sub_account_code='MULTICOIN_TEST'`,[currency,network])).rows[0].account_id;
  await core.post(pool,admin,key(),'TEST_OPENING','isolated multi-coin fixture',[
   {accountId:offset,direction:'DEBIT',amount:'5000'},{accountId:account,direction:'CREDIT',amount:'5000'}]);
 }
});
after(async()=>db.close());
const rows=()=>core.list(user,'tradingallowances');
const select=async(code,enabled,requestKey=key())=>{
 const row=(await rows()).find(r=>r.account_id===accounts[code]);
 return core.selectWalletTrading(user,{accountId:accounts[code],enabled,expectedVersion:row?.version||0},requestKey);
};
const balanceSnapshot=async()=>({
 accounts:(await pool.query('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows,
 journals:(await pool.query('SELECT journal_id FROM avis_core_v2.ledger_journals ORDER BY journal_id')).rows,
 keys:(await pool.query('SELECT * FROM avis_core_v2.crypto_wallet_keys ORDER BY address_id')).rows
});

test('no coin is added before positive wallet trading consent',async()=>{
 assert.deepEqual(await rows(),[]);
 await assert.rejects(select('AG',true),/CRYPTO_TRADING_ALLOWANCE/);
 await assert.rejects(core.selectWalletTrading(user,{accountId:accounts.AG,enabled:'true',expectedVersion:0},key()),/INVALID_FIELD/);
});
test('AG, AGi and BTC appear independently with exact consent quantities even without market prices',async()=>{
 for(const [code,amount]of [['AG','2000'],['AGi','1000'],['BTC','0.123456789012345678']])
  await core.delegateWalletTrading(user,{accountId:accounts[code],amount,consent:true},key());
 const result=await rows();assert.equal(result.length,3);
 assert.equal(result.find(r=>r.currency_code==='AG').quantity,'2000.000000000000000000');
 assert.equal(result.find(r=>r.currency_code==='AGi').quantity,'1000.000000000000000000');
 assert.equal(result.find(r=>r.currency_code==='BTC').quantity,'0.123456789012345678');
 assert.ok(result.every(r=>!r.enabled&&r.version===0));
});
test('several coins can be selected together, persisted and paused independently without financial postings',async()=>{
 const before=await balanceSnapshot();
 for(const code of ['AG','AGi','BTC'])assert.equal((await select(code,true)).enabled,true);
 assert.ok((await rows()).every(r=>r.enabled));
 await select('AG',false);
 assert.equal((await rows()).find(r=>r.currency_code==='AG').enabled,false);
 assert.equal((await rows()).find(r=>r.currency_code==='AGi').enabled,true);
 assert.equal((await rows()).find(r=>r.currency_code==='BTC').enabled,true);
 assert.deepEqual(await balanceSnapshot(),before);
 const reconstructed=new CryptoWorkspace(pool);
 assert.equal((await reconstructed.list(user,'tradingallowances')).filter(r=>r.enabled).length,2);
});
test('same selection request replays once; stale versions cannot overwrite another session',async()=>{
 const row=(await rows()).find(r=>r.currency_code==='AG'),input={accountId:accounts.AG,enabled:true,expectedVersion:row.version},requestKey=key();
 const first=await core.selectWalletTrading(user,input,requestKey);
 assert.deepEqual(await core.selectWalletTrading(user,input,requestKey),first);
 await assert.rejects(core.selectWalletTrading(user,{...input,enabled:false},key()),/CRYPTO_TRADING_SELECTION_CHANGED/);
 assert.equal((await rows()).find(r=>r.currency_code==='AG').enabled,true);
});
test('customer boundary neither exposes nor selects another holder allowance',async()=>{
 assert.deepEqual(await core.list(foreign,'tradingallowances'),[]);
 await assert.rejects(core.selectWalletTrading(foreign,{accountId:accounts.AG,enabled:false,expectedVersion:3},key()),/FORBIDDEN/);
 const boundary=new CustomerAccess(core),publicActor={id:'customer-two',admin:false,customerUserId:'2'};
 assert.deepEqual(await boundary.list(publicActor,'tradingallowances'),[]);
 await assert.rejects(boundary.invoke(publicActor,'selectWalletTrading',{accountId:accounts.AG,enabled:true,expectedVersion:3},key()),/FORBIDDEN/);
});
test('releasing the final allowance removes the coin and a later allocation does not silently reactivate it',async()=>{
 const allocation=(await core.list(user,'walletdelegations')).find(r=>r.account_id===accounts.AG&&r.state==='ACTIVE');
 await core.revokeWalletTrading(user,{delegationId:allocation.delegation_id},key());
 assert.ok(!(await rows()).some(r=>r.currency_code==='AG'));
 const saved=(await pool.query('SELECT enabled FROM avis_core_v2.wallet_trading_selections WHERE account_id=$1',[accounts.AG])).rows[0];
 assert.equal(saved.enabled,false);
 await core.delegateWalletTrading(user,{accountId:accounts.AG,amount:'1',consent:true},key());
 assert.equal((await rows()).find(r=>r.currency_code==='AG').enabled,false);
 assert.equal((await rows()).find(r=>r.currency_code==='AGi').enabled,true);
});
