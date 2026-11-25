import {marketDecimal} from './live-market.mjs';

const origin='https://global.ems.coinapi.net';
const fail=code=>{throw Object.assign(Error(code),{code});};
const accountId=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,119}$/.test(v);
const orderId=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(v);
const spotSymbol=v=>typeof v==='string'&&/^[A-Z0-9]+_SPOT_[A-Z0-9]+_[A-Z0-9]+$/.test(v);
const statuses=new Set(['RECEIVED','ROUTING','ROUTED','NEW','PARTIALLY_FILLED','PENDING_CANCEL','FILLED','CANCELED','REJECTED']);
const terminal=new Set(['FILLED','CANCELED','REJECTED']);
function orderNumber(value){
 const exact=marketDecimal(value,true),n=Number(exact);
 if(exact===null||!Number.isFinite(n)||marketDecimal(n,true)!==exact)fail('EMS_ORDER_PRECISION');
 return n;
}
export function prepareEmsOrder({exchangeId,symbol,clientOrderId,side,quantity,price}){
 if(!accountId(exchangeId)||!spotSymbol(symbol)||symbol.split('_')[0]!==exchangeId.split('/')[0]||!orderId(clientOrderId)||!['BUY','SELL'].includes(side))fail('EMS_ORDER_IDENTITY');
 return Object.freeze({exchange_id:exchangeId,symbol_id_coinapi:symbol,client_order_id:clientOrderId,side,amount_order:orderNumber(quantity),price:orderNumber(price),order_type:'LIMIT',time_in_force:'IMMEDIATE_OR_CANCEL'});
}
export function emsExecutionEvidence(row,expected){
 if(!row||row.type!=='ORDER_EXEC_REPORT_UPDATE'||row.exchange_id!==expected.exchange_id||row.client_order_id!==expected.client_order_id||row.symbol_id_coinapi!==expected.symbol_id_coinapi||row.side!==expected.side||row.order_type!==expected.order_type||row.time_in_force!==expected.time_in_force||row.amount_order!==expected.amount_order||row.price!==expected.price||!statuses.has(row.status))fail('EMS_SCHEMA');
 const filled=marketDecimal(row.amount_filled),remaining=marketDecimal(row.amount_open);
 if(filled===null||remaining===null||Number(filled)>expected.amount_order||Number(remaining)>expected.amount_order||row.status==='FILLED'&&Number(filled)!==expected.amount_order||row.status==='REJECTED'&&Number(filled)!==0)fail('EMS_SCHEMA');
 const fills=Array.isArray(row.fills)?row.fills.map(f=>({amount:marketDecimal(f.amount,true),price:marketDecimal(f.price,true),time:typeof f.time==='string'&&Number.isFinite(Date.parse(f.time))?f.time:null})):null;
 if(fills?.some(f=>!f.amount||!f.price||!f.time))fail('EMS_SCHEMA');
 // Compare exact decimal quantities so execution evidence cannot overstate fills.
 const units=value=>{const [whole,fraction='']=value.split('.');return BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,'0'));};
 const reported=units(filled);
 const actual=(fills||[]).reduce((sum,f)=>sum+units(f.amount),0n);
 if(actual!==reported||reported>0n&&(!orderId(row.exchange_order_id)||!fills?.length))fail('EMS_SCHEMA');
 // Evidence is intentionally separate from Binance settlement objects. EMS
 // fill fee and exact consideration validation must precede any ledger posting.
 return {exchangeId:row.exchange_id,clientOrderId:row.client_order_id,symbol:row.symbol_id_coinapi,side:row.side,status:row.status,terminal:terminal.has(row.status),filled,remaining,fills,venueOrderId:orderId(row.exchange_order_id)?row.exchange_order_id:null,ledgerSettlementVerified:false};
}
export class CoinApiEms {
 constructor({env=process.env,fetcher=fetch}={}){this.key=env.COINAPI_EMS_API_KEY||'';this.fetcher=fetcher;}
 async request(path,method='GET',payload){
  if(!this.key||typeof this.key!=='string'||/[^\x21-\x7e]/.test(this.key)||this.key.length>2048)fail('EMS_CREDENTIAL');
  let response;try{response=await this.fetcher(origin+path,{method,headers:{'X-CoinAPI-Key':this.key,Accept:'application/json',...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(10000),redirect:'error'});}catch{fail('EMS_TRANSPORT');}
  if(!response.ok)fail('EMS_HTTP_'+response.status);
  let data;try{data=await response.json();}catch{fail('EMS_SCHEMA');}
  return data;
 }
 async audit(){
  const checkedAt=new Date().toISOString();
  const base={provider:'CoinAPI EMS',configured:Boolean(this.key),verified:false,executionVerified:false,capability:'Authenticated balance and open-order reads',checkedAt};
  if(!this.key)return {...base,setting:'COINAPI_EMS_API_KEY'};
  try{
   const [balances,orders]=await Promise.all([this.request('/v1/balances'),this.request('/v1/orders')]);
   if(!Array.isArray(balances)||!Array.isArray(orders)||balances.some(r=>r?.type!=='BALANCE_SNAPSHOT'||!accountId(r.exchange_id)||!Array.isArray(r.data))||orders.some(r=>!accountId(r?.exchange_id)||!orderId(r.client_order_id)||!statuses.has(r.status)))fail('EMS_SCHEMA');
   const accounts=balances.map(r=>r.exchange_id);
   if(new Set(accounts).size!==accounts.length||orders.some(r=>!accounts.includes(r.exchange_id)))fail('EMS_SCHEMA');
   if(!accounts.length)return {...base,accounts:[],openOrderCount:orders.length,code:'EMS_NO_ACCOUNTS'};
   return {...base,verified:true,accounts,openOrderCount:orders.length,fundedAccountCount:balances.filter(r=>r.data.some(x=>typeof x?.available==='number'&&Number.isFinite(x.available)&&x.available>0&&typeof x.asset_id_coinapi==='string')).length};
  }catch(e){return {...base,code:/^EMS_(?:HTTP_\d{3}|SCHEMA|TRANSPORT|CREDENTIAL)$/.test(e.code||'')?e.code:'EMS_TRANSPORT'};}
 }
 // Used by an authorized dispatcher only after a durable order claim. A
 // transport failure is ambiguous; never automatically submit a second time.
 async submit(order){const request=prepareEmsOrder(order);return emsExecutionEvidence(await this.request('/v1/orders','POST',request),request);}
 async status(order){const request=prepareEmsOrder(order);return emsExecutionEvidence(await this.request('/v1/orders/status/'+encodeURIComponent(request.client_order_id)),request);}
}
