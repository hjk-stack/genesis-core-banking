import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {CryptoWorkspace} from '../src/crypto-workspace.mjs';
import {TradingRobotCore} from '../src/trading-robot.mjs';
import {robotWalletAllowance,assertRobotWalletAllowance} from '../src/robot-wallet-allowance.mjs';
let db,pool,core;const accounts={};let serial=0;
const key=()=>`robot-allowance-${++serial}`;
const actor={id:'robot-allowance-test',admin:true,customerUserId:'1'};
const robot={robot_id:randomUUID(),user_id:'1',base_asset:'AG',quote_asset:'USD'};
before(async()=>{
 if(process.env.TEST_DATABASE_URL){
  assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
 }else{
  db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};
 }
 const c=await pool.connect();await migrate(c);c.release();core=new CryptoWorkspace(pool);
 for(const [code,quantity]of [['AG','2000'],['AGi','1000']]){
  const account=await core.networkAccount(pool,'USER',code,'ETHEREUM','ROBOT_ALLOWANCE_TEST','1');accounts[code]=account;
  // Isolated fixture only: no external transfer or production account mutation.
  await pool.query('UPDATE avis_core_v2.ledger_accounts SET available_balance=5000 WHERE account_id=$1',[account]);
  await core.delegateWalletTrading(actor,{accountId:account,amount:quantity,consent:true},key());
  await core.selectWalletTrading(actor,{accountId:account,enabled:true,expectedVersion:0},key());
 }
});
after(async()=>{if(db)await db.close();else await pool?.end();});
test('AG and AGi selection budgets are independent and enforce exact base-unit limits',async()=>{
 const ag=await robotWalletAllowance(pool,robot),agi=await robotWalletAllowance(pool,{...robot,base_asset:'AGi'});
 assert.equal(ag.quantity,'2000.000000000000000000');assert.equal(agi.quantity,'1000.000000000000000000');
 await assertRobotWalletAllowance(pool,robot,'2000');
 await assert.rejects(assertRobotWalletAllowance(pool,robot,'2000.000000000000000001'),/CRYPTO_TRADING_ALLOWANCE_LIMIT/);
 await assert.rejects(assertRobotWalletAllowance(pool,{...robot,base_asset:'AGi'},'1001'),/CRYPTO_TRADING_ALLOWANCE_LIMIT/);
});
test('two profiles cannot each reuse the same coin allowance',async()=>{
 await pool.query(`INSERT INTO avis_core_v2.trading_robots
  (robot_id,name,user_id,venue,symbol,index_id,max_notional,daily_notional,max_loss,trailing_bps,quantity_step,price_tick,base_asset,quote_asset,position_quantity)
  VALUES($1,'Existing position',1,'BINANCE','AGUSDT','AG',5000,10000,100,50,1,1,'AG','USD',900)`,[robot.robot_id]);
 const orderId=randomUUID();await pool.query(`INSERT INTO avis_core_v2.trading_robot_orders
  (id,robot_id,signal_id,client_order_id,side,quantity,price,notional,instruction)
  VALUES($1,$2,$3,$4,'BUY',100,1,100,'{}')`,[orderId,robot.robot_id,'a'.repeat(64),randomUUID()]);
 await assertRobotWalletAllowance(pool,robot,'1000');
 await assert.rejects(assertRobotWalletAllowance(pool,robot,'1001'),/CRYPTO_TRADING_ALLOWANCE_LIMIT/);
 await assertRobotWalletAllowance(pool,robot,'1100',orderId);
});
test('pausing AG denies new AG entries without pausing AGi or preventing an existing-position exit',async()=>{
 await core.selectWalletTrading(actor,{accountId:accounts.AG,enabled:false,expectedVersion:1},key());
 assert.equal((await robotWalletAllowance(pool,robot)).allowed,false);
 assert.equal((await robotWalletAllowance(pool,{...robot,base_asset:'AGi'})).allowed,true);
 await assert.rejects(assertRobotWalletAllowance(pool,robot,'1'),/CRYPTO_TRADING_SELECTION_REQUIRED/);
 const trading=new TradingRobotCore(pool);
 assert.equal(await trading.entryDispatchRejection(pool,robot,{side:'SELL'}),null);
});
test('a legacy strategy without a wallet consent record keeps its original execution checks',async()=>{
 const legacy={...robot,base_asset:'BTC'};
 assert.equal((await robotWalletAllowance(pool,legacy)).governed,false);
 await assertRobotWalletAllowance(pool,legacy,'1');
 const foreign={...robot,user_id:'2'};assert.equal((await robotWalletAllowance(pool,foreign)).governed,false);
});
test('AGi allowance cannot be released while an uppercase AGI venue position still exists',async()=>{
 const id=randomUUID();
 await pool.query(`INSERT INTO avis_core_v2.trading_robots
  (robot_id,name,user_id,venue,symbol,index_id,max_notional,daily_notional,max_loss,trailing_bps,quantity_step,price_tick,base_asset,quote_asset,position_quantity)
  VALUES($1,'AGi existing position',1,'BINANCE','AGIUSDT','AGi',5000,10000,100,50,1,1,'AGI','USD',1)`,[id]);
 await core.selectWalletTrading(actor,{accountId:accounts.AGi,enabled:false,expectedVersion:1},key());
 const allocation=(await core.list(actor,'walletdelegations')).find(d=>d.account_id===accounts.AGi&&d.state==='ACTIVE');
 await assert.rejects(core.revokeWalletTrading(actor,{delegationId:allocation.delegation_id},key()),/CRYPTO_TRADING_POSITION/);
 const locked=(await pool.query('SELECT locked_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[accounts.AGi])).rows[0];
 assert.equal(locked.locked_balance,'1000.000000000000000000');
 await pool.query('UPDATE avis_core_v2.trading_robots SET position_quantity=0 WHERE robot_id=$1',[id]);
 const released=await core.revokeWalletTrading(actor,{delegationId:allocation.delegation_id},key());
 assert.equal(released.state,'REVOKED');
 assert.ok(!(await core.list(actor,'tradingallowances')).some(row=>row.account_id===accounts.AGi));
});
