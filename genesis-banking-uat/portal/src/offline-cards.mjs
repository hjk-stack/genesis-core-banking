import {createPublicKey,createPrivateKey,verify,sign,createHash,randomUUID} from 'node:crypto';
import {PaymentServer} from './payments.mjs';
import {fault,money,decimal,text} from './core.mjs';
const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
export const signedBytes=v=>Buffer.from(JSON.stringify(sorted(v)));
function publicKey(pem){let key;try{key=pem?.type==='public'?pem:createPublicKey(pem);}catch{fault('INVALID_SIGNING_KEY','publicKey');}if(key.asymmetricKeyType!=='ed25519'&&!(key.asymmetricKeyType==='ec'&&key.asymmetricKeyDetails?.namedCurve==='prime256v1'))fault('INVALID_SIGNING_KEY','publicKey');return key;}
const algorithm=key=>key.asymmetricKeyType==='ed25519'?null:'sha256';
function verified(payload,signature,pem){const key=publicKey(pem);return typeof signature==='string'&&signature.length<512&&verify(algorithm(key),signedBytes(payload),key,Buffer.from(signature,'base64'));}
const line=(accountId,direction,amount)=>({accountId,direction,amount});
export class CardPaymentServer extends PaymentServer {
 constructor(pool,{signAllowance}={}){super(pool);this.signAllowance=signAllowance||function(payload){const privateKey=createPrivateKey(process.env.AVIS_OFFLINE_SIGNING_KEY||'');const key=publicKey(createPublicKey(privateKey));return {payload,signature:sign(algorithm(key),signedBytes(payload),privateKey).toString('base64'),publicKey:key.export({type:'spki',format:'pem'})};};}
 async configureOffline(actor,input,key){
  const pem=publicKey(input.publicKey).export({type:'spki',format:'pem'});
  if(!['CARD','TERMINAL'].includes(input.kind))fault('INVALID_FIELD','kind');
  return this.operation(actor,'CONFIGURE_OFFLINE_CARD',input,key,async db=>{
   let result;
   if(input.kind==='CARD')result=await db.query(`UPDATE avis_core_v2.avis_cards c SET offline_public_key_pem=$2 WHERE core_bank_card_ref=$1 AND status='ACTIVE' AND card_rail_mode<>'GLOBAL_SCHEME_ONLY' AND NOT EXISTS(SELECT 1 FROM avis_core_v2.offline_card_grants g WHERE g.card_id=c.card_id AND g.status='ACTIVE') RETURNING card_id AS id`,[input.reference,pem]);
   else result=await db.query(`UPDATE avis_core_v2.pos_terminals SET terminal_public_key_pem=$2,offline_enabled=true,offline_floor_limit_eur=$3,offline_batch_cap_eur=$4 WHERE terminal_id=$1 AND status='ACTIVE' RETURNING terminal_id AS id`,[input.reference,pem,decimal(money(input.floorLimit,6),6),decimal(money(input.batchCap,6),6)]);
   if(!result.rows.length)fault('OFFLINE_KEY_NOT_UPDATED','reference');return result.rows[0];
  });
 }
 async issueOfflineAllowance(actor,input,key){
  const amount=decimal(money(input.amount,6),6),expiry=Date.parse(input.expiresAt),now=Date.now();
  if(!Number.isFinite(expiry)||expiry<=now||expiry>now+7*86400000)fault('INVALID_FIELD','expiresAt');
  if(!Number.isInteger(input.maxTransactions)||input.maxTransactions<1||input.maxTransactions>5000)fault('INVALID_FIELD','maxTransactions');
  return this.operation(actor,'ISSUE_OFFLINE_ALLOWANCE',input,key,async(db,k)=>{
   const card=(await db.query(`SELECT c.*,COALESCE(c.stored_value_account_id,c.funding_account_id) AS funding_account_id,a.currency_code FROM avis_core_v2.avis_cards c JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.funding_account_id WHERE core_bank_card_ref=$1 AND c.status='ACTIVE' AND (c.expires_at IS NULL OR c.expires_at>now()) AND card_rail_mode<>'GLOBAL_SCHEME_ONLY' FOR UPDATE OF c`,[input.cardReference])).rows[0];
   if(!card?.offline_public_key_pem||card.currency_code!=='EUR')fault('OFFLINE_CARD_REQUIRED','cardReference');
   const id=randomUUID(),issuedAt=new Date(now).toISOString(),expiresAt=new Date(expiry).toISOString(),settleBy=new Date(expiry+2*86400000).toISOString();
   const payload={protocol:'AVIS_OFFLINE_V1',grantId:id,cardToken:card.core_bank_card_ref,amount,currency:'EUR',maxTransactions:input.maxTransactions,issuedAt,expiresAt,settleBy};
   let allowance;try{allowance=await this.signAllowance(payload);}catch{fault('OFFLINE_ISSUER_KEY','publicKey',503);}
   if(!allowance||!verified(payload,allowance.signature,allowance.publicKey))fault('OFFLINE_ISSUER_KEY');
   const hold=await this.system(db,'SUSPENSE_CARD_FX','EUR',id),journalId=await this.post(db,actor,k,'OFFLINE_ALLOWANCE',id,[line(card.funding_account_id,'DEBIT',amount),line(hold,'CREDIT',amount)]);
   await db.query(`INSERT INTO avis_core_v2.offline_card_grants(grant_id,card_id,allowance,max_transactions,issued_at,expires_at,settle_by,signed_allowance,hold_journal_id,debit_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,card.card_id,amount,input.maxTransactions,issuedAt,expiresAt,settleBy,JSON.stringify(allowance),journalId,card.funding_account_id]);
   return {id,journalId,allowance};
  });
 }
 async settleOfflineBatch(actor,input,key){
  if(!/^[0-9a-f-]{36}$/i.test(input.batchId)||!Array.isArray(input.transactions)||!input.transactions.length||input.transactions.length>500)fault('INVALID_FIELD','transactions');
  const payload={batchId:input.batchId,terminalId:input.terminalId,transactions:input.transactions};
  return this.operation(actor,'SETTLE_OFFLINE_BATCH',input,key,async(db,k)=>{
   const terminal=(await db.query(`SELECT t.*,m.owner_user_id,m.commission_rate_bps FROM avis_core_v2.pos_terminals t JOIN avis_core_v2.marketplace_merchants m USING(merchant_id) WHERE terminal_id=$1 AND t.status='ACTIVE' AND t.offline_enabled AND m.status='ACTIVE' FOR SHARE OF t,m`,[input.terminalId])).rows[0];
   if(!terminal||!verified(payload,input.terminalSignature,terminal.terminal_public_key_pem))fault('INVALID_TERMINAL_SIGNATURE','terminalSignature');
   await db.query('SELECT card_id FROM avis_core_v2.avis_cards WHERE core_bank_card_ref=ANY($1::text[]) ORDER BY card_id FOR UPDATE',[input.transactions.map(tx=>tx.cardToken)]);
   let total=0n,settled=0,duplicates=0;
   for(const tx of input.transactions){
    const amount=money(tx.amount,6);total+=amount;if(amount>money(terminal.offline_floor_limit_eur,6)||total>money(terminal.offline_batch_cap_eur,6))fault('OFFLINE_LIMIT_EXCEEDED','amount');
    if(!Number.isInteger(tx.atc)||tx.atc<1||tx.atc>65535||tx.terminalId!==input.terminalId||tx.currency!=='EUR')fault('INVALID_OFFLINE_TRANSACTION','transactions');
    text(tx.nonce,'nonce',64);const {signature,...cardPayload}=tx;
    const card=(await db.query(`SELECT * FROM avis_core_v2.avis_cards WHERE core_bank_card_ref=$1 AND status='ACTIVE' FOR UPDATE`,[tx.cardToken])).rows[0];
    if(!card||!verified(cardPayload,signature,card.offline_public_key_pem))fault('INVALID_CARD_SIGNATURE','transactions');
    const hash=createHash('sha256').update(signedBytes(cardPayload)).digest('hex');
    const previous=(await db.query('SELECT payload_hash FROM avis_core_v2.pos_offline_saf_transactions WHERE card_id=$1 AND atc=$2',[card.card_id,tx.atc])).rows[0];
    if(previous){if(previous.payload_hash!==hash)fault('OFFLINE_COUNTER_CONFLICT','atc');duplicates++;continue;}
    const grant=(await db.query(`SELECT * FROM avis_core_v2.offline_card_grants WHERE grant_id=$1 AND card_id=$2 AND status='ACTIVE' FOR UPDATE`,[tx.grantId,card.card_id])).rows[0];
    const timestamp=Date.parse(tx.timestamp);
    if(!grant||!Number.isFinite(timestamp)||timestamp<new Date(grant.issued_at).getTime()||timestamp>new Date(grant.expires_at).getTime()||timestamp>Date.now()+30000||Date.now()>new Date(grant.settle_by).getTime())fault('OFFLINE_GRANT_EXPIRED','grantId');
    const spent=/^0(?:\.0+)?$/.test(grant.spent)?0n:money(grant.spent,6);
    if(spent+amount>money(grant.allowance,6)||grant.used_transactions>=grant.max_transactions)fault('OFFLINE_LIMIT_EXCEEDED','amount');
    const fee=(amount*BigInt(terminal.commission_rate_bps)+5000n)/10000n,hold=await this.system(db,'SUSPENSE_CARD_FX','EUR',grant.grant_id),lines=[line(hold,'DEBIT',decimal(amount,6))];
    if(amount>fee)lines.push(line(await this.userFunding(db,terminal.owner_user_id,'EUR'),'CREDIT',decimal(amount-fee,6)));
    if(fee)lines.push(line(await this.system(db,'REVENUE','EUR','POS_OFFLINE_FEES','REVENUE'),'CREDIT',decimal(fee,6)));
    const journalId=await this.post(db,actor,k+':'+settled,'POS_OFFLINE_SAF_SETTLEMENT',input.batchId,lines);
    await db.query(`INSERT INTO avis_core_v2.pos_offline_saf_transactions(batch_id,terminal_id,card_id,grant_id,atc,payload_hash,amount_eur,offline_timestamp,journal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[input.batchId,input.terminalId,card.card_id,grant.grant_id,tx.atc,hash,decimal(amount,6),tx.timestamp,journalId]);
    await db.query('UPDATE avis_core_v2.offline_card_grants SET spent=spent+$2::numeric,used_transactions=used_transactions+1 WHERE grant_id=$1',[grant.grant_id,decimal(amount,6)]);settled++;
   }
   await db.query('UPDATE avis_core_v2.pos_terminals SET last_heartbeat_at=now() WHERE terminal_id=$1',[input.terminalId]);
   return {id:input.batchId,settled,duplicates};
  });
 }
 async closeOfflineAllowance(actor,input,key){
  return this.operation(actor,'CLOSE_OFFLINE_ALLOWANCE',input,key,async(db,k)=>{
   const g=(await db.query(`SELECT g.*,COALESCE(g.debit_account_id,c.funding_account_id) AS funding_account_id FROM avis_core_v2.offline_card_grants g JOIN avis_core_v2.avis_cards c USING(card_id) WHERE grant_id=$1 FOR UPDATE OF g`,[input.grantId])).rows[0];
   if(!g||g.status!=='ACTIVE'||Date.now()<=new Date(g.settle_by).getTime())fault('OFFLINE_SETTLEMENT_WINDOW','grantId');
   const spent=/^0(?:\.0+)?$/.test(g.spent)?0n:money(g.spent,6),remaining=money(g.allowance,6)-spent;let journalId=null;
   if(remaining)journalId=await this.post(db,actor,k,'OFFLINE_ALLOWANCE_RELEASE',g.grant_id,[line(await this.system(db,'SUSPENSE_CARD_FX','EUR',g.grant_id),'DEBIT',decimal(remaining,6)),line(g.funding_account_id,'CREDIT',decimal(remaining,6))]);
   await db.query("UPDATE avis_core_v2.offline_card_grants SET status='CLOSED' WHERE grant_id=$1",[g.grant_id]);return {id:g.grant_id,journalId};
  });
 }
 async list(actor,view){
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  if(view==='offlinegrants')return (await this.pool.query(`SELECT g.grant_id,c.last_four_digits,g.allowance::text,g.spent::text,g.max_transactions,g.used_transactions,g.expires_at,g.settle_by,g.status FROM avis_core_v2.offline_card_grants g JOIN avis_core_v2.avis_cards c USING(card_id) ORDER BY issued_at DESC LIMIT 300`)).rows;
  return super.list(actor,view);
 }
}
