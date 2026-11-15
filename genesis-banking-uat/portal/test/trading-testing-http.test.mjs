import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {TradingRobotCore} from '../src/trading-robot.mjs';
import {createBankServer} from '../server.mjs';

const actor={id:'trading-test-http',admin:true};
let pool,db,server,base,cookie,csrf,robotId;
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
 const core=new TradingRobotCore(pool);
 const securityId=(await core.addSecurity(actor,{name:'Isolated test instrument',shortName:'TST',currency:'EUR',denomination:'1',quoteBasis:'UNIT',kind:'share'},randomUUID())).id;
 const account=(await core.list(actor,'accountsummaries')).find(row=>String(row.user_id)==='1'&&row.currency_code==='EUR');
 robotId=(await core.configureRobot(actor,{name:'Awaiting replay review',userId:'1',venue:'AVIS',symbol:'TST',indexId:'TST',securityId,accountId:account.account_id,maxNotional:'1000',dailyNotional:'2000',maxLoss:'100',trailingBps:50,minimumIndex:0},randomUUID())).id;
 server=createBankServer({pool,secureCookies:false,authenticate:async()=>({...actor,username:'test-operator'})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'test-operator',password:'isolated-fixture'})});
 assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
});
after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(db)await db.close();else await pool?.end();});
async function request(path,body,extra={}){
 return fetch(base+path,{method:body===undefined?'GET':'POST',headers:{cookie,origin:base,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':randomUUID(),...extra},body:body===undefined?undefined:JSON.stringify(body)});
}

test('real isolated Nautilus acceptance runs through the mounted API without moving funds or enabling a robot',{timeout:120000},async()=>{
 const beforeCounts=await pool.query('SELECT (SELECT count(*) FROM avis_core_v2.ledger_journals)::text AS journals,(SELECT count(*) FROM avis_core_v2.trading_robot_orders)::text AS orders');
 const installed=await request('/api/crypto/trading/testing');assert.equal(installed.status,200);
 const installation=await installed.json();assert.equal(installation.engine.name,'NautilusTrader');assert.match(installation.engine.fingerprint,/^[a-f0-9]{64}$/);
 const submitted=await request('/api/crypto/trading/tests',{mode:'ACCEPTANCE',initialCash:'10000',feeBps:10,slippageBps:5});assert.equal(submitted.status,200);
 const {runId}=await submitted.json();assert.match(runId,/^[a-f0-9-]{36}$/);
 let run;
 for(let attempt=0;attempt<360;attempt++){
  const state=await(await request('/api/crypto/trading/testing')).json();run=state.runs.find(item=>item.runId===runId);
  if(run&&['PASSED','FAILED'].includes(run.status))break;
  await delay(200);
 }
 assert.equal(run?.status,'PASSED',JSON.stringify({status:run?.status,errorCode:run?.errorCode,checks:run?.report?.checks}));
 assert.equal(run.report.engineVersion,'1.231.0');assert.equal(run.report.complete,true);
 assert.ok(run.report.checks.length>=5);assert.ok(run.report.checks.every(check=>check.passed));
 assert.equal(run.robotId,null);assert.equal(run.reviewEligible,false);assert.equal(run.reviewedAt,null);
 const review=await request('/api/crypto/trading/tests/review',{runId});assert.equal(review.status,409);
 const start=await request('/api/crypto/trading/toggle',{robotId,enabled:true});assert.equal(start.status,409);
 assert.equal((await start.json()).code,'TRADING_TEST_REVIEW_REQUIRED');
 assert.equal((await pool.query('SELECT enabled FROM avis_core_v2.trading_robots WHERE robot_id=$1',[robotId])).rows[0].enabled,false);
 const afterCounts=await pool.query('SELECT (SELECT count(*) FROM avis_core_v2.ledger_journals)::text AS journals,(SELECT count(*) FROM avis_core_v2.trading_robot_orders)::text AS orders');
 assert.deepEqual(afterCounts.rows,beforeCounts.rows);
});

test('testing API remains private and mutations require same-origin CSRF',async()=>{
 assert.equal((await fetch(base+'/api/crypto/trading/testing')).status,401);
 assert.equal((await request('/api/crypto/trading/tests',{mode:'ACCEPTANCE'},{'x-csrf-token':'incorrect'})).status,403);
 assert.equal((await request('/api/crypto/trading/tests',{mode:'ACCEPTANCE'},{origin:'https://unrelated.example'})).status,403);
 assert.equal((await request('/api/workspace',{userId:'2'})).status,200);
 try{
  assert.equal((await request('/api/crypto/trading/testing')).status,403);
  assert.equal((await request('/api/crypto/trading/tests',{mode:'ACCEPTANCE'})).status,403);
 }finally{assert.equal((await request('/api/workspace',{userId:null})).status,200);}
});
