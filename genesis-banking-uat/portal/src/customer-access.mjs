import {fault} from './core.mjs';
// The public customer boundary checks ownership before invoking existing ledger services.
// It never grants a customer the unrestricted operator API.
export class CustomerAccess {
 constructor(core){this.core=core;this.pool=core.pool;}
 operator(actor){if(!actor?.customerUserId||!actor.id)fault('FORBIDDEN',null,403);return {...actor,admin:true};}
 async owns(actor,table,id,column='user_id',key='account_id'){
  const row=(await this.pool.query(`SELECT ${column} AS holder FROM avis_core_v2.${table} WHERE ${key}=$1`,[id])).rows[0];
  if(!row||String(row.holder)!==String(actor.customerUserId))fault('FORBIDDEN',null,403);
 }
 async ownsBank(actor,identifier,currency){const r=await this.core.route(this.pool,identifier,currency);if(String(r.user_id)!==String(actor.customerUserId))fault('FORBIDDEN','from',403);}
 async ownsRequest(actor,id){
  const r=await this.core.requestOn(this.pool,id);if(!r)fault('PAYMENT_REQUEST_NOT_FOUND','requestId',404);
  if(r.source_user_id){if(String(r.source_user_id)!==String(actor.customerUserId))fault('FORBIDDEN',null,403);}
  else await this.owns(actor,'ledger_accounts',r.source_account_id);
  return r;
 }
 async invoke(actor,method,input,key,...extra){
  const operator=this.operator(actor);
  if(['issueManagedCard','loadManagedCard','registerExternalCard','purchaseCrypto'].includes(method))await this.ownsBank(actor,input.from,input.currency||((await this.pool.query(`SELECT p.currency_code FROM avis_core_v2.crypto_sale_offers o JOIN avis_core_v2.ledger_accounts p ON p.account_id=o.proceeds_account_id WHERE offer_id=$1`,[input.offerId])).rows[0]?.currency_code));
  else if(method==='preparePayment'){
   if(input.method==='CRYPTO')await this.owns(actor,'ledger_accounts',input.cryptoAccount);
   else if(input.sourceCardId)await this.owns(actor,'avis_cards',input.sourceCardId,'user_id','card_id');
   else await this.ownsBank(actor,input.from,input.currency);
   if(input.from)await this.ownsBank(actor,input.from,input.currency);
  }else if(['confirmPayment','cancelPayment','cancelCodedDebit','cardDelivery'].includes(method))await this.ownsRequest(actor,input.requestId);
  else if(['setCardStatus','resetCardPin','managedCardDelivery','managedCardDetails'].includes(method))await this.owns(actor,'avis_cards',input.cardId,'user_id','card_id');
  else if(method==='sellCrypto'){await this.owns(actor,'ledger_accounts',input.cryptoAccount);const r=await this.pool.query(`SELECT p.currency_code FROM avis_core_v2.crypto_sale_offers o JOIN avis_core_v2.ledger_accounts p ON p.account_id=o.proceeds_account_id WHERE offer_id=$1`,[input.offerId]);await this.ownsBank(actor,input.to,r.rows[0]?.currency_code);}
  else if(['addCurrencies','saveCustomerProfile'].includes(method)){if(String(input.userId)!==String(actor.customerUserId))fault('FORBIDDEN','userId',403);}
  else if(method==='redeemCode')await this.ownsBank(actor,input.to,input.currency);
  else if(['accountDetails','movementDetails'].includes(method))await this.owns(actor,'ledger_accounts',input.accountId);
  else if(!['checkReceiver'].includes(method))fault('FORBIDDEN',null,403);
  return this.core[method](operator,input,key,...extra);
 }
 async paymentRequest(actor,id){await this.ownsRequest(actor,id);return this.core.paymentRequest(this.operator(actor),id);}
 async list(actor,view){
  const operator=this.operator(actor),id=actor.customerUserId;
  if(['cards','transfercards','cardaccounts','cryptooffers','fxrates','currencies','issuer','portfolio','accountsummaries'].includes(view))return this.core.list(operator,view);
  const queries={
   accounts:`SELECT b.abiq_iban,b.currency_code,b.user_id,u.full_name,u.account_type,u.account_role,b.status,p.abiq_bic,a.available_balance::text,a.locked_balance::text FROM avis_core_v2.abiq_routing_bridge b JOIN avis_core_v2.sovereign_users u USING(user_id) JOIN avis_core_v2.abiq_network_participants p USING(participant_code) JOIN avis_core_v2.ledger_accounts a ON a.account_id=b.ledger_account_id WHERE b.user_id=$1 ORDER BY b.account_series LIMIT 300`,
   customers:`SELECT user_id,full_name,account_type,account_role,postal_address FROM avis_core_v2.sovereign_users WHERE user_id=$1`,
   cryptoholdings:`SELECT a.account_id,a.user_id,u.full_name,u.account_role,a.currency_code,a.network,a.available_balance::text,a.locked_balance::text FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.sovereign_users u USING(user_id) WHERE a.user_id=$1 AND a.owner_type='USER' AND a.network IS NOT NULL AND a.wallet_scope='FUNDING' AND a.account_category='LIABILITY' ORDER BY a.currency_code,a.network LIMIT 300`,
   wallets:`SELECT user_id,network,public_address,destination_tag FROM avis_core_v2.user_deposit_addresses WHERE user_id=$1 ORDER BY network`,
   externalcards:`SELECT card_id,user_id,holder_name,last_four FROM avis_core_v2.external_payment_cards WHERE user_id=$1`,
   codedcards:`SELECT g.request_id,c.user_id,c.last_four_digits,g.amount::text,g.currency_code,g.valid_from,g.expires_at,g.status FROM avis_core_v2.coded_card_debits g JOIN avis_core_v2.avis_cards c USING(card_id) WHERE c.user_id=$1 ORDER BY g.expires_at DESC LIMIT 300`,
   transactions:`SELECT e.entry_id,j.journal_id,j.created_at,j.event_type,j.reference_id,e.direction,e.amount::text,a.currency_code,b.abiq_iban FROM avis_core_v2.ledger_entries e JOIN avis_core_v2.ledger_journals j USING(journal_id) JOIN avis_core_v2.ledger_accounts a USING(account_id) LEFT JOIN avis_core_v2.abiq_routing_bridge b ON b.ledger_account_id=a.account_id WHERE a.user_id=$1 ORDER BY e.entry_id DESC LIMIT 300`,
   ledger:`SELECT account_id,user_id,sub_account_code AS account_reference,currency_code,network,wallet_scope,account_category,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts WHERE user_id=$1 ORDER BY currency_code,network LIMIT 300`
  };
  if(view==='paymentregister'){
   return (await this.pool.query(`SELECT r.request_id,r.created_at,'BANK' AS payment_method,r.beneficiary_name,r.beneficiary_account,r.payment_reference,r.amount::text,r.currency_code,COALESCE(r.execution_mode,r.delivery_mode) AS delivery_mode,CASE WHEN t.iso_status='ACCC' THEN 'COMPLETED' WHEN t.iso_status='RJCT' THEN 'REJECTED' ELSE r.status END AS status FROM avis_core_v2.payment_requests r JOIN avis_core_v2.ledger_accounts a ON a.account_id=r.source_account_id LEFT JOIN avis_core_v2.interbank_ip_transfers t USING(transfer_id) WHERE a.user_id=$1 AND r.status<>'REVIEW'
    UNION ALL SELECT request_id,created_at,payment_method,instruction->>'receiverName',instruction->>'destinationLabel',instruction->>'reference',amount::text,currency_code,delivery_mode,status FROM avis_core_v2.asset_transfer_requests WHERE source_user_id=$1 AND status<>'REVIEW' ORDER BY created_at DESC LIMIT 300`,[id])).rows;
  }
  if(!queries[view])fault('FORBIDDEN',null,403);return (await this.pool.query(queries[view],[id])).rows;
 }
}
