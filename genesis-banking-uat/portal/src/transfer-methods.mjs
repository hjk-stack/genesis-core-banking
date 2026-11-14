import {createHash,randomBytes,randomInt,randomUUID,timingSafeEqual} from 'node:crypto';
import {PaymentRegister} from './payment-register.mjs';
import {fault,text,money,decimal} from './core.mjs';
import {seal,unseal,fingerprint} from './transfer-secrets.mjs';
import {sharedCardAccount,codeWindow} from './card-accounts.mjs';
import {postalAddress} from './beneficiaries.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const line=(accountId,direction,amount)=>({accountId,direction,amount});
const uuid=value=>/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value||'');
const units=s=>/^0(?:\.0+)?$/.test(s)?0n:String(s).startsWith('-')?-money(String(s).slice(1)):money(String(s));
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const fields=r=>({...r,message_format:'AVIS_TRANSFER_V1',beneficiary_name:r.instruction.receiverName,
 beneficiary_account:r.instruction.destinationLabel,beneficiary_bic:'',payment_reference:r.instruction.reference,current_status:r.status});
export class TransferMethods extends PaymentRegister {
 constructor(pool,options={}){super(pool,options);this.secretEnv=options.secretEnv||process.env;}
 async networkAccount(db,owner,currency,network,bucket,userId=null){
  await db.query(`INSERT INTO avis_core_v2.ledger_accounts(owner_type,user_id,sub_account_code,currency_code,network,account_category)
   VALUES($1,$2,$3,$4,$5,'LIABILITY') ON CONFLICT DO NOTHING`,[owner,userId,bucket,currency,network]);
  return (await db.query(`SELECT account_id FROM avis_core_v2.ledger_accounts WHERE owner_type=$1 AND user_id IS NOT DISTINCT FROM $2::bigint
   AND sub_account_code=$3 AND currency_code=$4 AND network IS NOT DISTINCT FROM $5 AND wallet_scope='FUNDING'`,[owner,userId,bucket,currency,network])).rows[0].account_id;
 }
 async registerExternalCard(actor,input,key){
  const pan=String(input.cardNumber||'').replace(/[ -]/g,'');
  let total=0;for(let i=pan.length-1,double=false;i>=0;i--,double=!double){let n=Number(pan[i]);if(double){n*=2;if(n>9)n-=9;}total+=n;}
  if(!/^\d{12,19}$/.test(pan)||total%10||/^0+$/.test(pan))fault('INVALID_CARD_NUMBER','cardNumber');
  const expiry=text(input.expiry,'expiry',7),m=/^(0[1-9]|1[0-2])\/(20\d{2})$/.exec(expiry);
  if(!m||Date.UTC(Number(m[2]),Number(m[1]),1)<=Date.now())fault('INVALID_CARD_EXPIRY','expiry');
  const name=text(input.holderName,'holderName',140),digest=fingerprint('pan:'+pan,this.secretEnv);
  // PAN never enters operation requests, audit records, review messages or logs.
  return this.operation(actor,'REGISTER_EXTERNAL_CARD',{from:input.from,currency:input.currency,panFingerprint:digest,expiry,holderName:name},key,async db=>{
   const source=await this.route(db,input.from,input.currency,'from');
   const existing=(await db.query('SELECT card_id,last_four FROM avis_core_v2.external_payment_cards WHERE user_id=$1 AND pan_fingerprint=$2',[source.user_id,digest])).rows[0];
   if(existing){await db.query('UPDATE avis_core_v2.external_payment_cards SET holder_name=$2,sealed_details=$3 WHERE card_id=$1',[existing.card_id,name,JSON.stringify(seal({pan,expiry},'external-card:'+existing.card_id,this.secretEnv))]);return {id:existing.card_id,lastFour:existing.last_four};}
   const id=randomUUID();await db.query(`INSERT INTO avis_core_v2.external_payment_cards(card_id,user_id,holder_name,last_four,pan_fingerprint,sealed_details)
    VALUES($1,$2,$3,$4,$5,$6)`,[id,source.user_id,name,pan.slice(-4),digest,JSON.stringify(seal({pan,expiry},'external-card:'+id,this.secretEnv))]);
   return {id,lastFour:pan.slice(-4)};
  });
 }
 async preparePayment(actor,input,key){
  input=Object.fromEntries(['method','from','currency','amount','receiverAccount','receiverBic','receiverName','address','reference','cryptoAccount','cryptoDestination','receiverUserId','cryptoAddress','destinationTag','cardDestination','cardId','externalCardId','offlineDebit','sourceCardId','codeStart','codeEnd'].filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]]));
  if(!input.method||input.method==='BANK')return super.preparePayment(actor,input,key);
  if(!['CRYPTO','CARD','CODED_CARD'].includes(input.method))fault('INVALID_FIELD','method');
  if(input.offlineDebit!==undefined&&typeof input.offlineDebit!=='boolean')fault('INVALID_FIELD','offlineDebit');
  const reference=text(input.reference,'reference',128);
  return this.operation(actor,'REVIEW_ASSET_TRANSFER',input,key,async db=>{
   let bank,sourceCard=null;
   if(input.sourceCardId&&['CARD','CODED_CARD'].includes(input.method)){
    sourceCard=(await db.query(`SELECT c.*,a.currency_code,COALESCE(c.stored_value_account_id,c.funding_account_id) AS debit_account_id FROM avis_core_v2.avis_cards c JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.funding_account_id WHERE c.card_id=$1 AND c.status='ACTIVE' AND c.card_rail_mode<>'GLOBAL_SCHEME_ONLY' AND (c.expires_at IS NULL OR c.expires_at>now())`,[input.sourceCardId])).rows[0];
    if(!sourceCard)fault('SELECT_AVIS_CARD','sourceCardId');
    bank={user_id:sourceCard.user_id,ledger_account_id:sourceCard.debit_account_id,currency_code:sourceCard.currency_code};
   }else if(input.method==='CRYPTO'&&!input.from){
    const holding=(await db.query("SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1 AND owner_type='USER' AND network IS NOT NULL AND wallet_scope='FUNDING' AND account_category='LIABILITY'",[input.cryptoAccount])).rows[0];
    if(!holding)fault('CRYPTO_HOLDING_REQUIRED','cryptoAccount');bank={user_id:holding.user_id,ledger_account_id:holding.account_id,currency_code:holding.currency_code};
   }else bank=await this.route(db,input.from,input.currency,'from');
   const currency=bank.currency_code||input.currency;
   let source=bank.ledger_account_id,asset=currency,network=null,mode='INTERNAL',target=null,card=null,external=null,receiverName='',destinationLabel='';
   if(input.method!=='CRYPTO'&&!new RegExp(currency==='JPY'?'^[0-9]{1,18}$':'^[0-9]{1,18}(\\.[0-9]{1,2})?$').test(input.amount))fault('INVALID_AMOUNT','amount');
   const amount=decimal(money(input.amount));
   const holder=(await db.query('SELECT full_name FROM avis_core_v2.sovereign_users WHERE user_id=$1',[bank.user_id])).rows[0];
   if(input.method==='CRYPTO'){
    if(!uuid(input.cryptoAccount))fault('CRYPTO_HOLDING_REQUIRED','cryptoAccount');
    const a=(await db.query(`SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1 AND owner_type='USER' AND user_id=$2
     AND network IS NOT NULL AND wallet_scope='FUNDING' AND account_category='LIABILITY'`,[input.cryptoAccount,bank.user_id])).rows[0];
    if(!a)fault('CRYPTO_HOLDING_REQUIRED','cryptoAccount');source=a.account_id;asset=a.currency_code;network=a.network;
    if(asset==='AG'&&units(a.available_balance)<=0n)fault('AG_PURCHASE_REQUIRED','cryptoAccount');
    if(input.cryptoDestination==='INTERNAL'){
     const recipient=(await db.query('SELECT user_id,full_name FROM avis_core_v2.sovereign_users WHERE user_id=$1',[input.receiverUserId])).rows[0];
     if(!recipient)fault('ABIQ_CUSTOMER_NOT_FOUND','receiverUserId');
     if(String(recipient.user_id)===String(bank.user_id))fault('SAME_ACCOUNT','receiverUserId');
     receiverName=recipient.full_name;destinationLabel='AVISPay user '+recipient.user_id;
    }else if(input.cryptoDestination==='EXTERNAL'){
     const address=text(input.cryptoAddress,'cryptoAddress',256);
     if(!/^[a-zA-Z0-9:_-]{8,256}$/.test(address))fault('INVALID_CRYPTO_ADDRESS','cryptoAddress');
     if(/^(ETHEREUM|ETH|EVM|POLYGON|ARBITRUM|BASE|BSC)$/i.test(network)&&!/^0x[0-9a-fA-F]{40}$/.test(address))fault('INVALID_CRYPTO_ADDRESS','cryptoAddress');
     if(/^(TRON|TRX)$/i.test(network)&&!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address))fault('INVALID_CRYPTO_ADDRESS','cryptoAddress');
     if(/^(XRP|XRPL)$/i.test(network)&&!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address))fault('INVALID_CRYPTO_ADDRESS','cryptoAddress');
     if(input.destinationTag&&!/^\d{1,10}$/.test(input.destinationTag))fault('INVALID_FIELD','destinationTag');
     if(input.destinationTag&&BigInt(input.destinationTag)>4294967295n)fault('INVALID_FIELD','destinationTag');
     receiverName=text(input.receiverName,'receiverName',140);destinationLabel=address;mode='MANUAL';
    }else fault('INVALID_FIELD','cryptoDestination');
   }else if(sourceCard){
    card=sourceCard;
    if(input.offlineDebit){fingerprint('key-check',this.secretEnv);receiverName=holder.full_name;destinationLabel='Card debit secured by code';}
    else{
     const payee=await this.checkReceiver(actor,{...input,currency});
     receiverName=payee.receiverName||text(input.receiverName,'receiverName',140);destinationLabel=payee.account;
     input={...input,receiverAccount:payee.account,receiverBic:payee.bic,address:postalAddress(payee.address||input.address)};
     if(payee.receiverBridgeId){target=(await this.route(db,payee.account,currency,'receiverAccount')).ledger_account_id;if(target===source)fault('SAME_ACCOUNT','receiverAccount');}else mode='MANUAL';
    }
   }else{
    if(input.cardDestination==='EXISTING'){
     if(!uuid(input.cardId))fault('SELECT_AVIS_CARD','cardId');
     card=(await db.query(`SELECT c.*,a.currency_code FROM avis_core_v2.avis_cards c JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.funding_account_id
      WHERE c.card_id=$1 AND c.user_id=$2 AND c.status='ACTIVE' AND c.card_rail_mode<>'GLOBAL_SCHEME_ONLY'`,[input.cardId,bank.user_id])).rows[0];
     if(!card)fault('SELECT_AVIS_CARD','cardId');if(card.currency_code!==asset)fault('CURRENCY_MISMATCH','cardId');
     receiverName=holder.full_name;destinationLabel='AVIS card ending '+card.last_four_digits;
    }else if(input.cardDestination==='EXTERNAL'){
     if(input.offlineDebit||input.method==='CODED_CARD')fault('OFFLINE_INTERNAL_CARD','offlineDebit');
     if(!uuid(input.externalCardId))fault('SELECT_EXTERNAL_CARD','externalCardId');
     external=(await db.query('SELECT * FROM avis_core_v2.external_payment_cards WHERE card_id=$1 AND user_id=$2',[input.externalCardId,bank.user_id])).rows[0];
     if(!external)fault('SELECT_EXTERNAL_CARD','externalCardId');
     receiverName=external.holder_name;destinationLabel='External card ending '+external.last_four;mode='MANUAL';
    }else if(input.cardDestination==='NEW'){
     receiverName=holder.full_name;destinationLabel='New AVIS card for '+holder.full_name;
    }else fault('INVALID_FIELD','cardDestination');
    // Validate the existing key before accepting a new card/code instruction.
    if(input.cardDestination==='NEW'||input.offlineDebit||input.method==='CODED_CARD')fingerprint('key-check',this.secretEnv);
   }
   const offlineDebit=sourceCard?input.offlineDebit===true:input.method==='CODED_CARD'||input.offlineDebit===true;
   const window=offlineDebit?codeWindow(input):{};
   const id=randomUUID(),instruction={method:input.method,from:input.from||(sourceCard?(sourceCard.display_number||'Card ending '+sourceCard.last_four_digits):'Wallet '+asset+' · '+network),sourceUserId:String(bank.user_id),currency:asset,network,amount,receiverName,
    destinationLabel,reference,createdAt:new Date().toISOString(),cryptoDestination:input.cryptoDestination||null,
    receiverUserId:input.cryptoDestination==='INTERNAL'?String(input.receiverUserId):null,
    cryptoAddress:input.cryptoDestination==='EXTERNAL'?input.cryptoAddress:null,destinationTag:input.destinationTag||null,
    cardDestination:input.cardDestination||null,offlineDebit,sourceCardId:sourceCard?.card_id||null,receiverAccount:input.receiverAccount||null,receiverBic:input.receiverBic||null,address:input.address||null,...window};
   const message=JSON.stringify({protocol:'AVIS_TRANSFER_V1',requestId:id,...instruction},null,2),messageHash=hash(message);
   await db.query(`INSERT INTO avis_core_v2.asset_transfer_requests(request_id,actor_id,payment_method,source_account_id,source_user_id,currency_code,network,amount,
    target_account_id,card_id,external_card_id,instruction,message_content,message_hash,delivery_mode)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[id,actor.id,input.method,source,bank.user_id,asset,network,amount,target,card?.card_id||null,external?.card_id||null,JSON.stringify(instruction),message,messageHash,mode]);
   return {id,messageHash,message,format:'AVIS_TRANSFER_V1',mode,instruction};
  });
 }
 async confirmPayment(actor,input,key){
  const found=(await this.pool.query('SELECT request_id FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1',[input.requestId])).rows[0];
  if(!found)return super.confirmPayment(actor,input,key);
  const result=await this.operation(actor,'CONFIRM_ASSET_TRANSFER',input,key,async(db,k)=>{
   const r=(await db.query('SELECT * FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   if(r.actor_id!==actor.id)fault('PAYMENT_REQUEST_NOT_FOUND','review',404);
   if(input.messageHash!==r.message_hash||hash(r.message_content)!==r.message_hash)fault('PAYMENT_REVIEW_CHANGED','review',409);
   if(r.status==='CANCELLED')fault('PAYMENT_REQUEST_CLOSED','review',409);
   if(r.status!=='REVIEW')return {id:r.request_id};
   if(Date.now()-Date.parse(r.instruction.createdAt)>86400000)fault('PAYMENT_REVIEW_CHANGED','review',409);
   const source=(await db.query('SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[r.source_account_id])).rows[0];
   if(source.owner_type!=='USER'||source.wallet_scope!=='FUNDING'||source.account_category!=='LIABILITY'||String(source.user_id)!==String(r.source_user_id)||source.currency_code!==r.currency_code||source.network!==r.network)fault('PAYMENT_REVIEW_CHANGED','review',409);
   if(r.instruction.sourceCardId){
    const card=(await db.query(`SELECT c.card_id FROM avis_core_v2.avis_cards c WHERE c.card_id=$1 AND c.user_id=$2 AND c.status='ACTIVE' AND (c.expires_at IS NULL OR c.expires_at>now()) AND COALESCE(c.stored_value_account_id,c.funding_account_id)=$3 FOR SHARE`,[r.instruction.sourceCardId,r.source_user_id,r.source_account_id])).rows[0];
    if(!card)fault('SELECT_AVIS_CARD','sourceCardId');
   }
   let to,cardId=r.card_id,delivery=null,status='COMPLETED';
   if(r.delivery_mode==='MANUAL'){
    to=await this.networkAccount(db,'SUSPENSE_OUTBOUND',r.currency_code,r.network,r.request_id);status='OUTGOING';
   }else if(r.instruction.sourceCardId){
    if(r.instruction.offlineDebit){({to,delivery}=await this.reserveCodedDebit(db,r,cardId));}
    else{const target=await this.route(db,r.instruction.receiverAccount,r.currency_code,'receiverAccount');if(target.ledger_account_id!==r.target_account_id)fault('PAYMENT_REVIEW_CHANGED','review');to=target.ledger_account_id;}
   }else if(r.payment_method==='CRYPTO'){
    to=await this.networkAccount(db,'USER',r.currency_code,r.network,'CRYPTO',r.instruction.receiverUserId);
   }else{
    if(cardId){
     const card=(await db.query(`SELECT c.* FROM avis_core_v2.avis_cards c JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.funding_account_id WHERE c.card_id=$1 AND c.user_id=$2 AND c.status='ACTIVE' AND c.card_rail_mode<>'GLOBAL_SCHEME_ONLY' AND a.currency_code=$3 FOR UPDATE OF c`,[cardId,r.source_user_id,r.currency_code])).rows[0];
     if(!card)fault('SELECT_AVIS_CARD','cardId');
    }else{
     cardId=randomUUID();const token='AVIS-'+randomBytes(24).toString('base64url'),lastFour=String(randomInt(0,10000)).padStart(4,'0');
     await db.query(`INSERT INTO avis_core_v2.avis_cards(card_id,user_id,core_bank_card_ref,card_type,last_four_digits,status,card_rail_mode,funding_account_id)
      VALUES($1,$2,$3,'PREPAID',$4,'ACTIVE','AVIS_PROPRIETARY_ONLY',$5)`,[cardId,r.source_user_id,token,lastFour,r.source_account_id]);
     delivery={cardReference:token,lastFour,holder:r.instruction.receiverName,currency:r.currency_code,amount:r.amount};
    }
    const purse=await sharedCardAccount(this,db,r.source_user_id,r.currency_code);
    await db.query('UPDATE avis_core_v2.avis_cards SET stored_value_account_id=$2 WHERE card_id=$1',[cardId,purse]);
    to=purse;
    if(r.instruction.offlineDebit){
     ({to,delivery}=await this.reserveCodedDebit(db,r,cardId,delivery));
    }
   }
   const journalId=await this.post(db,actor,k,'TRANSFER_'+r.payment_method,r.instruction.reference,[line(r.source_account_id,'DEBIT',r.amount),line(to,'CREDIT',r.amount)]);
   await db.query(`UPDATE avis_core_v2.asset_transfer_requests SET status=$2,card_id=$3,reservation_journal_id=$4,submitted_at=now(),
    completed_at=CASE WHEN $2='COMPLETED' THEN now() ELSE NULL END,sealed_delivery=$5 WHERE request_id=$1`,
    [r.request_id,status,cardId,journalId,delivery?JSON.stringify(seal(delivery,'delivery:'+r.request_id,this.secretEnv)):null]);
   return {id:r.request_id};
  });
  return this.paymentRequest(actor,result.id);
 }
 async reserveCodedDebit(db,r,cardId,delivery=null){
  const to=await this.networkAccount(db,'SUSPENSE_CARD_FX',r.currency_code,null,r.request_id);
  const token=randomBytes(32).toString('base64url'),code=String(randomInt(0,1000000)).padStart(6,'0');
  const {validFrom,expiresAt}=codeWindow({codeStart:r.instruction.validFrom,codeEnd:r.instruction.expiresAt});
  await db.query(`INSERT INTO avis_core_v2.coded_card_debits(request_id,card_id,token_hash,code_hash,hold_account_id,amount,currency_code,valid_from,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[r.request_id,cardId,hash(token),fingerprint(r.request_id+':'+code,this.secretEnv),to,r.amount,r.currency_code,validFrom,expiresAt]);
  return {to,delivery:{...delivery,holder:r.instruction.receiverName,currency:r.currency_code,amount:r.amount,redemptionToken:token,code,validFrom,expiresAt}};
 }
 async paymentRequest(actor,id){
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  const r=(await this.pool.query('SELECT * FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1',[id])).rows[0];
  if(!r)return super.paymentRequest(actor,id);
  if(r.status==='REVIEW'&&r.actor_id!==actor.id)fault('PAYMENT_REQUEST_NOT_FOUND','requestId',404);
  const {sealed_delivery,...safe}=r;
  return {...fields(safe),hasDelivery:Boolean(sealed_delivery)&&(actor.id===r.actor_id||String(actor.customerUserId)===String(r.source_user_id))};
 }
 async cardDelivery(actor,input){
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  const r=(await this.pool.query("SELECT * FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1 AND (actor_id=$2 OR source_user_id=$3::bigint) AND status='COMPLETED'",[input.requestId,actor.id,actor.customerUserId||null])).rows[0];
  if(!r?.sealed_delivery)fault('PAYMENT_REQUEST_NOT_FOUND','requestId',404);
  return {requestId:r.request_id,...unseal(r.sealed_delivery,'delivery:'+r.request_id,this.secretEnv)};
 }
 async redeemCode(actor,input,key){
  const token=text(input.token,'token',128),code=String(input.code||'');
  if(!/^\d{6}$/.test(code))fault('INVALID_CARD_CODE','code');
  const safe={tokenHash:hash(token),credentialFingerprint:fingerprint(token+':'+code,this.secretEnv),to:input.to,currency:input.currency,reference:input.reference};
  const result=await this.operation(actor,'REDEEM_CODED_CARD',safe,key,async(db,k)=>{
   const g=(await db.query('SELECT * FROM avis_core_v2.coded_card_debits WHERE token_hash=$1 FOR UPDATE',[hash(token)])).rows[0];
   if(!g||g.status!=='ACTIVE'||new Date(g.expires_at).getTime()<=Date.now())return {error:'CARD_CODE_CLOSED'};
   if(new Date(g.valid_from).getTime()>Date.now())return {error:'CARD_CODE_NOT_STARTED'};
   const card=(await db.query('SELECT status,expires_at FROM avis_core_v2.avis_cards WHERE card_id=$1 FOR SHARE',[g.card_id])).rows[0];
   if(card.status!=='ACTIVE'||(card.expires_at&&new Date(card.expires_at).getTime()<=Date.now()))return {error:'CARD_CODE_BLOCKED'};
   if(!same(g.code_hash,fingerprint(g.request_id+':'+code,this.secretEnv))){
    await db.query("UPDATE avis_core_v2.coded_card_debits SET attempts=attempts+1,status=CASE WHEN attempts+1>=5 THEN 'LOCKED' ELSE status END WHERE request_id=$1",[g.request_id]);return {error:'INVALID_CARD_CODE'};
   }
   if(input.currency!==g.currency_code)fault('CURRENCY_MISMATCH','currency');
   const to=await this.route(db,input.to,g.currency_code,'to');text(input.reference,'reference',128);
   const journalId=await this.post(db,actor,k,'CODED_CARD_REDEEM',input.reference,[line(g.hold_account_id,'DEBIT',g.amount),line(to.ledger_account_id,'CREDIT',g.amount)]);
   await db.query("UPDATE avis_core_v2.coded_card_debits SET status='REDEEMED',redemption_journal_id=$2 WHERE request_id=$1",[g.request_id,journalId]);
   return {id:g.request_id,journalId,amount:g.amount,currency:g.currency_code,status:'REDEEMED'};
  });
  if(result.error)fault(result.error,'code');return result;
 }
 async cancelCodedDebit(actor,input,key){
  return this.operation(actor,'CANCEL_CODED_CARD',input,key,async(db,k)=>{
   const g=(await db.query('SELECT * FROM avis_core_v2.coded_card_debits WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   if(!g||g.status==='REDEEMED')fault('CARD_CODE_CLOSED','requestId');
   if(g.status==='CANCELLED')return {id:g.request_id,status:'CANCELLED'};
   const r=(await db.query('SELECT * FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1 FOR UPDATE',[g.request_id])).rows[0];
   const journalId=await this.post(db,actor,k,'CODED_CARD_CANCELLED',r.instruction.reference,[line(g.hold_account_id,'DEBIT',g.amount),line(r.source_account_id,'CREDIT',g.amount)],r.reservation_journal_id);
   await db.query("UPDATE avis_core_v2.coded_card_debits SET status='CANCELLED' WHERE request_id=$1",[g.request_id]);
   await db.query("UPDATE avis_core_v2.asset_transfer_requests SET status='CANCELLED',settlement_journal_id=$2 WHERE request_id=$1",[g.request_id,journalId]);return {id:g.request_id,journalId,status:'CANCELLED'};
  });
 }
 async externalCardDetails(actor,input,key){
  // A picked-up instruction is required before revealing its card data.
  await this.operation(actor,'VIEW_PICKED_UP_CARD',{requestId:input.requestId},key,async db=>{
   const row=(await db.query(`SELECT r.request_id FROM avis_core_v2.asset_transfer_requests r JOIN avis_core_v2.transfer_pickups p USING(request_id)
    WHERE r.request_id=$1 AND r.status='OUTGOING' AND r.external_card_id IS NOT NULL AND p.actor_id=$2`,[input.requestId,actor.id])).rows[0];
   if(!row)fault('TRANSFER_PICKUP_REQUIRED','requestId');return {id:row.request_id};
  });
  const c=(await this.pool.query(`SELECT c.* FROM avis_core_v2.external_payment_cards c JOIN avis_core_v2.asset_transfer_requests r ON r.external_card_id=c.card_id JOIN avis_core_v2.transfer_pickups p ON p.request_id=r.request_id WHERE r.request_id=$1 AND r.status='OUTGOING' AND p.actor_id=$2`,[input.requestId,actor.id])).rows[0];
  if(!c)fault('TRANSFER_PICKUP_REQUIRED','requestId');
  return {holder:c.holder_name,...unseal(c.sealed_details,'external-card:'+c.card_id,this.secretEnv)};
 }
 async cancelPayment(actor,input,key){
  const r=(await this.pool.query('SELECT request_id FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1',[input.requestId])).rows[0];
  if(!r)return super.cancelPayment(actor,input,key);
  return this.operation(actor,'CANCEL_ASSET_TRANSFER',input,key,async(db,k)=>{
   const r=(await db.query('SELECT * FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   if(r.status==='CANCELLED')return {id:r.request_id,status:r.status};
   if(r.status!=='OUTGOING')fault('PAYMENT_REQUEST_CLOSED','requestId');
   const hold=await this.networkAccount(db,'SUSPENSE_OUTBOUND',r.currency_code,r.network,r.request_id);
   const journalId=await this.post(db,actor,k,'TRANSFER_CANCELLED',r.instruction.reference,[line(hold,'DEBIT',r.amount),line(r.source_account_id,'CREDIT',r.amount)],r.reservation_journal_id);
   await db.query("UPDATE avis_core_v2.asset_transfer_requests SET status='CANCELLED',settlement_journal_id=$2 WHERE request_id=$1",[r.request_id,journalId]);
   return {id:r.request_id,status:'CANCELLED'};
  });
 }
 async pickupTransfer(actor,input,key){
  return this.operation(actor,'PICKUP_TRANSFER',input,key,async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['pickup:'+input.requestId]);
   const r=await this.requestOn(db,input.requestId);
   if(!r||!['OUTGOING','PROCESSING'].includes(r.status))fault('PAYMENT_REQUEST_CLOSED','requestId');
   const existing=(await db.query('SELECT actor_id FROM avis_core_v2.transfer_pickups WHERE request_id=$1',[input.requestId])).rows[0];
   if(existing&&existing.actor_id!==actor.id)fault('TRANSFER_ALREADY_CLAIMED','requestId');
   await db.query('INSERT INTO avis_core_v2.transfer_pickups(request_id,actor_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[input.requestId,actor.id]);return {id:input.requestId,status:'CLAIMED'};
  });
 }
 async requestOn(db,id){
  return (await db.query('SELECT *,true AS asset_request FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1',[id])).rows[0]||
   (await db.query('SELECT *,COALESCE(execution_mode,delivery_mode) AS delivery_mode,false AS asset_request FROM avis_core_v2.payment_requests WHERE request_id=$1',[id])).rows[0];
 }
 async settleManualTransfer(actor,input,key){
  text(input.settlementReference,'settlementReference',140);
  return this.operation(actor,'SETTLE_MANUAL_TRANSFER',input,key,async(db,k)=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['pickup:'+input.requestId]);
   const r=await this.requestOn(db,input.requestId);if(!r)fault('PAYMENT_REQUEST_NOT_FOUND','requestId');
   // Only never-dispatched manual requests can be settled here. Uncertain bank delivery retains its separate reconciliation path.
   if(r.delivery_mode!=='MANUAL'||r.status!=='OUTGOING')fault('PAYMENT_REQUEST_CLOSED','requestId');
   const pickup=(await db.query('SELECT * FROM avis_core_v2.transfer_pickups WHERE request_id=$1',[input.requestId])).rows[0];
   if(!pickup||pickup.actor_id!==actor.id)fault('TRANSFER_PICKUP_REQUIRED','requestId');
   const table=r.asset_request?'asset_transfer_requests':'payment_requests';
   await db.query('SELECT request_id FROM avis_core_v2.'+table+' WHERE request_id=$1 FOR UPDATE',[input.requestId]);
   const current=(await db.query('SELECT status FROM avis_core_v2.'+table+' WHERE request_id=$1',[input.requestId])).rows[0];if(current.status!=='OUTGOING')fault('PAYMENT_REQUEST_CLOSED','requestId');
   const network=r.network||null,settlement=(await db.query(`SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1 AND owner_type IN ('CORRESPONDENT_NOSTRO','HOT_WALLET','TREASURY') AND account_category='ASSET' FOR UPDATE`,[input.settlementAccountId])).rows[0];
   if(!settlement||settlement.currency_code!==r.currency_code||settlement.network!==network||units(settlement.available_balance)-units(settlement.locked_balance)<money(r.amount)||settlement.sub_account_code.startsWith('UAT_OPENING'))fault('SETTLEMENT_ACCOUNT_REQUIRED','settlementAccountId');
   const hold=await this.networkAccount(db,'SUSPENSE_OUTBOUND',r.currency_code,network,r.request_id);
   const journalId=await this.post(db,actor,k,'MANUAL_TRANSFER_SETTLED',input.settlementReference,[line(hold,'DEBIT',r.amount),line(settlement.account_id,'CREDIT',r.amount)]);
   if(r.asset_request)await db.query("UPDATE avis_core_v2.asset_transfer_requests SET status='COMPLETED',settlement_journal_id=$2,completed_at=now() WHERE request_id=$1",[r.request_id,journalId]);
   else await db.query("UPDATE avis_core_v2.payment_requests SET status='COMPLETED' WHERE request_id=$1",[r.request_id]);
   await db.query('UPDATE avis_core_v2.transfer_pickups SET settlement_reference=$2,completed_at=now() WHERE request_id=$1',[r.request_id,input.settlementReference]);
   return {id:r.request_id,journalId,status:'COMPLETED'};
  });
 }
 async registerCryptoOffer(actor,input,key){
  const price=decimal(money(input.unitPrice));
  return this.operation(actor,'REGISTER_CRYPTO_OFFER',input,key,async db=>{
   const stock=(await db.query(`SELECT a.*,u.account_role FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.sovereign_users u USING(user_id)
    WHERE a.account_id=$1 AND a.owner_type='USER' AND a.wallet_scope='FUNDING' AND a.account_category='LIABILITY' AND a.network IS NOT NULL`,[input.stockAccountId])).rows[0];
   const proceeds=await this.route(db,input.proceedsAccount,input.fiatCurrency,'proceedsAccount');
   if(stock?.account_role!=='INSTITUTION'||String(stock.user_id)!==String(proceeds.user_id))fault('CRYPTO_STOCK_REQUIRED','stockAccountId');
   const id=randomUUID();await db.query('INSERT INTO avis_core_v2.crypto_sale_offers(offer_id,stock_account_id,proceeds_account_id,unit_price) VALUES($1,$2,$3,$4)',[id,stock.account_id,proceeds.ledger_account_id,price]);return {id};
  });
 }
 async purchaseCrypto(actor,input,key){
  const quantity=money(input.quantity),reference=text(input.reference,'reference',128);
  return this.operation(actor,'PURCHASE_CRYPTO',input,key,async(db,k)=>{
   const offer=(await db.query(`SELECT o.*,s.currency_code AS asset,s.network,s.user_id AS seller_id,p.currency_code AS fiat
    FROM avis_core_v2.crypto_sale_offers o JOIN avis_core_v2.ledger_accounts s ON s.account_id=o.stock_account_id
    JOIN avis_core_v2.ledger_accounts p ON p.account_id=o.proceeds_account_id WHERE offer_id=$1 AND is_active FOR SHARE OF o`,[input.offerId])).rows[0];
   if(!offer)fault('CRYPTO_OFFER_REQUIRED','offerId');if(money(input.unitPrice)!==money(offer.unit_price))fault('CRYPTO_PRICE_CHANGED','offerId');
   const source=await this.route(db,input.from,offer.fiat,'from');if(String(source.user_id)===String(offer.seller_id))fault('SAME_ACCOUNT','from');
   const quantum=offer.fiat==='JPY'?10n**18n:10n**16n,raw=quantity*money(offer.unit_price),divisor=10n**18n*quantum,total=((raw+divisor-1n)/divisor)*quantum;
   if(money(input.total)!==total)fault('CRYPTO_PRICE_CHANGED','amount');
   const target=await this.networkAccount(db,'USER',offer.asset,offer.network,'CRYPTO',source.user_id);
   const journalId=await this.post(db,actor,k,'CRYPTO_PURCHASE',reference,[line(source.ledger_account_id,'DEBIT',decimal(total)),line(offer.proceeds_account_id,'CREDIT',decimal(total)),line(offer.stock_account_id,'DEBIT',decimal(quantity)),line(target,'CREDIT',decimal(quantity))]);
   return {journalId,asset:offer.asset,quantity:decimal(quantity),total:decimal(total),currency:offer.fiat};
  });
 }
 async list(actor,view){
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  if(view==='cryptoholdings')return (await this.pool.query(`SELECT a.account_id,a.user_id,u.full_name,u.account_role,a.currency_code,a.network,a.available_balance::text,a.locked_balance::text
   FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.sovereign_users u USING(user_id) WHERE a.owner_type='USER' AND a.network IS NOT NULL AND a.wallet_scope='FUNDING' AND a.account_category='LIABILITY' ORDER BY a.user_id,a.currency_code,a.network LIMIT 500`)).rows;
  if(view==='transfercards')return (await this.pool.query(`SELECT c.card_id,c.user_id,u.full_name,c.last_four_digits,c.card_type,c.card_rail_mode,a.currency_code,COALESCE(p.available_balance,0)::text AS available_balance,
   COALESCE((SELECT sum(g.amount) FROM avis_core_v2.coded_card_debits g WHERE g.card_id=c.card_id AND g.status IN ('ACTIVE','LOCKED')),0)::text AS offline_reserved
   FROM avis_core_v2.avis_cards c JOIN avis_core_v2.sovereign_users u USING(user_id) JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.funding_account_id
   LEFT JOIN avis_core_v2.ledger_accounts p ON p.account_id=c.stored_value_account_id WHERE c.status='ACTIVE' ORDER BY c.created_at DESC LIMIT 300`)).rows;
  if(view==='externalcards')return (await this.pool.query('SELECT card_id,user_id,holder_name,last_four FROM avis_core_v2.external_payment_cards ORDER BY created_at DESC LIMIT 300')).rows;
  if(view==='codedcards')return (await this.pool.query(`SELECT g.request_id,c.user_id,c.last_four_digits,g.amount::text,g.currency_code,g.valid_from,g.expires_at,g.status FROM avis_core_v2.coded_card_debits g JOIN avis_core_v2.avis_cards c USING(card_id) ORDER BY g.expires_at DESC LIMIT 300`)).rows;
  if(view==='cryptooffers')return (await this.pool.query(`SELECT o.offer_id,o.unit_price::text,s.currency_code AS asset,s.network,s.available_balance::text,p.currency_code AS fiat
   FROM avis_core_v2.crypto_sale_offers o JOIN avis_core_v2.ledger_accounts s ON s.account_id=o.stock_account_id JOIN avis_core_v2.ledger_accounts p ON p.account_id=o.proceeds_account_id WHERE o.is_active ORDER BY o.created_at DESC LIMIT 300`)).rows;
  if(view==='paymentregister'||view==='transferrequests'||view==='transferalerts'){
   const banks=await super.list(actor,view==='paymentregister'?'paymentregister':'transferrequests');
   const assets=(await this.pool.query(`SELECT * FROM avis_core_v2.asset_transfer_requests WHERE status<>'REVIEW' ${view==='paymentregister'?'':"AND delivery_mode='MANUAL'"} ORDER BY created_at DESC LIMIT 300`)).rows.map(r=>{
    const {sealed_delivery,instruction,message_content,...safe}=fields(r);return {...safe,beneficiary_name:instruction.receiverName,beneficiary_account:instruction.destinationLabel,payment_reference:instruction.reference};
   });
   const pickups=new Map((await this.pool.query('SELECT * FROM avis_core_v2.transfer_pickups')).rows.map(r=>[r.request_id,r]));
   let rows=[...banks.map(r=>({...r,payment_method:'BANK'})),...assets].map(r=>({...r,pickup:pickups.get(r.request_id)?.actor_id||null})).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,300);
   if(view==='transferalerts')rows=rows.filter(r=>r.status==='OUTGOING'||(r.status==='PROCESSING'&&r.delivery!=='ACKNOWLEDGED'));return rows;
  }
  return super.list(actor,view);
 }
}
