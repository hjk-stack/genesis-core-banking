import {fault} from './core.mjs';
export const CARD_PRODUCTS={VIRTUAL:'Virtual',STANDARD_BUSINESS:'Standard - Business',GOLD_STANDARD:'Gold Card Standard',BLACK_VIP:'Black VIP Card',GOLD_METAL:'Gold Card Metal',GOLD_DIAMOND:'Gold Diamond'};
export async function sharedCardAccount(core,db,userId,currency){
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['card-account:'+userId+':'+currency]);
 const known=(await db.query('SELECT account_id FROM avis_core_v2.managed_card_accounts WHERE user_id=$1 AND currency_code=$2',[userId,currency])).rows[0];
 if(known)return known.account_id;
 // Adopt an existing purse without moving money; older distinct purses remain intact.
 const previous=(await db.query(`SELECT c.stored_value_account_id AS account_id FROM avis_core_v2.avis_cards c
  JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.stored_value_account_id WHERE c.user_id=$1 AND a.currency_code=$2
  AND a.user_id=c.user_id AND a.owner_type='USER' AND a.account_category='LIABILITY' AND a.network IS NULL
  ORDER BY c.created_at,c.card_id LIMIT 1`,[userId,currency])).rows[0];
 const accountId=previous?.account_id||await core.networkAccount(db,'USER',currency,null,'CARDS',userId);
 await db.query('INSERT INTO avis_core_v2.managed_card_accounts(user_id,currency_code,account_id) VALUES($1,$2,$3)',[userId,currency,accountId]);
 return accountId;
}
export function codeWindow(input,now=Date.now()){
 const start=input.codeStart?Date.parse(input.codeStart):now,end=input.codeEnd?Date.parse(input.codeEnd):start+48*3600000;
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end<=now||end-start>48*3600000)fault('INVALID_CODE_WINDOW','codeEnd');
 return {validFrom:new Date(start).toISOString(),expiresAt:new Date(end).toISOString()};
}
