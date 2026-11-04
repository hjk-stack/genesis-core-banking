'use strict';
// GENESIS Exchange core: a deterministic price-time-priority central limit order book.
// UAT SIMULATION ONLY. It matches orders in memory and emits events; it never moves money,
// securities or crypto, never connects to a real venue and never settles anything.
// The same engine backs the stock exchange, the crypto exchange, tokenised assets and the
// derivatives hub; each instrument carries its own tick, lot and price-band rules.
const ASSET_CLASSES=['equity','bond','fund','crypto','token','future','option'];
const SYMBOL=/^[A-Z0-9][A-Z0-9_.:/-]{0,39}$/;
const REF=/^[A-Za-z0-9_.:-]{2,80}$/;
const MAX=9223372036854775807n;

function positive(v,code){
 if(typeof v!=='string'||!/^[1-9][0-9]*$/.test(v)||BigInt(v)>MAX)throw Error(code);
 return BigInt(v);
}
function ref(v,code){if(typeof v!=='string'||!REF.test(v))throw Error(code);return v}

function validateInstrument(i){
 if(!i||typeof i.symbol!=='string'||!SYMBOL.test(i.symbol))throw Error('INVALID_SYMBOL');
 if(!ASSET_CLASSES.includes(i.assetClass))throw Error('INVALID_ASSET_CLASS');
 if(typeof i.quoteAsset!=='string'||!/^[A-Z0-9]{2,12}$/.test(i.quoteAsset))throw Error('INVALID_QUOTE_ASSET');
 const tick=positive(i.tickSize,'INVALID_TICK_SIZE'),lot=positive(i.lotSize,'INVALID_LOT_SIZE');
 const band=i.priceBandBps==null?null:Number(i.priceBandBps);
 if(band!=null&&(!Number.isInteger(band)||band<1||band>10000))throw Error('INVALID_PRICE_BAND');
 const reference=i.referencePrice==null?null:positive(i.referencePrice,'INVALID_REFERENCE_PRICE');
 if(reference!=null&&reference%tick!==0n)throw Error('REFERENCE_PRICE_OFF_TICK');
 return {symbol:i.symbol,assetClass:i.assetClass,quoteAsset:i.quoteAsset,tickSize:tick,lotSize:lot,priceBandBps:band,referencePrice:reference};
}

// One side of the book: price levels kept sorted best-first, each a FIFO queue.
class BookSide{
 constructor(side){this.side=side;this.levels=[]}
 better(a,b){return this.side==='buy'?a>b:a<b}
 index(price){
  let lo=0,hi=this.levels.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(this.better(this.levels[mid].price,price)||this.levels[mid].price===price)lo=mid+1;else hi=mid}
  return lo;
 }
 add(order){
  const at=this.index(order.price);
  const prev=this.levels[at-1];
  if(prev&&prev.price===order.price)prev.orders.push(order);
  else this.levels.splice(at,0,{price:order.price,orders:[order]});
 }
 remove(order){
  const i=this.levels.findIndex(l=>l.price===order.price);
  if(i<0)return false;
  const level=this.levels[i],j=level.orders.indexOf(order);
  if(j<0)return false;
  level.orders.splice(j,1);
  if(!level.orders.length)this.levels.splice(i,1);
  return true;
 }
 best(){return this.levels[0]}
 crosses(limit){const b=this.best();return !!b&&(limit==null||(this.side==='buy'?b.price>=limit:b.price<=limit))}
 // Quantity fillable up to the limit before matching would reach one of the account's own orders.
 fillable(limit,account,needed){
  let total=0n;
  for(const level of this.levels){
   if(limit!=null&&(this.side==='buy'?level.price<limit:level.price>limit))break;
   for(const o of level.orders){if(o.accountId===account)return total;total+=o.remaining;if(total>=needed)return total}
  }
  return total;
 }
 depth(n){return this.levels.slice(0,n).map(l=>({price:l.price.toString(),quantity:l.orders.reduce((s,o)=>s+o.remaining,0n).toString(),orders:l.orders.length}))}
}

