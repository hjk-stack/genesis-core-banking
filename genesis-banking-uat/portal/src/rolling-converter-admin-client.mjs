import {CONVERTER_WEB_ORIGIN,CONVERTER_ADMIN_PREFIX,converterAdminRoute,converterBody,signConverterRequest} from './rolling-converter-service-auth.mjs';
export const BANK_CONVERTER_PREFIX='/api/crypto/rolling-converter';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid=(status,message)=>({status,data:{code:'ROLLING_CONVERTER_REQUEST',message}});
export function legacyConversionAction(action){return ['HUB','DEPLOY','CAP','MINT'].includes(action);}
export function createRollingConverterAdminClient({env=process.env,fetcher=fetch}={}){
 return async function request({method,path,actor,body,idempotencyKey,privateDesk}){
  if(!privateDesk||!actor?.admin||actor.customerUserId)return invalid(403,'Use the rolling converter in Administration.');
  if(!path.startsWith(BANK_CONVERTER_PREFIX+'/'))return invalid(404,'Converter action not found.');
  const upstream=CONVERTER_ADMIN_PREFIX+path.slice(BANK_CONVERTER_PREFIX.length);
  if(!converterAdminRoute(method,upstream))return invalid(404,'Converter action not found.');
  if(method==='POST'&&!UUID.test(idempotencyKey||''))return invalid(400,'Converter request identity is required.');
  try{
   const raw=converterBody(method,body);
   if(Buffer.byteLength(raw)>16384)return invalid(413,'Converter request is too large.');
   const authorization=signConverterRequest({method,path:upstream,body,actor:actor.id,env,...(method==='POST'?{nonce:idempotencyKey}:{})});
   const response=await fetcher(CONVERTER_WEB_ORIGIN+upstream,{method,headers:{accept:'application/json',authorization,...(method==='POST'?{'content-type':'application/json'}:{})},...(method==='POST'?{body:raw}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});
   const reader=response.body?.getReader();
   if(!reader)return invalid(502,'The converter did not return a response.');
   const chunks=[];let size=0;
   try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();return invalid(502,'The converter response is too large.');}chunks.push(Buffer.from(value));}}
   finally{reader.releaseLock();}
   const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!response.ok)return invalid([400,403,404,409,413,422].includes(response.status)?response.status:502,typeof data?.error==='string'?data.error.slice(0,300):'The converter request could not be completed.');
   if(!data||typeof data!=='object'||Array.isArray(data))return invalid(502,'The converter response could not be read.');
   return {status:response.status,data};
  }catch{return invalid(502,'The converter connection could not be completed.');}
 };
}
