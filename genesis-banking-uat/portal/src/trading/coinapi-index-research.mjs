// Independent CoinAPI Indexes research feed. Index values never count as fills, custody or executable quotes.
import {marketDecimal} from './live-market.mjs';

export const COINAPI_INDEX_ORIGIN='https://rest-api.indexes.coinapi.io';
const DEFAULT_IDS=['IDX_REFRATE_PRIMKT_BTC_USD','IDX_REFRATE_PRIMKT_ETH_USD'];
const validId=id=>typeof id==='string'&&/^IDX_[A-Z0-9_]{4,110}$/.test(id);
const timestamp=(value,now)=>{
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(value))return null;
 const time=Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value)?value:value+'Z');
 return Number.isFinite(time)&&time>0&&time<=now+30000?new Date(time).toISOString():null;
};
export function configuredCoinApiIndexes(env=process.env){
 const raw=typeof env.AVIS_INDEX_BENCHMARKS==='string'?env.AVIS_INDEX_BENCHMARKS.trim():null;
 const ids=raw===null?DEFAULT_IDS:raw?raw.split(',').map(x=>x.trim()):[];
 if(ids.length>8||ids.some(x=>!validId(x)))throw Error('COINAPI_INDEX_IDENTIFIERS');
 return [...new Set(ids)];
}
export function coinApiIndexKey(env=process.env){
 return env.COINAPI_INDEXES_API_KEY||env.COINAPI_MARKET_DATA_API_KEY||env.COINAPI_API_KEY||env.APIBRICKS_COINAPI_KEY||null;
}
const positive=value=>marketDecimal(value,true);
const safeReason=error=>/^COINAPI_INDEX_(SCHEMA|HTTP_\d{3}|TRANSPORT)$/.test(error.message)?error.message:'COINAPI_INDEX_TRANSPORT';

export class CoinApiIndexResearch {
 constructor({pool,env=process.env,fetcher=fetch,now=Date.now}){
  this.pool=pool;this.env=env;this.fetcher=fetcher;this.now=now;this.historyCheckedAt=new Map();this.busy=false;
 }
 async request(id,kind,query=''){
  if(!validId(id)||!['current','timeseries'].includes(kind))throw Error('COINAPI_INDEX_SCHEMA');
  const key=coinApiIndexKey(this.env);
  if(typeof key!=='string'||!key||key.length>2048||/[\r\n]/.test(key))throw Error('COINAPI_INDEX_AUTH');
  let response;
  try{response=await this.fetcher(COINAPI_INDEX_ORIGIN+'/v1/indexes/'+encodeURIComponent(id)+'/'+kind+query,{
   headers:{'X-CoinAPI-Key':key,accept:'application/json'},signal:AbortSignal.timeout(9000),redirect:'error'});
  }catch{throw Error('COINAPI_INDEX_TRANSPORT');}
  if(!response.ok||response.redirected)throw Error('COINAPI_INDEX_HTTP_'+response.status);
  let body;
  try{body=await response.text();}catch{throw Error('COINAPI_INDEX_TRANSPORT');}
  if(body.length>1000000)throw Error('COINAPI_INDEX_SCHEMA');
  try{return JSON.parse(body);}catch{throw Error('COINAPI_INDEX_SCHEMA');}
 }
 async history(id,now){
  const start=new Date(now-32*86400000).toISOString(),end=new Date(now).toISOString();
  const q='?'+new URLSearchParams({period_id:'1DAY',time_start:start,time_end:end,limit:'35'});
  const values=await this.request(id,'timeseries',q);
  if(!Array.isArray(values)||values.length>35)throw Error('COINAPI_INDEX_SCHEMA');
  let inserted=0;
  for(const row of values){
   const startAt=timestamp(row?.time_period_start,now),endAt=timestamp(row?.time_period_end,now);
   const open=positive(row?.value_open),high=positive(row?.value_high),low=positive(row?.value_low),close=positive(row?.value_close);
   if(!startAt||!endAt||Date.parse(endAt)<=Date.parse(startAt)||Date.parse(endAt)>now||!open||!high||!low||!close||
      Number(high)<Math.max(Number(open),Number(low),Number(close))||Number(low)>Math.min(Number(open),Number(high),Number(close)))continue;
   const result=await this.pool.query(`INSERT INTO avis_core_v2.coinapi_index_bars
    (index_id,period_id,period_start,period_end,value_open,value_high,value_low,value_close)
    VALUES($1,'1DAY',$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[id,startAt,endAt,open,high,low,close]);
   inserted+=result.rowCount||0;
  }
  return inserted;
 }
 async current(id,now){
  const value=await this.request(id,'current'),at=timestamp(value?.timestamp,now),price=positive(value?.value);
  if(!at||!price||now-Date.parse(at)>300000)throw Error('COINAPI_INDEX_SCHEMA');
  const result=await this.pool.query(`INSERT INTO avis_core_v2.coinapi_index_observations(index_id,source_at,value)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[id,at,price]);
  return {id,at,value:price,inserted:result.rowCount||0};
 }
 async poll(){
  if(this.busy)return {skipped:'BUSY'};
  if(!coinApiIndexKey(this.env))return {configured:false,indices:[]};
  this.busy=true;
  try{
   const ids=configuredCoinApiIndexes(this.env),results=[];
   for(const id of ids){
    const item={id};
    if(!this.historyCheckedAt.has(id)||this.now()-this.historyCheckedAt.get(id)>=24*60*60*1000){try{item.newBars=await this.history(id,this.now());this.historyCheckedAt.set(id,this.now());}
     catch(error){item.historyError=safeReason(error);}}
    try{item.latest=await this.current(id,this.now());}
    catch(error){item.currentError=safeReason(error);}
    results.push(item);
   }
   return {configured:true,indices:results};
  }finally{this.busy=false;}
 }
}
export async function readCoinApiIndexResearch(pool,env=process.env,now=Date.now()){
 const ids=configuredCoinApiIndexes(env);
 const results=[];
 for(const id of ids){
  const [latest,history]=await Promise.all([
   pool.query('SELECT source_at,value,received_at FROM avis_core_v2.coinapi_index_observations WHERE index_id=$1 ORDER BY source_at DESC LIMIT 1',[id]),
   pool.query('SELECT period_start,period_end,value_close FROM avis_core_v2.coinapi_index_bars WHERE index_id=$1 ORDER BY period_start DESC LIMIT 30',[id])
  ]);
  const row=latest.rows[0],at=row?.source_at?new Date(row.source_at).toISOString():null;
  results.push({indexId:id,value:row?.value==null?null:String(row.value),sourceAt:at,receivedAt:row?.received_at?new Date(row.received_at).toISOString():null,
   fresh:at!==null&&now-Date.parse(at)>=0&&now-Date.parse(at)<=300000,
   history:history.rows.slice().reverse().map(r=>({at:new Date(r.period_start).toISOString(),close:String(r.value_close)}))});
 }
 return {provider:'CoinAPI Indexes API',configured:Boolean(coinApiIndexKey(env)),researchActive:results.some(r=>r.fresh),
  verifiedAt:new Date(now).toISOString(),indices:results};
}
