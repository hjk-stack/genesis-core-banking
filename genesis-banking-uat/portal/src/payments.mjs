import {createHash,randomUUID} from 'node:crypto';
import {SovereignCore,fault,text,money,decimal} from './core.mjs';
import {linkAbiqBankRoute} from './avispay-core-accounts.mjs';
import {normalizeIban} from './avispay-correspondent-mapping.mjs';
import {buildPacs008,readIso20022} from './iso20022.mjs';
const line=(accountId,direction,amount)=>({accountId,direction,amount});
const digest=value=>createHash('sha256').update(value).digest('hex');
const terminal=s=>['ACCC','RJCT'].includes(s);
const zeroMoney=v=>/^0(?:\.0+)?$/.test(v)?0n:money(v);
export class PaymentServer extends SovereignCore {
 async registerCashAccount(actor,input,key){
  text(input.institutionName,'institutionName',100);text(input.accountNumber,'accountNumber',128);
  if(!['CENTRAL_BANK','CORRESPONDENT_BANK','CORE_BANK_OMNIBUS','CARD_SCHEME_SETTLEMENT'].includes(input.institutionType))fault('INVALID_FIELD','institutionType');
  if(!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(input.bic))fault('INVALID_FIELD','bic');
  return this.operation(actor,'REGISTER_CASH_ACCOUNT',input,key,async db=>{
   if(!(await db.query('SELECT 1 FROM avis_core_v2.abiq_currencies WHERE currency_code=$1',[input.currency])).rows.length)fault('INVALID_FIELD','currency');
   const id=randomUUID(),accountId=await this.system(db,input.institutionType==='CENTRAL_BANK'?'CENTRAL_BANK_RESERVE':'CORRESPONDENT_NOSTRO',input.currency,id,'ASSET');
   await db.query(`INSERT INTO avis_core_v2.external_cash_accounts(cash_account_id,ledger_account_id,institution_type,institution_name,bic_code,iban_or_account_no,currency_code,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,true)`,[id,accountId,input.institutionType,input.institutionName,input.bic,input.accountNumber,input.currency]);
   return {id,accountId};
  });
 }
 async registerBankConnector(actor,input,key){
  if(!/^[A-Z0-9_]{1,35}$/.test(input.profileId))fault('INVALID_FIELD','profileId');
  for(const name of ['localBic','peerBic'])if(!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(input[name]))fault('INVALID_FIELD',name);
  if(!['IP_TO_IP','SWIFT_ISO20022','BANK_API'].includes(input.protocol))fault('INVALID_FIELD','protocol');
  const url=new URL(text(input.endpoint,'endpoint',500));
  if(!['https:','tls:'].includes(url.protocol)||url.username||url.password||url.hash)fault('INVALID_FIELD','endpoint');
  if(!/^AVIS_CONNECTOR_[A-Z0-9_]+$/.test(input.credentialReference))fault('INVALID_FIELD','credentialReference');
  return this.operation(actor,'REGISTER_BANK_CONNECTOR',input,key,async db=>{
   const cash=(await db.query('SELECT * FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1 AND is_active FOR SHARE',[input.cashAccountId])).rows[0];
   if(!cash)fault('ACCOUNT_NOT_FOUND','cashAccountId');
   await db.query(`INSERT INTO avis_core_v2.platform_connectors(connector_code,display_name,is_enabled,endpoint_url,credential_reference) VALUES($1,$2,true,$3,$4)`,[input.profileId,text(input.name,'name',100),url.href,input.credentialReference]);
   await db.query(`INSERT INTO avis_core_v2.bank_connector_profiles(profile_id,cash_account_id,protocol,local_bic,peer_bic,operations) VALUES($1,$2,$3,$4,$5,$6)`,[input.profileId,cash.cash_account_id,input.protocol,input.localBic,input.peerBic,JSON.stringify(input.operations||{})]);
   return {id:input.profileId};
  });
 }
 async linkBankAccount(actor,input,key){
  return this.operation(actor,'LINK_ABIQ_BANK_ACCOUNT',input,key,async db=>{
   const route=await this.route(db,input.abiqIban,input.currency,'abiqIban');
   const linked=await linkAbiqBankRoute(db,{userId:route.user_id,participantCode:route.participant_code,abiqIban:input.abiqIban,bankRoute:input.bankRoute});
   return {id:linked.bridge_id,...linked};
  });
 }
 async profile(db,id){
  const p=(await db.query(`SELECT p.*,c.endpoint_url,c.credential_reference,c.config_metadata,a.ledger_account_id,a.currency_code,a.iban_or_account_no FROM avis_core_v2.bank_connector_profiles p JOIN avis_core_v2.platform_connectors c ON c.connector_code=p.profile_id JOIN avis_core_v2.external_cash_accounts a USING(cash_account_id) WHERE profile_id=$1 AND c.is_enabled AND a.is_active`,[id])).rows[0];
  if(!p)fault('CONNECTOR_NOT_FOUND','profileId');return p;
 }
 async initiatePayment(actor,input,key){
  const amount=decimal(money(input.amount,6),6),creditorIban=normalizeIban(input.creditorIban);
  return this.operation(actor,'CREATE_BANK_PAYMENT',input,key,async(db,k)=>{
   const p=await this.profile(db,input.profileId),payer=await this.route(db,input.from,input.currency,'from');
   if(p.currency_code!==input.currency)fault('CURRENCY_MISMATCH','currency');
   const account=(await db.query(`SELECT r.account_number,u.full_name FROM avis_core_v2.abiq_bank_routes r JOIN avis_core_v2.abiq_routing_bridge b USING(bridge_id) JOIN avis_core_v2.sovereign_users u USING(user_id) WHERE r.bridge_id=$1 AND r.connector_code=$2 AND r.account_type='IBAN'`,[payer.bridge_id,p.profile_id])).rows[0];
   if(!account)fault('BANK_ROUTE_REQUIRED','from');
   const id=randomUUID(),uetr=randomUUID(),xml=await buildPacs008({messageId:id.replaceAll('-',''),uetr,endToEndId:input.reference,amount,currency:input.currency,senderBic:p.local_bic,receiverBic:p.peer_bic,debtorName:account.full_name,debtorIban:account.account_number,creditorName:input.creditorName,creditorIban,reference:input.reference});
   // Lock both balances in the same order used by post_journal. Reserve external cash as well as customer funds.
   await db.query('SELECT account_id FROM avis_core_v2.ledger_accounts WHERE account_id=ANY($1::uuid[]) ORDER BY account_id FOR UPDATE',[[p.ledger_account_id,payer.ledger_account_id]]);
   const reserved=await db.query(`UPDATE avis_core_v2.ledger_accounts SET locked_balance=locked_balance+$2::numeric WHERE account_id=$1 AND available_balance-locked_balance >=$2::numeric RETURNING account_id`,[p.ledger_account_id,amount]);
   if(!reserved.rows.length)fault('INSUFFICIENT_CLEARING_FUNDS','cashAccountId');
   const suspense=await this.system(db,'SUSPENSE_OUTBOUND',input.currency,id);
   const journalId=await this.post(db,actor,k,'BANK_PAYMENT_RESERVED',input.reference,[line(payer.ledger_account_id,'DEBIT',amount),line(suspense,'CREDIT',amount)]);
   await db.query(`INSERT INTO avis_core_v2.interbank_ip_transfers(transfer_id,uetr,direction,cash_account_id,user_id,journal_id,debtor_iban,creditor_iban,currency_code,amount,raw_iso_payload,profile_id,source_account_id,cash_reserved) VALUES($1,$2,'OUTBOUND',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)`,[id,uetr,p.cash_account_id,payer.user_id,journalId,account.account_number,creditorIban,input.currency,amount,JSON.stringify({xml}),p.profile_id,payer.ledger_account_id]);
   await db.query('INSERT INTO avis_core_v2.payment_outbox(transfer_id,content,content_type) VALUES($1,$2,$3)',[id,xml,'application/xml']);
   return {id,uetr,journalId,status:'PDNG'};
  });
 }
 // Called only after transport authentication; browser operators cannot synthesize peer events.
 async receive(profileId,xml){
  const message=await readIso20022(xml),payloadHash=digest(xml),actor={id:'connector:'+profileId,admin:true};
  return this.operation(actor,'BANK_MESSAGE',{payloadHash},message.messageId,async(db,k)=>{
   const p=await this.profile(db,profileId);
   if(message.senderBic!==p.peer_bic||message.receiverBic!==p.local_bic)fault('MESSAGE_PARTNER_MISMATCH','message');
   let transfer=(await db.query('SELECT * FROM avis_core_v2.interbank_ip_transfers WHERE uetr=$1 FOR UPDATE',[message.uetr])).rows[0];
   if(message.type==='pacs.008.001.08'){
    if(transfer)fault('DUPLICATE_UETR','uetr',409);
    if(message.currency!==p.currency_code)fault('CURRENCY_MISMATCH','currency');
    const recipient=await this.route(db,message.creditorIban,message.currency,'creditorIban');
    const binding=(await db.query('SELECT connector_code FROM avis_core_v2.abiq_bank_routes WHERE bridge_id=$1',[recipient.bridge_id])).rows[0];
    if(binding?.connector_code!==profileId)fault('MESSAGE_PARTNER_MISMATCH','creditorIban');
    transfer=(await db.query(`INSERT INTO avis_core_v2.interbank_ip_transfers(uetr,direction,cash_account_id,user_id,debtor_iban,creditor_iban,currency_code,amount,raw_iso_payload,profile_id,source_account_id,iso_status) VALUES($1,'INBOUND',$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTC') RETURNING *`,[message.uetr,p.cash_account_id,recipient.user_id,message.debtorIban,message.creditorIban,message.currency,message.amount,JSON.stringify({xml}),profileId,recipient.ledger_account_id])).rows[0];
   }else{
    if(!transfer||transfer.profile_id!==profileId)fault('TRANSFER_NOT_FOUND','uetr',404);
    await this.applyStatus(db,actor,k,p,transfer,message.status,message.bankReference);
   }
   await db.query('INSERT INTO avis_core_v2.payment_events(profile_id,message_id,transfer_id,event_type,payload_hash) VALUES($1,$2,$3,$4,$5)',[profileId,message.messageId,transfer.transfer_id,message.type==='pacs.008.001.08'?'RECEIVED':message.status,payloadHash]);
   return {id:transfer.transfer_id,status:message.status||'ACTC'};
  });
 }
 async applyStatus(db,actor,k,p,t,status,bankReference){
  if(terminal(t.iso_status)){if(status===t.iso_status)return;fault('TRANSFER_ALREADY_CLOSED','uetr',409);}
  if(!terminal(status)){
   const next=t.iso_status==='ACSP'?'ACSP':status;
   await db.query('UPDATE avis_core_v2.interbank_ip_transfers SET iso_status=$2 WHERE transfer_id=$1',[t.transfer_id,next]);return;
  }
  let journalId=null;
  if(t.direction==='OUTBOUND'){
   if(!t.cash_reserved)fault('CASH_RESERVATION_REQUIRED','transferId');
   const hold=await this.system(db,'SUSPENSE_OUTBOUND',t.currency_code,t.transfer_id);
   await db.query('SELECT account_id FROM avis_core_v2.ledger_accounts WHERE account_id=ANY($1::uuid[]) ORDER BY account_id FOR UPDATE',[[p.ledger_account_id,t.source_account_id,hold]]);
   await db.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=locked_balance-$2::numeric WHERE account_id=$1',[p.ledger_account_id,t.amount]);
   journalId=await this.post(db,actor,k,status==='ACCC'?'BANK_PAYMENT_SETTLED':'BANK_PAYMENT_REJECTED',bankReference,[line(hold,'DEBIT',t.amount),line(status==='ACCC'?p.ledger_account_id:t.source_account_id,'CREDIT',t.amount)],status==='RJCT'?t.journal_id:null);
  }else if(status==='ACCC'){
   const suspense=await this.system(db,'SUSPENSE_INBOUND',t.currency_code,t.transfer_id),common=await this.system(db,'COMMON_POOL',t.currency_code);
   journalId=await this.post(db,actor,k,'BANK_INCOMING_ALLOCATED',bankReference,[line(p.ledger_account_id,'DEBIT',t.amount),line(suspense,'CREDIT',t.amount),line(suspense,'DEBIT',t.amount),line(common,'CREDIT',t.amount),line(common,'DEBIT',t.amount),line(t.source_account_id,'CREDIT',t.amount)]);
  }
  await db.query('UPDATE avis_core_v2.interbank_ip_transfers SET iso_status=$2,settlement_journal_id=$3,bank_reference=$4,cash_reserved=false WHERE transfer_id=$1',[t.transfer_id,status,journalId,bankReference]);
  if(t.direction==='OUTBOUND')await db.query("UPDATE avis_core_v2.payment_outbox SET status='ACKNOWLEDGED',lease_until=NULL,last_error_code=NULL,updated_at=now() WHERE transfer_id=$1",[t.transfer_id]);
 }
 async reconcileStatement(actor,input,key){
  text(input.reference,'reference');const opening=zeroMoney(input.openingBalance),closing=zeroMoney(input.closingBalance);
  if(!Array.isArray(input.entries)||!input.entries.length||input.entries.length>500)fault('INVALID_FIELD','entries');
  let expected=opening;
  for(const e of input.entries){text(e.bankReference,'bankReference');if(!['DEBIT','CREDIT'].includes(e.direction))fault('INVALID_FIELD','direction');expected+=(e.direction==='CREDIT'?1n:-1n)*money(e.amount);}
  if(expected!==closing)fault('STATEMENT_TOTAL_MISMATCH','closingBalance');
  return this.operation(actor,'RECONCILE_BANK_STATEMENT',input,key,async(db,k)=>{
   const p=await this.profile(db,input.profileId);if(p.currency_code!==input.currency)fault('CURRENCY_MISMATCH','currency');
   const id=randomUUID();await db.query(`INSERT INTO avis_core_v2.clearing_statements(statement_id,cash_account_id,provider_reference,currency_code,opening_balance,closing_balance,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,p.cash_account_id,input.reference,input.currency,input.openingBalance,input.closingBalance,digest(JSON.stringify(input))]);
   let matched=0;
   for(const e of input.entries){
    const t=e.uetr?(await db.query('SELECT * FROM avis_core_v2.interbank_ip_transfers WHERE uetr=$1 FOR UPDATE',[e.uetr])).rows[0]:null;
    if(e.uetr&&(!t||t.cash_account_id!==p.cash_account_id||t.profile_id!==p.profile_id||t.currency_code!==input.currency||money(t.amount)!==money(e.amount)||(t.direction==='INBOUND'?'CREDIT':'DEBIT')!==e.direction))fault('STATEMENT_MATCH_FAILED','entries');
    if(t){await this.applyStatus(db,actor,k+':'+matched,p,t,'ACCC',e.bankReference);matched++;}
    await db.query('INSERT INTO avis_core_v2.clearing_statement_entries(statement_id,bank_reference,direction,amount,transfer_id) VALUES($1,$2,$3,$4,$5)',[id,e.bankReference,e.direction,e.amount,t?.transfer_id||null]);
   }
   return {id,matched,unmatched:input.entries.length-matched};
  });
 }
 async list(actor,view){
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  const queries={
   bankprofiles:`SELECT p.profile_id,c.display_name,p.protocol,p.local_bic,p.peer_bic,p.cash_account_id,a.currency_code,c.endpoint_url FROM avis_core_v2.bank_connector_profiles p JOIN avis_core_v2.platform_connectors c ON c.connector_code=p.profile_id JOIN avis_core_v2.external_cash_accounts a USING(cash_account_id) ORDER BY profile_id`,
   bankroutes:`SELECT b.abiq_iban,r.account_number,r.bank_bic,r.currency_code,r.connector_code FROM avis_core_v2.abiq_bank_routes r JOIN avis_core_v2.abiq_routing_bridge b USING(bridge_id) ORDER BY b.user_id LIMIT 300`,
   bankpayments:`SELECT t.transfer_id,t.uetr,t.direction,t.profile_id,t.debtor_iban,t.creditor_iban,t.amount::text,t.currency_code,t.iso_status AS status,t.bank_reference,t.created_at,o.status AS delivery FROM avis_core_v2.interbank_ip_transfers t LEFT JOIN avis_core_v2.payment_outbox o USING(transfer_id) ORDER BY created_at DESC LIMIT 300`,
   clearing:`SELECT s.provider_reference,s.currency_code,s.opening_balance::text,s.closing_balance::text,s.imported_at,count(e.*)::int AS entries,count(e.transfer_id)::int AS matched FROM avis_core_v2.clearing_statements s JOIN avis_core_v2.clearing_statement_entries e USING(statement_id) GROUP BY s.statement_id ORDER BY s.imported_at DESC LIMIT 300`
  };return queries[view]?(await this.pool.query(queries[view])).rows:super.list(actor,view);
 }
}
