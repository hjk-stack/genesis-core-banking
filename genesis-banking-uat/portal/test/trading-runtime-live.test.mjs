import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TradingRuntime} from '../src/trading/runtime.mjs';

test('W runtime consumes the same shared feed as the live screen without duplicate subscriptions',async()=>{
 const observers=[],removed=[],messages=[];let closed=0;
 const liveMarkets={subscribe:(robot,callback)=>{observers.push({robot,callback});return ()=>removed.push(robot.symbol);},close:()=>closed++};
 const runtime=new TradingRuntime({liveMarkets,pool:{query:async()=>({rows:[]})}});runtime.send=v=>messages.push(v);
 runtime.configs=[{robot_id:'r1',venue:'BINANCE',symbol:'BTCUSDT',base_asset:'BTC',quote_asset:'USDT',enabled:false,position_quantity:'1'}];
 runtime.syncMarkets();runtime.syncMarkets();assert.equal(observers.length,1);
 const tick={tsMicros:Date.now()*1000,bid:100,ask:101,bidSize:2,askSize:1,sellVolume:.3};observers[0].callback(tick);assert.deepEqual(messages,[{type:'TICK',robotId:'r1',tick}]);
 runtime.configs=[{...runtime.configs[0],symbol:'ETHUSDT',base_asset:'ETH'}];runtime.syncMarkets();assert.deepEqual(removed,['BTCUSDT']);assert.equal(observers.length,2);
 observers[0].callback(tick);assert.equal(messages.length,1);observers[1].callback(tick);assert.equal(messages.length,2);
 await runtime.stop();observers[1].callback(tick);assert.equal(messages.length,2);assert.deepEqual(removed,['BTCUSDT','ETHUSDT']);assert.equal(closed,0,'the shared display feed remains owned by the application');
});
test('removed profiles stop receiving ticks and runtime entry flags still require reviewed evidence',()=>{
 let callback,removed=0;const runtime=new TradingRuntime({liveMarkets:{subscribe:(_r,cb)=>{callback=cb;return ()=>removed++;}},pool:{query:async()=>({rows:[]})}}),messages=[];runtime.send=v=>messages.push(v);
 const robot={robot_id:'r1',venue:'BINANCE',symbol:'BTCUSDT',base_asset:'BTC',quote_asset:'USDT',enabled:true,test_reviewed:false};runtime.configs=[robot];runtime.syncMarkets();assert.equal(runtime.settings(robot).enabled,false);assert.equal(runtime.settings({...robot,test_reviewed:true}).enabled,true);
 runtime.configs=[];runtime.syncMarkets();callback({bid:1,ask:2});assert.equal(messages.length,0);assert.equal(removed,1);
});
test('retired callbacks cannot resume after the same robot and market are re-added',()=>{
 const callbacks=[],messages=[],runtime=new TradingRuntime({liveMarkets:{subscribe:(_r,cb)=>{callbacks.push(cb);return ()=>{};}},pool:{query:async()=>({rows:[]})}});runtime.send=v=>messages.push(v);
 const robot={robot_id:'same',venue:'BINANCE',symbol:'BTCUSDT',base_asset:'BTC',quote_asset:'USDT'};runtime.configs=[robot];runtime.syncMarkets();runtime.configs=[];runtime.syncMarkets();runtime.configs=[robot];runtime.syncMarkets();
 callbacks[0]({bid:1,ask:2});assert.equal(messages.length,0);callbacks[1]({bid:1,ask:2});assert.equal(messages.length,1);
});
test('shutdown during a delayed refresh cannot recreate subscriptions or start buffered orders',async()=>{
 let release,entered,subscribed=0,orders=0,dispatches=0;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const core={liveMarkets:{subscribe:()=>{subscribed++;return ()=>{};}},pool:{query:async()=>{entered();await gate;return {rows:[{robot_id:'r',venue:'BINANCE',symbol:'BTCUSDT',base_asset:'BTC',quote_asset:'USDT'}]};}},tradingTestReviewed:async()=>true,robotOrder:async()=>{orders++;return {id:'o'};},dispatchRobotOrder:async()=>{dispatches++;}};
 const runtime=new TradingRuntime(core),refresh=runtime.refresh();await started;await runtime.stop();release();await refresh;runtime.syncMarkets();await runtime.execute({robotId:'r',signalId:'buffered'});await runtime.executeStored('o');assert.equal(subscribed,0);assert.equal(orders,0);assert.equal(dispatches,0);assert.equal(runtime.marketSubscriptions.size,0);
});
test('AVIS ticks use the same verified counterparty book and observe replacement lots at unchanged prices',async()=>{
 const book={bids:[{price:'99',quantity:'2',orders:1,quoteValue:'198'}],asks:[{price:'100',quantity:'3',orders:1,quoteValue:'300'}],lots:[{orderId:'bid-1',side:'BUY',price:'99',quantity:'2',reservationConsistent:true},{orderId:'ask-1',side:'SELL',price:'100',quantity:'3',reservationConsistent:true}]},messages=[];let reads=0;
 const runtime=new TradingRuntime({liveMarkets:{},liveOrderBook:async()=>{reads++;return structuredClone(book);},pool:{query:async sql=>{assert.match(sql,/status='FILLED'/);return {rows:[{qty:'0.25'}]};}}});runtime.send=v=>messages.push(v);
 const robot={robot_id:'avis',venue:'AVIS',security_id:'security'};await runtime.avisTick(robot);await runtime.avisTick(robot);assert.equal(messages.length,1);assert.equal(messages[0].tick.bid,99);assert.equal(messages[0].tick.askSize,3);assert.equal(messages[0].tick.sellVolume,0,'the first observed book does not import all historical sales');
 book.lots[1].orderId='replacement-ask';await runtime.avisTick(robot);assert.equal(messages.length,2);assert.equal(messages[1].tick.sellVolume,.25);assert.equal(reads,3);
 book.asks=[];await runtime.avisTick(robot);assert.equal(messages.length,2,'missing executable liquidity cannot invent another tick');
 runtime.configs=[];runtime.syncMarkets();assert.equal(runtime.avisBooks.size,0);
});
