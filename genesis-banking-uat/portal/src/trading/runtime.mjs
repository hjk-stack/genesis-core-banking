import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {LiveMarketFeed} from './live-market.mjs';
export const engineStatus={engine:'NautilusTrader',version:'1.231.0',ready:false};
const actor={id:'system:w-effect-robot',admin:true};
export class TradingRuntime {
 constructor(core,{python=process.env.AVIS_TRADING_PYTHON||'python3',fetcher=fetch,WebSocketClass=WebSocket}={}){this.core=core;this.python=python;this.fetcher=fetcher;this.liveMarkets=core.liveMarkets||new LiveMarketFeed({env:core.secretEnv||process.env,WebSocketClass});this.ownsLiveMarkets=!core.liveMarkets;this.configs=[];this.marketSubscriptions=new Map();this.avisBooks=new Map();this.ticks=new Map();this.states=new Map();this.busy=false;this.processing=new Set();this.stopped=false;}
 start(){if(this.stopped)return this;clearInterval(this.timer);this.child=spawn(this.python,[new URL('../../trading/worker.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});const lines=createInterface({input:this.child.stdout});lines.on('line',line=>{if(this.stopped||line.length>100000)return;try{const v=JSON.parse(line);if(v.type==='READY'){this.ready=v;Object.assign(engineStatus,{ready:true,version:v.version,startedAt:new Date().toISOString()});void this.refresh();}if(v.type==='ORDER')void this.execute(v);if(v.type==='STATE'&&Number.isFinite(v.stopPrice)&&Number.isFinite(v.peakPrice))this.states.set(v.robotId,v);}catch{}});this.child.stderr.on('data',()=>{});this.child.on('error',()=>this.log('ROBOT_PROCESS_START'));this.child.on('exit',()=>{this.ready=null;engineStatus.ready=false;if(!this.stopped)this.restart=setTimeout(()=>this.start(),5000);});this.timer=setInterval(()=>{void this.refresh();},10000);this.timer.unref();void this.refresh();return this;}
 send(v){if(!this.stopped&&this.ready&&this.child?.stdin.writable&&this.child.stdin.writableLength<1000000)this.child.stdin.write(JSON.stringify(v)+'\n');}
 log(code){console.error(JSON.stringify({operation:'W_EFFECT_ROBOT',code}));}
 settings(r){return {id:r.robot_id,version:r.version,enabled:r.enabled&&r.test_reviewed===true,priceMultiplier:r.quote_basis==='PERCENT'?Number(r.denomination)/100:1,symbol:r.symbol,venue:r.venue,indexId:r.index_id,maxNotional:r.max_notional,minimumIndex:r.minimum_index,trailingBps:r.trailing_bps,priceTick:r.price_tick,quantityStep:r.quantity_step,positionQuantity:r.position_quantity,stopPrice:r.stop_price,peakPrice:r.peak_price};}
 async refresh(){if(this.busy||this.stopped)return;this.busy=true;try{
  for(const [id,state]of this.states){if(this.stopped)return;await this.core.pool.query('UPDATE avis_core_v2.trading_robots SET stop_price=GREATEST(stop_price,$2),peak_price=GREATEST(peak_price,$3) WHERE robot_id=$1 AND position_quantity>0',[id,state.stopPrice,state.peakPrice]);this.states.delete(id);}
  if(this.stopped)return;
  this.configs=(await this.core.pool.query('SELECT r.*,s.quote_basis,s.denomination FROM avis_core_v2.trading_robots r LEFT JOIN avis_core_v2.portfolio_securities s USING(security_id) WHERE enabled OR position_quantity>0')).rows;
  if(this.stopped)return;
  for(const robot of this.configs){robot.test_reviewed=await this.core.tradingTestReviewed(this.core.pool,robot);if(this.stopped)return;}
  this.send({type:'CONFIG',robots:this.configs.map(r=>this.settings(r))});
  this.syncMarkets();
  await this.refreshIndex();
  if(this.stopped)return;
  await this.refreshEventAdvice();
  if(this.stopped)return;
  if(this.configs.length){
   for(const r of this.configs.filter(r=>r.venue==='AVIS')){if(this.stopped)return;await this.avisTick(r);}
  }
  if(this.stopped)return;const pending=(await this.core.pool.query("SELECT id FROM avis_core_v2.trading_robot_orders WHERE status IN('CREATED','DISPATCHING','ACKNOWLEDGED') ORDER BY created_at LIMIT 20")).rows;for(const o of pending){if(this.stopped)return;await this.executeStored(o.id);}for(const r of this.configs){if(this.stopped)return;if(!(await this.core.pool.query("SELECT 1 FROM avis_core_v2.trading_robot_orders WHERE robot_id=$1 AND status IN('CREATED','DISPATCHING','ACKNOWLEDGED')",[r.robot_id])).rows.length)await this.ack(r.robot_id);}
 }catch(e){this.log(e.code||e.message||'REFRESH');}finally{this.busy=false;}}
 async refreshIndex(){
  try{const response=await this.fetcher('https://avis.land/press/api/index',{signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)return;const index=await response.json(),age=Date.now()-Date.parse(index.generatedAt);
   if(index.producer!=='AVIS_PRESS_ROBOT'||index.schemaVersion!==1||!Array.isArray(index.indices)||!/^[a-f0-9]{64}$/.test(index.sequence)||!Number.isFinite(age)||age<0||age>180000)return;
   engineStatus.indexReceipt={producer:'AVIS_W_EFFECT_ROBOT',source:'AVIS_PRESS_ROBOT',sequence:index.sequence,generatedAt:index.generatedAt,receivedAt:new Date().toISOString()};
   for(const r of this.configs){const row=index.indices.find(i=>i.instrumentId===r.index_id),snapshot=row&&index.collectionEnabled!==false?{...row,sequence:index.sequence,generatedAt:index.generatedAt}:null;
    await this.core.pool.query('UPDATE avis_core_v2.trading_robots SET last_index=$2 WHERE robot_id=$1',[r.robot_id,snapshot?JSON.stringify(snapshot):null]);
    this.send({type:'INDEX',robotId:r.robot_id,index:snapshot?{...snapshot,generatedAtMs:Date.parse(index.generatedAt),validUntilMs:Date.parse(row.validUntil)}:null});
   }
  }catch{this.log('PRESS_INDEX_READ');}
 }
 async refreshEventAdvice(){
  if(!this.configs.length)return;
  try{const advice=await this.core.robotIndexAdvice(actor,this.configs.map(r=>r.robot_id));
   for(const r of this.configs){const candidates=advice[r.robot_id]||[];await this.core.pool.query('UPDATE avis_core_v2.trading_robots SET last_event_advice=$2 WHERE robot_id=$1 AND version=$3',[r.robot_id,JSON.stringify(candidates),r.version]);this.send({type:'EVENT_ADVICE',robotId:r.robot_id,candidates});}
  }catch{for(const r of this.configs)this.send({type:'EVENT_ADVICE',robotId:r.robot_id,candidates:[]});this.log('INDEX_EVENT_ADVICE_READ');}
 }
 syncMarkets(){
  if(this.stopped)return;
  for(const id of this.avisBooks.keys())if(!this.configs.some(r=>r.robot_id===id&&r.venue==='AVIS'))this.avisBooks.delete(id);
  const signature=r=>[r.venue,r.symbol,r.base_asset,r.quote_asset].join(':'),wanted=new Map(this.configs.filter(r=>r.venue==='BINANCE').map(r=>[r.robot_id,r]));
  for(const[id,subscription]of this.marketSubscriptions){if(!wanted.has(id)||subscription.signature!==signature(wanted.get(id))){subscription.unsubscribe();this.marketSubscriptions.delete(id);}}
  for(const[id,robot]of wanted){if(this.marketSubscriptions.has(id))continue;const expected=signature(robot),subscription={signature:expected,unsubscribe:()=>{}};this.marketSubscriptions.set(id,subscription);
   try{subscription.unsubscribe=this.liveMarkets.subscribe(robot,tick=>{
    const current=this.configs.find(r=>r.robot_id===id);if(this.stopped||this.marketSubscriptions.get(id)!==subscription||!current||signature(current)!==expected)return;
    this.send({type:'TICK',robotId:id,tick});this.ticks.set(id,Date.now());
   });}catch(error){if(this.marketSubscriptions.get(id)===subscription)this.marketSubscriptions.delete(id);throw error;}
  }
 }
 async avisTick(r){
  if(this.stopped)return;const book=await this.core.liveOrderBook(r,new Date().toISOString());if(this.stopped)return;
  const bid=book.bids[0],ask=book.asks[0];if(!bid||!ask||Number(bid.price)>Number(ask.price)){this.avisBooks.delete(r.robot_id);return;}
  const signature=JSON.stringify({bid,ask,lots:book.lots.filter(l=>l.reservationConsistent&&((l.side==='BUY'&&Number(l.price)===Number(bid.price))||(l.side==='SELL'&&Number(l.price)===Number(ask.price)))).map(l=>[l.orderId,l.quantity,l.price])});
  const previous=this.avisBooks.get(r.robot_id);if(previous?.signature===signature)return;
  const receivedAt=Date.now(),sold=previous?(await this.core.pool.query("SELECT COALESCE(sum(quantity),0)::text AS qty FROM avis_core_v2.securities_orders WHERE security_id=$1 AND side='SELL' AND status='FILLED' AND executed_at>$2 AND executed_at<=$3",[r.security_id,new Date(previous.receivedAt),new Date(receivedAt)])).rows[0]:{qty:'0'};if(this.stopped)return;
  this.avisBooks.set(r.robot_id,{signature,receivedAt});this.ticks.set(r.robot_id,receivedAt);
  this.send({type:'TICK',robotId:r.robot_id,tick:{tsMicros:receivedAt*1000,bid:Number(bid.price),ask:Number(ask.price),bidSize:Number(bid.quantity),askSize:Number(ask.quantity),sellVolume:Number(sold.qty)}});
 }
 async execute(signal){if(this.stopped)return;let id;try{const r=await this.core.robotOrder(actor,signal,'signal:'+signal.signalId);id=r.id;await this.executeStored(id);}catch(e){this.log(e.code||e.message||'ROBOT_ORDER');}finally{if(!this.stopped)await this.ack(signal.robotId);}}
 async executeStored(id){if(this.stopped||this.processing.has(id))return;this.processing.add(id);try{await this.core.dispatchRobotOrder(actor,id);}catch(e){this.log(e.code||e.message||'ROBOT_RECONCILE');}finally{this.processing.delete(id);}}
 async ack(id){const r=(await this.core.pool.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=$1',[id])).rows[0];if(r)this.send({type:'ACK',robotId:id,state:this.settings(r)});}
 async stop(){this.stopped=true;clearInterval(this.timer);clearTimeout(this.restart);for(const subscription of this.marketSubscriptions.values())subscription.unsubscribe();this.marketSubscriptions.clear();if(this.ownsLiveMarkets)this.liveMarkets.close();this.child?.kill();}
}