class OrderBook{
 constructor(instrument,{clock=()=>new Date().toISOString(),onEvent=()=>{}}={}){
  this.instrument=validateInstrument(instrument);
  this.clock=clock;this.onEvent=onEvent;
  this.bids=new BookSide('buy');this.asks=new BookSide('sell');
  this.orders=new Map();this.clientIds=new Set();
  this.seq=0n;this.lastPrice=this.instrument.referencePrice;this.status='open';
 }
 emit(type,body){this.seq+=1n;const e={seq:this.seq.toString(),type,symbol:this.instrument.symbol,at:this.clock(),...body};this.onEvent(e);return e}
 halt(reason){this.status='halted';return this.emit('trading_halted',{reason:ref(reason,'INVALID_REASON')})}
 resume(){this.status='open';return this.emit('trading_resumed',{})}

 validate(o){
  if(!o||typeof o!=='object')throw Error('INVALID_ORDER');
  ref(o.accountId,'INVALID_ACCOUNT');ref(o.clientOrderId,'INVALID_CLIENT_ORDER_ID');
  if(!['buy','sell'].includes(o.side))throw Error('INVALID_SIDE');
  if(!['limit','market'].includes(o.type))throw Error('INVALID_ORDER_TYPE');
  const tif=o.timeInForce||(o.type==='market'?'IOC':'GTC');
  if(!['GTC','IOC','FOK'].includes(tif))throw Error('INVALID_TIME_IN_FORCE');
  if(o.type==='market'&&tif==='GTC')throw Error('MARKET_ORDER_CANNOT_REST');
  const {tickSize,lotSize,priceBandBps}=this.instrument;
  const quantity=positive(o.quantity,'INVALID_QUANTITY');
  if(quantity%lotSize!==0n)throw Error('QUANTITY_NOT_LOT_MULTIPLE');
  let price=null;
  if(o.type==='limit'){
   price=positive(o.price,'INVALID_PRICE');
   if(price%tickSize!==0n)throw Error('PRICE_OFF_TICK');
   if(priceBandBps!=null&&this.lastPrice!=null){
    const width=this.lastPrice*BigInt(priceBandBps)/10000n;
    if(price>this.lastPrice+width||price<this.lastPrice-width)throw Error('PRICE_OUTSIDE_BAND');
   }
  }else if(o.price!=null)throw Error('MARKET_ORDER_HAS_PRICE');
  const key=o.accountId+'\u0000'+o.clientOrderId;
  if(this.clientIds.has(key))throw Error('DUPLICATE_CLIENT_ORDER_ID');
  return {key,quantity,price,tif};
 }

 marketLimit(side){
  const {priceBandBps}=this.instrument;
  if(priceBandBps==null||this.lastPrice==null)return null;
  const width=this.lastPrice*BigInt(priceBandBps)/10000n;
  return side==='buy'?this.lastPrice+width:this.lastPrice-width;
 }

