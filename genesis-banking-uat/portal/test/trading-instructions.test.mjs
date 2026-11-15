import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {TradingRobotCore} from '../src/trading-robot.mjs';
import {parseTradingInstructions} from '../src/trading-instructions.mjs';
import {reviewFixtureReplay,tradingTestFixtureRunner} from './helpers/trading-testing-fixture.mjs';
import {createBankServer} from '../server.mjs';

const actor={id:'trading-instructions-test',admin:true},key=()=>randomUUID();
let pool,db,core,securityId,accountId,serial=0;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname,'/avispay_ci');pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release(){}})};}
 const client=await pool.connect();try{await migrate(client);}finally{client.release();}
 core=new TradingRobotCore(pool,{tradingTestRunner:tradingTestFixtureRunner});
 securityId=(await core.addSecurity(actor,{name:'Instruction fixture',shortName:'RULE',currency:'EUR',denomination:'1',quoteBasis:'UNIT',kind:'share'},key())).id;
 accountId=(await core.list(actor,'accountsummaries')).find(a=>String(a.user_id)==='1'&&a.currency_code==='EUR').account_id;
});
after(async()=>{core?.liveMarkets.close();if(db)await db.close();else await pool.end();});
async function profile(){return (await core.configureRobot(actor,{name:'Instruction profile',userId:'1',venue:'AVIS',symbol:'RULE'+(++serial),indexId:'RULE',securityId,accountId,maxNotional:'1000',dailyNotional:'2000',maxLoss:'100',trailingBps:50,minimumIndex:0},key())).id;}
async function snapshot(){return (await pool.query('SELECT account_id,available_balance,locked_balance FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows;}
async function save(id,overrides={}){const old=await core.robotInstructions(actor,{robotId:id}),document={...JSON.parse(old.instructions),...overrides};return core.saveRobotInstructions(actor,{robotId:id,expectedVersion:old.version,instructions:JSON.stringify(document)},key());}

test('instruction reads require the actual back-office administrator and show exact saved settings',async()=>{
 const id=await profile();for(const a of [{id:'customer',admin:false},{...actor,customerUserId:'2'},{...actor,indexService:true}])await assert.rejects(core.robotInstructions(a,{robotId:id}),e=>e.code==='FORBIDDEN');
 const state=await core.robotInstructions(actor,{robotId:id});assert.equal(state.instructionVersion,0);assert.equal(state.updatedAt,null);assert.deepEqual(JSON.parse(state.instructions),{maxNotional:'1000',dailyNotional:'2000',maxLoss:'100',minimumIndex:0,trailingBps:50,notes:''});
 await assert.rejects(core.robotInstructions(actor,{robotId:'not-an-id'}),e=>e.code==='TRADING_TEST_PROFILE');
});
test('executable instructions apply exact rules once, pause entries and preserve financial state',async()=>{
 const id=await profile(),old=await core.robotInstructions(actor,{robotId:id}),before=await snapshot();await pool.query('UPDATE avis_core_v2.trading_robots SET enabled=true WHERE robot_id=$1',[id]);
 const input={robotId:id,expectedVersion:old.version,instructions:JSON.stringify({...JSON.parse(old.instructions),maxNotional:'175.123456789012345678',dailyNotional:'500',maxLoss:'25',minimumIndex:21,trailingBps:80,notes:'Use source-backed INDEX evidence.\nReview fees.'})},retry=key();
 const saved=await core.saveRobotInstructions(actor,input,retry);assert.deepEqual(await core.saveRobotInstructions(actor,input,retry),saved);
 const robot=(await pool.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=$1',[id])).rows[0];assert.equal(robot.enabled,false);assert.equal(robot.max_notional,'175.123456789012345678');assert.equal(Number(robot.daily_notional),500);assert.equal(Number(robot.max_loss),25);assert.equal(Number(robot.minimum_index),21);assert.equal(robot.trailing_bps,80);assert.equal(saved.version,old.version+1);assert.match(saved.instructions,/Review fees/);assert.deepEqual(await snapshot(),before);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.trading_robot_instructions WHERE robot_id=$1',[id])).rows[0].n,1);
 await assert.rejects(core.saveRobotInstructions(actor,{...input,instructions:input.instructions+' '},retry),e=>e.code==='IDEMPOTENCY_CONFLICT');
});
test('instruction language rejects unknown commands, nondecimal values and out-of-range execution controls',()=>{
 const valid={maxNotional:'10',dailyNotional:'20',maxLoss:'5',minimumIndex:0,trailingBps:50};
 for(const value of [{...valid,apiKey:'not-a-rule'},{...valid,maxNotional:10},{...valid,maxNotional:'1e2'},{...valid,dailyNotional:'1'},{...valid,maxLoss:'0'},{...valid,trailingBps:1},{...valid,minimumIndex:101},{...valid,notes:'x\u0000y'}])assert.throws(()=>parseTradingInstructions(JSON.stringify(value)),e=>e.code==='TRADING_INSTRUCTIONS');
 assert.throws(()=>parseTradingInstructions('Buy anything automatically'),e=>e.code==='TRADING_INSTRUCTIONS');assert.throws(()=>parseTradingInstructions('[]'),e=>e.code==='TRADING_INSTRUCTIONS');
 assert.equal(parseTradingInstructions(JSON.stringify({...valid,notes:'line1\nline2'})).notes,'line1\nline2');
});
test('a changed profile version cannot be overwritten by a delayed instruction save',async()=>{
 const id=await profile(),old=await core.robotInstructions(actor,{robotId:id});await core.toggleRobot(actor,{robotId:id,enabled:false},key());
 await assert.rejects(core.saveRobotInstructions(actor,{robotId:id,expectedVersion:old.version,instructions:old.instructions},key()),e=>e.code==='TRADING_INSTRUCTIONS_CONFLICT');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.trading_robot_instructions WHERE robot_id=$1',[id])).rows[0].n,0);
});
test('open positions and pending orders keep their execution rules and stop state',async()=>{
 const id=await profile();await pool.query('UPDATE avis_core_v2.trading_robots SET position_quantity=1,cost_basis=100,stop_price=95,peak_price=103 WHERE robot_id=$1',[id]);
 await assert.rejects(save(id,{trailingBps:200}),e=>e.code==='ROBOT_POSITION');
 await pool.query('UPDATE avis_core_v2.trading_robots SET position_quantity=0 WHERE robot_id=$1',[id]);
 await pool.query("INSERT INTO avis_core_v2.trading_robot_orders(id,robot_id,signal_id,client_order_id,side,quantity,price,instruction,notional) VALUES($1,$2,$3,$4,'BUY',1,100,'{}',100)",[key(),id,'a'.repeat(64),'policy-pending']);
 await assert.rejects(save(id,{trailingBps:200}),e=>e.code==='ROBOT_POSITION');
 const r=(await pool.query('SELECT trailing_bps,stop_price,peak_price FROM avis_core_v2.trading_robots WHERE robot_id=$1',[id])).rows[0];assert.equal(r.trailing_bps,50);assert.equal(Number(r.stop_price),95);assert.equal(Number(r.peak_price),103);
});
test('changed notes or rules invalidate exact replay review and saving never starts a robot',async()=>{
 const id=await profile();await reviewFixtureReplay(core,actor,id);await core.toggleRobot(actor,{robotId:id,enabled:true},key());
 await save(id,{notes:'Require reviewed W-effect evidence.'});
 assert.equal((await pool.query('SELECT enabled FROM avis_core_v2.trading_robots WHERE robot_id=$1',[id])).rows[0].enabled,false);
 await assert.rejects(core.toggleRobot(actor,{robotId:id,enabled:true},key()),e=>e.code==='TRADING_TEST_REVIEW_REQUIRED');
 await reviewFixtureReplay(core,actor,id);assert.equal((await pool.query('SELECT enabled FROM avis_core_v2.trading_robots WHERE robot_id=$1',[id])).rows[0].enabled,false);
 await core.toggleRobot(actor,{robotId:id,enabled:true},key());
});
test('orders bind server-owned instruction evidence and ignore a forged caller policy',async()=>{
 const id=await profile(),saved=await save(id,{notes:'Recorded operator context.'});await reviewFixtureReplay(core,actor,id);await core.toggleRobot(actor,{robotId:id,enabled:true},key());
 const index={instrumentId:'RULE',score:20,confidence:.7,sourceCount:3,sequence:'instructions-index',generatedAt:new Date().toISOString(),validUntil:new Date(Date.now()+180000).toISOString()};await pool.query('UPDATE avis_core_v2.trading_robots SET last_index=$2 WHERE robot_id=$1',[id,JSON.stringify(index)]);
 const result=await core.robotOrder(actor,{robotId:id,signalId:key().replaceAll('-','').repeat(2),side:'BUY',quantity:'1',price:'100',indexSequence:index.sequence,tickTime:Date.now()*1000,stopPrice:98,pattern:{l1:99,l2:99.1,neckline:99.8,zScore:-3,sellVolumeL1:90,sellVolumeL2:5,imbalance:2,spread:.001},tradingInstructions:{policyHash:'forged'}},key());
 const order=(await pool.query('SELECT instruction FROM avis_core_v2.trading_robot_orders WHERE id=$1',[result.id])).rows[0];assert.equal(order.instruction.tradingInstructions.policyHash,saved.policyHash);assert.equal(order.instruction.tradingInstructions.document.notes,'Recorded operator context.');assert.equal(order.instruction.tradingInstructions.instructionVersion,saved.instructionVersion);
});
test('saved instruction history cannot be updated or deleted',async()=>{
 const id=await profile();await save(id,{notes:'Original.'});
 await assert.rejects(pool.query("UPDATE avis_core_v2.trading_robot_instructions SET document='{}' WHERE robot_id=$1",[id]));await assert.rejects(pool.query('DELETE FROM avis_core_v2.trading_robot_instructions WHERE robot_id=$1',[id]));
});
test('PostgreSQL simultaneous edits serialize on the robot and retain one version',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const id=await profile(),old=await core.robotInstructions(actor,{robotId:id}),input={robotId:id,expectedVersion:old.version,instructions:old.instructions};
 const results=await Promise.allSettled([core.saveRobotInstructions(actor,input,key()),core.saveRobotInstructions(actor,input,key())]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'TRADING_INSTRUCTIONS_CONFLICT');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.trading_robot_instructions WHERE robot_id=$1',[id])).rows[0].n,1);
});
test('mounted instruction API enforces login, current workspace, origin and CSRF',async()=>{
 const id=await profile(),server=createBankServer({pool,secureCookies:false,authenticate:async()=>({...actor,username:'operator'}),transferOptions:{tradingTestRunner:tradingTestFixtureRunner}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const path='/api/crypto/trading/robot-instructions?robotId='+id;assert.equal((await fetch(base+path)).status,401);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'operator',password:'fixture'})}),cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrf;
  const headers={cookie,origin:base,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':key()},read=await fetch(base+path,{headers});assert.equal(read.status,200);const current=await read.json(),body=JSON.stringify({robotId:id,expectedVersion:current.version,instructions:current.instructions});
  assert.equal((await fetch(base+'/api/crypto/trading/robot-instructions',{method:'POST',headers:{...headers,'x-csrf-token':'bad'},body})).status,403);
  assert.equal((await fetch(base+'/api/crypto/trading/robot-instructions',{method:'POST',headers:{...headers,origin:'https://other.invalid'},body})).status,403);
  assert.equal((await fetch(base+'/api/crypto/trading/robot-instructions',{method:'POST',headers,body})).status,200);
  await fetch(base+'/api/workspace',{method:'POST',headers,body:JSON.stringify({userId:'2'})});assert.equal((await fetch(base+path,{headers})).status,403);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
