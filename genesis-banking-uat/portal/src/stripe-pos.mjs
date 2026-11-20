import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {fault,text} from './core.mjs';

const STRIPE_API='https://api.stripe.com/v1/checkout/sessions';
const CURRENCIES=new Set(['EUR','USD','GBP','CHF']);
const TRANSITIONS=Object.freeze({
 'checkout.session.completed':'PAID',
 'checkout.session.async_payment_succeeded':'PAID',
 'checkout.session.async_payment_failed':'FAILED',
 'checkout.session.expired':'EXPIRED',
 'charge.refunded':'REFUNDED',
 'charge.dispute.created':'DISPUTED'
});
const hash=value=>createHash('sha256').update(value).digest('hex');
function minorUnits(value){
 if(typeof value!=='string'||!/^\d{1,6}\.\d{2}$/.test(value))fault('INVALID_AMOUNT','amount');
 const [integer,decimal]=value.split('.'),n=BigInt(integer)*100n+BigInt(decimal);
 if(n<100n||n>99999999n)fault('INVALID_AMOUNT','amount');
 return Number(n);
}
function requireAdministrator(actor){if(!actor?.admin||!actor.id)fault('FORBIDDEN',null,403);}
export function verifyStripePosEvent(raw,signature,secret,{now=Date.now}={}){
 if(!Buffer.isBuffer(raw)||!raw.length||raw.length>512*1024)fault('STRIPE_SIGNATURE',null,400);
 if(typeof secret!=='string'||!secret)fault('STRIPE_CONFIGURATION',null,503);
 if(typeof signature!=='string'||signature.length>4096)fault('STRIPE_SIGNATURE',null,400);
 const items=signature.split(',').map(t=>t.trim().split('='));
 const stamp=items.find(p=>p[0]==='t')?.[1],v1=items.filter(p=>p[0]==='v1').map(p=>p[1]);
 if(!/^\d{10,11}$/.test(stamp||'')||Math.abs(now()-Number(stamp)*1000)>300000||!v1.length)fault('STRIPE_SIGNATURE',null,400);
 const expected=createHmac('sha256',secret).update(stamp+'.').update(raw).digest(),valid=v1.some(s=>{
  if(!/^[0-9a-f]{64}$/i.test(s||''))return false;
  return timingSafeEqual(expected,Buffer.from(s,'hex'));
 });
 if(!valid)fault('STRIPE_SIGNATURE',null,400);
 let event;try{event=JSON.parse(raw.toString('utf8'));}catch{fault('STRIPE_SIGNATURE',null,400);}
 if(!event||typeof event!=='object'||typeof event.id!=='string'||!/^evt_[A-Za-z0-9_]{5,245}$/.test(event.id))fault('STRIPE_SIGNATURE',null,400);
 return event;
}
function cleanOrigin(value){
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||u.hostname==='localhost')throw Error('origin');return u.origin;}
 catch{fault('STRIPE_CONFIGURATION',null,503);}
}
export class StripeWebPos {
 constructor(pool,{env=process.env,fetcher=fetch,now=Date.now}={}){this.pool=pool;this.env=env;this.fetcher=fetcher;this.now=now;}
 secretKey(){
  const secret=this.env.STRIPE_SECRET_KEY;
  if(!/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(secret||''))fault('STRIPE_CONFIGURATION',null,503);
  return secret;
 }
 async connection(actor){
  requireAdministrator(actor);
  const secret=this.secretKey();
  if(!/^whsec_[A-Za-z0-9]+$/.test(this.env.STRIPE_WEBHOOK_SECRET||''))fault('STRIPE_CONFIGURATION',null,503);
  let response;
  try{
   response=await this.fetcher(STRIPE_API+'?limit=1',{
    method:'GET',redirect:'error',headers:{authorization:'Bearer '+secret},signal:AbortSignal.timeout(12000)
   });
   await response.body?.cancel();
  }catch{fault('STRIPE_PROVIDER_RESPONSE',null,503);}
  if(response.status!==200||response.redirected)fault('STRIPE_PROVIDER_RESPONSE',null,503);
  return {mode:secret.split('_')[1],checkoutAccess:true,webhookConfigured:true};
 }
 async createCheckout(actor,input,idempotencyKey){
  requireAdministrator(actor);
  const terminalId=text(input?.terminalId,'terminalId',32),reference=text(input?.reference,'reference',100);
  const currency=typeof input.currency==='string'?input.currency.toUpperCase():'';
  if(!CURRENCIES.has(currency))fault('CURRENCY_MISMATCH','currency');
  const amountMinor=minorUnits(input.amount),key=text(idempotencyKey,'idempotencyKey',128);
  const requestKey=hash(actor.id+'|STRIPE_POS|'+key),paymentId=randomUUID();
  const inserted=(await this.pool.query(`INSERT INTO avis_core_v2.stripe_pos_payments
   (payment_id,request_key,actor_id,terminal_id,merchant_id,reference,currency_code,amount_minor)
   SELECT $1,$2,$3,t.terminal_id,t.merchant_id,$5,$6,$7
   FROM avis_core_v2.pos_terminals t
   JOIN avis_core_v2.marketplace_merchants m USING(merchant_id)
   WHERE t.terminal_id=$4 AND t.terminal_type='WEB_POS'
      AND t.status='ACTIVE' AND m.status='ACTIVE'
   ON CONFLICT(request_key) DO NOTHING RETURNING *`,
   [paymentId,requestKey,actor.id,terminalId,reference,currency,amountMinor])).rows[0];
  const row=inserted||(await this.pool.query('SELECT * FROM avis_core_v2.stripe_pos_payments WHERE request_key=$1',[requestKey])).rows[0];
  if(!row)fault('TERMINAL_NOT_FOUND','terminalId');
  if(row.actor_id!==actor.id||row.terminal_id!==terminalId||row.reference!==reference||
    row.currency_code!==currency||Number(row.amount_minor)!==amountMinor)fault('IDEMPOTENCY_CONFLICT','idempotencyKey',409);
  if(row.session_id)return {id:row.payment_id,checkoutUrl:row.checkout_url,status:row.status,sessionId:row.session_id};
  const secret=this.secretKey();
  const origin=cleanOrigin(this.env.AVIS_STRIPE_RETURN_ORIGIN);
  const form=new URLSearchParams();
  for(const [name,value] of Object.entries({
   mode:'payment','payment_method_types[0]':'card',
   'line_items[0][price_data][currency]':currency.toLowerCase(),
   'line_items[0][price_data][unit_amount]':String(amountMinor),
   'line_items[0][price_data][product_data][name]':'AVISPay WEB POS · '+terminalId+' · '+reference,
   'line_items[0][quantity]':'1',
   client_reference_id:row.payment_id,
   success_url:origin+'/?stripe_pos=return&session_id={CHECKOUT_SESSION_ID}#pos',
   cancel_url:origin+'/?stripe_pos=cancel#pos',
   'metadata[source]':'AVISPAY_WEB_POS','metadata[paymentId]':row.payment_id,
   'metadata[merchantId]':row.merchant_id,
   'payment_intent_data[metadata][source]':'AVISPAY_WEB_POS',
   'payment_intent_data[metadata][paymentId]':row.payment_id
  }))form.set(name,value);
  let result;
  try{result=await this.fetcher(STRIPE_API,{method:'POST',redirect:'error',
   headers:{authorization:'Bearer '+secret,'content-type':'application/x-www-form-urlencoded',
    'idempotency-key':'avispay-webpos-'+row.payment_id},body:form.toString(),signal:AbortSignal.timeout(12000)});}
  catch{fault('STRIPE_PROVIDER_RESPONSE',null,503);}
  if(!result.ok||result.redirected)fault('STRIPE_PROVIDER_RESPONSE',null,503);
  let session;try{session=await result.json();}catch{fault('STRIPE_PROVIDER_RESPONSE',null,503);}
  let checkoutUrl;
  try{checkoutUrl=new URL(session?.url);if(checkoutUrl.protocol!=='https:'||checkoutUrl.hostname!=='checkout.stripe.com')throw Error('host');}
  catch{fault('STRIPE_PROVIDER_RESPONSE',null,503);}
  if(typeof session.id!=='string'||!/^cs_(test|live)_[A-Za-z0-9]+$/.test(session.id))fault('STRIPE_PROVIDER_RESPONSE',null,503);
  await this.pool.query(`UPDATE avis_core_v2.stripe_pos_payments
   SET session_id=$2,checkout_url=$3,status='CHECKOUT_CREATED',updated_at=now()
   WHERE payment_id=$1 AND session_id IS NULL`,[row.payment_id,session.id,checkoutUrl.href]);
  const saved=(await this.pool.query('SELECT * FROM avis_core_v2.stripe_pos_payments WHERE payment_id=$1',[row.payment_id])).rows[0];
  return {id:row.payment_id,checkoutUrl:saved.checkout_url,status:saved.status,sessionId:saved.session_id};
 }
 async applyEvent(event){
  const type=event.type,proposed=TRANSITIONS[type];
  if(!proposed)return {received:true,ignored:true};
  const object=event.data?.object;
  if(!object||typeof object!=='object')fault('STRIPE_SIGNATURE',null,400);
  const checkout=type.startsWith('checkout.session.'),sessionId=checkout?object.id:null,pi=checkout?(
   typeof object.payment_intent==='string'?object.payment_intent:object.payment_intent?.id||null):object.payment_intent;
  if(checkout&&object.metadata?.source!=='AVISPAY_WEB_POS')return {received:true,ignored:true};
  if(!checkout&&typeof pi!=='string')return {received:true,ignored:true};
  const client=await this.pool.connect();
  try{
   await client.query('BEGIN');
   const row=(await client.query(checkout
    ?'SELECT * FROM avis_core_v2.stripe_pos_payments WHERE session_id=$1 FOR UPDATE'
    :'SELECT * FROM avis_core_v2.stripe_pos_payments WHERE payment_intent_id=$1 FOR UPDATE',[checkout?sessionId:pi])).rows[0];
   if(!row){await client.query('COMMIT');return {received:true,ignored:true};}
   if(checkout&&(object.metadata?.paymentId!==row.payment_id||object.metadata?.merchantId!==row.merchant_id||
      object.mode!=='payment'||object.currency?.toUpperCase()!==row.currency_code||
      Number(object.amount_total)!==Number(row.amount_minor)))fault('STRIPE_EVENT_MISMATCH',null,422);
   if(checkout&&row.payment_intent_id&&pi&&row.payment_intent_id!==pi)fault('STRIPE_EVENT_MISMATCH',null,422);
   const eventInsert=(await client.query(`INSERT INTO avis_core_v2.stripe_pos_webhook_events(stripe_event_id,payment_id,event_type)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING stripe_event_id`,[event.id,row.payment_id,type])).rows;
   if(!eventInsert.length){await client.query('COMMIT');return {received:true,duplicate:true};}
   let next=proposed;
   if(checkout&&type==='checkout.session.completed'&&object.payment_status!=='paid')next='CHECKOUT_CREATED';
   if(!checkout&&type==='charge.refunded'){
    if(Number(object.amount)<Number(row.amount_minor)||!Number.isInteger(object.amount_refunded))fault('STRIPE_EVENT_MISMATCH',null,422);
    next=object.amount_refunded>=object.amount?'REFUNDED':'PARTIALLY_REFUNDED';
   }
   if(row.status==='DISPUTED'||['REFUNDED','PARTIALLY_REFUNDED'].includes(row.status)&&
      !['REFUNDED','DISPUTED'].includes(next))next=row.status;
   if(row.status==='PAID'&&['EXPIRED','FAILED','CHECKOUT_CREATED'].includes(next))next='PAID';
   if((row.status==='EXPIRED'||row.status==='FAILED')&&next==='CHECKOUT_CREATED')next=row.status;
   await client.query(`UPDATE avis_core_v2.stripe_pos_payments
     SET status=$2,payment_intent_id=COALESCE(payment_intent_id,$3),
       paid_at=CASE WHEN $2='PAID' THEN COALESCE(paid_at,now()) ELSE paid_at END,
       updated_at=now() WHERE payment_id=$1`,[row.payment_id,next,typeof pi==='string'?pi:null]);
   await client.query('COMMIT');return {received:true,paymentId:row.payment_id,status:next};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 async receiveWebhook(raw,signature){return this.applyEvent(verifyStripePosEvent(raw,signature,this.env.STRIPE_WEBHOOK_SECRET,{now:this.now}));}
 async status(actor,sessionId){
  requireAdministrator(actor);
  if(typeof sessionId!=='string'||!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId))fault('INVALID_FIELD','sessionId');
  const row=(await this.pool.query(`SELECT payment_id AS id,terminal_id,merchant_id,reference,currency_code,
   (amount_minor::numeric/100)::numeric(12,2)::text AS amount,status,session_id,created_at,paid_at
   FROM avis_core_v2.stripe_pos_payments WHERE session_id=$1`,[sessionId])).rows[0];
  if(!row)fault('INVALID_REFERENCE','sessionId',404);return row;
 }
 async list(actor){
  requireAdministrator(actor);
  return (await this.pool.query(`SELECT payment_id,merchant_id,terminal_id,reference,currency_code,
     (amount_minor::numeric/100)::numeric(12,2)::text AS amount,status,session_id,payment_intent_id,created_at,paid_at
     FROM avis_core_v2.stripe_pos_payments ORDER BY created_at DESC LIMIT 150`)).rows;
 }
}
