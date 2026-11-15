import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {createBankServer} from '../server.mjs';

let pool,db,server,base,cookie,csrf;const observed=[];
before(async()=>{
 if(process.env.TEST_DATABASE_URL){assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname,'/avispay_ci');pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release(){}})};}
 const client=await pool.connect();try{await migrate(client);}finally{client.release();}
 const feed={snapshot:robot=>{observed.push(robot);return {provider:'CoinAPI',symbolId:'BINANCE_SPOT_BTC_USDT',baseAsset:'BTC',quoteAsset:'USDT',quote:null,trades:[],connection:{state:'CONNECTING',lastMessageAt:null,errorCode:null},usedByStrategy:false};}};
 server=createBankServer({pool,secureCookies:false,authenticate:async()=>({id:'live-http-test',username:'operator',admin:true}),transferOptions:{tradingMarketFeed:feed}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'operator',password:'isolated-fixture'})});cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(db)await db.close();else await pool.end();});
const counts=async()=>(await pool.query('SELECT (SELECT count(*) FROM avis_core_v2.ledger_journals)::int AS journals,(SELECT count(*) FROM avis_core_v2.trading_robots)::int AS profiles,(SELECT count(*) FROM avis_core_v2.trading_robot_orders)::int AS orders')).rows[0];
test('mounted live API serves the actual reference transport contract without creating financial records',async()=>{
 const before=await counts(),response=await fetch(base+'/api/crypto/trading/live',{headers:{cookie}});assert.equal(response.status,200);const state=await response.json();assert.equal(state.schemaVersion,1);assert.deepEqual(state.profiles,[]);assert.equal(state.selectedRobotId,null);assert.equal(state.market.reference,true);assert.equal(state.market.provider,'CoinAPI');assert.equal(state.audit,null);assert.equal(state.liquidity,null);assert.equal(observed.length,1);assert.equal(observed[0].symbol,'BTCUSDT');assert.deepEqual(await counts(),before);
 assert.equal((await fetch(base+'/api/crypto/trading/live?robotId=bad',{headers:{cookie}})).status,422);
 assert.equal((await fetch(base+'/api/crypto/trading/live/liquidity?robotId=bad',{headers:{cookie}})).status,422);
 assert.equal((await fetch(base+'/trading-live.mjs')).status,200);
});
test('live market and security backing routes deny anonymous, service-only and customer workspace reads',async()=>{
 for(const path of ['/api/crypto/trading/live','/api/crypto/trading/live/liquidity']){
  assert.equal((await fetch(base+path)).status,401);assert.equal((await fetch(base+path,{headers:{authorization:'Bearer invalid-service'}})).status,401);
 }
 const headers={cookie,origin:base,'content-type':'application/json','x-csrf-token':csrf};
 assert.equal((await fetch(base+'/api/workspace',{method:'POST',headers,body:JSON.stringify({userId:'2'})})).status,200);
 try{for(const path of ['/api/crypto/trading/live','/api/crypto/trading/live/liquidity'])assert.equal((await fetch(base+path,{headers:{cookie}})).status,403);}
 finally{await fetch(base+'/api/workspace',{method:'POST',headers,body:JSON.stringify({userId:null})});}
 assert.equal(observed.length,1,'denied reads cannot start additional provider subscriptions');
});