 submit(o){
  if(this.status!=='open')throw Error('TRADING_HALTED');
  const {key,quantity,price,tif}=this.validate(o);
  this.clientIds.add(key);
  const order={id:this.instrument.symbol+'-'+(this.seq+1n).toString(),accountId:o.accountId,clientOrderId:o.clientOrderId,side:o.side,type:o.type,timeInForce:tif,price,quantity,remaining:quantity,status:'new'};
  const events=[this.emit('order_accepted',view(order))];
  const contra=order.side==='buy'?this.asks:this.bids;
  // Market orders never trade beyond the instrument's price band around the last price.
  const limit=price??this.marketLimit(order.side);
  if(tif==='FOK'&&contra.fillable(limit,order.accountId,quantity)<quantity){
   order.status='cancelled';
   events.push(this.emit('order_cancelled',{...view(order),reason:'fok_not_fillable'}));
   return {order:view(order),events};
  }
  if(order.type==='market'&&!contra.best()){
   order.status='cancelled';
   events.push(this.emit('order_cancelled',{...view(order),reason:'no_liquidity'}));
   return {order:view(order),events};
  }
  while(order.remaining>0n&&contra.crosses(limit)){
   const level=contra.best(),maker=level.orders[0];
   if(maker.accountId===order.accountId){
    // Self-trade prevention: the incoming order's remainder is cancelled; the resting order stays.
    order.status='cancelled';
    events.push(this.emit('order_cancelled',{...view(order),reason:'self_trade_prevented'}));
    return {order:view(order),events};
   }
   const qty=maker.remaining<order.remaining?maker.remaining:order.remaining;
   maker.remaining-=qty;order.remaining-=qty;this.lastPrice=level.price;
   const buy=order.side==='buy'?order:maker,sell=order.side==='sell'?order:maker;
   events.push(this.emit('trade',{price:level.price.toString(),quantity:qty.toString(),aggressor:order.side,makerOrderId:maker.id,takerOrderId:order.id,buyOrderId:buy.id,sellOrderId:sell.id,buyAccountId:buy.accountId,sellAccountId:sell.accountId}));
   maker.status=maker.remaining===0n?'filled':'partially_filled';
   if(maker.remaining===0n){contra.remove(maker);this.orders.delete(maker.id)}
  }
  if(order.remaining===0n)order.status='filled';
  else if(order.type==='limit'&&tif==='GTC'){
   order.status=order.remaining<quantity?'partially_filled':'resting';
   (order.side==='buy'?this.bids:this.asks).add(order);this.orders.set(order.id,order);
   events.push(this.emit('order_resting',view(order)));
  }else{
   order.status='cancelled';
   events.push(this.emit('order_cancelled',{...view(order),reason:'unfilled_remainder'}));
  }
  return {order:view(order),events};
 }

 cancel(orderId,accountId){
  const order=this.orders.get(orderId);
  if(!order||order.accountId!==accountId)throw Error('ORDER_NOT_FOUND');
  (order.side==='buy'?this.bids:this.asks).remove(order);this.orders.delete(orderId);
  order.status='cancelled';
  return this.emit('order_cancelled',{...view(order),reason:'client_request'});
 }

 snapshot(levels=10){
  return {symbol:this.instrument.symbol,status:this.status,lastPrice:this.lastPrice?.toString()??null,seq:this.seq.toString(),bids:this.bids.depth(levels),asks:this.asks.depth(levels)};
 }
}

function view(o){return {orderId:o.id,accountId:o.accountId,clientOrderId:o.clientOrderId,side:o.side,type:o.type,timeInForce:o.timeInForce,price:o.price?.toString()??null,quantity:o.quantity.toString(),remaining:o.remaining.toString(),status:o.status}}

class Exchange{
 constructor(venue,options={}){this.venue=ref(venue,'INVALID_VENUE');this.options=options;this.books=new Map()}
 list(instrument){
  const i=validateInstrument(instrument);
  if(this.books.has(i.symbol))throw Error('INSTRUMENT_ALREADY_LISTED');
  this.books.set(i.symbol,new OrderBook(instrument,this.options));
  return {venue:this.venue,symbol:i.symbol,assetClass:i.assetClass,quoteAsset:i.quoteAsset};
 }
 book(symbol){const b=this.books.get(symbol);if(!b)throw Error('UNKNOWN_INSTRUMENT');return b}
 submit(symbol,order){return this.book(symbol).submit(order)}
 cancel(symbol,orderId,accountId){return this.book(symbol).cancel(orderId,accountId)}
 instruments(){return [...this.books.values()].map(b=>({symbol:b.instrument.symbol,assetClass:b.instrument.assetClass,quoteAsset:b.instrument.quoteAsset,tickSize:b.instrument.tickSize.toString(),lotSize:b.instrument.lotSize.toString(),status:b.status}))}
}

module.exports={ASSET_CLASSES,validateInstrument,OrderBook,Exchange};
