import {test,before,after} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {PGlite} from '@electric-sql/pglite';import pg from 'pg';
import {TradingRobotCore} from '../src/trading-robot.mjs';import {tradingTestFixtureRunner,reviewFixtureReplay} from './helpers/trading-testing-fixture.mjs';import {migrate} from '../src/migrate.mjs';import {BinanceSpot} from '../src/trading/binance.mjs';
let pool,db,core,accounts,securityId,robotId;const actor={id:'robot-regression',admin:true},key=()=>randomUUID();
before(async()=>{if(process.env.TEST_DATABASE_URL){assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname,'/avispay_ci');pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}else{db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};}const c=await pool.connect();try{await migrate(c);}finally{c.release();}core=new TradingRobotCore(pool,{tradingTestRunner:tradingTestFixtureRunner});accounts=await core.list(actor,'accountsummaries');await core.operation(actor,'TEST_FUNDS',{},key(),async(d,k)=>{const offset=await core.system(d,'TREASURY','EUR','TEST','ASSET');return {journalId:await core.post(d,actor,k,'TEST','isolated funding',accounts.filter(a=>a.currency_code==='EUR').flatMap(a=>[{accountId:offset,direction:'DEBIT',amount:'20000'},{accountId:a.account_id,direction:'CREDIT',amount:'20000'}]))};});});
after(async()=>{if(db)await db.close();else await pool.end();});
const account=u=>accounts.find(a=>String(a.user_id)===String(u)&&a.currency_code==='EUR');
async function index(id){const v={instrumentId:'TEST',score:20,confidence:.7,sourceCount:3,sequence:'press-test',generatedAt:new Date().toISOString(),validUntil:new Date(Date.now()+180000).toISOString()};await pool.query('UPDATE avis_core_v2.trading_robots SET last_index=$2 WHERE robot_id=$1',[id,JSON.stringify(v)]);}
const signal=(id,side='BUY',q='3')=>({robotId:id,signalId:randomUUID().replaceAll('-','').repeat(2),side,quantity:q,price:'100',indexSequence:'press-test',tickTime:Date.now()*1000,stopPrice:98,pattern:{l1:99,l2:99.1,neckline:99.8,zScore:-3,sellVolumeL1:90,sellVolumeL2:5,imbalance:2,spread:.001}});
test('AVIS W robot consumes existing exchange lots and cancels unfilled IOC quantity with no duplicate fill',async()=>{
 securityId=(await core.addSecurity(actor,{name:'Robot test security',shortName:'TEST',currency:'EUR',denomination:'1',quoteBasis:'UNIT',kind:'share'},key())).id;await core.recordPosition(actor,{userId:'2',securityId,quantity:'20',issuingPrice:'100',marketPrice:'100',reference:'Test custody'},key());const maker=await core.reviewSecurityOrder(actor,{securityId,side:'SELL',accountId:account(2).account_id,paymentMethod:'ACCOUNT',quantity:'2',denomination:'1',price:'99',total:'198',reference:'Test maker'},key());await core.submitSecurityOrder(actor,{orderId:maker.id,reviewHash:maker.reviewHash},key());
 robotId=(await core.configureRobot(actor,{name:'W test',userId:'1',venue:'AVIS',symbol:'TEST',indexId:'TEST',securityId,accountId:account(1).account_id,maxNotional:'1000',dailyNotional:'2000',maxLoss:'100',trailingBps:50,minimumIndex:0},key())).id;await reviewFixtureReplay(core,actor,robotId);await core.toggleRobot(actor,{robotId,enabled:true},key());await index(robotId);
 const bad=signal(robotId);await assert.rejects(core.robotOrder(actor,{...bad,pattern:{...bad.pattern,imbalance:undefined}},key()),/ROBOT_LIMIT/);await pool.query("UPDATE avis_core_v2.trading_robots SET last_index=last_index||'{\"validUntil\":\"invalid\"}'::jsonb WHERE robot_id=$1",[robotId]);await assert.rejects(core.robotOrder(actor,signal(robotId),key()),/ROBOT_INDEX/);await index(robotId);
 const input=signal(robotId),order=await core.robotOrder(actor,input,key());await core.dispatchRobotOrder(actor,order.id);const r=(await core.list(actor,'tradingrobots'))[0],o=(await core.list(actor,'robotorders'))[0];assert.equal(Number(r.position_quantity),2);assert.equal(Number(r.cost_basis),198);assert.equal(o.response.status,'EXPIRED');assert.equal(Number(o.response.executedQty),2);assert.equal(Number((await core.list(actor,'accountsummaries')).find(a=>a.account_id===account(1).account_id).available_balance),19802);
 await core.dispatchRobotOrder(actor,order.id);assert.equal(Number((await core.list(actor,'tradingrobots'))[0].position_quantity),2);
});
test('fresh INDEX, limits, institution ownership and acquired positions are enforced server-side',async()=>{
 await assert.rejects(core.toggleRobot({...actor,customerUserId:'2'},{robotId,enabled:true},key()),/FORBIDDEN/);await assert.rejects(core.robotOrder(actor,signal(robotId,'SELL','3'),key()),/ROBOT_POSITION/);await pool.query("UPDATE avis_core_v2.trading_robots SET last_index=last_index||'{\"generatedAt\":\"2020-01-01T00:00:00Z\"}'::jsonb WHERE robot_id=$1",[robotId]);await assert.rejects(core.robotOrder(actor,signal(robotId),key()),/ROBOT_INDEX/);await core.toggleRobot(actor,{robotId,enabled:false},key());await assert.rejects(core.robotOrder(actor,signal(robotId),key()),/ROBOT_SYMBOL/);
});
test('venue timeout recovers the same client order, records partial execution and base commission once',async()=>{
 let submits=0,queries=0;const response={symbol:'BTCUSDT',side:'BUY',status:'EXPIRED',executedQty:'0.4',cummulativeQuoteQty:'40',orderId:8,fills:[{commission:'0.001',commissionAsset:'BTC'}]};core.venue={credentials(){return {};},market:async()=>({baseAsset:'BTC',quoteAsset:'USDT',priceTick:'0.01',quantityStep:'0.001'}),balance:async()=>[{asset:'USDT',free:'1000'}],submit:async o=>{submits++;response.clientOrderId=o.client_order_id;throw Error('timeout');},order:async()=>{queries++;return response;}};
 const id=(await core.configureRobot(actor,{name:'External W',userId:'1',venue:'BINANCE',symbol:'BTCUSDT',indexId:'TEST',keyRef:'TRADING_TEST',maxNotional:'1000',dailyNotional:'2000',maxLoss:'100',trailingBps:50,minimumIndex:0},key())).id;await reviewFixtureReplay(core,actor,id);await core.toggleRobot(actor,{robotId:id,enabled:true},key());await index(id);const order=await core.robotOrder(actor,signal(id,'BUY','1'),key());await assert.rejects(core.dispatchRobotOrder(actor,order.id),/timeout/);await core.dispatchRobotOrder(actor,order.id);await core.dispatchRobotOrder(actor,order.id);assert.equal(submits,1);assert.equal(queries,1);const r=(await core.list(actor,'tradingrobots')).find(r=>r.robot_id===id);assert.equal(Number(r.position_quantity),.399);assert.equal(Number(r.cost_basis),40);
});
test('Binance adapter uses authenticated IOC API and rejects malformed secret references',async()=>{
 const calls=[],api=new BinanceSpot({env:{TRADING_TEST_KEY:'test-api',TRADING_TEST_SECRET:'test-signing-secret'},fetcher:async(url,options)=>{calls.push({url,options});return new Response('{}');}});await api.submit({symbol:'BTCUSDT',side:'BUY',quantity:'1',price:'100',client_order_id:'AVIS-test'},'TRADING_TEST');const u=new URL(calls[0].url);assert.equal(u.hostname,'api.binance.com');assert.equal(u.searchParams.get('timeInForce'),'IOC');assert.ok(u.searchParams.get('signature'));assert.equal(calls[0].options.method,'POST');assert.ok(!calls[0].url.includes('test-signing-secret'));assert.throws(()=>api.credentials('PGPASSWORD'),/ROBOT_API_KEY/);
});

