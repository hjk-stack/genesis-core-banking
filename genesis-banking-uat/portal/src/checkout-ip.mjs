import {randomUUID,createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {fault,text,money} from './core.mjs';
import {RECEIVING_OWNERS} from './checkout-ip-settlement.mjs';
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
async function checkMilestoneDuplicate(db,requestId,reference,account,currency,value,{retryExisting=false}={}){
 // A new browser key or a changed signatory must not start the same open milestone twice.
 const senderAccount=account.replace(/\s+/g,'').toUpperCase();
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
  ['checkout-ip-milestone:'+key([reference,senderAccount,currency])]);
 const duplicate=await db.query(`SELECT 1 FROM avis_core_v2.checkout_ip_requests r
  WHERE checkout_kind='MILESTONE' AND source='industrial' AND checkout_reference=$1
   AND upper(regexp_replace(sender_account,'[[:space:]]','','g'))=$2 AND currency_code=$3 AND amount=$4
   AND request_id<>$5 AND ((NOT $6::boolean AND status IN ('REQUESTED','ACTIVE'))
    OR EXISTS (SELECT 1 FROM avis_core_v2.checkout_ip_processing p
     WHERE p.request_id=r.request_id AND (p.operation_completed OR p.handler_status='SETTLED'))
    OR EXISTS (SELECT 1 FROM avis_core_v2.checkout_ip_settlement_claims c WHERE c.request_id=r.request_id)
    OR EXISTS (SELECT 1 FROM avis_core_v2.checkout_ip_settlements s WHERE s.request_id=r.request_id))
  LIMIT 1`,
  [reference,senderAccount,currency,value,requestId,retryExisting]);
 if(duplicate.rows.length)fault('CHECKOUT_IP_ALREADY_REGISTERED','checkoutReference',409);
}
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
   if(input.checkoutKind==='MILESTONE'&&input.source==='industrial'&&(!existing||existing.status==='CLOSED')){
    await checkMilestoneDuplicate(db,input.requestId,reference,account,currency,value);
   }
   if(existing){
    if(existing.request_fingerprint!==fingerprint)fault('IDEMPOTENCY_CONFLICT','requestId',409);
    if(existing.status==='CLOSED'){
     const completed=(await db.query('SELECT operation_completed,handler_status FROM avis_core_v2.checkout_ip_processing WHERE request_id=$1',[input.requestId])).rows[0];
     if(completed?.operation_completed||completed?.handler_status==='SETTLED')fault('CHECKOUT_IP_COMPLETED','requestId',409);
     if((await db.query('SELECT request_id FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=$1',[input.requestId])).rows.length)
      fault('CHECKOUT_IP_PROCESSING','requestId',409);
     const reopened=(await db.query(`UPDATE avis_core_v2.checkout_ip_requests
      SET status='REQUESTED',register_archived_at=NULL,requested_at=now(),expires_at=now()+interval '60 minutes',
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
   WHERE superseded_by IS NULL AND register_archived_at IS NULL
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
 async receivingAccounts(actor,input={}){
  if(!actor?.ipHandlerService||!actor.id||actor.customerUserId)fault('FORBIDDEN',null,403);
  const rows=await this.backofficeReceivingAccounts();
  const directory=input.includeNostros===true?await this.processingControl.nostroDirectory(this.pool):{};
  if(input.includeOrderingAccounts===true||input.orderingAccountId!==undefined){
   const id=input.orderingAccountId;
   if(id!==undefined&&!uuid(id))fault('INVALID_FIELD','orderingAccountId');
   directory.orderingAccounts=(await this.pool.query(`SELECT a.account_id AS id,i.abiq_iban AS number,a.currency_code AS currency,
     COALESCE(h.full_name,p.institution_name) AS "holderName",p.institution_name AS "bankName",p.abiq_bic AS bic
     FROM avis_core_v2.ledger_accounts a
     JOIN avis_core_v2.abiq_account_identifiers i ON i.ledger_account_id=a.account_id AND i.status='ACTIVE'
     JOIN avis_core_v2.abiq_network_participants p ON p.participant_code=i.participant_code AND p.is_active
     LEFT JOIN avis_core_v2.holder_identities h ON h.record_user_id=a.user_id
     WHERE a.network IS NULL AND a.wallet_scope='FUNDING' AND a.account_category='LIABILITY'
      AND ((a.owner_type='USER' AND h.user_id IS NOT NULL) OR a.owner_type=ANY($1::text[]))
      AND ($2::uuid IS NULL OR a.account_id=$2)
     ORDER BY a.currency_code, "holderName", i.abiq_iban`,[RECEIVING_OWNERS,id??null])).rows;
  }
  return {...directory,accounts:rows.map(row=>({accountId:row.account_id,accountType:row.owner_type,currency:row.currency_code,abiqIban:row.abiq_iban,label:row.label}))};
 }
 async selectNostroAccount(actor,input){
  if(!(actor?.admin||actor?.ipHandlerService)||!actor.id||actor.customerUserId)fault('FORBIDDEN',null,403);
  if(!uuid(input?.requestId)||![input.nostroCashAccountId,input.expectedNostroCashAccountId].every(id=>id===null||uuid(id)))
   fault('INVALID_FIELD','nostroCashAccountId');
  return this.withTransaction(async db=>{
   const row=(await db.query('SELECT * FROM avis_core_v2.checkout_ip_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   if(!row||row.superseded_by)fault('CHECKOUT_IP_NOT_FOUND','requestId',404);
   const selected=input.nostroCashAccountId?.toLowerCase()||null;
   if(selected===row.nostro_cash_account_id)return {nostroCashAccountId:selected,intermediaryId:row.intermediary_id};
   if(row.nostro_cash_account_id!==input.expectedNostroCashAccountId)fault('CHECKOUT_IP_ACCOUNT_CHANGED','nostroCashAccountId',409);
   if(selected){
    const registered=await db.query('SELECT cash_account_id FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1 AND currency_code=$2 AND is_active FOR SHARE',[selected,row.currency_code]);
    if(!registered.rows.length)fault('CHECKOUT_IP_ACCOUNT','nostroCashAccountId',409);
   }
   const booked=await db.query(`SELECT request_id FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=$1
    UNION ALL SELECT request_id FROM avis_core_v2.checkout_ip_settlements WHERE request_id=$1
    UNION ALL SELECT request_id FROM avis_core_v2.checkout_ip_processing WHERE request_id=$1 AND (operation_completed OR handler_status='SETTLED')`,[row.request_id]);
   if(booked.rows.length)fault('CHECKOUT_IP_PROCESSING','nostroCashAccountId',409);
   await db.query('UPDATE avis_core_v2.checkout_ip_requests SET nostro_cash_account_id=$2,intermediary_id=NULL,updated_at=now() WHERE request_id=$1',[row.request_id,selected]);
   await db.query("INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,'CHECKOUT_IP_NOSTRO_SELECTED',$2)",[actor.id,row.request_id]);
   return {nostroCashAccountId:selected,intermediaryId:null};
  });
 }
 async selectReceivingAccount(actor,input){
  if(!actor?.ipHandlerService||!actor.id||actor.customerUserId)fault('FORBIDDEN',null,403);
  if(!uuid(input?.requestId)||!uuid(input.receivingAccountId)||input.expectedReceivingAccountId!==null&&!uuid(input.expectedReceivingAccountId))fault('INVALID_FIELD','receivingAccountId');
  return this.withTransaction(async db=>{
   const row=(await db.query('SELECT * FROM avis_core_v2.checkout_ip_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   if(!row||row.status!=='ACTIVE'||row.superseded_by)fault('CHECKOUT_IP_STATE','requestId',409);
   const selected=(await db.query(`SELECT a.account_id FROM avis_core_v2.ledger_accounts a
    JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=a.account_id AND b.status='ACTIVE'
    WHERE a.account_id=$1 AND a.currency_code=$2 AND a.owner_type=ANY($3::text[]) AND a.account_category='LIABILITY'
     AND a.wallet_scope='FUNDING' AND a.network IS NULL FOR SHARE OF a`,[input.receivingAccountId,row.currency_code,RECEIVING_OWNERS])).rows[0];
   if(!selected)fault('CHECKOUT_IP_ACCOUNT','receivingAccountId',409);
   if(row.receiving_account_id===selected.account_id)return {receivingAccountId:selected.account_id};
   if((row.receiving_account_id||null)!==input.expectedReceivingAccountId)fault('CHECKOUT_IP_ACCOUNT_CHANGED','receivingAccountId',409);
   const locked=await db.query(`SELECT request_id FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=$1
    UNION ALL SELECT request_id FROM avis_core_v2.checkout_ip_processing WHERE request_id=$1 AND (operation_completed OR handler_status<>'DRAFT')
    UNION ALL SELECT request_id FROM avis_core_v2.checkout_ip_settlements WHERE request_id=$1`,[row.request_id]);
   if(locked.rows.length)fault('CHECKOUT_IP_PROCESSING','receivingAccountId',409);
   await db.query('UPDATE avis_core_v2.checkout_ip_requests SET receiving_account_id=$2,updated_at=now() WHERE request_id=$1',[row.request_id,selected.account_id]);
   await db.query("INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,'CHECKOUT_IP_RECEIVING_ACCOUNT_SELECTED',$2)",[actor.id,row.request_id]);
   return {receivingAccountId:selected.account_id};
  });
 }
 async backofficeReceivingAccounts(){
  return (await this.pool.query(`SELECT a.account_id,a.owner_type,a.currency_code,b.abiq_iban,
    COALESCE(a.display_name,CASE WHEN a.owner_type='COMMON_POOL' THEN 'Common Account' ELSE 'Suspense Account' END) AS label,
    a.available_balance::text
    FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=a.account_id
    WHERE a.owner_type=ANY($1::text[]) AND b.status='ACTIVE' AND a.wallet_scope='FUNDING'
     AND a.account_category='LIABILITY' AND a.network IS NULL
    ORDER BY a.currency_code,a.owner_type,b.abiq_iban`,[RECEIVING_OWNERS])).rows;
 }
 async accounts(actor){
  if(!actor?.admin||actor.customerUserId)fault('FORBIDDEN',null,403);
  return this.backofficeReceivingAccounts();
 }
 async setActive(actor,input){
  if(!actor?.admin||actor.customerUserId)fault('FORBIDDEN',null,403);
  if(!uuid(input?.requestId)||typeof input.active!=='boolean')fault('INVALID_FIELD','requestId');
  return this.withTransaction(async db=>{
   await this.expire(db);
   const row=(await db.query('SELECT * FROM avis_core_v2.checkout_ip_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   if(!row)fault('CHECKOUT_IP_NOT_FOUND','requestId',404);
   if(input.active){
    if(input.expectedNostroCashAccountId!==undefined&&row.nostro_cash_account_id!==input.expectedNostroCashAccountId)fault('CHECKOUT_IP_ACCOUNT_CHANGED','nostroCashAccountId',409);
    const retry=input.retryClosedAt!==undefined;
    if(retry){
     if(row.status!=='CLOSED'||row.superseded_by||typeof input.retryClosedAt!=='string'||
      !row.closed_at||Date.parse(input.retryClosedAt)!==new Date(row.closed_at).getTime())fault('CHECKOUT_IP_STATE','requestId',409);
     const protectedRequest=await db.query(`SELECT request_id FROM avis_core_v2.checkout_ip_cancellations WHERE request_id=$1
      UNION ALL SELECT request_id FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=$1
      UNION ALL SELECT request_id FROM avis_core_v2.checkout_ip_settlements WHERE request_id=$1
      UNION ALL SELECT request_id FROM avis_core_v2.checkout_ip_processing WHERE request_id=$1 AND (operation_completed OR handler_status='SETTLED')`,[row.request_id]);
     if(protectedRequest.rows.length)fault('CHECKOUT_IP_STATE','requestId',409);
     if(row.checkout_kind==='MILESTONE'&&row.source==='industrial')
      await checkMilestoneDuplicate(db,row.request_id,row.checkout_reference,row.sender_account,row.currency_code,row.amount,{retryExisting:true});
    }else if(row.status!=='REQUESTED')fault('CHECKOUT_IP_STATE','requestId',409);
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
    if(retry){
     await db.query(`UPDATE avis_core_v2.checkout_ip_requests SET requested_at=now(),expires_at=now()+interval '60 minutes',
      closed_at=NULL WHERE request_id=$1`,[row.request_id]);
     await db.query("INSERT INTO avis_core_v2.checkout_ip_events(request_id,event_type,actor_id) VALUES($1,'REQUEST',$2)",[row.request_id,actor.id]);
    }
    await db.query(`UPDATE avis_core_v2.checkout_ip_requests SET status='ACTIVE',register_archived_at=NULL,approved_at=now(),approved_by=$2,
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
