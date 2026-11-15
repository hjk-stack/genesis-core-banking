import {randomUUID} from 'node:crypto';

// Dependency-injected evidence for execution-unit tests. The separate HTTP test
// executes the real isolated Nautilus process; production has no fixture switch.
export async function tradingTestFixtureRunner(input){
 const cash=input.initialCash;
 const orders=['BUY','SELL'].map((side,i)=>({id:'fixture-order-'+i,signalId:String(i).repeat(64),tsMicros:1_000_000+i*1_000_000,side,requestedQuantity:'1',limitPrice:'100',filledQuantity:'1',status:'FILLED',reason:null,type:'LIMIT',timeInForce:'IOC'}));
 return {schemaVersion:1,engine:'NautilusTrader',engineVersion:'1.231.0',mode:input.mode,status:'PASSED',complete:true,
  checks:[{id:'FIXTURE_ROUND_TRIP',label:'Execution fixture review',passed:true,detail:'Injected evidence for existing order-path regressions.'}],
  metrics:{ticksProcessed:2,indexObservationsUsed:1,ordersGenerated:2,filledOrders:2,rejectedOrders:0,partialFills:0,duplicateSignalsIgnored:0,buyFills:1,sellFills:1,openOrders:0,initialCash:cash,finalCash:cash,finalPosition:'0',costBasis:'0',realisedPnl:'0',unrealisedPnl:'0',fees:'0',finalEquity:cash,drawdown:'0',drawdownFraction:'0',ordersTruncated:0,fillsTruncated:0},
  orders,fills:orders.map((order,i)=>({orderId:order.id,tsMicros:order.tsMicros,side:order.side,quantity:'1',price:'100',notional:'100',fee:'0',cashAfter:String(Number(cash)-(i?0:100)),positionAfter:i?'0':'1'})),assumptions:{virtualCash:true,fixture:true}};
}

export async function reviewFixtureReplay(core,actor,robotId){
 const robot=(await core.pool.query('SELECT index_id FROM avis_core_v2.trading_robots WHERE robot_id=$1',[robotId])).rows[0];
 const dataset={ticks:[1_000_000,2_000_000].map(tsMicros=>({tsMicros,bid:100,ask:100.01,bidSize:2,askSize:1,sellVolume:0})),indices:[{atMicros:900_000,index:{instrumentId:robot.index_id,score:30,confidence:.8,sourceCount:3,generatedAtMs:800,validUntilMs:180000,sequence:'execution-fixture'}}]};
 const run=await core.runTradingTest(actor,{robotId,mode:'REPLAY',dataset,initialCash:'10000',feeBps:0,slippageBps:0},randomUUID());
 await core.processTradingTests();
 await core.reviewTradingTest(actor,{runId:run.runId},randomUUID());
 return run.runId;
}
