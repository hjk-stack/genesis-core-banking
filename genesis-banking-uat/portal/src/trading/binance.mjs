import {createHmac} from 'node:crypto';
export class BinanceSpot {
 constructor({env=process.env,fetcher=fetch}={}){this.env=env;this.fetcher=fetcher;}
 credentials(ref){if(!/^TRADING_[A-Z0-9_]{1,50}$/.test(ref||''))throw Error('ROBOT_API_KEY');const key=this.env[ref+'_KEY'],secret=this.env[ref+'_SECRET'];if(!key||!secret)throw Error('ROBOT_API_KEY');return {key,secret};}
 async request(path,params={},ref,method='GET'){
  const p=new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)]));let headers={};
  if(ref){const {key,secret}=this.credentials(ref);p.set('timestamp',String(Date.now()));p.set('recvWindow','5000');p.set('signature',createHmac('sha256',secret).update(p.toString()).digest('hex'));headers['X-MBX-APIKEY']=key;}
  const r=await this.fetcher('https://api.binance.com'+path+'?'+p,{method,headers,signal:AbortSignal.timeout(8000),redirect:'error'});const v=await r.json();if(!r.ok){const e=Error('ROBOT_VENUE_RESPONSE');e.venueCode=v.code;e.status=r.status;throw e;}return v;
 }
 async market(symbol){if(!/^[A-Z0-9]{3,30}$/.test(symbol))throw Error('ROBOT_SYMBOL');const r=await this.request('/api/v3/exchangeInfo',{symbol}),m=r.symbols?.find(s=>s.symbol===symbol);if(!m||m.status!=='TRADING'||!m.isSpotTradingAllowed)throw Error('ROBOT_SYMBOL');const f=Object.fromEntries(m.filters.map(x=>[x.filterType,x]));return {baseAsset:m.baseAsset,quoteAsset:m.quoteAsset,priceTick:f.PRICE_FILTER.tickSize,quantityStep:f.LOT_SIZE.stepSize,minQuantity:f.LOT_SIZE.minQty,maxQuantity:f.LOT_SIZE.maxQty,minNotional:f.NOTIONAL?.minNotional||f.MIN_NOTIONAL?.minNotional||'0'};}
 async balance(ref){const a=await this.request('/api/v3/account',{},ref);if(!a.canTrade)throw Error('ROBOT_ACCOUNT');return a.balances;}
 submit(o,ref){return this.request('/api/v3/order',{symbol:o.symbol,side:o.side,type:'LIMIT',timeInForce:'IOC',quantity:o.quantity,price:o.price,newClientOrderId:o.client_order_id,newOrderRespType:'FULL'},ref,'POST');}
 order(symbol,id,ref){return this.request('/api/v3/order',{symbol,origClientOrderId:id},ref);}
 trades(symbol,orderId,ref){return this.request('/api/v3/myTrades',{symbol,orderId},ref);}
}
