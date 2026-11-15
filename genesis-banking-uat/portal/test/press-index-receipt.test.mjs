import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TradingRuntime,engineStatus} from '../src/trading/runtime.mjs';
import {createBankServer} from '../server.mjs';
const snapshot=()=>({producer:'AVIS_PRESS_ROBOT',schemaVersion:1,sequence:'a'.repeat(64),generatedAt:new Date(Date.now()-1000).toISOString(),collectionEnabled:true,indices:[{instrumentId:'BTC',validUntil:new Date(Date.now()+60000).toISOString(),score:20,confidence:.4,sourceCount:3}]});
test('INDEX is received with no enabled trading profile and no order is placed',async()=>{
 const queries=[],pool={query:async(...q)=>{queries.push(q);return {rows:[]};}},runtime=new TradingRuntime({pool},{fetcher:async()=>new Response(JSON.stringify(snapshot()))});await runtime.refreshIndex();
 assert.equal(queries.length,0);assert.equal(engineStatus.indexReceipt.sequence,'a'.repeat(64));assert.equal(engineStatus.indexReceipt.source,'AVIS_PRESS_ROBOT');assert.ok(Date.parse(engineStatus.indexReceipt.receivedAt));
});
test('paused INDEX clears trading entry evidence; stale or wrong-producer data cannot claim receipt',async()=>{
 let value=snapshot();const queries=[],messages=[],runtime=new TradingRuntime({pool:{query:async(...q)=>{queries.push(q);return {rows:[]};}}},{fetcher:async()=>new Response(JSON.stringify(value))});runtime.configs=[{robot_id:'robot',index_id:'BTC'}];runtime.send=v=>messages.push(v);
 value.collectionEnabled=false;await runtime.refreshIndex();assert.equal(queries.at(-1)[1][1],null);assert.equal(messages.at(-1).index,null);
 const old=engineStatus.indexReceipt;value={...snapshot(),sequence:'b'.repeat(64),generatedAt:'2000-01-01T00:00:00Z'};await runtime.refreshIndex();assert.equal(engineStatus.indexReceipt,old);value={...snapshot(),producer:'OTHER'};await runtime.refreshIndex();assert.equal(engineStatus.indexReceipt,old);
});
test('public receipt exposes only dated INDEX delivery, while account views still require login',async()=>{
 const server=createBankServer({pool:{query:async()=>({rows:[]})},authenticate:async()=>null});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{const response=await fetch(base+'/api/crypto/trading/index-receipt');assert.equal(response.status,200);const data=await response.json();assert.deepEqual(Object.keys(data).sort(),['generatedAt','producer','receivedAt','sequence','source']);assert.equal((await fetch(base+'/api/views/accounts')).status,401);}finally{await new Promise(r=>server.close(r));}
});
