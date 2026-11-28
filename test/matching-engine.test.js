'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {OrderBook,Exchange,validateInstrument}=require('../src/matching-engine');
const clock=()=>'2026-10-10T00:00:00.000Z';
const equity={symbol:'AVIS',assetClass:'equity',quoteAsset:'EUR',tickSize:'5',lotSize:'10'};
const book=(over={})=>new OrderBook({...equity,...over},{clock});
const order=(account,clientOrderId,side,quantity,price,extra={})=>({accountId:'ACC-'+account,clientOrderId,side,type:price==null?'market':'limit',quantity,...(price==null?{}:{price}),...extra});
const trades=r=>r.events.filter(e=>e.type==='trade').map(e=>[e.price,e.quantity]);

test('instrument rules are validated',()=>{
 assert.equal(validateInstrument(equity).tickSize,5n);
 assert.throws(()=>validateInstrument({...equity,assetClass:'lottery'}),/INVALID_ASSET_CLASS/);
 assert.throws(()=>validateInstrument({...equity,symbol:'bad symbol'}),/INVALID_SYMBOL/);
 assert.throws(()=>validateInstrument({...equity,referencePrice:'101'}),/REFERENCE_PRICE_OFF_TICK/);
});

test('orders respect tick, lot and duplicate client ids',()=>{
 const b=book();
 assert.throws(()=>b.submit(order('A','C1','buy','10','101')),/PRICE_OFF_TICK/);
 assert.throws(()=>b.submit(order('A','C1','buy','15','100')),/QUANTITY_NOT_LOT_MULTIPLE/);
 b.submit(order('A','C1','buy','10','100'));
 assert.throws(()=>b.submit(order('A','C1','buy','10','100')),/DUPLICATE_CLIENT_ORDER_ID/);
 assert.throws(()=>b.submit({...order('A','C2','buy','10',null),timeInForce:'GTC'}),/MARKET_ORDER_CANNOT_REST/);
});

test('price-time priority: best price first, then first in',()=>{
 const b=book();
 b.submit(order('S1','A1','sell','10','105'));
 b.submit(order('S2','A2','sell','10','100'));
 b.submit(order('S3','A3','sell','10','100'));
 const r=b.submit(order('B','B1','buy','30','105'));
 assert.deepEqual(trades(r),[['100','10'],['100','10'],['105','10']]);
 const makers=r.events.filter(e=>e.type==='trade').map(e=>e.sellAccountId);
 assert.deepEqual(makers,['ACC-S2','ACC-S3','ACC-S1']);
 assert.equal(r.order.status,'filled');
 assert.deepEqual(b.snapshot().asks,[]);
 assert.equal(b.snapshot().lastPrice,'105');
});

test('partial fill rests the remainder at its limit',()=>{
 const b=book();
 b.submit(order('S','A1','sell','10','100'));
 const r=b.submit(order('B','B1','buy','30','100'));
 assert.equal(r.order.status,'partially_filled');
 assert.equal(r.order.remaining,'20');
 assert.deepEqual(b.snapshot().bids,[{price:'100',quantity:'20',orders:1}]);
});

test('IOC cancels the remainder; FOK fills fully or not at all',()=>{
 const b=book();
 b.submit(order('S','A1','sell','10','100'));
 const ioc=b.submit(order('B','B1','buy','20','100',{timeInForce:'IOC'}));
 assert.deepEqual(trades(ioc),[['100','10']]);
 assert.equal(ioc.order.status,'cancelled');
 b.submit(order('S','A2','sell','10','100'));
 const fok=b.submit(order('B','B2','buy','20','100',{timeInForce:'FOK'}));
 assert.deepEqual(trades(fok),[]);
 assert.equal(b.snapshot().asks[0].quantity,'10');
});

test('market orders sweep the book and never rest',()=>{
 const b=book();
 assert.equal(b.submit(order('B','B0','buy','10',null)).order.status,'cancelled');
 b.submit(order('S','A1','sell','10','100'));
 b.submit(order('S','A2','sell','10','110'));
 const r=b.submit(order('B','B1','buy','30',null));
 assert.deepEqual(trades(r),[['100','10'],['110','10']]);
 assert.equal(r.order.status,'cancelled');
 assert.deepEqual(b.snapshot().bids,[]);
});

test('self-trade prevention cancels the incoming order, keeps the resting one',()=>{
 const b=book();
 b.submit(order('A','S1','sell','10','100'));
 const r=b.submit(order('A','B1','buy','10','100'));
 assert.deepEqual(trades(r),[]);
 assert.equal(r.events.at(-1).reason,'self_trade_prevented');
 assert.equal(b.snapshot().asks[0].quantity,'10');
 b.submit(order('X','S2','sell','10','95'));
 const fok=b.submit(order('A','B2','buy','20','100',{timeInForce:'FOK'}));
 assert.deepEqual(trades(fok),[],'FOK never part-fills before reaching its own order');
});

test('price band rejects off-market limits and caps market sweeps',()=>{
 const b=book({priceBandBps:1000,referencePrice:'100'});
 assert.throws(()=>b.submit(order('B','B1','buy','10','115')),/PRICE_OUTSIDE_BAND/);
 b.submit(order('S','A1','sell','10','105'));
 b.halt('VOLATILITY');
 assert.throws(()=>b.submit(order('B','B2','buy','10','105')),/TRADING_HALTED/);
 b.resume();
 const r=b.submit(order('B','B3','buy','20',null));
 assert.deepEqual(trades(r),[['105','10']]);
});

test('cancel only by the owning account',()=>{
 const b=book();
 const {order:o}=b.submit(order('A','C1','buy','10','100'));
 assert.throws(()=>b.cancel(o.orderId,'ACC-B'),/ORDER_NOT_FOUND/);
 assert.equal(b.cancel(o.orderId,'ACC-A').reason,'client_request');
 assert.deepEqual(b.snapshot().bids,[]);
});

test('exchange lists stocks, crypto pairs, tokens and futures on one engine',()=>{
 const events=[];
 const x=new Exchange('GENESIS_UAT',{clock,onEvent:e=>events.push(e)});
 x.list(equity);
 x.list({symbol:'BTC/EUR',assetClass:'crypto',quoteAsset:'EUR',tickSize:'1',lotSize:'1000'});
 x.list({symbol:'AVISGB-2030',assetClass:'token',quoteAsset:'EUR',tickSize:'1',lotSize:'1'});
 x.list({symbol:'AVIS-FUT-2612',assetClass:'future',quoteAsset:'EUR',tickSize:'5',lotSize:'1'});
 assert.throws(()=>x.list(equity),/INSTRUMENT_ALREADY_LISTED/);
 assert.deepEqual(x.instruments().map(i=>i.assetClass),['equity','crypto','token','future']);
 x.submit('BTC/EUR',order('S','A1','sell','5000','60000'));
 const r=x.submit('BTC/EUR',order('B','B1','buy','2000','60000'));
 assert.deepEqual(trades(r),[['60000','2000']]);
 assert.ok(events.some(e=>e.type==='trade'&&e.symbol==='BTC/EUR'));
 assert.throws(()=>x.submit('NOPE',order('B','B2','buy','1','1')),/UNKNOWN_INSTRUMENT/);
});
