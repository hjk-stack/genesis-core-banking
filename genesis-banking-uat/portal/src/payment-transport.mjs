import https from 'node:https';
import tls from 'node:tls';
import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {fault} from './core.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const canonical=(method,path,time,nonce,body)=>[method,path,time,nonce,hash(body)].join('\n');
export function connectorCredentials(reference,env=process.env){
 if(!/^AVIS_CONNECTOR_[A-Z0-9_]+$/.test(reference||''))fault('CONNECTOR_CONFIGURATION',null,503);
 let credentials;try{credentials=JSON.parse(env[reference]);}catch{fault('CONNECTOR_CONFIGURATION',null,503);}
 if(typeof credentials.hmacSecret!=='string'||Buffer.byteLength(credentials.hmacSecret)<32||!credentials.cert||!credentials.key)fault('CONNECTOR_CONFIGURATION',null,503);
 return credentials;
}
export function signRequest(method,path,body,secret,time=String(Date.now()),nonce=randomBytes(24).toString('hex')){
 return {'x-avis-time':time,'x-avis-nonce':nonce,'x-avis-signature':createHmac('sha256',secret).update(canonical(method,path,time,nonce,body)).digest('hex')};
}
export async function authenticateMessage(pool,profileId,method,path,body,headers,secret,now=Date.now()){
 const time=headers['x-avis-time'],nonce=headers['x-avis-nonce'],signature=headers['x-avis-signature'];
 if(!/^\d{13}$/.test(time||'')||Math.abs(now-Number(time))>120000||!/^[0-9a-f]{48}$/.test(nonce||'')||!/^[0-9a-f]{64}$/.test(signature||''))fault('MESSAGE_AUTHENTICATION',null,401);
 const expected=signRequest(method,path,body,secret,time,nonce)['x-avis-signature'];
 if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))fault('MESSAGE_AUTHENTICATION',null,401);
 await pool.query('DELETE FROM avis_core_v2.connector_nonces WHERE expires_at<now()');
 const r=await pool.query(`INSERT INTO avis_core_v2.connector_nonces(profile_id,nonce,expires_at) VALUES($1,$2,now()+interval '5 minutes') ON CONFLICT DO NOTHING RETURNING nonce`,[profileId,nonce]);
 if(!r.rows.length)fault('MESSAGE_REPLAY',null,409);
}
export function frame(payload){const data=Buffer.from(payload);if(!data.length||data.length>65535)fault('MESSAGE_LENGTH');const out=Buffer.alloc(data.length+2);out.writeUInt16BE(data.length);data.copy(out,2);return out;}
export async function sendBankMessage(profile,body,credentials){
 const url=new URL(profile.endpoint_url),tlsOptions={cert:credentials.cert,key:credentials.key,ca:credentials.ca||undefined,minVersion:'TLSv1.2',rejectUnauthorized:true,servername:url.hostname};
 if(url.protocol==='https:')return new Promise((resolve,reject)=>{
  const req=https.request(url,{...tlsOptions,method:'POST',headers:{'content-type':'application/xml','content-length':Buffer.byteLength(body),...signRequest('POST',url.pathname+url.search,body,credentials.hmacSecret)}},res=>{
   const parts=[];let size=0;
   res.on('data',chunk=>{size+=chunk.length;if(size>65535)req.destroy(new Error('RESPONSE_TOO_LARGE'));else parts.push(chunk);});
   res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300)return reject(new Error('BANK_HTTP_'+res.statusCode));resolve(Buffer.concat(parts).toString('utf8'));});res.on('error',reject);
  });const deadline=setTimeout(()=>req.destroy(new Error('BANK_TIMEOUT')),15000);req.once('close',()=>clearTimeout(deadline));req.setTimeout(15000,()=>req.destroy(new Error('BANK_TIMEOUT')));req.on('error',reject);req.end(body);
 });
 if(url.protocol!=='tls:')fault('CONNECTOR_CONFIGURATION');
 return new Promise((resolve,reject)=>{
  const socket=tls.connect({...tlsOptions,host:url.hostname,port:Number(url.port||443)});let received=Buffer.alloc(0),finished=false;
  const deadline=setTimeout(()=>socket.destroy(new Error('BANK_TIMEOUT')),15000);socket.once('close',()=>clearTimeout(deadline));
  socket.setTimeout(15000,()=>socket.destroy(new Error('BANK_TIMEOUT')));
  socket.on('secureConnect',()=>socket.write(frame(body)));
  socket.on('data',chunk=>{received=Buffer.concat([received,chunk]);if(received.length>65537)return socket.destroy(new Error('RESPONSE_TOO_LARGE'));if(received.length<2)return;const size=received.readUInt16BE();if(!size||received.length>size+2)return socket.destroy(new Error('INVALID_FRAME'));if(received.length===size+2){finished=true;resolve(received.subarray(2).toString('utf8'));socket.end();}});
  socket.on('error',reject);socket.on('end',()=>{if(!finished)reject(new Error('INCOMPLETE_BANK_RESPONSE'));});
 });
}
const recoverable = "o.status<>'ACKNOWLEDGED' AND (t.iso_status IN ('ACCC','RJCT') OR (o.status='SENDING' AND (o.lease_until IS NULL OR o.lease_until<=now())))";
export async function recoverPaymentDeliveries(server,actor) {
 if(!actor?.admin||!actor.id)fault('FORBIDDEN',null,403);
 const pending=await server.pool.query('SELECT 1 FROM avis_core_v2.payment_outbox o JOIN avis_core_v2.interbank_ip_transfers t USING(transfer_id) WHERE '+recoverable+' LIMIT 1');
 if(!pending.rows.length)return {recovered:0};
 return server.operation(actor,'RECOVER_PAYMENT_DELIVERIES',{},'recovery:'+randomUUID(),async db=>{
  const result=await db.query("WITH recover AS (SELECT o.transfer_id,t.iso_status FROM avis_core_v2.payment_outbox o JOIN avis_core_v2.interbank_ip_transfers t USING(transfer_id) WHERE "+recoverable+" ORDER BY o.transfer_id LIMIT 100 FOR UPDATE OF o SKIP LOCKED) UPDATE avis_core_v2.payment_outbox o SET status=CASE WHEN r.iso_status IN ('ACCC','RJCT') THEN 'ACKNOWLEDGED' ELSE 'UNCERTAIN' END,lease_until=NULL,last_error_code=CASE WHEN r.iso_status IN ('ACCC','RJCT') THEN NULL ELSE 'DELIVERY_LEASE_EXPIRED' END,updated_at=now() FROM recover r WHERE o.transfer_id=r.transfer_id RETURNING o.transfer_id,o.status");
  return {recovered:result.rows.length,deliveries:result.rows};
 });
}
export const bankRouteSnapshot=p=>({profileId:p.profile_id,endpoint:p.endpoint_url,cashAccountId:p.cash_account_id,
 localBic:p.local_bic,peerBic:p.peer_bic,credentialReference:p.credential_reference});
