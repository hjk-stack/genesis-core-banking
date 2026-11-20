import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {StripeWebPos,verifyStripePosEvent} from '../src/stripe-pos.mjs';
import {createBankServer} from '../server.mjs';

const now=Date.parse('2026-11-20T10:00:00.000Z');
const env={STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',
 AVIS_STRIPE_RETURN_ORIGIN:'https://genesis-banking-uat.example.org'};
const actor={id:'admin-1',admin:true};
const sessionId='cs_test_123456abcdef',pi='pi_123456abcdef';
const sign=(value,secret=env.STRIPE_WEBHOOK_SECRET,time=now)=>{
 const bytes=Buffer.from(JSON.stringify(value)),ts=String(Math.floor(time/1000));
 return {bytes,header:'t='+ts+',v1='+createHmac('sha256',secret).update(ts+'.').update(bytes).digest('hex')};
};
function fixture({failFirst=false,terminal='POS1'}={}){
 const records=new Map(),byKey=new Map(),eventIds=new Set(),requests=[];let createCount=0;
 const query=async(sql,p=[])=>{
  requests.push({sql,p});
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[]};
  if(sql.includes('INSERT INTO avis_core_v2.stripe_pos_payments')){
   const [id,key,actorId,terminalId,reference,currency,amountMinor]=p;
   if(terminalId!==terminal||byKey.has(key))return {rows:[]};
   const r={payment_id:id,request_key:key,actor_id:actorId,terminal_id:terminalId,merchant_id:'MERCHANT1',
    reference,currency_code:currency,amount_minor:amountMinor,session_id:null,checkout_url:null,payment_intent_id:null,status:'INITIATED'};
   records.set(id,r);byKey.set(key,id);return {rows:[{...r}]};
  }
  if(sql.includes('FROM avis_core_v2.stripe_pos_payments WHERE request_key=')){const id=byKey.get(p[0]);return {rows:id?[{...records.get(id)}]:[]};}
  if(sql.includes('UPDATE avis_core_v2.stripe_pos_payments')&&sql.includes("status='CHECKOUT_CREATED'")){
   const r=records.get(p[0]);if(!r.session_id){r.session_id=p[1];r.checkout_url=p[2];r.status='CHECKOUT_CREATED';}return {rows:[]};
  }
  if(sql.includes('FROM avis_core_v2.stripe_pos_payments WHERE payment_id=')){return {rows:[{...records.get(p[0])}]};}
  if(sql.includes('FROM avis_core_v2.stripe_pos_payments WHERE session_id=')){
   const r=[...records.values()].find(x=>x.session_id===p[0]);
   if(!r)return {rows:[]};
   return {rows:[sql.includes('AS id')?{id:r.payment_id,...r}: {...r}]};
  }
  if(sql.includes('FROM avis_core_v2.stripe_pos_payments WHERE payment_intent_id=')){
   const r=[...records.values()].find(x=>x.payment_intent_id===p[0]);return {rows:r?[{...r}]:[]};
  }
  if(sql.includes('INSERT INTO avis_core_v2.stripe_pos_webhook_events')){
   if(eventIds.has(p[0]))return {rows:[]};eventIds.add(p[0]);return {rows:[{stripe_event_id:p[0]}]};
  }
  if(sql.includes('UPDATE avis_core_v2.stripe_pos_payments')&&sql.includes('paid_at=')){
   const r=records.get(p[0]);r.status=p[1];r.payment_intent_id||=p[2];if(p[1]==='PAID')r.paid_at=new Date(now);return {rows:[]};
  }
  if(sql.includes('ORDER BY created_at DESC LIMIT 150'))return {rows:[...records.values()]};
  throw Error('Unexpected DB query: '+sql.slice(0,120));
 };
 const pool={query,connect:async()=>({query,release(){}})};
 const fetcher=async(url,options)=>{
  assert.equal(url,'https://api.stripe.com/v1/checkout/sessions');assert.equal(options.redirect,'error');
  assert.equal(options.headers.authorization,'Bearer sk_test_fixture');
  assert.equal(options.headers['idempotency-key'].startsWith('avispay-webpos-'),true);
  const form=new URLSearchParams(options.body);
  assert.equal(form.get('mode'),'payment');assert.equal(form.get('payment_method_types[0]'),'card');
  assert.equal(form.get('line_items[0][price_data][unit_amount]'),'1250');
  assert.equal(form.get('line_items[0][price_data][currency]'),'eur');
  assert.equal(form.get('metadata[source]'),'AVISPAY_WEB_POS');
  assert.equal(form.get('success_url').startsWith('https://genesis-banking-uat.example.org/'),true);
  createCount++;
  if(failFirst&&createCount===1)throw Error('transport');
  return {ok:true,redirected:false,json:async()=>({id:sessionId,url:'https://checkout.stripe.com/c/pay/'+sessionId})};
 };
 const service=new StripeWebPos(pool,{env,fetcher,now:()=>now});
 return {records,byKey,eventIds,requests,service,get createCount(){return createCount;}};
}
const createInput={terminalId:'POS1',reference:'INV-2026-101',currency:'EUR',amount:'12.50'};
function event(payment,type='checkout.session.completed',id='evt_payment123'){
 return {id,type,data:{object:{id:sessionId,mode:'payment',currency:'eur',amount_total:1250,
  payment_intent:pi,payment_status:'paid',
  metadata:{source:'AVISPAY_WEB_POS',merchantId:'MERCHANT1',paymentId:payment.id}}}};
}
test('registered WEB_POS creates one hosted Stripe card checkout and preserves idempotency',async()=>{
 const x=fixture(),first=await x.service.createCheckout(actor,createInput,'first-attempt');
 assert.equal(first.status,'CHECKOUT_CREATED');
 assert.equal(first.checkoutUrl,'https://checkout.stripe.com/c/pay/'+sessionId);
 assert.equal(x.createCount,1);
 const again=await x.service.createCheckout(actor,createInput,'first-attempt');
 assert.deepEqual(again,first);assert.equal(x.createCount,1);
 await assert.rejects(x.service.createCheckout(actor,{...createInput,amount:'18.00'},'first-attempt'),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(x.service.createCheckout({id:'customer',admin:false},createInput,'another'),/FORBIDDEN/);
 assert.equal((await x.service.list(actor)).length,1);
 assert.equal((await x.service.status(actor,sessionId)).status,'CHECKOUT_CREATED');
 assert.equal(x.requests.some(q=>q.sql.includes('post_journal')),false,'Stripe session never fabricates bank credit');
});
test('invalid POS terminal cannot create a card session or charge',async()=>{
 const x=fixture();await assert.rejects(x.service.createCheckout(actor,{...createInput,terminalId:'UNKNOWN'},'unknown'),/TERMINAL_NOT_FOUND/);
 assert.equal(x.createCount,0);
});
test('a provider failure retains a stable payment ID and safely retries',async()=>{
 const x=fixture({failFirst:true});
 await assert.rejects(x.service.createCheckout(actor,createInput,'retry'),/STRIPE_PROVIDER_RESPONSE/);
 const id=[...x.records.keys()][0];assert.equal(x.records.get(id).status,'INITIATED');
 const retry=await x.service.createCheckout(actor,createInput,'retry');
 assert.equal(retry.id,id);assert.equal(x.createCount,2);assert.equal(x.records.size,1);
});
test('signed completed event confirms a card payment; duplicates and late expiry cannot undo it',async()=>{
 const x=fixture(),p=await x.service.createCheckout(actor,createInput,'paid');
 const {bytes,header}=sign(event(p));
 assert.equal((await x.service.receiveWebhook(bytes,header)).status,'PAID');
 assert.equal((await x.service.receiveWebhook(bytes,header)).duplicate,true);
 assert.equal((await x.service.status(actor,sessionId)).status,'PAID');
 const expired=sign(event(p,'checkout.session.expired','evt_expired123'));
 assert.equal((await x.service.receiveWebhook(expired.bytes,expired.header)).status,'PAID');
 assert.equal(x.eventIds.size,2);
 assert.equal(x.requests.some(q=>q.sql.includes('post_journal')),false);
});
test('provider mismatches and forged signatures cannot mark card payments as paid',async()=>{
 const x=fixture(),p=await x.service.createCheckout(actor,createInput,'secure');
 const forged=sign(event(p));
 assert.throws(()=>verifyStripePosEvent(forged.bytes,'t=1,v1=deadbeef',env.STRIPE_WEBHOOK_SECRET,{now:()=>now}),/STRIPE_SIGNATURE/);
 const mismatch=event(p,'checkout.session.completed','evt_mismatch123');mismatch.data.object.amount_total=1251;
 const sig=sign(mismatch);
 await assert.rejects(x.service.receiveWebhook(sig.bytes,sig.header),/STRIPE_EVENT_MISMATCH/);
 assert.equal((await x.service.status(actor,sessionId)).status,'CHECKOUT_CREATED');
 const old=sign(event(p,'checkout.session.completed','evt_old123'),env.STRIPE_WEBHOOK_SECRET,now-600000);
 assert.throws(()=>verifyStripePosEvent(old.bytes,old.header,env.STRIPE_WEBHOOK_SECRET,{now:()=>now}),/STRIPE_SIGNATURE/);
});
test('Stripe webhook is accessible without browser CSRF/session; authenticated API remains separate',async()=>{
 let calls=0;
 const bank=createBankServer({pool:{query:async()=>({rows:[]})},authenticate:async()=>null,secureCookies:false,
  transferOptions:{stripePos:{receiveWebhook:async(raw,sig)=>{calls++;assert.equal(sig,'valid');assert.equal(raw.toString(),'{}');return {received:true};}}}});
 await new Promise(resolve=>bank.listen(0,'127.0.0.1',resolve));
 try{
  const base='http://127.0.0.1:'+bank.address().port;
  const ok=await fetch(base+'/api/stripe/webpos/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':'valid'},body:'{}'});
  assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{received:true});assert.equal(calls,1);
  const checkout=await fetch(base+'/api/stripe/webpos/checkout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(checkout.status,403,'browser mutations remain behind the existing origin and session requirements');
 }finally{await new Promise(resolve=>bank.close(resolve));}
});
