import {randomUUID,createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {fault,text,money} from './core.mjs';
import {CheckoutIpProcessing} from './checkout-ip-processing.mjs';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const amount=value=>{money(value);return value;};
const key=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const map=row=>({requestId:row.request_id,checkoutKind:row.checkout_kind,checkoutReference:row.checkout_reference,
 title:row.checkout_title,source:row.source,amount:row.amount,currency:row.currency_code,
 senderBankName:row.sender_bank_name,senderIp:row.sender_ip,authorizedPerson:row.authorized_person,
 senderAccount:row.sender_account,senderAccountName:row.sender_account_name,
 buyerName:row.buyer_contact_name,buyerEmail:row.buyer_contact_email,
 documents:row.document_names||[],status:row.status,requestedAt:row.requested_at,expiresAt:row.expires_at,
 approvedAt:row.approved_at,closedAt:row.closed_at,approvedBy:row.approved_by,
 receivingAccountId:row.receiving_account_id,nostroCashAccountId:row.nostro_cash_account_id,intermediaryId:row.intermediary_id});
export class CheckoutIpControl{
 constructor(pool){this.pool=pool;this.processingControl=new CheckoutIpProcessing(pool,{mapRequest:map});}
 async withTransaction(work){
  const db=await this.pool.connect();try{await db.query('BEGIN');const value=await work(db);await db.query('COMMIT');return value}
  catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
 }
 async expire(db=this.pool){
  const result=await db.query(`WITH expired AS(
   UPDATE avis_core_v2.checkout_ip_requests SET status='CLOSED',closed_at=expires_at,updated_at=now()
    WHERE status='REQUESTED' AND expires_at<=now() RETURNING request_id
   ), events AS(
   INSERT INTO avis_core_v2.checkout_ip_events(request_id,event_type,actor_id)
    SELECT request_id,'EXPIRE','system:ip-request-expiry' FROM expired RETURNING event_id)
   SELECT count(*)::int AS count FROM events`);
  return result.rows[0]?.count||0;
 }
 async register(actor,input){
  if(!actor?.posService)fault('FORBIDDEN',null,403);
  if(!uuid(input?.requestId))fault('INVALID_FIELD','requestId');
  if(!['MILESTONE','SHOP'].includes(input.checkoutKind)||!['industrial','shop-basket'].includes(input.source))fault('INVALID_FIELD','checkoutKind');
  const reference=text(input.checkoutReference,'checkoutReference',128);
  const title=text(input.title,'title',160);
  const bankName=text(input.bankName,'bankName',180),ip=text(input.ip,'ip',46);
  if(!isIP(ip))fault('INVALID_FIELD','ip');
  const authorized=text(input.authorized,'authorized',160),account=text(input.account,'account',80),
   accountName=text(input.accountName,'accountName',160);
  const currency=text(input.currency,'currency',3).toUpperCase();
  if(!['EUR','USD','GBP','CHF','JPY','CAD','AUD','AED','TND'].includes(currency))fault('INVALID_FIELD','currency');
  const value=amount(input.amount),documents=input.documents||[];
  if(!Array.isArray(documents)||documents.length>3||documents.some(x=>typeof x!=='string'||x.length>130))fault('INVALID_FIELD','documents');
  const buyerName=typeof input.contactName==='string'?input.contactName.slice(0,140):null,
    buyerEmail=typeof input.contactEmail==='string'?input.contactEmail.slice(0,254):null;
  const fingerprint=key([input.checkoutKind,reference,title,input.source,value,currency,bankName,ip,authorized,account,accountName,buyerName,buyerEmail,documents]);
  return this.withTransaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['checkout-ip-request:'+input.requestId.toLowerCase()]);
   if((await db.query('SELECT request_id FROM avis_core_v2.checkout_ip_cancellations WHERE request_id=$1',[input.requestId])).rows.length)
    fault('CHECKOUT_IP_CANCELLED','requestId',409);
   await this.expire(db);
   const existing=(await db.query('SELECT * FROM avis_core_v2.checkout_ip_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   if(existing){
    if(existing.request_fingerprint!==fingerprint)fault('IDEMPOTENCY_CONFLICT','requestId',409);
    if(existing.status==='CLOSED'){
     const completed=(await db.query('SELECT operation_completed,handler_status FROM avis_core_v2.checkout_ip_processing WHERE request_id=$1',[input.requestId])).rows[0];
     if(completed?.operation_completed||completed?.handler_status==='SETTLED')fault('CHECKOUT_IP_COMPLETED','requestId',409);
     if((await db.query('SELECT request_id FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=$1',[input.requestId])).rows.length)
      fault('CHECKOUT_IP_PROCESSING','requestId',409);
     const reopened=(await db.query(`UPDATE avis_core_v2.checkout_ip_requests
      SET status='REQUESTED',requested_at=now(),expires_at=now()+interval '60 minutes',
       approved_at=NULL,closed_at=NULL,approved_by=NULL,receiving_account_id=NULL,
       nostro_cash_account_id=NULL,intermediary_id=NULL,updated_at=now()
      WHERE request_id=$1 RETURNING *`,[input.requestId])).rows[0];
     await db.query(`INSERT INTO avis_core_v2.checkout_ip_events(request_id,event_type,actor_id)
      VALUES($1,'REQUEST',$2)`,[input.requestId,actor.id]);
     return map(reopened);
    }
    return map(existing);
   }
   const row=(await db.query(`INSERT INTO avis_core_v2.checkout_ip_requests(
    request_id,checkout_kind,checkout_reference,checkout_title,source,amount,currency_code,
    sender_bank_name,sender_ip,authorized_person,sender_account,sender_account_name,
    buyer_contact_name,buyer_contact_email,document_names,request_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16) RETURNING *`,
    [input.requestId,input.checkoutKind,reference,title,input.source,value,currency,bankName,ip,authorized,
     account,accountName,buyerName,buyerEmail,JSON.stringify(documents),fingerprint])).rows[0];
   await db.query(`INSERT INTO avis_core_v2.checkout_ip_events(request_id,event_type,actor_id)
    VALUES($1,'REQUEST',$2)`,[input.requestId,actor.id]);
   return map(row);
  });
 }
 async status(actor,input){
  if(!actor?.posService||!uuid(input?.requestId))fault('FORBIDDEN',null,403);
  await this.expire();
  const row=(await this.pool.query('SELECT * FROM avis_core_v2.checkout_ip_requests WHERE request_id=$1',[input.requestId])).rows[0];
  if(!row)fault('CHECKOUT_IP_NOT_FOUND','requestId',404);
  return {requestId:row.request_id,status:row.status,requestedAt:row.requested_at,expiresAt:row.expires_at,
   approvedAt:row.approved_at,closedAt:row.closed_at}; // No admin account data to checkout
 }
 async cancel(actor,input){
  if(!actor?.posService||actor.customerUserId)fault('FORBIDDEN',null,403);
  if(!uuid(input?.requestId))fault('INVALID_FIELD','requestId');
  return this.withTransaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['checkout-ip-request:'+input.requestId.toLowerCase()]);
   const row=(await db.query('SELECT * FROM avis_core_v2.checkout_ip_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   const completed=(await db.query('SELECT operation_completed,handler_status FROM avis_core_v2.checkout_ip_processing WHERE request_id=$1',[input.requestId])).rows[0];
   // Checkout rejection or stock expiry cannot discard a completed payment.
   if(completed?.operation_completed||completed?.handler_status==='SETTLED')fault('CHECKOUT_IP_COMPLETED','requestId',409);
   if((await db.query('SELECT request_id FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=$1',[input.requestId])).rows.length)
    fault('CHECKOUT_IP_PROCESSING','requestId',409);
   await db.query('INSERT INTO avis_core_v2.checkout_ip_cancellations(request_id,actor_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[input.requestId,actor.id]);
   const cancellation=(await db.query('SELECT request_id,cancelled_at FROM avis_core_v2.checkout_ip_cancellations WHERE request_id=$1',[input.requestId])).rows[0];
   if(!row)return {requestId:cancellation.request_id,cancelled:true,registered:false,cancelledAt:cancellation.cancelled_at};
   if(row.status!=='CLOSED'){
    row.closed_at=(await db.query("UPDATE avis_core_v2.checkout_ip_requests SET status='CLOSED',closed_at=now(),updated_at=now() WHERE request_id=$1 RETURNING closed_at",[row.request_id])).rows[0].closed_at;
    await db.query("INSERT INTO avis_core_v2.checkout_ip_events(request_id,event_type,actor_id) VALUES($1,'CLOSE',$2)",[row.request_id,actor.id]);
   }
   return {requestId:row.request_id,cancelled:true,registered:true,status:'CLOSED',requestedAt:row.requested_at,expiresAt:row.expires_at,
    approvedAt:row.approved_at,closedAt:row.closed_at};
  });
 }
 async list(actor){
  if(!actor?.admin||actor.customerUserId)fault('FORBIDDEN',null,403);
  await this.expire();
  const rows=(await this.pool.query(`SELECT * FROM avis_core_v2.checkout_ip_requests
   ORDER BY (status='REQUESTED') DESC,requested_at DESC LIMIT 300`)).rows;
  const reports=await this.processingControl.readReports(this.pool,rows.map(row=>row.request_id));
  return rows.map(row=>({...map(row),processing:reports.get(row.request_id)||null}));
 }
 async context(actor,input){
  if(!actor?.ipHandlerService||actor.customerUserId)fault('FORBIDDEN',null,403);
  await this.expire();return this.processingControl.context(actor,input);
 }
 async processing(actor,input){return this.processingControl.publish(actor,input);}
 async claim(actor,input){return this.processingControl.claim(actor,input);}
 async proof(actor,requestId){return this.processingControl.proof(actor,requestId);}
 async accounts(actor){
  if(!actor?.admin||actor.customerUserId)fault('FORBIDDEN',null,403);
  return (await this.pool.query(`SELECT a.account_id,a.owner_type,a.currency_code,b.abiq_iban,
    a.available_balance::text
    FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=a.account_id
    WHERE a.owner_type=ANY($1::text[]) AND b.status='ACTIVE' AND a.wallet_scope='FUNDING'
    ORDER BY a.currency_code,a.owner_type,b.abiq_iban`,
   [['COMMON_POOL','SUSPENSE_INBOUND','SUSPENSE_OUTBOUND','SUSPENSE_CARD_FX']])).rows;
 }
 async setActive(actor,input){
  if(!actor?.admin||actor.customerUserId)fault('FORBIDDEN',null,403);
  if(!uuid(input?.requestId)||typeof input.active!=='boolean')fault('INVALID_FIELD','requestId');
  return this.withTransaction(async db=>{
   await this.expire(db);
   const row=(await db.query('SELECT * FROM avis_core_v2.checkout_ip_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   if(!row)fault('CHECKOUT_IP_NOT_FOUND','requestId',404);
   if(input.active){
    if(row.status!=='REQUESTED')fault('CHECKOUT_IP_STATE','requestId',409);
    if(!uuid(input.receivingAccountId))fault('INVALID_FIELD','receivingAccountId');
    const account=(await db.query(`SELECT a.account_id FROM avis_core_v2.ledger_accounts a
     JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=a.account_id
     WHERE a.account_id=$1 AND a.currency_code=$2 AND a.owner_type=ANY($3::text[])
      AND a.wallet_scope='FUNDING' AND b.status='ACTIVE' FOR SHARE OF a`,
     [input.receivingAccountId,row.currency_code,['COMMON_POOL','SUSPENSE_INBOUND','SUSPENSE_OUTBOUND','SUSPENSE_CARD_FX']])).rows[0];
    if(!account)fault('CHECKOUT_IP_ACCOUNT','receivingAccountId',409);
    let nostro=null,intermediary=null;
    if(input.nostroCashAccountId){
     nostro=(await db.query('SELECT cash_account_id FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1 AND currency_code=$2 AND is_active',[input.nostroCashAccountId,row.currency_code])).rows[0];
     if(!nostro)fault('CHECKOUT_IP_ACCOUNT','nostroCashAccountId',409);
    }
    if(input.intermediaryId){
     if(!nostro)fault('CHECKOUT_IP_ACCOUNT','nostroCashAccountId',409);
     intermediary=(await db.query('SELECT intermediary_id FROM avis_core_v2.nostro_intermediary_banks WHERE intermediary_id=$1 AND cash_account_id=$2',[input.intermediaryId,nostro.cash_account_id])).rows[0];
     if(!intermediary)fault('CHECKOUT_IP_ACCOUNT','intermediaryId',409);
    }
    await db.query(`UPDATE avis_core_v2.checkout_ip_requests SET status='ACTIVE',approved_at=now(),approved_by=$2,
     receiving_account_id=$3,nostro_cash_account_id=$4,intermediary_id=$5,updated_at=now() WHERE request_id=$1`,
     [row.request_id,actor.id,account.account_id,nostro?.cash_account_id||null,intermediary?.intermediary_id||null]);
   }else{
    if(row.status==='CLOSED')return map(row);
    await db.query(`UPDATE avis_core_v2.checkout_ip_requests SET status='CLOSED',closed_at=now(),updated_at=now(),approved_by=$2
     WHERE request_id=$1`,[row.request_id,actor.id]);
   }
   await db.query('INSERT INTO avis_core_v2.checkout_ip_events(request_id,event_type,actor_id) VALUES($1,$2,$3)',
    [row.request_id,input.active?'APPROVE':'CLOSE',actor.id]);
   return map((await db.query('SELECT * FROM avis_core_v2.checkout_ip_requests WHERE request_id=$1',[row.request_id])).rows[0]);
  });
 }
}
