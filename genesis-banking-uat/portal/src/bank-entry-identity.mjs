import {fault} from './core.mjs';

// All paths that can book a handler-confirmed bank entry use the same lock.
// Its identity excludes amount/date so a changed payload cannot evade deduplication.
export async function lockBankEntry(db,cashAccountId,bankReference){
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
  'bank-entry:'+cashAccountId+':'+bankReference
 ]);
}

export async function assertNoCheckoutBankEntry(db,cashAccountId,bankReference,field='bankReference'){
 if(!bankReference)return;
 await lockBankEntry(db,cashAccountId,bankReference);
 if((await db.query(`SELECT request_id FROM avis_core_v2.checkout_ip_settlements
  WHERE cash_account_id=$1 AND bank_transaction_id=$2`,[cashAccountId,bankReference])).rows.length)
  fault('NOSTRO_ALREADY_SETTLED',field,409);
}
