'use strict';
const {randomUUID}=require('node:crypto');
const MARKET=Object.freeze({
'SIM-TECH':Object.freeze({symbol:'SIM-TECH',name:'Technology Index Simulator',priceCents:18250,category:'equity-demo'}),
'SIM-GREEN':Object.freeze({symbol:'SIM-GREEN',name:'Green Industry Simulator',priceCents:8420,category:'equity-demo'}),
'SIM-GOLD':Object.freeze({symbol:'SIM-GOLD',name:'Precious Metals Simulator',priceCents:22460,category:'commodity-demo'}),
'SIM-CASH':Object.freeze({symbol:'SIM-CASH',name:'Treasury Basket Simulator',priceCents:10130,category:'fund-demo'})
});
const MAX_ORDER_NOTIONAL_CENTS=500000n, INITIAL_CASH_CENTS=25000000n;
function validateId(v){if(typeof v!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(v))throw Error('INVALID_CLIENT_ORDER_ID');return v}
function parseQuantity(v){if(typeof v!=='string'||!/^[1-9][0-9]{0,5}$/.test(v))throw Error('INVALID_QUANTITY');return BigInt(v)}
function parsePrice(v){if(typeof v!=='string'||!/^[1-9][0-9]{0,9}$/.test(v))throw Error('INVALID_LIMIT_PRICE');return BigInt(v)}
function createEngine(){
let cashCents=INITIAL_CASH_CENTS,rejected=0;const positions=new Map(),orders=[],orderByClientId=new Map(),events=[],startedAt=new Date().toISOString();
function record(type,detail){events.unshift({id:randomUUID(),at:new Date().toISOString(),type,detail});if(events.length>100)events.pop()}
function submit(input){
try {
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('INVALID_ORDER');
 const id=validateId(input.clientOrderId),existing=orderByClientId.get(id);
 if(existing){if(existing.instrument!==input.instrument||existing.side!==input.side||existing.quantity!==input.quantity||existing.limitPriceCents!==input.limitPriceCents)throw Error('IDEMPOTENCY_CONFLICT');return {...existing,idempotentReplay:true}}
 if(!Object.hasOwn(MARKET,input.instrument))throw Error('INSTRUMENT_NOT_ALLOWED');
 if(!['buy','sell'].includes(input.side))throw Error('INVALID_SIDE');
 const q=parseQuantity(input.quantity),p=parsePrice(input.limitPriceCents),notional=q*p;
 if(notional>MAX_ORDER_NOTIONAL_CENTS)throw Error('RISK_NOTIONAL_LIMIT');
 const mark=BigInt(MARKET[input.instrument].priceCents),marketable=input.side==='buy'?p>=mark:p<=mark;
 if(marketable&&input.side==='buy'&&cashCents<q*mark)throw Error('INSUFFICIENT_SIMULATED_CASH');
 if(input.side==='sell'&&(positions.get(input.instrument)||0n)<q)throw Error('NO_SHORT_SELLING');
 const item={id:randomUUID(),clientOrderId:id,instrument:input.instrument,side:input.side,quantity:String(q),limitPriceCents:String(p),status:marketable?'FILLED':'OPEN',executionPriceCents:marketable?String(mark):null,createdAt:new Date().toISOString()};
 if(marketable){positions.set(input.instrument,(positions.get(input.instrument)||0n)+(input.side==='buy'?q:-q));cashCents+=input.side==='buy'?-q*mark:q*mark}
 orders.unshift(item);orderByClientId.set(id,item);record('ORDER_'+item.status,{clientOrderId:id,instrument:input.instrument,side:input.side});return {...item};
}catch(e){rejected++;record('ORDER_REJECTED',{code:e.message});throw e}
}
function cancel(id){const item=orderByClientId.get(validateId(id));if(!item)throw Error('ORDER_NOT_FOUND');if(item.status!=='OPEN')throw Error('ORDER_NOT_CANCELLABLE');item.status='CANCELLED';record('ORDER_CANCELLED',{clientOrderId:id});return {...item}}
function snapshot(){
let equity=cashCents;
const holdings=Object.keys(MARKET).map(symbol=>{const quantity=positions.get(symbol)||0n,value=quantity*BigInt(MARKET[symbol].priceCents);equity+=value;return {symbol,quantity:String(quantity),marketValueCents:String(value),markCents:String(MARKET[symbol].priceCents)}});
return {mode:'PAPER_ONLY',externalTradingEnabled:false,paymentPostingEnabled:false,bondInfrastructureConnected:false,startedAt,cashCents:String(cashCents),equityCents:String(equity),holdings,orders:orders.slice(0,50).map(x=>({...x})),quotes:Object.values(MARKET),monitoring:{rejectedOrders:rejected,filledOrders:orders.filter(x=>x.status==='FILLED').length,openOrders:orders.filter(x=>x.status==='OPEN').length,alerts:rejected>0?['SIMULATED_ORDER_REJECTION_REVIEW']:[],gateway:{payment:'NOT_CONNECTED',exchange:'DISABLED',riskMonitor:'DEMO_RULES_ONLY'},events:events.slice(0,15).map(x=>({...x}))}};
}
return {submit,cancel,snapshot}
}
module.exports={createEngine,MARKET,MAX_ORDER_NOTIONAL_CENTS};
