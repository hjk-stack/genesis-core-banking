import {createHash} from 'node:crypto';
import {SovereignCore,fault,text,money,decimal} from './core.mjs';
import {lockBankEntry} from './bank-entry-identity.mjs';

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
export const normalizedBankAccount=value=>String(value||'').replace(/\s+/g,'').toUpperCase();
export const RECEIVING_OWNERS=['COMMON_POOL','SUSPENSE_INBOUND','SUSPENSE_OUTBOUND','SUSPENSE_CARD_FX'];
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;

export function parseSettlementEvidence(value){
 if(!value||typeof value!=='object'||Array.isArray(value))fault('INVALID_FIELD','settlementEvidence');
 if(!uuid(value.journalId))fault('INVALID_FIELD','settlementEvidence.journalId');
 if(typeof value.currency!=='string'||!/^[A-Z]{3}$/.test(value.currency))fault('INVALID_FIELD','settlementEvidence.currency');
 if(typeof value.statementHash!=='string'||!/^[a-f0-9]{64}$/.test(value.statementHash))fault('INVALID_FIELD','settlementEvidence.statementHash');
 const bookedDate=value.bookedDate==null?null:value.bookedDate,bookedAt=value.bookedAt==null?null:value.bookedAt;
 if(bookedDate!==null&&(typeof bookedDate!=='string'||!validDate(bookedDate)))fault('INVALID_FIELD','settlementEvidence.bookedDate');
 if(bookedAt!==null&&(typeof bookedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(bookedAt)||
  !validDate(bookedAt.slice(0,10))||!Number.isFinite(Date.parse(bookedAt))))fault('INVALID_FIELD','settlementEvidence.bookedAt');
 return {journalId:value.journalId.toLowerCase(),bankTransactionId:text(value.bankTransactionId,'settlementEvidence.bankTransactionId',140),
  statementId:text(value.statementId,'settlementEvidence.statementId',140),currency:value.currency,amount:decimal(money(value.amount)),
  nostroAccount:normalizedBankAccount(text(value.nostroAccount,'settlementEvidence.nostroAccount',128)),statementHash:value.statementHash,
  bookedAt:bookedAt===null?null:new Date(bookedAt).toISOString(),bookedDate};
}

export const mapSettlement=row=>row?({journalId:row.journal_id,handlerJournalId:row.handler_journal_id,
 cashAccountId:row.cash_account_id,receivingAccountId:row.receiving_account_id,bankTransactionId:row.bank_transaction_id,
 statementId:row.statement_id,currency:row.currency_code,amount:row.amount,nostroAccount:row.nostro_account,
 statementHash:row.statement_hash,bookedAt:row.booked_at==null?null:new Date(row.booked_at).toISOString(),bookedDate:row.booked_date,booked:true}):null;

