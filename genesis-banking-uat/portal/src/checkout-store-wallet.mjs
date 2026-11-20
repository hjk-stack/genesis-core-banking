import {createHash} from 'node:crypto';
import {money,decimal,fault} from './core.mjs';
const endpoint='https://avis.land/avispay/checkout/commerce/';
const s='avis_core_v2.',uuid=id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||'');
const proof=t=>typeof t==='string'&&/^[0-9a-f]{64}$/.test(t);
const digest=t=>createHash('sha256').update(t).digest('hex');
export class StoreWallet {
 constructor(basket,{fetcher=fetch}={}){this.basket=basket;this.pool=basket.pool;this.fetcher=fetcher;}
 async web(path,input){
  let r;try{r=await this.fetcher(endpoint+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(7000)});}catch{fault('BASKET_ORDER',null,503);}
  if(!r.ok)fault('BASKET_ORDER',null,r.status>=500?503:409);return r.json();}
 async claim(token,input){
  const owner=await this.basket.session(this.pool,token);if(!uuid(input.id)||!proof(input.secret))fault('BASKET_ORDER',null,404);
  const hash=digest(input.secret),existing=(await this.pool.query('SELECT * FROM '+s+'checkout_store_payments WHERE invoice_id=$1 AND store_key=$2',[input.id,hash])).rows[0];
  if(existing?.journal_id)return this.summary(existing,owner.buyer_id);
  const data=await this.web('terms',{id:input.id,secret:input.secret});
  if(data.id!==input.id||!['RETAIL','INDUSTRIAL'].includes(data.kind)||!['USD','EUR','GBP','CHF'].includes(data.fiat)||typeof data.title!=='string'||data.title.length>180||!/^[1-9]\d{0,17}$/.test(data.amountMinor)||!Number.isFinite(Date.parse(data.expiresAt))||Date.parse(data.expiresAt)<=Date.now())fault('BASKET_ORDER');
  const row=await this.basket.transaction(async db=>{await db.query('INSERT INTO '+s+'checkout_store_payments(invoice_id,store_key,terms) VALUES($1,$2,$3) ON CONFLICT(invoice_id) DO NOTHING',[input.id,hash,JSON.stringify(data)]);
   const r=(await db.query('SELECT * FROM '+s+'checkout_store_payments WHERE invoice_id=$1 AND store_key=$2',[input.id,hash])).rows[0];if(!r)fault('BASKET_ORDER');return r;});
  const wallets=await this.basket.tender.choices(this.pool,owner.buyer_id);
  return {...this.summary(row,owner.buyer_id),wallets:wallets.map(w=>({id:w.account_id,asset:w.asset,network:w.network,available:w.spendable}))};
 }
 summary(row,buyer){
  const own=String(row.buyer_id)===String(buyer),authorized=own&&row.quote;
  return {id:row.invoice_id,title:row.terms.title,fiat:row.terms.fiat,principal:decimal(BigInt(row.terms.amountMinor),2),kind:row.terms.kind,
   status:row.journal_id?'PAID':authorized?'QUOTED':'OPEN',...(authorized?{fee:row.quote.fee,total:row.quote.total,pay:row.quote.pay,expiresAt:row.quoted_until}:{})};
 }
 async quote(token,input){
  const state=await this.claim(token,input);if(state.status==='PAID')return state;
  if(!uuid(input.walletId))fault('BASKET_WALLET','wallet');
  return this.basket.transaction(async db=>{const session=await this.basket.session(db,token);
   const r=(await db.query('SELECT * FROM '+s+'checkout_store_payments WHERE invoice_id=$1 FOR UPDATE',[input.id])).rows[0];if(r.journal_id)return this.summary(r,session.buyer_id);
   if(r.buyer_id&&String(r.buyer_id)!==String(session.buyer_id)&&Date.parse(r.quoted_until)>Date.now())fault('BASKET_REVIEW');
   const policy=(await db.query('SELECT markup_bps FROM '+s+'crypto_basket_policy')).rows[0],amount=BigInt(r.terms.amountMinor),fee=(amount*BigInt(policy.markup_bps)+9999n)/10000n,gross=amount+fee;
   const pay=await this.basket.tender.quote(db,session.buyer_id,input.walletId,String(gross),r.terms.fiat);
   const quote={pay,fee:decimal(fee,2),total:decimal(gross,2),markupBps:policy.markup_bps};
   const saved=(await db.query(`UPDATE avis_core_v2.checkout_store_payments SET quote=$2,buyer_id=$3,wallet_id=$4,session_id=$5,quoted_until=LEAST(now()+interval '60 seconds',$6::timestamptz) WHERE invoice_id=$1 RETURNING *`,[input.id,JSON.stringify(quote),session.buyer_id,input.walletId,session.session_id,r.terms.expiresAt])).rows[0];
   return this.summary(saved,session.buyer_id);});
 }
 async details(actor,id){if(!uuid(id))fault('BASKET_ORDER',null,404);const buyer=await this.basket.buyer(this.pool,actor);
  const r=(await this.pool.query('SELECT * FROM '+s+'checkout_store_payments WHERE invoice_id=$1 AND buyer_id=$2',[id,buyer])).rows[0];if(!r)fault('BASKET_ORDER',null,404);return this.summary(r,buyer);}
 async confirm(actor,input){
  if(!uuid(input.id))fault('BASKET_ORDER',null,404);return this.basket.transaction(async db=>{
   const buyer=await this.basket.buyer(db,actor),r=(await db.query('SELECT * FROM '+s+'checkout_store_payments WHERE invoice_id=$1 AND buyer_id=$2 FOR UPDATE',[input.id,buyer])).rows[0];
   if(!r)fault('BASKET_ORDER',null,404);if(r.journal_id)return this.summary(r,buyer);
   if(!r.quote||r.quote.total!==input.total||r.quote.pay.quantity!==input.quantity||r.quote.pay.walletId!==input.walletId||Date.parse(r.quoted_until)<=Date.now())fault('BASKET_REVIEW');
   const merchant=(await db.query("SELECT user_id FROM avis_core_v2.sovereign_users WHERE account_role='INSTITUTION' AND full_name='AVISPay PLC' AND merged_into_user_id IS NULL")).rows[0];
   if(!merchant)fault('BASKET_ORDER');
   const lines=await this.basket.tender.paymentLines(db,buyer,r.quote.pay,merchant.user_id);
   const journal=await this.basket.core.post(db,actor,'store-wallet:'+r.invoice_id,'MERCHANT_WALLET_PAYMENT',r.invoice_id,lines);
   const saved=(await db.query('UPDATE '+s+'checkout_store_payments SET journal_id=$2 WHERE invoice_id=$1 RETURNING *',[r.invoice_id,journal])).rows[0];return this.summary(saved,buyer);
  });
 }
 async receipt(input){
  if(!uuid(input.id)||!proof(input.lookup))fault('BASKET_ORDER',null,404);
  const r=(await this.pool.query('SELECT * FROM '+s+'checkout_store_payments WHERE invoice_id=$1 AND store_key=$2',[input.id,input.lookup])).rows[0];
  if(!r?.journal_id)return {id:input.id,paid:false};return {id:r.invoice_id,paid:true,journal:r.journal_id,ref:r.terms.ref,fiat:r.terms.fiat,amountMinor:r.terms.amountMinor};
 }
 async notify(){
  const rows=(await this.pool.query('SELECT invoice_id,store_key FROM '+s+'checkout_store_payments WHERE journal_id IS NOT NULL AND notified_at IS NULL ORDER BY notify_attempt NULLS FIRST LIMIT 12')).rows;
  for(const row of rows){try{const ack=await this.web('settled',{id:row.invoice_id,lookup:row.store_key});if(ack.paid===true)await this.pool.query('UPDATE '+s+'checkout_store_payments SET notified_at=now() WHERE invoice_id=$1',[row.invoice_id]);}finally{await this.pool.query('UPDATE '+s+'checkout_store_payments SET notify_attempt=now() WHERE invoice_id=$1',[row.invoice_id]);}}
 }
}
