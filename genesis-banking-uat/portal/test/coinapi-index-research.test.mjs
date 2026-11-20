import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CoinApiIndexResearch,readCoinApiIndexResearch,configuredCoinApiIndexes} from '../src/trading/coinapi-index-research.mjs';

const now=Date.parse('2026-11-20T08:00:00Z'),start='2026-11-18T00:00:00Z',end='2026-11-19T00:00:00Z';
const ids=['IDX_REFRATE_PRIMKT_BTC_USD','IDX_REFRATE_PRIMKT_ETH_USD'];
const bar={time_period_start:start,time_period_end:end,value_open:100,value_high:110,value_low:90,value_close:105};
function fixture({invalidETH=false,noKey=false}={}){
 let currentTime=now;
 const observations=new Map(),bars=new Map(),calls=[],rows=[];
 const pool={async query(sql,params){
  if(sql.includes('INSERT INTO avis_core_v2.coinapi_index_bars')){const key=params.slice(0,2).join(':');if(bars.has(key))return {rowCount:0};bars.set(key,params);return {rowCount:1};}
  if(sql.includes('INSERT INTO avis_core_v2.coinapi_index_observations')){const key=params.slice(0,2).join(':');if(observations.has(key))return {rowCount:0};observations.set(key,params);return {rowCount:1};}
  if(sql.includes('FROM avis_core_v2.coinapi_index_observations')){const record=[...observations.values()].find(v=>v[0]===params[0]);return {rows:record?[{source_at:record[1],value:record[2],received_at:new Date(now)}]:[]};}
  if(sql.includes('FROM avis_core_v2.coinapi_index_bars')){return {rows:[...bars.values()].filter(v=>v[0]===params[0]).map(v=>({period_start:v[1],period_end:v[2],value_close:v[6]}))};}
  throw Error('Unexpected database query');
 }};
 const fetcher=async(url,options)=>{
  calls.push({url,headers:options.headers,redirect:options.redirect});
  const isETH=url.includes('_ETH_'),history=url.includes('/timeseries'),body=history?[bar, {...bar,time_period_end:'2026-11-21T00:00:00Z'}]:
    {timestamp:'2026-11-20T07:59:00Z',value: isETH&&invalidETH?-20:111.25};
  return {ok:true,redirected:false,text:async()=>JSON.stringify(body)};
 };
 const env=noKey?{AVIS_INDEX_BENCHMARKS:ids.join(',')}:{COINAPI_INDEXES_API_KEY:'unit-secret',AVIS_INDEX_BENCHMARKS:ids.join(',')};
 return {pool,observations,bars,calls,env,advance:ms=>{currentTime+=ms;},collector:new CoinApiIndexResearch({pool,env,fetcher,now:()=>currentTime})};
}
test('indexes feed ingests actual current values and completed daily history, never future bars',async()=>{
 const t=fixture(),r=await t.collector.poll();
 assert.equal(r.configured,true);assert.equal(r.indices.length,2);assert.equal(t.observations.size,2);assert.equal(t.bars.size,2);
 assert.equal(t.calls.length,4);
 assert.ok(t.calls.every(c=>c.url.startsWith('https://rest-api.indexes.coinapi.io/v1/indexes/')));
 assert.ok(t.calls.every(c=>c.headers['X-CoinAPI-Key']==='unit-secret'&&c.redirect==='error'));
 const snapshot=await readCoinApiIndexResearch(t.pool,t.env,now);
 assert.equal(snapshot.researchActive,true);assert.equal(snapshot.indices[0].value,'111.25');assert.equal(snapshot.indices[0].fresh,true);
 assert.equal(snapshot.indices[0].history.length,1);assert.equal(JSON.stringify(snapshot).includes('unit-secret'),false);
 const again=await t.collector.poll();
 assert.equal(again.indices[0].latest.inserted,0);assert.equal(t.calls.length,6,'historical backfill must run once after success');
 assert.equal(t.observations.size,2);assert.equal(t.bars.size,2);
});
test('completed historical index bars refresh each day without creating duplicate observations',async()=>{
 const t=fixture();
 await t.collector.poll();assert.equal(t.calls.filter(c=>c.url.includes('/timeseries')).length,2);
 await t.collector.poll();assert.equal(t.calls.filter(c=>c.url.includes('/timeseries')).length,2);
 t.advance(24*60*60*1000+1);await t.collector.poll();
 assert.equal(t.calls.filter(c=>c.url.includes('/timeseries')).length,4);
 assert.equal(t.bars.size,2,'repeated completed bars retain immutable identities');
 assert.equal(t.observations.size,2,'stale current values must not be recredited as new research observations');
});
test('invalid provider values cannot enter research data or block independent indexes',async()=>{
 const t=fixture({invalidETH:true});const result=await t.collector.poll();
 assert.equal(t.observations.size,1);assert.equal(result.indices[1].currentError,'COINAPI_INDEX_SCHEMA');
 assert.equal(result.indices[0].latest.value,'111.25');
});
test('missing credentials cause no network calls; malformed configured index ids are rejected',async()=>{
 const t=fixture({noKey:true});
 assert.deepEqual(await t.collector.poll(),{configured:false,indices:[]});assert.equal(t.calls.length,0);
 assert.throws(()=>configuredCoinApiIndexes({AVIS_INDEX_BENCHMARKS:'../traversal'}),/COINAPI_INDEX_IDENTIFIERS/);
 assert.deepEqual(configuredCoinApiIndexes({AVIS_INDEX_BENCHMARKS:''}),[]);
});