export async function bookCheckoutSettlement(db,actor,request,claim,value,evidence){
 const saved=(await db.query('SELECT * FROM avis_core_v2.checkout_ip_settlements WHERE request_id=$1',[request.request_id])).rows[0];
 if(saved){
  if(!evidence||saved.evidence_fingerprint!==fingerprint(evidence))fault('CHECKOUT_IP_SETTLEMENT_CONFLICT','settlementEvidence',409);
  return mapSettlement(saved);
 }
 if(!evidence)return null;
 if(value.handlerStatus!=='SETTLED'||!claim)fault('CHECKOUT_IP_CLAIM_REQUIRED','settlementEvidence',409);
 const route=claim.routing_snapshot;
 if(!uuid(route.nostroCashAccountId)||!uuid(route.receivingAccountId)||!route.nostroIban)
  fault('CHECKOUT_IP_ACCOUNT','nostroCashAccountId',409);
 if(evidence.currency!==request.currency_code)fault('CURRENCY_MISMATCH','settlementEvidence.currency',409);
 if(money(evidence.amount)!==money(request.amount)||value.amountCleared===null||money(value.amountCleared)!==money(request.amount)||
  value.bankServerSentAmount!==null&&money(value.bankServerSentAmount)!==money(request.amount))
  fault('CHECKOUT_IP_SETTLEMENT_AMOUNT','settlementEvidence.amount',409);
 if(evidence.nostroAccount!==normalizedBankAccount(route.nostroIban))fault('CHECKOUT_IP_ACCOUNT','settlementEvidence.nostroAccount',409);
 await lockBankEntry(db,route.nostroCashAccountId,evidence.bankTransactionId);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['handler-settlement-journal:'+evidence.journalId]);
 const cash=(await db.query(`SELECT c.*,a.account_category,a.currency_code AS ledger_currency,a.owner_type,a.network,a.wallet_scope
  FROM avis_core_v2.external_cash_accounts c JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.ledger_account_id
  WHERE c.cash_account_id=$1 AND c.is_active FOR SHARE OF c`,[route.nostroCashAccountId])).rows[0];
 if(!cash||cash.currency_code!==evidence.currency||cash.ledger_currency!==evidence.currency||cash.account_category!=='ASSET'||
  !['CORRESPONDENT_NOSTRO','CENTRAL_BANK_RESERVE'].includes(cash.owner_type)||cash.network!==null||cash.wallet_scope!=='FUNDING'||
  normalizedBankAccount(cash.iban_or_account_no)!==evidence.nostroAccount)
  fault('CHECKOUT_IP_ACCOUNT','nostroCashAccountId',409);
 const receiving=(await db.query(`SELECT a.account_id FROM avis_core_v2.ledger_accounts a
  JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=a.account_id
  WHERE a.account_id=$1 AND a.currency_code=$2 AND a.owner_type=ANY($3::text[])
   AND a.account_category='LIABILITY' AND a.network IS NULL AND a.wallet_scope='FUNDING'
   AND b.abiq_iban=$4 AND b.status='ACTIVE'`,[route.receivingAccountId,evidence.currency,RECEIVING_OWNERS,route.receivingAbiqIban])).rows[0];
 if(!receiving||receiving.account_id===cash.ledger_account_id)fault('CHECKOUT_IP_ACCOUNT','receivingAccountId',409);
 const duplicate=(await db.query(`SELECT 1 FROM avis_core_v2.checkout_ip_settlements
  WHERE (cash_account_id=$1 AND bank_transaction_id=$2) OR handler_journal_id=$3
  UNION ALL SELECT 1 FROM avis_core_v2.nostro_manual_mirrors WHERE cash_account_id=$1 AND external_reference=$2
  UNION ALL SELECT 1 FROM avis_core_v2.interbank_ip_transfers WHERE cash_account_id=$1 AND bank_reference=$2 AND iso_status='ACCC'
  LIMIT 1`,[cash.cash_account_id,evidence.bankTransactionId,evidence.journalId])).rows[0];
 if(duplicate)fault('NOSTRO_ALREADY_SETTLED','settlementEvidence.bankTransactionId',409);
 const retained=(await db.query(`SELECT e.direction,e.amount::text,e.transfer_id,s.currency_code
  FROM avis_core_v2.clearing_statement_entries e JOIN avis_core_v2.clearing_statements s USING(statement_id)
  WHERE s.cash_account_id=$1 AND e.bank_reference=$2`,[cash.cash_account_id,evidence.bankTransactionId])).rows;
 if(retained.some(entry=>entry.transfer_id))fault('NOSTRO_ALREADY_SETTLED','settlementEvidence.bankTransactionId',409);
 if(retained.some(entry=>entry.direction!=='CREDIT'||entry.currency_code!==evidence.currency||money(entry.amount)!==money(evidence.amount)))
  fault('STATEMENT_MATCH_FAILED','settlementEvidence',409);
 // This journal is owned by the core. The handler's journal UUID is audit
 // evidence only; the immutable approved claim supplies both core accounts.
 const journalId=await new SovereignCore(null).post(db,actor,'checkout-ip:'+request.request_id,'CHECKOUT_IP_INCOMING_SETTLED',evidence.bankTransactionId,[
  {accountId:cash.ledger_account_id,direction:'DEBIT',amount:evidence.amount},
  {accountId:receiving.account_id,direction:'CREDIT',amount:evidence.amount}
 ]);
 const row=(await db.query(`INSERT INTO avis_core_v2.checkout_ip_settlements(request_id,journal_id,handler_journal_id,cash_account_id,
  receiving_account_id,bank_transaction_id,statement_id,currency_code,amount,nostro_account,statement_hash,booked_at,booked_date,
  evidence_snapshot,evidence_fingerprint,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16) RETURNING *`,
  [request.request_id,journalId,evidence.journalId,cash.cash_account_id,receiving.account_id,evidence.bankTransactionId,evidence.statementId,
   evidence.currency,evidence.amount,evidence.nostroAccount,evidence.statementHash,evidence.bookedAt,evidence.bookedDate,
   JSON.stringify(evidence),fingerprint(evidence),actor.id])).rows[0];
 await db.query('INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,$2,$3)',
  [actor.id,'CHECKOUT_IP_INCOMING_SETTLED',journalId]);
 return mapSettlement(row);
}