test('percentage-quoted AVIS bonds consume their full denomination in the daily purchase limit',async()=>{
 const s=(await core.addSecurity(actor,{name:'Daily-limit bond',shortName:'BOND',currency:'EUR',denomination:'1000',quoteBasis:'PERCENT',kind:'bond'},key())).id;
 const id=(await core.configureRobot(actor,{name:'Bond W',userId:'1',venue:'AVIS',symbol:'BOND',indexId:'TEST',securityId:s,accountId:account(1).account_id,maxNotional:'1000',dailyNotional:'1500',maxLoss:'100',trailingBps:50,minimumIndex:0},key())).id;
 await reviewFixtureReplay(core,actor,id);await core.toggleRobot(actor,{robotId:id,enabled:true},key());await index(id);const first=await core.robotOrder(actor,signal(id,'BUY','1'),key());await pool.query("UPDATE avis_core_v2.trading_robot_orders SET status='SETTLED' WHERE id=$1",[first.id]);
 await assert.rejects(core.robotOrder(actor,signal(id,'BUY','1'),key()),/ROBOT_LIMIT/);
 await pool.query("UPDATE avis_core_v2.trading_robot_orders SET status='REJECTED' WHERE id=$1",[first.id]);const queued=await core.robotOrder(actor,signal(id,'BUY','1'),key());await pool.query("UPDATE avis_core_v2.trading_robot_orders SET created_at=now()-interval '1 minute' WHERE id=$1",[queued.id]);await core.dispatchRobotOrder(actor,queued.id);assert.equal((await pool.query('SELECT status FROM avis_core_v2.trading_robot_orders WHERE id=$1',[queued.id])).rows[0].status,'REJECTED');
});

