import {createHash,randomUUID} from 'node:crypto';
import {ABIQ_PARTITIONS,ABIQ_ISSUER,provisionAbiqAccounts,resolveAbiqAccount} from './avispay-core-accounts.mjs';

export function fault(code,field,status=422) {throw Object.assign(new Error(code),{code,field,status});}
export function text(value,field,max=128) {
 if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\x00-\x1f\x7f]/.test(value)) fault('INVALID_FIELD',field);
 return value.trim();
}
export function money(value,scale=18) {
 if(typeof value!=='string'||!new RegExp('^[0-9]{1,18}(\\.[0-9]{1,'+scale+'})?$').test(value)) fault('INVALID_AMOUNT','amount');
 const [whole,fraction='']=value.split('.'); const n=BigInt(whole)*10n**BigInt(scale)+BigInt(fraction.padEnd(scale,'0'));
 if(n<=0n) fault('INVALID_AMOUNT','amount'); return n;
}
export function decimal(n,scale=18) {const s=(n<0n?-n:n).toString().padStart(scale+1,'0');return (n<0n?'-':'')+s.slice(0,-scale)+'.'+s.slice(-scale);}
const side=(accountId,direction,amount)=>({accountId,direction,amount});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export class SovereignCore {
 constructor(pool) {this.pool=pool;}
 async operation(actor,operation,input,key,work) {
  if(!actor?.admin||!actor.id) fault('FORBIDDEN',null,403);
  text(key,'idempotencyKey');
  const operationKey=hash([actor.id,operation,key]);
  const client=await this.pool.connect();
  try {
   await client.query('BEGIN');
   await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['operation:'+operationKey]);
   const existing=(await client.query('SELECT request,response FROM avis_core_v2.operation_requests WHERE operation_key=$1',[operationKey])).rows[0];
   if(existing) {
    if(hash(existing.request)!==hash(input)) fault('IDEMPOTENCY_CONFLICT','idempotencyKey',409);
    await client.query('COMMIT'); return existing.response;
   }
   const response=await work(client,operationKey);
   await client.query('INSERT INTO avis_core_v2.operation_requests(operation_key,actor_id,operation,request,response) VALUES($1,$2,$3,$4,$5)',[operationKey,actor.id,operation,JSON.stringify(input),JSON.stringify(response)]);
   await client.query('INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,$2,$3)',[actor.id,operation,response.id??response.journalId??response.userId??operationKey]);
   await client.query('COMMIT');return response;
  } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
 }
 async post(db,actor,key,event,reference,lines,reverses=null) {
  return (await db.query('SELECT avis_core_v2.post_journal($1,$2,$3,$4,$5::jsonb,$6::uuid) AS id',
   [key,event,reference,actor.id,JSON.stringify(lines),reverses])).rows[0].id;
 }
 async system(db,owner,currency,bucket='MAIN',category='LIABILITY') {
  await db.query(`INSERT INTO avis_core_v2.ledger_accounts(owner_type,sub_account_code,currency_code,account_category)
   VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[owner,bucket,currency,category]);
  return (await db.query(`SELECT account_id FROM avis_core_v2.ledger_accounts WHERE owner_type=$1 AND sub_account_code=$2
   AND currency_code=$3 AND network IS NULL AND wallet_scope='FUNDING'`,[owner,bucket,currency])).rows[0].account_id;
 }
 async route(db,identifier,currency,field='account') {
  const r=await resolveAbiqAccount(db,{identifier,currency}); if(!r)fault('ACCOUNT_NOT_FOUND',field,404);return r;
 }
 async userFunding(db,userId,currency) {
  const rows=(await db.query(`SELECT b.ledger_account_id FROM avis_core_v2.abiq_routing_bridge b
   JOIN avis_core_v2.abiq_network_participants p USING(participant_code) WHERE b.user_id=$1 AND b.currency_code=$2
   AND b.participant_code IN ('AVIP','AVIS') AND b.status='ACTIVE' AND p.is_active
   ORDER BY (b.participant_code='AVIS') DESC LIMIT 1`,[userId,currency])).rows;
  if(rows.length!==1)fault('ACCOUNT_NOT_FOUND','ownerUserId',404);return rows[0].ledger_account_id;
 }
 async openCustomer(actor,input,key) {
  const name=text(input.fullName,'fullName',120);
  if(!['PERSONAL','BUSINESS'].includes(input.accountType))fault('INVALID_FIELD','accountType');
  const currencies=input.currencies;
  if(!Array.isArray(currencies)||currencies.length===0||currencies.length>14||currencies.some(c=>!Object.hasOwn(ABIQ_PARTITIONS,c)))fault('INVALID_FIELD','currencies');
  const node=input.participantCode||ABIQ_ISSUER.participantCode;
  return this.operation(actor,'OPEN_CUSTOMER',input,key,async(db,k)=>{
   const id=String((await db.query("SELECT nextval('avis_core_v2.sovereign_user_ids') AS id")).rows[0].id);
   const identifier='AVIP-'+id.padStart(14,'0');
   await db.query(`INSERT INTO avis_core_v2.sovereign_users(user_id,avis_account_no,full_name,account_type)
    VALUES($1,$2,$3,$4)`,[id,identifier,name,input.accountType]);
   const accounts=await provisionAbiqAccounts(db,{userId:id,participantCode:node,currencies,idempotencyKey:k});
   await db.query('UPDATE avis_core_v2.sovereign_users SET avis_account_no=$2 WHERE user_id=$1',[id,accounts[0].abiqIban]);
   for(const currency of new Set(currencies)) for(const scope of ['MARGIN','CUSTODY'])
    await db.query(`INSERT INTO avis_core_v2.ledger_accounts(owner_type,user_id,sub_account_code,currency_code,wallet_scope,account_category)
     VALUES('USER',$1,$2,$3,$4,'LIABILITY') ON CONFLICT DO NOTHING`,[id,'ABIQ:'+node,currency,scope]);
   // Connector work is asynchronous and cannot veto sovereign account creation.
   await db.query(`INSERT INTO avis_core_v2.user_external_connectors(user_id,connector_code)
    SELECT $1,connector_code FROM avis_core_v2.platform_connectors WHERE is_enabled AND auto_provision ON CONFLICT DO NOTHING`,[id]);
   await db.query(`INSERT INTO avis_core_v2.connector_outbox(user_id,connector_code,event_type,payload)
    SELECT $1::bigint,connector_code,'CUSTOMER_CREATED',jsonb_build_object('userId',($1::bigint)::text)
    FROM avis_core_v2.platform_connectors WHERE is_enabled AND auto_provision ON CONFLICT DO NOTHING`,[id]);
   return {userId:id,fullName:name,accountType:input.accountType,accounts};
  });
 }
 async addCurrencies(actor,input,key) {
  return this.operation(actor,'ADD_CURRENCIES',input,key,async(db,k)=>{
   const node=input.participantCode||ABIQ_ISSUER.participantCode;
   const accounts=await provisionAbiqAccounts(db,{userId:input.userId,participantCode:node,currencies:input.currencies,idempotencyKey:k});
   for(const a of accounts)for(const scope of ['MARGIN','CUSTODY'])
    await db.query(`INSERT INTO avis_core_v2.ledger_accounts(owner_type,user_id,sub_account_code,currency_code,wallet_scope,account_category)
     VALUES('USER',$1,$2,$3,$4,'LIABILITY') ON CONFLICT DO NOTHING`,[input.userId,'ABIQ:'+node,a.currency,scope]);
   return {userId:String(input.userId),accounts};
  });
 }
 async transfer(actor,input,key) {
  const amount=decimal(money(input.amount));text(input.reference,'reference');
  return this.operation(actor,'ABIQ_TRANSFER',input,key,async(db,k)=>{
   const from=await this.route(db,input.from,input.currency,'from'); const to=await this.route(db,input.to,input.currency,'to');
   if(from.ledger_account_id===to.ledger_account_id)fault('SAME_ACCOUNT','to');
   const journalId=await this.post(db,actor,k,'ABIQ_INTERNAL_TRANSFER',input.reference,[side(from.ledger_account_id,'DEBIT',amount),side(to.ledger_account_id,'CREDIT',amount)]);
   return {journalId,status:'SETTLED',currency:input.currency,amount};
  });
 }
 async registerShop(actor,input,key) {
  const id=text(input.merchantId,'merchantId',64),name=text(input.shopName,'shopName',150);
  if(!Number.isInteger(input.commissionBps)||input.commissionBps<0||input.commissionBps>10000)fault('INVALID_FIELD','commissionBps');
  return this.operation(actor,'REGISTER_SHOP',input,key,async db=>{
   const user=(await db.query('SELECT account_type FROM avis_core_v2.sovereign_users WHERE user_id=$1 FOR SHARE',[input.ownerUserId])).rows[0];
   if(user?.account_type!=='BUSINESS')fault('BUSINESS_ACCOUNT_REQUIRED','ownerUserId');
   await this.userFunding(db,input.ownerUserId,'EUR');
   await db.query(`INSERT INTO avis_core_v2.marketplace_merchants(merchant_id,owner_user_id,shop_name,commission_rate_bps,status)
    VALUES($1,$2,$3,$4,'ACTIVE')`,[id,input.ownerUserId,name,input.commissionBps]);
   return {id,shopName:name};
  });
 }
 async captureCheckout(actor,input,key) {
  text(input.orderReference,'orderReference');
  if(!Array.isArray(input.splits)||input.splits.length<1||input.splits.length>50)fault('INVALID_FIELD','splits');
  if(input.paymentRail!=='AVIS_BANK_EUR')fault('SELECT_BANK_ACCOUNT','paymentRail');
  return this.operation(actor,'CHECKOUT_CAPTURE',input,key,async(db,k)=>{
   const buyer=await this.route(db,input.buyerAccount,'EUR','buyerAccount');
   const splits=[]; let gross=0n;
   for(const split of input.splits) {
    const amount=money(split.amount,6);
    const merchant=(await db.query("SELECT * FROM avis_core_v2.marketplace_merchants WHERE merchant_id=$1 AND status='ACTIVE' FOR SHARE",[split.merchantId])).rows[0];
    if(!merchant)fault('SHOP_NOT_FOUND','merchantId');
    await this.userFunding(db,merchant.owner_user_id,'EUR');
    const fee=(amount*BigInt(merchant.commission_rate_bps)+5000n)/10000n;
    splits.push({merchantId:merchant.merchant_id,amount,fee});gross+=amount;
   }
   const id=randomUUID(),escrow=await this.system(db,'MARKETPLACE_ESCROW','EUR',id);
   const journalId=await this.post(db,actor,k,'MARKETPLACE_CAPTURE',input.orderReference,[side(buyer.ledger_account_id,'DEBIT',decimal(gross,6)),side(escrow,'CREDIT',decimal(gross,6))]);
   await db.query(`INSERT INTO avis_core_v2.checkout_payment_sessions(checkout_id,marketplace_order_ref,buyer_user_id,payment_rail,total_amount_eur,status,capture_journal_id)
    VALUES($1,$2,$3,'AVIS_BANK_EUR',$4,'ESCROW_HELD',$5)`,[id,input.orderReference,buyer.user_id,decimal(gross,6),journalId]);
   for(const s of splits)await db.query(`INSERT INTO avis_core_v2.checkout_split_lines(checkout_id,merchant_id,gross_amount_eur,marketplace_fee_eur,net_merchant_eur)
    VALUES($1,$2,$3,$4,$5)`,[id,s.merchantId,decimal(s.amount,6),decimal(s.fee,6),decimal(s.amount-s.fee,6)]);
   return {id,journalId,status:'ESCROW_HELD'};
  });
 }
 async releaseCheckout(actor,input,key) {
  return this.operation(actor,'CHECKOUT_RELEASE',input,key,async(db,k)=>{
   const session=(await db.query('SELECT * FROM avis_core_v2.checkout_payment_sessions WHERE checkout_id=$1 FOR UPDATE',[input.checkoutId])).rows[0];
   if(!session)fault('CHECKOUT_NOT_FOUND','checkoutId',404);
   if(!['ESCROW_HELD','PARTIALLY_SETTLED'].includes(session.status))fault('CHECKOUT_ALREADY_CLOSED','checkoutId',409);
   const splits=(await db.query(`SELECT s.*,m.owner_user_id FROM avis_core_v2.checkout_split_lines s JOIN avis_core_v2.marketplace_merchants m USING(merchant_id)
    WHERE checkout_id=$1 AND NOT is_released ORDER BY split_id FOR UPDATE OF s`,[input.checkoutId])).rows
    .filter(s=>!input.splitId||s.split_id===input.splitId);
   if(splits.length===0)fault('SPLIT_NOT_FOUND','splitId');
   const escrow=await this.system(db,'MARKETPLACE_ESCROW','EUR',session.checkout_id);
   const revenue=await this.system(db,'REVENUE','EUR','MARKETPLACE_FEES','REVENUE'); const lines=[];
   for(const s of splits) {
    lines.push(side(escrow,'DEBIT',s.gross_amount_eur));
    if(/[1-9]/.test(s.net_merchant_eur)) lines.push(side(await this.userFunding(db,s.owner_user_id,'EUR'),'CREDIT',s.net_merchant_eur));
    if(/[1-9]/.test(s.marketplace_fee_eur))lines.push(side(revenue,'CREDIT',s.marketplace_fee_eur));
   }
   const journalId=await this.post(db,actor,k,'MARKETPLACE_RELEASE',session.marketplace_order_ref,lines);
   await db.query('UPDATE avis_core_v2.checkout_split_lines SET is_released=true WHERE split_id=ANY($1::uuid[])',[splits.map(s=>s.split_id)]);
   const remaining=(await db.query('SELECT count(*)::int AS n FROM avis_core_v2.checkout_split_lines WHERE checkout_id=$1 AND NOT is_released',[input.checkoutId])).rows[0].n;
   const status=remaining?'PARTIALLY_SETTLED':'SETTLED';
   await db.query('UPDATE avis_core_v2.checkout_payment_sessions SET status=$2::varchar,settlement_journal_id=$3,settled_at=CASE WHEN $2::varchar=\'SETTLED\' THEN now() ELSE NULL END WHERE checkout_id=$1',[input.checkoutId,status,journalId]);
   return {id:input.checkoutId,journalId,status};
  });
 }
 async refundCheckout(actor,input,key) {
  return this.operation(actor,'CHECKOUT_REFUND',input,key,async(db,k)=>{
   const s=(await db.query('SELECT * FROM avis_core_v2.checkout_payment_sessions WHERE checkout_id=$1 FOR UPDATE',[input.checkoutId])).rows[0];
   if(!s||s.status!=='ESCROW_HELD')fault('CHECKOUT_NOT_IN_ESCROW','checkoutId');
   const escrow=await this.system(db,'MARKETPLACE_ESCROW','EUR',s.checkout_id);
   const journalId=await this.post(db,actor,k,'MARKETPLACE_REFUND',s.marketplace_order_ref,[side(escrow,'DEBIT',s.total_amount_eur),side(await this.userFunding(db,s.buyer_user_id,'EUR'),'CREDIT',s.total_amount_eur)]);
   await db.query("UPDATE avis_core_v2.checkout_payment_sessions SET status='REFUNDED' WHERE checkout_id=$1",[s.checkout_id]);
   return {id:s.checkout_id,journalId,status:'REFUNDED'};
  });
 }
 async registerCard(actor,input,key) {
  text(input.cardReference,'cardReference');
  if(!/^\d{4}$/.test(input.lastFour))fault('INVALID_FIELD','lastFour');
  if(!['AVIS_PROPRIETARY_ONLY','GLOBAL_SCHEME_ONLY','DUAL_COBADGED'].includes(input.railMode))fault('INVALID_FIELD','railMode');
  return this.operation(actor,'REGISTER_CARD',input,key,async db=>{
   const account=await this.route(db,input.fundingAccount,input.currency,'fundingAccount');
   const row=(await db.query(`INSERT INTO avis_core_v2.avis_cards(user_id,core_bank_card_ref,card_type,last_four_digits,status,card_rail_mode,funding_account_id)
    VALUES($1,$2,'DEBIT',$3,'ACTIVE',$4,$5) RETURNING card_id`,[account.user_id,input.cardReference,input.lastFour,input.railMode,account.ledger_account_id])).rows[0];
   return {id:row.card_id};
  });
 }
 async registerTerminal(actor,input,key) {
  text(input.terminalId,'terminalId',32);
  if(!['SMART_POS','SOFTPOS_NFC','TRANSIT_GATE','UNATTENDED_KIOSK','WEB_POS'].includes(input.terminalType))fault('INVALID_FIELD','terminalType');
  return this.operation(actor,'REGISTER_TERMINAL',input,key,async db=>{
   const m=(await db.query("SELECT merchant_id FROM avis_core_v2.marketplace_merchants WHERE merchant_id=$1 AND status='ACTIVE'",[input.merchantId])).rows[0];
   if(!m)fault('SHOP_NOT_FOUND','merchantId');
   await db.query('INSERT INTO avis_core_v2.pos_terminals(terminal_id,merchant_id,terminal_type) VALUES($1,$2,$3)',[input.terminalId,input.merchantId,input.terminalType]);
   return {id:input.terminalId};
  });
 }
 async authorizeCard(actor,input,key) {
  const amount=decimal(money(input.amount)); text(input.networkReference,'networkReference');
  return this.operation(actor,'AVIS_CARD_AUTHORIZE',input,key,async(db,k)=>{
   const card=(await db.query(`SELECT c.*,COALESCE(c.stored_value_account_id,c.funding_account_id) AS funding_account_id,a.currency_code FROM avis_core_v2.avis_cards c
    JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.funding_account_id
    WHERE core_bank_card_ref=$1 AND c.status='ACTIVE' AND (c.expires_at IS NULL OR c.expires_at>now()) FOR SHARE OF c`,[input.cardReference])).rows[0];
   if(!card||card.card_rail_mode==='GLOBAL_SCHEME_ONLY')fault('SELECT_AVIS_CARD','cardReference');
   if(card.currency_code!==input.currency)fault('CURRENCY_MISMATCH','currency');
   const terminal=(await db.query(`SELECT t.terminal_id,m.commission_rate_bps FROM avis_core_v2.pos_terminals t JOIN avis_core_v2.marketplace_merchants m USING(merchant_id)
    WHERE terminal_id=$1 AND t.status='ACTIVE' AND m.status='ACTIVE' FOR SHARE OF t,m`,[input.terminalId])).rows[0];
   if(!terminal)fault('TERMINAL_NOT_FOUND','terminalId');
   const id=randomUUID(),hold=await this.system(db,'SUSPENSE_CARD_FX',input.currency,id);
   const journalId=await this.post(db,actor,k,'AVIS_CARD_AUTHORIZATION',input.networkReference,[side(card.funding_account_id,'DEBIT',amount),side(hold,'CREDIT',amount)]);
   await db.query(`INSERT INTO avis_core_v2.card_authorizations(authorization_id,card_id,terminal_id,network_reference,amount,currency_code,status,authorization_journal_id,commission_rate_bps,debit_account_id)
    VALUES($1,$2,$3,$4,$5,$6,'AUTHORIZED',$7,$8,$9)`,[id,card.card_id,terminal.terminal_id,input.networkReference,amount,input.currency,journalId,terminal.commission_rate_bps,card.funding_account_id]);
   return {id,journalId,status:'AUTHORIZED'};
  });
 }
 async settleCard(actor,input,key,reverse=false) {
  return this.operation(actor,reverse?'AVIS_CARD_REVERSE':'AVIS_CARD_CAPTURE',input,key,async(db,k)=>{
   const auth=(await db.query(`SELECT a.*,COALESCE(a.debit_account_id,c.funding_account_id) AS funding_account_id,m.owner_user_id FROM avis_core_v2.card_authorizations a
    JOIN avis_core_v2.avis_cards c USING(card_id) JOIN avis_core_v2.pos_terminals t USING(terminal_id)
    JOIN avis_core_v2.marketplace_merchants m USING(merchant_id) WHERE authorization_id=$1 FOR UPDATE OF a`,[input.authorizationId])).rows[0];
   if(!auth||auth.status!=='AUTHORIZED')fault('AUTHORIZATION_ALREADY_CLOSED','authorizationId',409);
   const hold=await this.system(db,'SUSPENSE_CARD_FX',auth.currency_code,auth.authorization_id);
   const amount=money(auth.amount),fee=reverse?0n:(amount*BigInt(auth.commission_rate_bps)+5000n)/10000n;
   const to=reverse?auth.funding_account_id:await this.userFunding(db,auth.owner_user_id,auth.currency_code);
   const lines=[side(hold,'DEBIT',auth.amount)];
   if(amount>fee)lines.push(side(to,'CREDIT',decimal(amount-fee)));
   if(fee>0n)lines.push(side(await this.system(db,'REVENUE',auth.currency_code,'POS_FEES','REVENUE'),'CREDIT',decimal(fee)));
   const journalId=await this.post(db,actor,k,reverse?'AVIS_CARD_REVERSAL':'AVIS_CARD_CAPTURE',auth.network_reference,lines,reverse?auth.authorization_journal_id:null);
   const status=reverse?'REVERSED':'CAPTURED';
   await db.query('UPDATE avis_core_v2.card_authorizations SET status=$2,settlement_journal_id=$3 WHERE authorization_id=$1',[auth.authorization_id,status,journalId]);
   return {id:auth.authorization_id,journalId,status};
  });
 }
 async list(actor,view) {
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  const queries={
   accounts:`SELECT b.abiq_iban,b.currency_code,b.participant_code,p.abiq_bic,lpad(b.account_series::text,5,'0') || b.customer_number::text AS account_number,b.customer_number::text AS customer_number,b.user_id,u.full_name,u.account_type,u.account_role,a.available_balance::text,a.locked_balance::text,b.status
    FROM avis_core_v2.abiq_routing_bridge b JOIN avis_core_v2.sovereign_users u USING(user_id) JOIN avis_core_v2.abiq_network_participants p USING(participant_code) JOIN avis_core_v2.ledger_accounts a ON a.account_id=b.ledger_account_id ORDER BY u.user_id,b.account_series NULLS LAST,b.currency_code LIMIT 300`,
   customers:'SELECT u.user_id,u.full_name,u.account_type,u.account_role,u.postal_address,u.created_at,n.customer_number::text AS customer_number FROM avis_core_v2.sovereign_users u LEFT JOIN avis_core_v2.abiq_customer_numbers n USING(user_id) ORDER BY u.user_id DESC LIMIT 300',
   issuer:"SELECT i.abiq_code,i.country_code,i.participant_code,p.institution_name FROM avis_core_v2.abiq_issuers i JOIN avis_core_v2.abiq_network_participants p USING(participant_code) WHERE p.is_active",
   currencies:'SELECT currency_code,iso_numeric_partition,account_series FROM avis_core_v2.abiq_currencies ORDER BY account_series',
   ledger:`SELECT a.account_id,a.owner_type,a.user_id,
    CASE WHEN a.owner_type='USER' THEN u.account_role ELSE a.owner_type END AS owner_class,
    COALESCE(u.full_name,issuer.institution_name) AS account_holder,
    b.abiq_iban,COALESCE(b.abiq_iban,a.sub_account_code) AS account_reference,
    a.sub_account_code,a.currency_code,a.network,a.wallet_scope,a.account_category,a.available_balance::text,a.locked_balance::text
    FROM avis_core_v2.ledger_accounts a
    LEFT JOIN avis_core_v2.sovereign_users u USING(user_id)
    LEFT JOIN avis_core_v2.abiq_network_participants issuer ON issuer.participant_code='AVIP'
    LEFT JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=a.account_id
    LEFT JOIN avis_core_v2.abiq_currencies c ON c.currency_code=a.currency_code
    ORDER BY CASE WHEN u.account_role='INSTITUTION' THEN 0 WHEN a.owner_type<>'USER' THEN 1 ELSE 2 END,
     a.user_id,a.owner_type,c.account_series NULLS LAST,a.currency_code,a.sub_account_code,
     CASE a.wallet_scope WHEN 'FUNDING' THEN 0 WHEN 'MARGIN' THEN 1 ELSE 2 END,b.participant_code,a.account_id LIMIT 500`,
   transactions:`SELECT j.journal_id,j.created_at,j.event_type,j.reference_id,e.direction,e.amount::text,a.currency_code,a.owner_type,b.abiq_iban
    FROM avis_core_v2.ledger_entries e JOIN avis_core_v2.ledger_journals j USING(journal_id) JOIN avis_core_v2.ledger_accounts a USING(account_id)
    LEFT JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=a.account_id ORDER BY e.entry_id DESC LIMIT 300`,
   shops:`SELECT m.merchant_id,m.shop_name,m.owner_user_id,u.full_name,m.commission_rate_bps,m.status FROM avis_core_v2.marketplace_merchants m JOIN avis_core_v2.sovereign_users u ON u.user_id=m.owner_user_id ORDER BY m.created_at DESC LIMIT 300`,
   checkouts:'SELECT checkout_id,marketplace_order_ref,buyer_user_id,payment_rail,total_amount_eur::text,status,created_at FROM avis_core_v2.checkout_payment_sessions ORDER BY created_at DESC LIMIT 300',
   cards:'SELECT card_id,user_id,last_four_digits,card_type,card_rail_mode,status FROM avis_core_v2.avis_cards ORDER BY created_at DESC LIMIT 300',
   terminals:'SELECT terminal_id,merchant_id,terminal_type,offline_enabled,status FROM avis_core_v2.pos_terminals ORDER BY terminal_id LIMIT 300',
   authorizations:'SELECT authorization_id,terminal_id,network_reference,amount::text,currency_code,status,created_at FROM avis_core_v2.card_authorizations ORDER BY created_at DESC LIMIT 300',
   gateways:'SELECT gateway_code,display_name,gateway_category,settlement_cycle FROM avis_core_v2.payment_gateway_bridges ORDER BY gateway_code LIMIT 300',
   correspondents:'SELECT cash_account_id,institution_type,institution_name,bic_code,iban_or_account_no,currency_code FROM avis_core_v2.external_cash_accounts ORDER BY institution_name LIMIT 300',
   wallets:'SELECT user_id,network,public_address,destination_tag FROM avis_core_v2.user_deposit_addresses ORDER BY user_id,network LIMIT 300',
   connectors:'SELECT connector_code,display_name,is_enabled,auto_provision,updated_at FROM avis_core_v2.platform_connectors ORDER BY connector_code',
   audit:'SELECT actor_id,operation,resource_id,created_at FROM avis_core_v2.operation_audit ORDER BY audit_id DESC LIMIT 300'
  };
  if(!queries[view])fault('NOT_FOUND',null,404); return (await this.pool.query(queries[view])).rows;
 }
}