async function checkReviewedRoute(db,transfer,profile){
 const request=(await db.query('SELECT route_snapshot FROM avis_core_v2.payment_requests WHERE transfer_id=$1',[transfer.transfer_id])).rows[0];
 if(request){const current=bankRouteSnapshot(profile);if(!request.route_snapshot||!Object.keys(current).every(k=>current[k]===request.route_snapshot[k]))fault('PAYMENT_REVIEW_CHANGED','review',409);}
}
export async function dispatchPayment(server,actor,input,key,{send=sendBankMessage,credentials=connectorCredentials}={}) {
 await recoverPaymentDeliveries(server,actor);
 // Claim once. A lost response is resolved by authenticated bank evidence, never a blind resend.
 const claim=await server.operation(actor,'DISPATCH_PAYMENT',input,key,async db=>{
  const t=(await db.query('SELECT * FROM avis_core_v2.interbank_ip_transfers WHERE transfer_id=$1 FOR UPDATE',[input.transferId])).rows[0];
  if(!t||t.direction!=='OUTBOUND')fault('TRANSFER_NOT_FOUND','transferId');
  if(['ACCC','RJCT'].includes(t.iso_status))fault('TRANSFER_ALREADY_CLOSED','transferId');
  const p=await server.profile(db,t.profile_id);await checkReviewedRoute(db,t,p);credentials(p.credential_reference);
  const outbox=(await db.query("UPDATE avis_core_v2.payment_outbox SET status='SENDING',attempts=attempts+1,lease_until=now()+interval '1 minute',updated_at=now() WHERE transfer_id=$1 AND status='QUEUED' RETURNING transfer_id",[t.transfer_id])).rows[0];
  if(!outbox)fault('PAYMENT_ALREADY_DISPATCHED','transferId',409);
  return {id:t.transfer_id,claimed:true};
 });
 const taken=await server.pool.query("UPDATE avis_core_v2.payment_outbox SET last_error_code='DELIVERY_STARTED' WHERE transfer_id=$1 AND status='SENDING' AND lease_until>now() AND last_error_code IS NULL RETURNING content",[claim.id]);
 if(!taken.rows.length) {
  const outbox=(await server.pool.query('SELECT status FROM avis_core_v2.payment_outbox WHERE transfer_id=$1',[claim.id])).rows[0];
  return {id:claim.id,delivery:outbox.status};
 }
 try {
  const t=(await server.pool.query('SELECT * FROM avis_core_v2.interbank_ip_transfers WHERE transfer_id=$1',[claim.id])).rows[0],p=await server.profile(server.pool,t.profile_id);
  await checkReviewedRoute(server.pool,t,p);
  const xml=await send(p,taken.rows[0].content,credentials(p.credential_reference));
  const {readIso20022}=await import('./iso20022.mjs');const result=await readIso20022(xml);
  if(result.type!=='pacs.002.001.10'||result.uetr!==t.uetr)fault('BANK_RESPONSE_CORRELATION');
  const received=await server.receive(p.profile_id,xml);
  await server.pool.query("UPDATE avis_core_v2.payment_outbox SET status='ACKNOWLEDGED',lease_until=NULL,last_error_code=NULL,updated_at=now() WHERE transfer_id=$1",[claim.id]);
  return {...received,delivery:'ACKNOWLEDGED'};
 } catch(e) {
  const diagnostic=/^[A-Z0-9_]{1,64}$/.test(e.code||e.message||'')?(e.code||e.message):'BANK_DELIVERY_ERROR';
  // An authenticated callback may already have settled while this request lost its response.
  await server.pool.query("UPDATE avis_core_v2.payment_outbox SET status='UNCERTAIN',lease_until=NULL,last_error_code=$2,updated_at=now() WHERE transfer_id=$1 AND status<>'ACKNOWLEDGED'",[claim.id,diagnostic]);
  const state=(await server.pool.query('SELECT o.status AS delivery,t.iso_status AS status FROM avis_core_v2.payment_outbox o JOIN avis_core_v2.interbank_ip_transfers t USING(transfer_id) WHERE transfer_id=$1',[claim.id])).rows[0];
  return {id:claim.id,...state};
 }
}
