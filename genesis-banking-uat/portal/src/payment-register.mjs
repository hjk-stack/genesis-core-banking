import {createHash,randomUUID} from 'node:crypto';
import {FxBankingServer} from './fx.mjs';
import {fault,text,money,decimal} from './core.mjs';
import {ABIQ_ISSUER} from './avispay-core-accounts.mjs';
import {checkBeneficiary,postalAddress} from './beneficiaries.mjs';
import {buildPacs008} from './iso20022.mjs';
import {buildFin103} from './fin-message.mjs';
import {connectorCredentials,dispatchPayment,bankRouteSnapshot} from './payment-transport.mjs';

const digest=s=>createHash('sha256').update(s).digest('hex');
const entry=(accountId,direction,amount)=>({accountId,direction,amount});
const equal=(a,b)=>b&&Object.keys(a).every(k=>a[k]===b[k]);
const requestFields=`r.*,t.iso_status AS bank_status,o.status AS delivery,
 CASE WHEN t.iso_status='ACCC' THEN 'COMPLETED' WHEN t.iso_status='RJCT' THEN 'REJECTED' ELSE r.status END AS current_status`;
export class PaymentRegister extends FxBankingServer {
 constructor(pool,{directory={},transport={}}={}){super(pool);this.directory=directory;this.transport=transport;}
 checkReceiver(actor,input){return checkBeneficiary(this.pool,actor,input,this.directory);}
 async saveCustomerProfile(actor,input,key){
  const address=postalAddress(input.address);
  return this.operation(actor,'SAVE_CUSTOMER_ADDRESS',input,key,async db=>{
   const r=await db.query('UPDATE avis_core_v2.sovereign_users SET postal_address=$2 WHERE user_id=$1 RETURNING user_id',[input.userId,JSON.stringify(address)]);
   if(!r.rows.length)fault('ABIQ_CUSTOMER_NOT_FOUND','userId');return {userId:String(r.rows[0].user_id)};
  });
 }
 async preparePayment(actor,input,key){
  // Directory IO precedes the short database transaction; final routing is checked again inside it.
  const payee=await this.checkReceiver(actor,input);
  const address=postalAddress(payee.receiverBridgeId&&payee.addressSource==='REGISTERED'?payee.address:input.address);
  const receiverName=payee.receiverBridgeId?payee.receiverName:text(input.receiverName,'receiverName',140);
  const reference=text(input.reference,'reference',128),amount=decimal(money(input.amount,6),6);
  if(!new RegExp(input.currency==='JPY'?'^[0-9]{1,18}$':'^[0-9]{1,18}(\\.[0-9]{1,2})?$').test(input.amount))fault('INVALID_AMOUNT','amount');
  return this.operation(actor,'REVIEW_PAYMENT',input,key,async db=>{
   const source=await this.route(db,input.from,input.currency,'from');
   const holder=(await db.query('SELECT full_name FROM avis_core_v2.sovereign_users WHERE user_id=$1',[source.user_id])).rows[0];
   const bank=(await db.query('SELECT * FROM avis_core_v2.abiq_bank_routes WHERE bridge_id=$1',[source.bridge_id])).rows[0];
   let mode=payee.receiverBridgeId?'INTERNAL':'MANUAL',profile=null;
   if(payee.receiverBridgeId===source.bridge_id)fault('SAME_ACCOUNT','receiverAccount');
   if(mode==='MANUAL'&&bank?.account_type==='IBAN'){
    try{profile=await this.profile(db,bank.connector_code);(this.transport.credentials||connectorCredentials)(profile.credential_reference);mode='CONNECTED';}
    catch(e){if(!['CONNECTOR_CONFIGURATION','CONNECTOR_NOT_FOUND'].includes(e.code))throw e;profile=null;}
   }
   const id=randomUUID(),uetr=randomUUID(),now=new Date().toISOString();
   const instruction={from:input.from,currency:input.currency,amount,receiverAccount:payee.account,receiverBic:payee.bic,
    receiverName,address,reference,createdAt:now};
   const p={messageId:id.replaceAll('-',''),uetr,endToEndId:id.replaceAll('-',''),amount,currency:input.currency,
    senderBic:profile?.local_bic||ABIQ_ISSUER.abiqCode,receiverBic:profile?.peer_bic||payee.bic,creditorBic:payee.bic,
    debtorName:holder.full_name,debtorIban:bank?.account_number||input.from,
    debtorAccountType:bank?.account_type==='IBAN'?'IBAN':'OTHER',creditorIban:payee.account,
    creditorAccountType:payee.accountType==='IBAN'?'IBAN':'OTHER',creditorName:receiverName,creditorAddress:address,
    reference,date:now.slice(0,10),createdAt:now};
   const iso=await buildPacs008(p);let content=iso,format='ISO20022';
   if(mode==='MANUAL')try{content=buildFin103(p);format='FIN_MT103';}catch(e){if(!['FIN_CHARACTER_SET','FIN_FIELD_LENGTH'].includes(e.code))throw e;}
   const hash=digest(content);
   await db.query(`INSERT INTO avis_core_v2.payment_requests(request_id,actor_id,source_bridge_id,source_account_id,receiver_bridge_id,profile_id,
    currency_code,amount,beneficiary_account,beneficiary_bic,beneficiary_name,beneficiary_address,payment_reference,uetr,instruction,route_snapshot,
    delivery_mode,message_format,message_content,iso_message,message_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [id,actor.id,source.bridge_id,source.ledger_account_id,payee.receiverBridgeId,profile?.profile_id||null,input.currency,amount,payee.account,payee.bic,
     receiverName,JSON.stringify(address),reference,uetr,JSON.stringify(instruction),profile?JSON.stringify(bankRouteSnapshot(profile)):null,mode,format,content,iso,hash]);
   return {id,messageHash:hash,message:content,format,mode,instruction};
  });
 }
 async confirmPayment(actor,input,key){
  const result=await this.operation(actor,'CONFIRM_PAYMENT',input,key,async(db,k)=>{
   const r=(await db.query('SELECT * FROM avis_core_v2.payment_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   if(!r||r.actor_id!==actor.id)fault('PAYMENT_REQUEST_NOT_FOUND','review',404);
   if(input.messageHash!==r.message_hash||digest(r.message_content)!==r.message_hash)fault('PAYMENT_REVIEW_CHANGED','review',409);
   if(r.status==='CANCELLED')fault('PAYMENT_REQUEST_CLOSED','review',409);
   if(r.status!=='REVIEW')return {id:r.request_id,transferId:r.transfer_id,mode:r.delivery_mode};
   if(r.instruction.createdAt.slice(0,10)!==new Date().toISOString().slice(0,10))fault('PAYMENT_REVIEW_CHANGED','review',409);
   const source=await this.route(db,r.instruction.from,r.currency_code,'from');
   if(source.bridge_id!==r.source_bridge_id)fault('PAYMENT_REVIEW_CHANGED','review',409);
   let journalId,transferId=null,status='OUTGOING';
   if(r.delivery_mode==='CONNECTED'){
    if(digest(r.iso_message)!==r.message_hash)fault('PAYMENT_REVIEW_CHANGED','review',409);
    const p=await this.profile(db,r.profile_id);
    if(!equal(bankRouteSnapshot(p),r.route_snapshot))fault('PAYMENT_REVIEW_CHANGED','review',409);
    (this.transport.credentials||connectorCredentials)(p.credential_reference);
    const t=await this.reserveBankPayment(db,actor,k,{from:r.instruction.from,currency:r.currency_code,amount:r.amount,
     profileId:r.profile_id,creditorIban:r.beneficiary_account,creditorName:r.beneficiary_name,reference:r.payment_reference},
     {id:r.request_id,uetr:r.uetr,xml:r.iso_message});
    journalId=t.journalId;transferId=t.id;status='PROCESSING';
   }else if(r.delivery_mode==='INTERNAL'){
    const target=await this.route(db,r.beneficiary_account,r.currency_code,'receiverAccount');
    if(target.bridge_id!==r.receiver_bridge_id||target.ledger_account_id===source.ledger_account_id)fault('PAYMENT_REVIEW_CHANGED','review',409);
    journalId=await this.post(db,actor,k,'PAYMENT_INTERNAL_TRANSFER',r.payment_reference,
     [entry(source.ledger_account_id,'DEBIT',r.amount),entry(target.ledger_account_id,'CREDIT',r.amount)]);status='COMPLETED';
   }else{
    const hold=await this.system(db,'SUSPENSE_OUTBOUND',r.currency_code,r.request_id);
    journalId=await this.post(db,actor,k,'PAYMENT_MANUAL_RESERVED',r.payment_reference,
     [entry(source.ledger_account_id,'DEBIT',r.amount),entry(hold,'CREDIT',r.amount)]);
   }
   await db.query(`UPDATE avis_core_v2.payment_requests SET status=$2,transfer_id=$3,reservation_journal_id=$4,submitted_at=now() WHERE request_id=$1`,[r.request_id,status,transferId,journalId]);
   await db.query(`INSERT INTO avis_core_v2.payment_beneficiaries(actor_id,account_number,bic,full_name,postal_address) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(actor_id,account_number) DO UPDATE SET bic=EXCLUDED.bic,full_name=EXCLUDED.full_name,postal_address=EXCLUDED.postal_address,updated_at=now()`,
    [actor.id,r.beneficiary_account,r.beneficiary_bic,r.beneficiary_name,JSON.stringify(r.beneficiary_address)]);
   return {id:r.request_id,transferId,mode:r.delivery_mode};
  });
  if(result.transferId){
   const t=(await this.pool.query('SELECT iso_status FROM avis_core_v2.interbank_ip_transfers WHERE transfer_id=$1',[result.transferId])).rows[0];
   if(!['ACCC','RJCT'].includes(t.iso_status))await dispatchPayment(this,actor,{transferId:result.transferId},'register:'+result.id,this.transport);
  }
  return this.paymentRequest(actor,result.id);
 }
 async cancelPayment(actor,input,key){
  return this.operation(actor,'CANCEL_MANUAL_PAYMENT',input,key,async(db,k)=>{
   const r=(await db.query('SELECT * FROM avis_core_v2.payment_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   if(!r)fault('PAYMENT_REQUEST_NOT_FOUND','requestId',404);
   if(r.delivery_mode!=='MANUAL'||!['OUTGOING','CANCELLED'].includes(r.status))fault('PAYMENT_REQUEST_CLOSED','requestId',409);
   if(r.status==='CANCELLED')return {id:r.request_id,status:r.status};
   const hold=await this.system(db,'SUSPENSE_OUTBOUND',r.currency_code,r.request_id);
   await this.post(db,actor,k,'PAYMENT_MANUAL_CANCELLED',r.payment_reference,
    [entry(hold,'DEBIT',r.amount),entry(r.source_account_id,'CREDIT',r.amount)],r.reservation_journal_id);
   await db.query("UPDATE avis_core_v2.payment_requests SET status='CANCELLED',cancelled_at=now() WHERE request_id=$1",[r.request_id]);
   return {id:r.request_id,status:'CANCELLED'};
  });
 }
 async paymentRequest(actor,id){
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  const r=(await this.pool.query(`SELECT ${requestFields} FROM avis_core_v2.payment_requests r LEFT JOIN avis_core_v2.interbank_ip_transfers t USING(transfer_id) LEFT JOIN avis_core_v2.payment_outbox o USING(transfer_id) WHERE r.request_id=$1`,[id])).rows[0];
  if(!r||(r.status==='REVIEW'&&r.actor_id!==actor.id))fault('PAYMENT_REQUEST_NOT_FOUND','requestId',404);
  return r;
 }
 async list(actor,view){
  if(!['paymentregister','transferrequests'].includes(view))return super.list(actor,view);
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  return (await this.pool.query(`SELECT r.request_id,r.created_at,r.beneficiary_name,r.beneficiary_account,r.beneficiary_bic,r.payment_reference,r.amount,r.currency_code,r.delivery_mode,
   CASE WHEN t.iso_status='ACCC' THEN 'COMPLETED' WHEN t.iso_status='RJCT' THEN 'REJECTED' ELSE r.status END AS status,o.status AS delivery
   FROM avis_core_v2.payment_requests r LEFT JOIN avis_core_v2.interbank_ip_transfers t USING(transfer_id) LEFT JOIN avis_core_v2.payment_outbox o USING(transfer_id)
   WHERE r.status<>'REVIEW' ${view==='transferrequests'?"AND r.delivery_mode<>'INTERNAL'":''} ORDER BY r.created_at DESC LIMIT 300`)).rows;
 }
}