test('test review is enforced at live start, order creation and queued entry dispatch while exits remain available',async()=>{
 const id=(await core.configureRobot(actor,{name:'Review boundary',userId:'1',venue:'AVIS',symbol:'BOUNDARY',indexId:'TEST',securityId,accountId:account(1).account_id,maxNotional:'1000',dailyNotional:'2000',maxLoss:'100',trailingBps:50,minimumIndex:0},key())).id;
 await pool.query('UPDATE avis_core_v2.trading_robots SET enabled=true WHERE robot_id=$1',[id]);
 await index(id);
 const requiresReview=error=>error.code==='TRADING_TEST_REVIEW_REQUIRED';
 await assert.rejects(core.toggleRobot(actor,{robotId:id,enabled:true},key()),requiresReview);
 await assert.rejects(core.robotOrder(actor,signal(id,'BUY','1'),key()),requiresReview);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.trading_robot_orders WHERE robot_id=$1',[id])).rows[0].n,0);
 await reviewFixtureReplay(core,actor,id);
 assert.equal((await pool.query('SELECT enabled FROM avis_core_v2.trading_robots WHERE robot_id=$1',[id])).rows[0].enabled,false);
 await core.toggleRobot(actor,{robotId:id,enabled:true},key());
 const entry=await core.robotOrder(actor,signal(id,'BUY','1'),key());
 const fingerprint=core.tradingTestingFingerprint;
 core.tradingTestingFingerprint=async()=> 'f'.repeat(64);
 try{
  await core.dispatchRobotOrder(actor,entry.id);
  const order=(await pool.query('SELECT status,response FROM avis_core_v2.trading_robot_orders WHERE id=$1',[entry.id])).rows[0];
  assert.equal(order.status,'REJECTED');assert.equal(order.response.code,'TRADING_TEST_REVIEW_REQUIRED');
  await pool.query("UPDATE avis_core_v2.trading_robots SET enabled=false,position_quantity=1,cost_basis=100 WHERE robot_id=$1",[id]);
  const exit=await core.robotOrder(actor,signal(id,'SELL','1'),key());
  assert.equal(exit.status,'CREATED');
 }finally{core.tradingTestingFingerprint=fingerprint;}
});

