import {createHash} from 'node:crypto';
import {fault,text} from './core.mjs';
import {bookCheckoutSettlement,mapSettlement,normalizedBankAccount,parseSettlementEvidence} from './checkout-ip-settlement.mjs';

export const IP_PROOF_MAX_BYTES=2*1024*1024;
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const sha=value=>createHash('sha256').update(value).digest('hex');
const optionalText=(value,field,max)=>value==null||value===''?null:text(value,field,max);
const decimal=(value,field,{percent=false}={})=>{
 if(value==null||value==='')return null;
 const pattern=percent?/^[0-9]{1,3}(\.[0-9]{1,2})?$/:/^[0-9]{1,18}(\.[0-9]{1,18})?$/;
 if(typeof value!=='string'||!pattern.test(value))fault('INVALID_FIELD',field);
 const [whole,fraction='']=value.split('.');
 if(percent&&BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'))>10000n)fault('INVALID_FIELD',field);
 return BigInt(whole).toString()+(fraction.replace(/0+$/,'')?'.'+fraction.replace(/0+$/,''):'');
};
const authorizeHandler=actor=>{if(!actor?.ipHandlerService||!actor.id||actor.customerUserId)fault('FORBIDDEN',null,403)};
const authorizeAdmin=actor=>{if(!actor?.admin||actor.customerUserId)fault('FORBIDDEN',null,403)};
const mapClaim=row=>row?({requestId:row.request_id,claimed:true,handlerTransferId:row.handler_transfer_id,
 transactionReference:row.transaction_reference,routing:row.routing_snapshot,claimedAt:row.claimed_at}):null;
const sameRoute=(left,right)=>['receivingAccountId','receivingAbiqIban','nostroCashAccountId','nostroIban','intermediaryId']
 .every(field=>(left?.[field]||null)===(right?.[field]||null));
async function assertIdentityAvailable(db,requestId,handlerTransferId,transactionReference){
 // Reports and settlement claims share ownership of both identities. Lock them
 // in the same order across requests before checking either table or writing.
 for(const identity of ['checkout-ip-handler-transfer:'+handlerTransferId,'checkout-ip-transaction-reference:'+transactionReference].sort())
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[identity]);
 const other=(await db.query(`SELECT handler_transfer_id,transaction_reference FROM avis_core_v2.checkout_ip_processing
  WHERE request_id<>$3 AND (handler_transfer_id=$1 OR transaction_reference=$2)
  UNION ALL
  SELECT handler_transfer_id,transaction_reference FROM avis_core_v2.checkout_ip_settlement_claims
  WHERE request_id<>$3 AND (handler_transfer_id=$1 OR transaction_reference=$2)
  LIMIT 1`,[handlerTransferId,transactionReference,requestId])).rows[0];
 if(other)fault('CHECKOUT_IP_PROCESSING_LINK',other.handler_transfer_id===handlerTransferId?'handlerTransferId':'transactionReference',409);
}
const report=row=>({handlerTransferId:row.handler_transfer_id,revision:row.revision,
 transactionReference:row.transaction_reference,handlerStatus:row.handler_status,bankName:row.bank_name,
 bankServerSentAmount:row.bank_server_sent_amount,nostroIban:row.nostro_iban,receivingAbiqIban:row.receiving_abiq_iban,
 amountCleared:row.amount_cleared,beneficiaryName:row.beneficiary_name,beneficiaryAccount:row.beneficiary_account,
 franchiseAllocatedPercent:row.franchise_allocated_percent,operationCompleted:row.operation_completed,
 manualReport100Digits:row.manual_report_100_digits,updatedAt:row.updated_at,
 settlement:mapSettlement(row.settlement_record),
 proof:{available:!!row.proof_sha256,fileName:row.proof_file_name||null,sha256:row.proof_sha256||null,sizeBytes:row.proof_size_bytes||null}});
const parseProof=value=>{
 if(!value||typeof value!=='object'||Array.isArray(value))fault('CHECKOUT_IP_PROOF','proof');
 const fileName=text(value.fileName,'proof.fileName',128);
 if(!/^[A-Za-z0-9][A-Za-z0-9 ._-]*\.pdf$/i.test(fileName))fault('INVALID_FIELD','proof.fileName');
 const encoded=value.pdfBase64;
 if(typeof encoded!=='string'||encoded.length>Math.ceil(IP_PROOF_MAX_BYTES/3)*4||!encoded.length||
  !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))fault('CHECKOUT_IP_PROOF','proof');
 const bytes=Buffer.from(encoded,'base64');
 if(bytes.length<8||bytes.length>IP_PROOF_MAX_BYTES||bytes.toString('base64')!==encoded||
  !/^%PDF-[12]\.[0-9]/.test(bytes.subarray(0,8).toString('ascii'))||!bytes.subarray(-1024).includes(Buffer.from('%%EOF')))
  fault('CHECKOUT_IP_PROOF','proof');
 return {fileName,bytes,sha256:sha(bytes),sizeBytes:bytes.length};
};

