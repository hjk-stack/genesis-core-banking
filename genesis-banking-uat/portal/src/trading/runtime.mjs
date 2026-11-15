import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
export const engineStatus={engine:'NautilusTrader',version:'1.231.0',ready:false};
const actor={id:'system:w-effect-robot',admin:true};
export class TradingRuntime {
 constructor(core,{python=process.env.AVIS_TRADING_PYTHON||'python3',fetcher=fetch,WebSocketClass=WebSocket}={}){this.core=core;this.python=python;this.fetcher=fetcher;this.WebSocketClass=WebSocketClass;this.configs=[];this.sockets=new Map();this.ticks=new Map();this.states=new Map();this.busy=false;this.processing=new Set();this.stopped=false;}
 start(){clearInterval(this.timer);this.child=spawn(this.python,[new URL('../../trading/worker.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});const lines=createInterface({input:this.child.stdout});lines.on('line',line=>{if(line.length>100000)return;try{const v=JSON.parse(line);if(v.type==='READY'){this.ready=v;Object.assign(engineStatus,{ready:true,version:v.version,startedAt:new Date().toISOString()});void this.refresh();}if(v.type==='ORDER')void this.execute(v);if(v.type==='STATE'&&Number.isFinite(v.stopPrice)&&Number.isFinite(v.peakPrice))this.states.set(v.robotId,v);}catch{}});this.child.stderr.on('data',()=>{});this.child.on('error',()=>this.log('ROBOT_PROCESS_START'));this.child.on('exit',()=>{this.ready=null;engineStatus.ready=false;if(!this.stopped)this.restart=setTimeout(()=>this.start(),5000);});this.timer=setInterval(()=>{void this.refresh();},10000);this.timer.unref();void this.refresh();return this;}
 send(v){if(this.ready&&this.child?.stdin.writable&&this.child.stdin.writableLength<1000000)this.child.stdin.write(JSON.stringify(v)+'\n');}
 log(code){console.error(JSON.stringify({operation:'W_EFFECT_ROBOT',code}));}
 settings(r){return {id:r.robot_id,version:r.version,enabled:r.enabled&&r.test_reviewed===true,priceMultiplier:r.quote_basis==='PERCENT'?Number(r.denomination)/100:1,symbol:r.symbol,venue:r.venue,indexId:r.index_id,maxNotional:r.max_notional,minimumIndex:r.minimum_index,trailingBps:r.trailing_bps,priceTick:r.price_tick,quantityStep:r.quantity_step,positionQuantity:r.position_quantity,stopPrice:r.stop_price,peakPrice:r.peak_price};}
 async refresh(){if(this.busy||this.stopped)return;this.busy=true;try{
  for(const [id,state]of this.states){await this.core.pool.query('UPDATE avis_core_v2.trading_robots SET stop_price=GREATEST(stop_price,$2),peak_price=GREATEST(peak_price,$3) WHERE robot_id=$1 AND position_quantity>0',[id,state.stopPrice,state.peakPrice]);this.states.delete(id);}
  this.configs=(await this.core.pool.query('SELECT r.*,s.quote_basis,s.denomination FROM avis_core_v2.trading_robots r LEFT JOIN avis_core_v2.portfolio_securities s USING(security_id) WHERE enabled OR position_quantity>0')).rows;
  for(const robot of this.configs)robot.test_reviewed=await this.core.tradingTestReviewed(this.core.pool,robot);
  this.send({type:'CONFIG',robots:this.configs.map(r=>this.settings(r))});
  const wanted=new Set(this.configs.filter(r=>r.venue==='BINANCE').map(r=>r.symbol));for(const [s,w]of this.sockets)if(!wanted.has(s)){w.close();this.sockets.delete(s);}for(const s of wanted)if(!this.sockets.has(s))this.connectMarket(s);
  await this.refreshIndex();
  await this.refreshEventAdvice();
  if(this.configs.length){
   for(const r of this.configs.filter(r=>r.venue==='AVIS'))await this.avisTick(r);
  }
  const pending=(await this.core.pool.query("SELECT id FROM avis_core_v2.trading_robot_orders WHERE status IN('CREATED','DISPATCHING','ACKNOWLEDGED') ORDER BY created_at LIMIT 20")).rows;for(const o of pending)await this.executeStored(o.id);for(const r of this.configs)if(!(await this.core.pool.query("SELECT 1 FROM avis_core_v2.trading_robot_orders WHERE robot_id=$1 AND status IN('CREATED','DISPATCHING','ACKNOWLEDGED')",[r.robot_id])).rows.length)await this.ack(r.robot_id);
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
 connectMarket(symbol){const name=symbol.toLowerCase(),ws=new this.WebSocketClass('wss://stream.binance.com:9443/stream?streams='+name+'@bookTicker/'+name+'@aggTrade');this.sockets.set(symbol,ws);let sell=0,lastBook=0;
  ws.addEventListener('message',event=>{try{const d=JSON.parse(event.data).data;if(d.s!==symbol)return;if(d.e==='aggTrade'){if(d.m===true)sell+=Number(d.q);return;}if(!(d.u>lastBook))return;lastBook=d.u;const now=Date.now(),tick={tsMicros:now*1000,bid:Number(d.b),ask:Number(d.a),bidSize:Number(d.B),askSize:Number(d.A),sellVolume:sell};sell=0;for(const r of this.configs.filter(r=>r.venue==='BINANCE'&&r.symbol===symbol)){this.send({type:'TICK',robotId:r.robot_id,tick});this.ticks.set(r.robot_id,now);}}catch{}});
  ws.addEventListener('close',()=>{if(this.sockets.get(symbol)===ws)this.sockets.delete(symbol);});ws.addEventListener('error',()=>{ws.close();});
 }
 async avisTick(r){const rows=(await this.core.pool.query("SELECT side,price::text,sum(quantity)::text AS volume,max(submitted_at) AS time FROM avis_core_v2.securities_orders WHERE security_id=$1 AND status='OPEN' GROUP BY side,price ORDER BY price",[r.security_id])).rows;const bid=rows.filter(x=>x.side==='BUY').at(-1),ask=rows.find(x=>x.side==='SELL');if(!bid||!ask)return;
  const stamp=Math.max(Date.parse(bid.time),Date.parse(ask.time));if(this.ticks.get(r.robot_id)===stamp)return;const last=this.ticks.get(r.robot_id)||0;this.ticks.set(r.robot_id,stamp);const sold=(await this.core.pool.query("SELECT COALESCE(sum(quantity),0)::text AS qty FROM avis_core_v2.securities_orders WHERE security_id=$1 AND side='SELL' AND status='FILLED' AND executed_at>$2",[r.security_id,new Date(last)])).rows[0];this.send({type:'TICK',robotId:r.robot_id,tick:{tsMicros:Date.now()*1000,bid:Number(bid.price),ask:Number(ask.price),bidSize:Number(bid.volume),askSize:Number(ask.volume),sellVolume:Number(sold.qty)}});
 }
 async execute(signal){let id;try{const r=await this.core.robotOrder(actor,signal,'signal:'+signal.signalId);id=r.id;await this.executeStored(id);}catch(e){this.log(e.code||e.message||'ROBOT_ORDER');}finally{await this.ack(signal.robotId);}}
 async executeStored(id){if(this.processing.has(id))return;this.processing.add(id);try{await this.core.dispatchRobotOrder(actor,id);}catch(e){this.log(e.code||e.message||'ROBOT_RECONCILE');}finally{this.processing.delete(id);}}
 async ack(id){const r=(await this.core.pool.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=$1',[id])).rows[0];if(r)this.send({type:'ACK',robotId:id,state:this.settings(r)});}
 async stop(){this.stopped=true;clearInterval(this.timer);clearTimeout(this.restart);for(const ws of this.sockets.values())ws.close();this.child?.kill();}
}
