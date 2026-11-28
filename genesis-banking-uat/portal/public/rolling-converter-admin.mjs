// Mount the canonical AVIS converter in the bank administration row.
// The isolated frame never receives the bank session, CSRF token or service key.
const SITE='https://avis.land';
const BANK='https://bank.avispay.online';
const RECORD='AVRT-\\d{8}-[0-9A-F]{6}';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isRollingConverterHost(doc){return doc?.defaultView?.location.origin===BANK;}
export function allowedConverterMessage(path,body){
 if(typeof path!=='string')return false;
 if(body===undefined)return path==='/assets'||new RegExp('^/records/'+RECORD+'/nautilus\\.json$').test(path);
 if(!body||typeof body!=='object'||Array.isArray(body))return false;
 const keys=path==='/records'?['asset','amount']:new RegExp('^/records/'+RECORD+'/loop$').test(path)?['legs','channels','legValue']:null;
 return !!keys&&Object.keys(body).every(k=>keys.includes(k)&&['string','number'].includes(typeof body[k])&&String(body[k]).length<=256)&&
 (path!=='/records'||typeof body.asset==='string');
}
export function mountRollingConverterAdmin({host,api,isCurrent}){
 if(!host||!isRollingConverterHost(host.ownerDocument)||!isCurrent())return {close(){}};
 const doc=host.ownerDocument,win=doc.defaultView,frame=doc.createElement('iframe');
 frame.title='Rolling-token converter';
 frame.className='crypto-rolling-frame';frame.height='850';
 frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-downloads');
 frame.setAttribute('referrerpolicy','origin');
 let closed=false;
 const seen=new Set(),pending=new Set();
 const current=()=>!closed&&frame.isConnected&&isCurrent();
 async function receive(event){
  if(!current()||event.origin!==SITE||event.source!==frame.contentWindow)return;
  const message=event.data;
  if(!message||typeof message!=='object')return;
  if(message.type==='avis-rolling-converter-resize'){
   if(Number.isFinite(message.height))frame.height=String(Math.min(18000,Math.max(300,Math.ceil(message.height))));
   return;
  }
  if(message.type!=='avis-rolling-converter-request'||!UUID.test(message.id)||!allowedConverterMessage(message.path,message.body)||seen.has(message.id)||pending.size>=4)return;
  if(seen.size>=2000)return;
  seen.add(message.id);pending.add(message.id);
  const reply=payload=>{if(current())frame.contentWindow.postMessage({type:'avis-rolling-converter-response',id:message.id,...payload},SITE);};
  try{
   const data=await api('crypto/rolling-converter'+message.path,message.body,message.id);
   reply({data});
  }catch(error){reply({error:String(error?.message||'The converter request could not be completed.').slice(0,300)});}
  finally{pending.delete(message.id);}
 }
 win.addEventListener('message',receive);
 host.append(frame);frame.src=SITE+'/exchange/converter/admin-embed';
 return {close(){closed=true;win.removeEventListener('message',receive);frame.remove();seen.clear();pending.clear();}};
}