// Only the authenticated handler writes this register. New booked-bank evidence
// posts the approved core route atomically; legacy report-only payloads stay reports.
export class CheckoutIpProcessing{
 constructor(pool,{mapRequest}={}){this.pool=pool;this.mapRequest=mapRequest;}
 async readReports(db,ids){
  if(!ids.length)return new Map();
  const rows=(await db.query(`SELECT p.*,p.bank_server_sent_amount::text,p.amount_cleared::text,
   p.franchise_allocated_percent::text,d.file_name AS proof_file_name,d.sha256 AS proof_sha256,
   octet_length(d.pdf_bytes) AS proof_size_bytes,
   CASE WHEN s.request_id IS NOT NULL THEN to_jsonb(s)||jsonb_build_object('amount',s.amount::text) END AS settlement_record
   FROM avis_core_v2.checkout_ip_processing p LEFT JOIN avis_core_v2.checkout_ip_proofs d USING(request_id)
   LEFT JOIN avis_core_v2.checkout_ip_settlements s ON s.request_id=p.request_id
   WHERE p.request_id=ANY($1::uuid[])`,[ids])).rows;
  return new Map(rows.map(row=>[row.request_id,report(row)]));
 }
 async routing(db,request){
  const row=(await db.query(`SELECT r.receiving_account_id,r.nostro_cash_account_id,r.intermediary_id,
   b.abiq_iban,c.iban_or_account_no
   FROM avis_core_v2.checkout_ip_requests r
   LEFT JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=r.receiving_account_id AND b.status='ACTIVE'
   LEFT JOIN avis_core_v2.external_cash_accounts c ON c.cash_account_id=r.nostro_cash_account_id
   WHERE r.request_id=$1`,[request.request_id])).rows[0];
  return {receivingAccountId:row?.receiving_account_id||null,receivingAbiqIban:row?.abiq_iban||null,
   nostroCashAccountId:row?.nostro_cash_account_id||null,nostroIban:row?.iban_or_account_no||null,
   intermediaryId:row?.intermediary_id||null};
 }
 async nostroDirectory(db,currency=null){
  const registered=(await db.query(`SELECT c.cash_account_id,c.iban_or_account_no,c.currency_code,c.institution_name,
   c.bank_address,c.account_name,c.bic_code,c.aba,
   (c.is_active AND a.currency_code=c.currency_code AND a.account_category='ASSET' AND
    a.owner_type IN ('CORRESPONDENT_NOSTRO','CENTRAL_BANK_RESERVE') AND a.network IS NULL AND a.wallet_scope='FUNDING') AS selectable
   FROM avis_core_v2.external_cash_accounts c LEFT JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.ledger_account_id
   WHERE $1::text IS NULL OR c.currency_code=$1
   ORDER BY c.institution_name,c.iban_or_account_no,c.cash_account_id`,[currency])).rows
   .map(c=>({cashAccountId:c.cash_account_id,accountNumber:c.iban_or_account_no,currency:c.currency_code,bankName:c.institution_name,...(c.selectable===true?{}:{selectable:false}),
    receiverClearing:{receiverBankName:c.institution_name,receiverBankAddress:c.bank_address||'',receiverAccountHolder:c.account_name||'',
     receiverIban:c.iban_or_account_no,receiverBic:c.bic_code||'',receiverSortCode:c.aba||'',receiverCountry:'',receiverBankCode:''}}));
  const nostroAccounts=registered.filter(bank=>bank.selectable!==false);
  return nostroAccounts.length===registered.length?{nostroAccounts}:{nostroAccounts,registeredNostros:registered};
 }
 async context(actor,input){
  authorizeHandler(actor);
  if(!uuid(input?.requestId))fault('INVALID_FIELD','requestId');
  const row=(await this.pool.query('SELECT * FROM avis_core_v2.checkout_ip_requests WHERE request_id=$1',[input.requestId])).rows[0];
  if(!row)fault('CHECKOUT_IP_NOT_FOUND','requestId',404);
  const reports=await this.readReports(this.pool,[row.request_id]);
  const claim=mapClaim((await this.pool.query('SELECT * FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=$1',[row.request_id])).rows[0]);
  const directory=await this.nostroDirectory(this.pool,row.currency_code);
  const receiving=(await this.pool.query(`SELECT a.account_id,a.owner_type,a.currency_code,b.abiq_iban,
   COALESCE(a.display_name,CASE WHEN a.owner_type='COMMON_POOL' THEN 'Common Account' ELSE 'Suspense Account' END) AS label
   FROM avis_core_v2.ledger_accounts a LEFT JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=a.account_id
   WHERE a.account_id=$1`,[row.receiving_account_id])).rows[0];
  return {request:{...this.mapRequest(row),processing:reports.get(row.request_id)||null},
   routing:claim?.routing||await this.routing(this.pool,row),claim,...directory,
   receivingAccount:receiving?{accountId:receiving.account_id,accountType:receiving.owner_type,label:receiving.label,
    currency:receiving.currency_code,abiqIban:receiving.abiq_iban}:null};
 }
 async claim(actor,input){
  authorizeHandler(actor);
  if(!uuid(input?.requestId))fault('INVALID_FIELD','requestId');
  if(!uuid(input.handlerTransferId))fault('INVALID_FIELD','handlerTransferId');
  const handlerTransferId=input.handlerTransferId.toLowerCase(),transactionReference=text(input.transactionReference,'transactionReference',140);
  const db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const request=(await db.query('SELECT * FROM avis_core_v2.checkout_ip_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   if(!request)fault('CHECKOUT_IP_NOT_FOUND','requestId',404);
   const previous=(await db.query('SELECT * FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=$1',[request.request_id])).rows[0];
   if(previous){
    if(previous.handler_transfer_id!==handlerTransferId||previous.transaction_reference!==transactionReference||!sameRoute(input,previous.routing_snapshot))
     fault('CHECKOUT_IP_PROCESSING_LINK','handlerTransferId',409);
    await db.query('COMMIT');return mapClaim(previous);
   }
   if(request.status!=='ACTIVE')fault('CHECKOUT_IP_STATE','requestId',409);
   if((await db.query('SELECT request_id FROM avis_core_v2.checkout_ip_cancellations WHERE request_id=$1',[request.request_id])).rows.length)
    fault('CHECKOUT_IP_CANCELLED','requestId',409);
   const routing=await this.routing(db,request);
   if(!routing.nostroCashAccountId&&input.nostroCashAccountId){
    if(!uuid(input.nostroCashAccountId)||typeof input.nostroIban!=='string')fault('CHECKOUT_IP_ACCOUNT','nostroCashAccountId',409);
    const matches=(await db.query(`SELECT c.cash_account_id,c.iban_or_account_no FROM avis_core_v2.external_cash_accounts c
     JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.ledger_account_id
     WHERE c.is_active AND c.currency_code=$1 AND a.currency_code=$1 AND a.account_category='ASSET'
      AND a.owner_type=ANY($2::text[]) AND a.network IS NULL AND a.wallet_scope='FUNDING'
      AND upper(regexp_replace(c.iban_or_account_no,'\\s','','g'))=$3 FOR SHARE OF c`,
     [request.currency_code,['CORRESPONDENT_NOSTRO','CENTRAL_BANK_RESERVE'],normalizedBankAccount(input.nostroIban)])).rows;
    if(matches.length!==1||matches[0].cash_account_id!==input.nostroCashAccountId.toLowerCase())fault('CHECKOUT_IP_ACCOUNT','nostroCashAccountId',409);
    routing.nostroCashAccountId=matches[0].cash_account_id;routing.nostroIban=matches[0].iban_or_account_no;
   }
   if(!routing.receivingAbiqIban||!sameRoute(input,routing))fault('CHECKOUT_IP_ACCOUNT','receivingAbiqIban',409);
   const report=(await db.query('SELECT handler_transfer_id,transaction_reference FROM avis_core_v2.checkout_ip_processing WHERE request_id=$1',[request.request_id])).rows[0];
   if(report&&(report.handler_transfer_id!==handlerTransferId||report.transaction_reference!==transactionReference))
    fault('CHECKOUT_IP_PROCESSING_LINK','handlerTransferId',409);
   await assertIdentityAvailable(db,request.request_id,handlerTransferId,transactionReference);
   const saved=(await db.query(`INSERT INTO avis_core_v2.checkout_ip_settlement_claims(request_id,handler_transfer_id,transaction_reference,routing_snapshot,actor_id)
    VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *`,[request.request_id,handlerTransferId,transactionReference,JSON.stringify(routing),actor.id])).rows[0];
   await db.query('COMMIT');return mapClaim(saved);
  }catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
 }
 async publish(actor,input){
  authorizeHandler(actor);
  if(!uuid(input?.requestId))fault('INVALID_FIELD','requestId');
  if(!uuid(input.handlerTransferId))fault('INVALID_FIELD','handlerTransferId');
  if(!Number.isSafeInteger(input.revision)||input.revision<1||input.revision>2147483647)fault('INVALID_FIELD','revision');
  if(typeof input.operationCompleted!=='boolean')fault('INVALID_FIELD','operationCompleted');
  const value={handlerTransferId:input.handlerTransferId.toLowerCase(),revision:input.revision,
   transactionReference:text(input.transactionReference,'transactionReference',140),
   handlerStatus:text(input.handlerStatus,'handlerStatus',40),bankName:optionalText(input.bankName,'bankName',180),
   bankServerSentAmount:decimal(input.bankServerSentAmount,'bankServerSentAmount'),
   nostroIban:optionalText(input.nostroIban,'nostroIban',128),receivingAbiqIban:optionalText(input.receivingAbiqIban,'receivingAbiqIban',64),
   amountCleared:decimal(input.amountCleared,'amountCleared'),beneficiaryName:optionalText(input.beneficiaryName,'beneficiaryName',160),
   beneficiaryAccount:optionalText(input.beneficiaryAccount,'beneficiaryAccount',128),
   franchiseAllocatedPercent:decimal(input.franchiseAllocatedPercent,'franchiseAllocatedPercent',{percent:true}),
   operationCompleted:input.operationCompleted,manualReport100Digits:optionalText(input.manualReport100Digits,'manualReport100Digits',100)};
  if(value.manualReport100Digits&&!/^[0-9]{100}$/.test(value.manualReport100Digits))fault('INVALID_FIELD','manualReport100Digits');
  const proof=input.proof==null?null:parseProof(input.proof);
  const settlementEvidence=input.settlementEvidence==null?null:parseSettlementEvidence(input.settlementEvidence);
  if(settlementEvidence&&value.handlerStatus!=='SETTLED')fault('CHECKOUT_IP_COMPLETION','settlementEvidence');
  if(proof&&!value.operationCompleted)fault('CHECKOUT_IP_PROOF','proof');
  if(value.operationCompleted){
   if(value.handlerStatus!=='SETTLED')fault('CHECKOUT_IP_COMPLETION','handlerStatus');
   for(const field of ['bankName','bankServerSentAmount','receivingAbiqIban','amountCleared','beneficiaryName','beneficiaryAccount','franchiseAllocatedPercent','manualReport100Digits'])
    if(value[field]==null)fault('CHECKOUT_IP_COMPLETION',field);
   if(!proof)fault('CHECKOUT_IP_PROOF','proof');
  }
  const snapshot={...value,proof:proof?{fileName:proof.fileName,sha256:proof.sha256,sizeBytes:proof.sizeBytes}:null};
  // Keep the exact historical fingerprint for payloads without new evidence.
  if(settlementEvidence)snapshot.settlementEvidence=settlementEvidence;
  const fingerprint=sha(JSON.stringify(snapshot)),db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const request=(await db.query('SELECT * FROM avis_core_v2.checkout_ip_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   if(!request)fault('CHECKOUT_IP_NOT_FOUND','requestId',404);
   const claim=(await db.query('SELECT * FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=$1',[request.request_id])).rows[0];
   if(claim&&(claim.handler_transfer_id!==value.handlerTransferId||claim.transaction_reference!==value.transactionReference))
    fault('CHECKOUT_IP_PROCESSING_LINK','handlerTransferId',409);
   if((value.handlerStatus==='SETTLED'||value.operationCompleted)&&!claim)fault('CHECKOUT_IP_CLAIM_REQUIRED','requestId',409);
   const previous=(await db.query('SELECT * FROM avis_core_v2.checkout_ip_processing WHERE request_id=$1',[request.request_id])).rows[0];
   if(previous){
    if(previous.handler_transfer_id!==value.handlerTransferId||previous.transaction_reference!==value.transactionReference)
     fault('CHECKOUT_IP_PROCESSING_LINK','handlerTransferId',409);
    if(previous.revision===value.revision){
     if(previous.report_fingerprint!==fingerprint)fault('IDEMPOTENCY_CONFLICT','revision',409);
     const reports=await this.readReports(db,[request.request_id]);await db.query('COMMIT');
     return {requestId:request.request_id,processing:reports.get(request.request_id)};
    }
    if(previous.operation_completed)fault('CHECKOUT_IP_COMPLETED','requestId',409);
    if(previous.revision>value.revision)fault('CHECKOUT_IP_REVISION','revision',409);
   }
   if(request.status!=='ACTIVE'&&!claim)fault('CHECKOUT_IP_STATE','requestId',409);
   const route=claim?.routing_snapshot||await this.routing(db,request);
   if(value.receivingAbiqIban!==route.receivingAbiqIban||value.nostroIban!==route.nostroIban)
    fault('CHECKOUT_IP_ACCOUNT',value.receivingAbiqIban!==route.receivingAbiqIban?'receivingAbiqIban':'nostroIban',409);
   await assertIdentityAvailable(db,request.request_id,value.handlerTransferId,value.transactionReference);
   await bookCheckoutSettlement(db,actor,request,claim,value,settlementEvidence);
   await db.query(`INSERT INTO avis_core_v2.checkout_ip_processing(request_id,handler_transfer_id,revision,
    transaction_reference,handler_status,bank_name,bank_server_sent_amount,nostro_iban,receiving_abiq_iban,
    amount_cleared,beneficiary_name,beneficiary_account,franchise_allocated_percent,operation_completed,
    manual_report_100_digits,report_fingerprint,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT(request_id) DO UPDATE SET revision=EXCLUDED.revision,handler_status=EXCLUDED.handler_status,
    bank_name=EXCLUDED.bank_name,bank_server_sent_amount=EXCLUDED.bank_server_sent_amount,
    nostro_iban=EXCLUDED.nostro_iban,receiving_abiq_iban=EXCLUDED.receiving_abiq_iban,amount_cleared=EXCLUDED.amount_cleared,
    beneficiary_name=EXCLUDED.beneficiary_name,beneficiary_account=EXCLUDED.beneficiary_account,
    franchise_allocated_percent=EXCLUDED.franchise_allocated_percent,operation_completed=EXCLUDED.operation_completed,
    manual_report_100_digits=EXCLUDED.manual_report_100_digits,report_fingerprint=EXCLUDED.report_fingerprint,
    updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [request.request_id,value.handlerTransferId,value.revision,value.transactionReference,value.handlerStatus,value.bankName,
     value.bankServerSentAmount,value.nostroIban,value.receivingAbiqIban,value.amountCleared,value.beneficiaryName,
     value.beneficiaryAccount,value.franchiseAllocatedPercent,value.operationCompleted,value.manualReport100Digits,fingerprint,actor.id]);
   if(proof)await db.query(`INSERT INTO avis_core_v2.checkout_ip_proofs(request_id,handler_transfer_id,revision,
    transaction_reference,manual_report_100_digits,file_name,pdf_bytes,sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [request.request_id,value.handlerTransferId,value.revision,value.transactionReference,value.manualReport100Digits,proof.fileName,proof.bytes,proof.sha256,actor.id]);
   await db.query(`INSERT INTO avis_core_v2.checkout_ip_processing_events(request_id,revision,report_snapshot,report_fingerprint,actor_id)
    VALUES($1,$2,$3::jsonb,$4,$5)`,[request.request_id,value.revision,JSON.stringify(snapshot),fingerprint,actor.id]);
   const reports=await this.readReports(db,[request.request_id]);await db.query('COMMIT');
   return {requestId:request.request_id,processing:reports.get(request.request_id)};
  }catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
 }
 async proof(actor,requestId){
  authorizeAdmin(actor);if(!uuid(requestId))fault('INVALID_FIELD','requestId');
  const row=(await this.pool.query('SELECT file_name,pdf_bytes,sha256 FROM avis_core_v2.checkout_ip_proofs WHERE request_id=$1',[requestId])).rows[0];
  if(!row)fault('CHECKOUT_IP_PROOF_NOT_FOUND','requestId',404);
  const bytes=Buffer.from(row.pdf_bytes);
  if(sha(bytes)!==row.sha256)fault('CHECKOUT_IP_PROOF_INTEGRITY','requestId',500);
  return {fileName:row.file_name,bytes,sha256:row.sha256};
 }
}
