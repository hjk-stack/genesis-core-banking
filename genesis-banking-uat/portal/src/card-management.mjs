import {randomUUID,randomBytes,randomInt,scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {TransferMethods} from './transfer-methods.mjs';
import {fault,text,money,decimal} from './core.mjs';
import {fingerprint} from './transfer-secrets.mjs';
import {sharedCardAccount,CARD_PRODUCTS} from './card-accounts.mjs';
const derive=promisify(scrypt),entry=(accountId,direction,amount)=>({accountId,direction,amount});
export class CardManagement extends TransferMethods {
 async issueManagedCard(actor,input,key){
  if(!Object.hasOwn(CARD_PRODUCTS,input.product))fault('INVALID_FIELD','product');
  const expiresAt=input.expiresAt?new Date(input.expiresAt):new Date(Date.now()+3*365*86400000);
  if(!Number.isFinite(expiresAt.getTime())||expiresAt.getTime()<=Date.now())fault('INVALID_CARD_EXPIRY','expiresAt');
  return this.operation(actor,'ISSUE_MANAGED_CARD',input,key,async db=>{
   const source=await this.route(db,input.from,input.currency,'from'),purse=await sharedCardAccount(this,db,source.user_id,input.currency);
   const id=randomUUID(),digits=Array.from({length:16},()=>randomInt(10)).join(''),number='AVIS-'+digits;
   await db.query(`INSERT INTO avis_core_v2.avis_cards(card_id,user_id,core_bank_card_ref,card_type,last_four_digits,status,card_rail_mode,funding_account_id,stored_value_account_id,card_product,display_number,issued_at,expires_at)
    VALUES($1,$2,$3,'PREPAID',$4,'ACTIVE','AVIS_PROPRIETARY_ONLY',$5,$6,$7,$8,now(),$9)`,[id,source.user_id,'AVIS-'+randomBytes(24).toString('base64url'),digits.slice(-4),source.ledger_account_id,purse,input.product,number,expiresAt.toISOString()]);
   return {id,accountId:purse,number,product:input.product};
  });
 }
 async loadManagedCard(actor,input,key){
  const amount=decimal(money(input.amount));text(input.reference,'reference');
  return this.operation(actor,'LOAD_CARD_ACCOUNT',input,key,async(db,k)=>{
   const from=await this.route(db,input.from,input.currency,'from');
   const card=(await db.query(`SELECT c.*,a.currency_code FROM avis_core_v2.avis_cards c JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.funding_account_id
    WHERE c.card_id=$1 AND c.user_id=$2 AND c.status='ACTIVE' AND c.card_rail_mode<>'GLOBAL_SCHEME_ONLY' AND (c.expires_at IS NULL OR c.expires_at>now()) FOR UPDATE OF c`,[input.cardId,from.user_id])).rows[0];
   if(!card)fault('SELECT_AVIS_CARD','cardId');if(card.currency_code!==input.currency)fault('CURRENCY_MISMATCH','cardId');
   if(!new RegExp(input.currency==='JPY'?'^[0-9]{1,18}$':'^[0-9]{1,18}(\\.[0-9]{1,2})?$').test(input.amount))fault('INVALID_AMOUNT','amount');
   const purse=card.stored_value_account_id||await sharedCardAccount(this,db,from.user_id,input.currency);
   if(purse===from.ledger_account_id)fault('SAME_ACCOUNT','from');
   await db.query('UPDATE avis_core_v2.avis_cards SET stored_value_account_id=$2 WHERE card_id=$1',[card.card_id,purse]);
   return {id:card.card_id,journalId:await this.post(db,actor,k,'CARD_ACCOUNT_LOADED',input.reference,[entry(from.ledger_account_id,'DEBIT',amount),entry(purse,'CREDIT',amount)])};
  });
 }
 async setCardStatus(actor,input,key){
  if(!['ACTIVE','BLOCKED'].includes(input.status))fault('INVALID_FIELD','status');
  return this.operation(actor,'SET_CARD_STATUS',input,key,async db=>{
   const c=(await db.query('SELECT card_id,expires_at FROM avis_core_v2.avis_cards WHERE card_id=$1 FOR UPDATE',[input.cardId])).rows[0];
   if(!c)fault('SELECT_AVIS_CARD','cardId');
   if(input.status==='ACTIVE'&&c.expires_at&&new Date(c.expires_at)<=new Date())fault('INVALID_CARD_EXPIRY','cardId');
   await db.query('UPDATE avis_core_v2.avis_cards SET status=$2 WHERE card_id=$1',[input.cardId,input.status]);return {id:input.cardId,status:input.status};
  });
 }
 async resetCardPin(actor,input,key){
  if(!/^\d{4,6}$/.test(input.pin||''))fault('INVALID_CARD_PIN','pin');
  const safe={cardId:input.cardId,pinFingerprint:fingerprint('pin:'+input.cardId+':'+input.pin,this.secretEnv)};
  return this.operation(actor,'RESET_CARD_PIN',safe,key,async db=>{
   const salt=randomBytes(32).toString('hex'),digest=(await derive(input.pin,salt,64)).toString('hex');
   const changed=await db.query('UPDATE avis_core_v2.avis_cards SET pin_salt=$2,pin_hash=$3,pin_updated_at=now() WHERE card_id=$1 RETURNING card_id',[input.cardId,salt,digest]);
   if(!changed.rows.length)fault('SELECT_AVIS_CARD','cardId');return {id:input.cardId};
  });
 }
 async cardRows(userId=null){
  return (await this.pool.query(`SELECT c.card_id,c.user_id,u.full_name,c.last_four_digits,c.card_type,c.card_product,c.card_rail_mode,c.status,
   COALESCE(c.display_number,'Card ending '||c.last_four_digits) AS card_number,c.issued_at,c.expires_at,c.pin_updated_at,
   COALESCE(c.stored_value_account_id,c.funding_account_id) AS card_account_id,a.currency_code,a.available_balance::text,a.locked_balance::text,
   COALESCE((SELECT sum(g.amount) FROM avis_core_v2.coded_card_debits g WHERE g.card_id=c.card_id AND g.status IN ('ACTIVE','LOCKED')),0)::text AS offline_reserved
   FROM avis_core_v2.avis_cards c JOIN avis_core_v2.sovereign_users u USING(user_id)
   JOIN avis_core_v2.ledger_accounts a ON a.account_id=COALESCE(c.stored_value_account_id,c.funding_account_id)
   WHERE ($1::bigint IS NULL OR c.user_id=$1) ORDER BY c.user_id,c.created_at,c.card_id LIMIT 1000`,[userId])).rows;
 }
 async managedCardDetails(actor,input){
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  const rows=await this.cardRows(actor.customerUserId||null),card=rows.find(c=>c.card_id===input.cardId);
  if(!card)fault('SELECT_AVIS_CARD','cardId',404);
  const entries=(await this.pool.query(`SELECT e.entry_id,e.direction,e.amount::text,e.running_balance::text,j.created_at,j.event_type,j.reference_id
   FROM avis_core_v2.ledger_entries e JOIN avis_core_v2.ledger_journals j USING(journal_id) WHERE account_id=$1 ORDER BY e.entry_id DESC LIMIT 300`,[card.card_account_id])).rows;
  const totals=(await this.pool.query(`SELECT COALESCE(sum(amount) FILTER(WHERE direction='CREDIT'),0)::text AS incoming,COALESCE(sum(amount) FILTER(WHERE direction='DEBIT'),0)::text AS outgoing FROM avis_core_v2.ledger_entries WHERE account_id=$1`,[card.card_account_id])).rows[0];
  return {card,cards:rows.filter(c=>c.card_account_id===card.card_account_id),entries,totals};
 }
 async managedCardDelivery(actor,input,key){
  await this.operation(actor,'VIEW_MANAGED_CARD_DELIVERY',{cardId:input.cardId},key,async db=>{
   const c=(await db.query('SELECT card_id FROM avis_core_v2.avis_cards WHERE card_id=$1',[input.cardId])).rows[0];if(!c)fault('SELECT_AVIS_CARD','cardId');return {id:c.card_id};
  });
  const c=(await this.pool.query(`SELECT c.core_bank_card_ref AS "cardReference",c.display_number AS "cardNumber",c.card_product AS product,c.expires_at AS "expiresAt",u.full_name AS holder,a.currency_code AS currency,a.available_balance::text AS amount FROM avis_core_v2.avis_cards c JOIN avis_core_v2.sovereign_users u USING(user_id) JOIN avis_core_v2.ledger_accounts a ON a.account_id=COALESCE(c.stored_value_account_id,c.funding_account_id) WHERE card_id=$1`,[input.cardId])).rows[0];return c;
 }
 async moveToSuspense(actor,input,key){
  const amount=decimal(money(input.amount));text(input.reference,'reference');
  return this.operation(actor,'MOVE_TO_SUSPENSE',input,key,async(db,k)=>{
   const source=await this.route(db,input.from,input.currency,'from'),hold=await this.system(db,'SUSPENSE_INBOUND',input.currency,'REVIEW:'+source.user_id);
   return {journalId:await this.post(db,actor,k,'ACCOUNT_SUSPENSE',input.reference,[entry(source.ledger_account_id,'DEBIT',amount),entry(hold,'CREDIT',amount)])};
  });
 }
 async bindCustomerLogin(actor,input,key){
  if(!/^\d{1,16}$/.test(input.fineractUserId||''))fault('INVALID_FIELD','fineractUserId');
  return this.operation(actor,'BIND_CUSTOMER_LOGIN',input,key,async db=>{
   const u=(await db.query("SELECT user_id FROM avis_core_v2.sovereign_users WHERE user_id=$1 AND account_role='CUSTOMER'",[input.userId])).rows[0];
   if(!u)fault('ABIQ_CUSTOMER_NOT_FOUND','userId');
   const principal='fineract:'+input.fineractUserId,existing=(await db.query('SELECT user_id FROM avis_core_v2.customer_logins WHERE principal_id=$1',[principal])).rows[0];
   if(existing&&String(existing.user_id)!==String(u.user_id))fault('IDENTITY_ALREADY_BOUND','fineractUserId');
   await db.query('INSERT INTO avis_core_v2.customer_logins(principal_id,user_id,created_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[principal,u.user_id,actor.id]);return {userId:String(u.user_id)};
  });
 }
 async sellCrypto(actor,input,key){
  const quantity=money(input.quantity);text(input.reference,'reference');
  return this.operation(actor,'SELL_CRYPTO',input,key,async(db,k)=>{
   const offer=(await db.query(`SELECT o.*,s.currency_code AS asset,s.network,s.user_id AS seller_id,p.currency_code AS fiat FROM avis_core_v2.crypto_sale_offers o JOIN avis_core_v2.ledger_accounts s ON s.account_id=o.stock_account_id JOIN avis_core_v2.ledger_accounts p ON p.account_id=o.proceeds_account_id WHERE offer_id=$1 AND is_active FOR SHARE OF o`,[input.offerId])).rows[0];
   if(!offer)fault('CRYPTO_OFFER_REQUIRED','offerId');if(money(input.unitPrice)!==money(offer.unit_price))fault('CRYPTO_PRICE_CHANGED','offerId');
   const to=await this.route(db,input.to,offer.fiat,'to'),holding=(await db.query("SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1 AND owner_type='USER' AND wallet_scope='FUNDING' AND account_category='LIABILITY' AND user_id=$2 AND currency_code=$3 AND network=$4",[input.cryptoAccount,to.user_id,offer.asset,offer.network])).rows[0];
   if(!holding)fault('CRYPTO_HOLDING_REQUIRED','cryptoAccount');if(String(to.user_id)===String(offer.seller_id))fault('SAME_ACCOUNT','to');
   // User-authorised robot allocations and all other reservations must remain
   // unavailable to ordinary conversion/sale flows until released.
   const spendable=(await db.query(`SELECT account_id FROM avis_core_v2.ledger_accounts
    WHERE account_id=$1 AND available_balance-locked_balance>=$2::numeric FOR UPDATE`,
    [holding.account_id,decimal(quantity)])).rows;
   if(!spendable.length)fault('INSUFFICIENT_FUNDS','quantity');

   const quantum=offer.fiat==='JPY'?10n**18n:10n**16n,total=(quantity*money(offer.unit_price)/(10n**18n*quantum))*quantum;
   if(total<=0n||money(input.total)!==total)fault('CRYPTO_PRICE_CHANGED','total');
   const journalId=await this.post(db,actor,k,'CRYPTO_SALE',input.reference,[entry(holding.account_id,'DEBIT',decimal(quantity)),entry(offer.stock_account_id,'CREDIT',decimal(quantity)),entry(offer.proceeds_account_id,'DEBIT',decimal(total)),entry(to.ledger_account_id,'CREDIT',decimal(total))]);
   return {journalId,quantity:decimal(quantity),total:decimal(total),currency:offer.fiat};
  });
 }
 async list(actor,view){
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  if(['cards','transfercards','cardaccounts'].includes(view)){
   const rows=await this.cardRows(actor.customerUserId||null);
   if(view==='transfercards')return rows.filter(c=>c.status==='ACTIVE'&&(!c.expires_at||Date.parse(c.expires_at)>Date.now()));
   if(view==='cardaccounts')return [...new Map(rows.map(c=>[c.card_account_id,{account_id:c.card_account_id,user_id:c.user_id,full_name:c.full_name,currency_code:c.currency_code,available_balance:c.available_balance,cards:rows.filter(x=>x.card_account_id===c.card_account_id)}])).values()];
   return rows;
  }
  return super.list(actor,view);
 }
}
