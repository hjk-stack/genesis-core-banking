import test from 'node:test';
import assert from 'node:assert/strict';
import {CoinApiEms,prepareEmsOrder,emsExecutionEvidence} from '../src/trading/coinapi-ems.mjs';
import {TradingRuntime} from '../src/trading/runtime.mjs';
const env={COINAPI_EMS_API_KEY:'fixture-ems',COINAPI_API_KEY:'fixture-market'};
const order={exchangeId:'KRAKEN/TREASURY',symbol:'KRAKEN_SPOT_BTC_USDT',clientOrderId:'AVIS-001',side:'BUY',quantity:'0.01',price:'90000'};
const req=prepareEmsOrder(order);
const report={...req,type:'ORDER_EXEC_REPORT_UPDATE',status:'CANCELED',amount_filled:0.005,amount_open:0,exchange_order_id:'K-123',fills:[{amount:0.005,price:89999,time:'2026-11-25T00:00:00Z'}]};
test('EMS audit uses the dedicated credential and reports only evidence, never authorization to execute',async()=>{
 const calls=[],ems=new CoinApiEms({env,fetcher:async(url,o)=>{calls.push([url,o.method]);assert.equal(o.headers['X-CoinAPI-Key'],'fixture-ems');return Response.json(url.endsWith('/balances')?[{type:'BALANCE_SNAPSHOT',exchange_id:'KRAKEN/TREASURY',data:[{asset_id_coinapi:'BTC',available:0.01}]}]:[]);}});
 const audit=await ems.audit();assert.equal(audit.verified,true);assert.equal(audit.executionVerified,false);assert.equal(audit.fundedAccountCount,1);assert.deepEqual(audit.accounts,['KRAKEN/TREASURY']);assert.doesNotMatch(JSON.stringify(audit),/fixture-/);
 assert.deepEqual(calls,[['https://global.ems.coinapi.net/v1/balances','GET'],['https://global.ems.coinapi.net/v1/orders','GET']]);
});
test('malformed and empty account responses cannot verify exchange connectivity',async()=>{
 for(const [rows,code] of [[[],'EMS_NO_ACCOUNTS'],[[{exchange_id:'KRAKEN/TREASURY'}],'EMS_SCHEMA']]){
 const audit=await new CoinApiEms({env,fetcher:async(url)=>Response.json(url.endsWith('/balances')?rows:[])}).audit();assert.equal(audit.verified,false);assert.equal(audit.code,code);
 }
 assert.equal((await new CoinApiEms({env:{COINAPI_API_KEY:'market-only'},fetcher:()=>assert.fail('no EMS key')}).audit()).configured,false);
});
test('EMS IOC routes only the exact account and spot symbol and uses status after an ambiguous send',async()=>{
 const calls=[],ems=new CoinApiEms({env,fetcher:async(url,o)=>{calls.push([url,o.method]);if(o.method==='POST'){assert.deepEqual(JSON.parse(o.body),req);throw Error('timeout');}return Response.json(report);}});
 assert.equal(req.time_in_force,'IMMEDIATE_OR_CANCEL');assert.equal(req.order_type,'LIMIT');
 await assert.rejects(ems.submit(order),/EMS_TRANSPORT/);
 const read=await ems.status(order);assert.equal(read.terminal,true);assert.equal(read.filled,'0.005');assert.equal(read.ledgerSettlementVerified,false);
 assert.deepEqual(calls,[['https://global.ems.coinapi.net/v1/orders','POST'],['https://global.ems.coinapi.net/v1/orders/status/AVIS-001','GET']]);
});
test('wrong exchange, derivative, imprecise amount or mismatched report cannot become execution evidence',()=>{
 for(const change of [{symbol:'BINANCE_SPOT_BTC_USDT'},{symbol:'KRAKEN_PERP_BTC_USDT'},{quantity:'0.123456789012345678'}])assert.throws(()=>prepareEmsOrder({...order,...change}),/EMS_ORDER_/);
 for(const change of [{exchange_id:'KRAKEN/OTHER'},{client_order_id:'OTHER'},{symbol_id_coinapi:'KRAKEN_SPOT_ETH_USDT'},{amount_filled:0.02},{fills:[]},{status:'FILLED'},{fills:[{amount:0.001,price:89999,time:'2026-11-25T00:00:00Z'}]},{fills:[{amount:0.006,price:89999,time:'2026-11-25T00:00:00Z'}]}])assert.throws(()=>emsExecutionEvidence({...report,...change},req),/EMS_SCHEMA/);
});

test('EMS audit scheduling remains stable when the worker repeatedly restarts',async()=>{
 let audits=0;
 const core={auditEms:async()=>{audits++;return {provider:'CoinAPI EMS',verified:true,executionVerified:false};},liveMarkets:{}};
 const runtime=new TradingRuntime(core,{WebSocketClass:class {}});
 try{
  runtime.startEmsAudit();
  const scheduled=runtime.auditTimer;
  assert.ok(scheduled);
  runtime.startEmsAudit();
  runtime.startEmsAudit();
  assert.equal(runtime.auditTimer,scheduled);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(audits,1);
 }finally{await runtime.stop();}
});