test('orders already submitted before review invalidation reconcile without a second venue submission',async()=>{
 let submits=0,queries=0;
 core.venue={credentials(){return {};},market:async()=>({baseAsset:'BTC',quoteAsset:'USDT',priceTick:'0.01',quantityStep:'0.001'}),balance:async()=>[{asset:'USDT',free:'1000'}],submit:async()=>{submits++;throw Error('unexpected new submission');},order:async(symbol,id)=>{queries++;return {symbol,clientOrderId:id,side:'BUY',status:'EXPIRED',executedQty:'0.4',cummulativeQuoteQty:'40',orderId:9,fills:[]};}};
 const id=(await core.configureRobot(actor,{name:'Submitted recovery',userId:'1',venue:'BINANCE',symbol:'BTCUSD',indexId:'TEST',keyRef:'TRADING_TEST',maxNotional:'1000',dailyNotional:'2000',maxLoss:'100',trailingBps:50,minimumIndex:0},key())).id;
 await reviewFixtureReplay(core,actor,id);await core.toggleRobot(actor,{robotId:id,enabled:true},key());await index(id);
 const entry=await core.robotOrder(actor,signal(id,'BUY','1'),key());
 await pool.query("UPDATE avis_core_v2.trading_robot_orders SET status='DISPATCHING' WHERE id=$1",[entry.id]);
 const fingerprint=core.tradingTestingFingerprint;core.tradingTestingFingerprint=async()=> 'f'.repeat(64);
 try{await core.dispatchRobotOrder(actor,entry.id);await core.dispatchRobotOrder(actor,entry.id);}
 finally{core.tradingTestingFingerprint=fingerprint;}
 assert.equal(submits,0);assert.equal(queries,1);
 const robot=(await pool.query('SELECT position_quantity FROM avis_core_v2.trading_robots WHERE robot_id=$1',[id])).rows[0];
 assert.equal(Number(robot.position_quantity),.4);
});

test('a pause during venue balance lookup is rechecked atomically before submission',async()=>{
 let submits=0,releaseBalance,enteredBalance;
 core.venue={credentials(){return {};},market:async()=>({baseAsset:'BTC',quoteAsset:'USDT',priceTick:'0.01',quantityStep:'0.001'}),balance:async()=>[{asset:'USDT',free:'1000'}],submit:async()=>{submits++;throw Error('paused order submitted');}};
 const id=(await core.configureRobot(actor,{name:'Pause race',userId:'1',venue:'BINANCE',symbol:'PAUSEUSDT',indexId:'TEST',keyRef:'TRADING_TEST',maxNotional:'1000',dailyNotional:'2000',maxLoss:'100',trailingBps:50,minimumIndex:0},key())).id;
 await reviewFixtureReplay(core,actor,id);await core.toggleRobot(actor,{robotId:id,enabled:true},key());await index(id);
 const entry=await core.robotOrder(actor,signal(id,'BUY','1'),key());
 const entered=new Promise(resolve=>{enteredBalance=resolve;});const released=new Promise(resolve=>{releaseBalance=resolve;});
 core.venue.balance=async()=>{enteredBalance();await released;return [{asset:'USDT',free:'1000'}];};
 const dispatch=core.dispatchRobotOrder(actor,entry.id);await entered;
 try{await core.toggleRobot(actor,{robotId:id,enabled:false},key());}finally{releaseBalance();}
 await dispatch;
 assert.equal(submits,0);
 const order=(await pool.query('SELECT status,response FROM avis_core_v2.trading_robot_orders WHERE id=$1',[entry.id])).rows[0];
 assert.equal(order.status,'REJECTED');assert.equal(order.response.code,'ROBOT_ENTRY_EXPIRED');
});

test('AVIS settlement rechecks a pause under the robot lock before moving securities or cash',async()=>{
 const id=(await core.configureRobot(actor,{name:'AVIS pause race',userId:'1',venue:'AVIS',symbol:'AVISPAUSE',indexId:'TEST',securityId,accountId:account(1).account_id,maxNotional:'1000',dailyNotional:'2000',maxLoss:'100',trailingBps:50,minimumIndex:0},key())).id;
 await reviewFixtureReplay(core,actor,id);await core.toggleRobot(actor,{robotId:id,enabled:true},key());await index(id);
 const entry=await core.robotOrder(actor,signal(id,'BUY','1'),key());
 const before=(await pool.query('SELECT account_id,available_balance,locked_balance FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows;
 const execute=core.executeAvisRobot;
 core.executeAvisRobot=async function(a,order){await this.toggleRobot(a,{robotId:id,enabled:false},key());return execute.call(this,a,order);};
 try{await core.dispatchRobotOrder(actor,entry.id);}finally{core.executeAvisRobot=execute;}
 const order=(await pool.query('SELECT status,response FROM avis_core_v2.trading_robot_orders WHERE id=$1',[entry.id])).rows[0];
 assert.equal(order.status,'REJECTED');assert.equal(order.response.code,'ROBOT_ENTRY_EXPIRED');
 assert.deepEqual((await pool.query('SELECT account_id,available_balance,locked_balance FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows,before);
});
