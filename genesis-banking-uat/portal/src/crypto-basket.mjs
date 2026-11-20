import {MetaMaskPricing} from './metamask-pricing.mjs';
import {CheckoutTender,breakdown} from './checkout-crypto-tender.mjs';
import {transferRoutesSql,transferMethod,matchTransfer} from './crypto-basket-transfer.mjs';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {decimal,fault,money,text} from './core.mjs';

const S='avis_core_v2.', unit=10n**18n, bps=10000n;
const currencies=new Set(['EUR','USD','GBP','CHF']);
const bankTransfer=method=>method==='WIRE'||method==='INTERBANK';
const own=asset=>asset==='AG'||asset==='AGi';
const ceil=(n,d)=>(n+d-1n)/d;
const digest=s=>createHash('sha256').update(s).digest('hex');
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const minor=s=>money(s,2);
const entry=(accountId,direction,amount)=>({accountId,direction,amount});
const reject=(code,field,status=409)=>fault(code,field,status);
const admin=a=>{if(!a?.admin||!a.id||a.customerUserId)fault('FORBIDDEN',null,403);};
const integer=(v,max,field)=>{if(!Number.isInteger(v)||v<0||v>max)fault('INVALID_FIELD',field);return v;};
const sameQty=(a,b)=>money(a)===money(b);
const lines=(order,from,to)=>[entry(from,'DEBIT',order.quantity),entry(to,'CREDIT',order.quantity)];
export const BASKET_MESSAGES={
 METAMASK_PRICE:'The live MetaMask price could not be refreshed. Request a new quote.',BASKET_PRICE:'A treasury price is required for this asset and currency.',BASKET_WALLET:'Select an accepted wallet with sufficient available funds.',BASKET_METHOD:'Select a payment method offered for this order.',BASKET_SESSION:'Open Purchase crypto from your AVISPay wallet.',BASKET_ORDER:'Open the order from its AVISPay checkout.',
 BASKET_STOCK:'This quantity needs a new treasury quote.',BASKET_COST:'Select a confirmed treasury deposit and its MetaMask provider purchase receipt.',
 BASKET_CARD:'Select a payment method available for this currency.',BASKET_REVIEW:'Review a new quote for this purchase.',
 BASKET_SELF:'Select the purchasing customer workspace to complete this order.',BASKET_LIMIT:'Complete an existing checkout before opening another.',
 BASKET_CHECKOUT:'Open the basket checkout to purchase this currency.'
};
export function priceBasket({quantity,lotQuantity,lotCost,unitPrice,markup=0,cardBps=0,fixedMinor=0}){
 const qty=money(quantity);
 const cost=lotQuantity?ceil(qty*BigInt(lotCost),money(lotQuantity)):ceil(qty*money(unitPrice)*100n,unit*unit);
 const benefit=ceil(cost*BigInt(markup),bps);
 const gross=ceil((cost+benefit+BigInt(fixedMinor))*bps,bps-BigInt(cardBps));
 if(gross<=0n||gross>=10n**20n)fault('INVALID_AMOUNT','quantity');
 return {costMinor:String(cost),markupMinor:String(benefit),collectionCostMinor:String(gross-cost-benefit),totalMinor:String(gross),total:decimal(gross,2)};
}
const offerSql=`SELECT o.offer_id,o.stock_account_id,o.proceeds_account_id,o.unit_price::text,s.currency_code AS asset,s.network,s.user_id AS seller,p.currency_code AS fiat,
 LEAST(s.available_balance-s.locked_balance,COALESCE(l.remaining,s.available_balance))::text AS available,
 l.quantity::text AS lot_quantity,l.cost_minor,l.gas_minor,l.remaining::text,l.deposit_journal,n.decimals,n.contract_address
 FROM avis_core_v2.crypto_sale_offers o JOIN avis_core_v2.ledger_accounts s ON s.account_id=o.stock_account_id
 JOIN avis_core_v2.holder_identities h ON h.record_user_id=s.user_id AND h.account_role='INSTITUTION'
 JOIN avis_core_v2.ledger_accounts p ON p.account_id=o.proceeds_account_id
 JOIN avis_core_v2.crypto_assets a ON a.currency_code=s.currency_code
 JOIN avis_core_v2.crypto_asset_networks n ON n.asset_id=a.asset_id AND n.network=s.network AND n.approved AND n.verified_at IS NOT NULL
 LEFT JOIN avis_core_v2.crypto_basket_lots l USING(offer_id)
 WHERE o.is_active AND p.currency_code IN ('EUR','USD','GBP','CHF') AND
 (s.currency_code IN ('AG','AGi') OR (l.offer_id IS NOT NULL AND NOT EXISTS
 (SELECT 1 FROM avis_core_v2.crypto_wallet_deposits d WHERE d.journal_id=l.deposit_journal AND d.reorg_detected_at IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM avis_core_v2.ledger_journals j WHERE j.reverses_journal_id=l.deposit_journal)))`;
export class CryptoBasket {
 constructor(core,stripe,{pricing=new MetaMaskPricing({env:core.secretEnv||process.env,rpcFees:network=>core.chain.provider(network).getFeeData()})}={}){this.core=core;this.pool=core.pool;this.stripe=stripe;this.pricing=pricing;this.tender=new CheckoutTender(core,pricing);}
 async transaction(fn){const db=await this.pool.connect();try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
 async buyer(db,actor){if(!actor?.id)fault('UNAUTHORIZED',null,401);
  if(actor.customerUserId)return String(actor.identityUserId||actor.customerUserId);
  admin(actor);const row=(await db.query("SELECT user_id FROM avis_core_v2.sovereign_users WHERE account_role='INSTITUTION' AND merged_into_user_id IS NULL AND full_name='AVISPay PLC'")).rows[0];
  if(!row)reject('BASKET_SESSION');return String(row.user_id);}
 async start(actor){
  const token=randomBytes(32).toString('hex'),buyer=await this.buyer(this.pool,actor);
  await this.pool.query('INSERT INTO '+S+'crypto_basket_sessions(session_id,token_hash,buyer_id,opened_by,expires_at) VALUES($1,$2,$3,$4,now()+interval \'4 hours\')',[randomUUID(),digest(token),buyer,actor.id]);
  return {token};
 }
 async session(db,token){if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))reject('BASKET_SESSION',null,401);
  const row=(await db.query('SELECT * FROM '+S+'crypto_basket_sessions WHERE token_hash=$1 AND expires_at>now()',[digest(token)])).rows[0];
  if(!row)reject('BASKET_SESSION',null,401);return row;}
 async policy(actor){admin(actor);const db=this.pool;
  const policy=(await db.query('SELECT markup_bps,participation_bps,procurement_region,procurement_method FROM '+S+'crypto_basket_policy')).rows[0];
  const requests=(await db.query("SELECT order_id,status,asset,network,quantity::text,created_at FROM avis_core_v2.crypto_basket_orders WHERE status IN ('SOURCING','REVIEW') ORDER BY created_at DESC LIMIT 40")).rows;
  const receipts=(await db.query(`SELECT DISTINCT j.journal_id,s.currency_code,s.network,t.tx_hash,e.amount::text,j.created_at
   FROM avis_core_v2.onchain_transactions t JOIN avis_core_v2.ledger_journals j ON j.journal_id=t.journal_id
   JOIN avis_core_v2.ledger_entries e ON e.journal_id=j.journal_id AND e.direction='CREDIT'
   JOIN avis_core_v2.ledger_accounts s ON s.account_id=e.account_id AND s.user_id=t.user_id AND s.network=t.network AND s.currency_code=t.currency_code
   JOIN avis_core_v2.holder_identities h ON h.record_user_id=s.user_id AND h.account_role='INSTITUTION'
   WHERE s.wallet_scope='FUNDING' AND s.currency_code NOT IN ('AG','AGi') AND t.tx_type='WALLET_DEPOSIT' AND t.status='CONFIRMED'
   AND (s.network<>'ETHEREUM' OR EXISTS(SELECT 1 FROM avis_core_v2.crypto_wallet_deposits d WHERE d.journal_id=j.journal_id AND d.reorg_detected_at IS NULL))
   AND NOT EXISTS(SELECT 1 FROM avis_core_v2.crypto_basket_lots l WHERE l.deposit_journal=j.journal_id AND l.gas_minor IS NOT NULL)
   AND NOT EXISTS(SELECT 1 FROM avis_core_v2.ledger_journals rev WHERE rev.reverses_journal_id=j.journal_id) ORDER BY j.created_at DESC LIMIT 100`)).rows;
  return {...policy,requests,receipts,cardCurrencies:(await db.query('SELECT fiat FROM '+S+'crypto_basket_card_terms ORDER BY fiat')).rows.map(r=>r.fiat)};
 }
 async setPolicy(actor,input,key){admin(actor);const markup=integer(input.markupBps,10000,'markupBps'),part=integer(input.participationBps,10000,'participationBps');
  return this.core.operation(actor,'CRYPTO_BASKET_POLICY',{markup,part},key,async db=>{
   await db.query('UPDATE '+S+'crypto_basket_policy SET markup_bps=$1,participation_bps=$2,updated_by=$3,updated_at=now()',[markup,part,actor.id]);return {markupBps:markup,participationBps:part};});}
 async setCard(actor,input,key){admin(actor);if(!currencies.has(input.fiat))fault('INVALID_FIELD','fiat');
  const publicKey=input.publishableKey?.trim()||null;
  if(publicKey&&!/^pk_(live|test)_[A-Za-z0-9]+$/.test(publicKey))fault('INVALID_FIELD','publishableKey');
  const approval=text(input.approvalReference,'approvalReference',150),rate=integer(input.feeBps,9999,'feeBps'),fixed=integer(input.fixedMinor,100000,'fixedMinor');
  return this.core.operation(actor,'CRYPTO_BASKET_CARD_TERMS',{fiat:input.fiat,approval,rate,fixed,publicKey},key,async db=>{
   await db.query(`INSERT INTO avis_core_v2.crypto_basket_card_terms(fiat,fee_bps,fixed_minor,approval_reference,updated_by,publishable_key) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(fiat) DO UPDATE SET fee_bps=EXCLUDED.fee_bps,fixed_minor=EXCLUDED.fixed_minor,publishable_key=EXCLUDED.publishable_key,approval_reference=EXCLUDED.approval_reference,updated_by=EXCLUDED.updated_by,updated_at=now()`,[input.fiat,rate,fixed,approval,actor.id,publicKey]);return {currency:input.fiat};});}
 async registerLot(actor,input,key){
  admin(actor);if(!currencies.has(input.fiat)||!uuid(input.journalId))reject('BASKET_COST','journalId');
  const cost=minor(input.cost),gas=/^0(?:\.0{1,2})?$/.test(input.gasCost)?0n:minor(input.gasCost);
  if(gas>cost)fault('INVALID_AMOUNT','gasCost');
  const ref=text(input.providerReference,'providerReference',140);
  if(cost>9223372036854775807n)fault('INVALID_AMOUNT','cost');
  return this.core.operation(actor,'METAMASK_PURCHASE_LOT',{journal:input.journalId,fiat:input.fiat,cost:String(cost),gas:String(gas),ref},key,async db=>{
   const receipt=(await db.query(`SELECT e.account_id,e.amount::text,s.user_id,s.currency_code,s.network,h.user_id AS institution
    FROM avis_core_v2.ledger_entries e JOIN avis_core_v2.ledger_accounts s ON s.account_id=e.account_id
    JOIN avis_core_v2.holder_identities h ON h.record_user_id=s.user_id
    WHERE e.journal_id=$1 AND e.direction='CREDIT' AND h.account_role='INSTITUTION' AND s.wallet_scope='FUNDING'
    AND s.owner_type='USER' AND s.currency_code NOT IN ('AG','AGi') AND s.network IS NOT NULL
    AND EXISTS(SELECT 1 FROM avis_core_v2.onchain_transactions t WHERE t.journal_id=e.journal_id AND t.user_id=s.user_id AND t.network=s.network AND t.currency_code=s.currency_code AND t.tx_type='WALLET_DEPOSIT' AND t.status='CONFIRMED')
    AND (s.network<>'ETHEREUM' OR EXISTS(SELECT 1 FROM avis_core_v2.crypto_wallet_deposits d WHERE d.journal_id=e.journal_id AND d.account_id=s.account_id AND d.amount=e.amount AND d.reorg_detected_at IS NULL))
    AND NOT EXISTS(SELECT 1 FROM avis_core_v2.ledger_journals j WHERE j.reverses_journal_id=e.journal_id)`,[input.journalId])).rows;
   if(receipt.length!==1)reject('BASKET_COST','journalId');
   const r=receipt[0],proceeds=await this.core.userFunding(db,r.institution,input.fiat),id=randomUUID();
   const prior=(await db.query('SELECT l.*,p.currency_code AS fiat FROM avis_core_v2.crypto_basket_lots l JOIN avis_core_v2.crypto_sale_offers o USING(offer_id) JOIN avis_core_v2.ledger_accounts p ON p.account_id=o.proceeds_account_id WHERE deposit_journal=$1 FOR UPDATE OF l',[input.journalId])).rows[0];
   if(prior){if(prior.gas_minor!==null||prior.provider_reference!==ref||BigInt(prior.cost_minor)!==cost||prior.fiat!==input.fiat)reject('BASKET_COST','journalId');
    await db.query('UPDATE avis_core_v2.crypto_basket_lots SET gas_minor=$2 WHERE offer_id=$1',[prior.offer_id,String(gas)]);return {id:prior.offer_id};}
   const price=decimal(ceil(cost*unit*unit,100n*money(r.amount)));
   await db.query('INSERT INTO '+S+'crypto_sale_offers(offer_id,stock_account_id,proceeds_account_id,unit_price) VALUES($1,$2,$3,$4)',[id,r.account_id,proceeds,price]);
   await db.query('INSERT INTO '+S+'crypto_basket_lots(offer_id,deposit_journal,provider_reference,cost_minor,quantity,remaining,registered_by,gas_minor) VALUES($1,$2,$3,$4,$5,$5,$6,$7)',[id,input.journalId,ref,String(cost),r.amount,actor.id,String(gas)]);
   return {id,asset:r.currency_code,quantity:r.amount};});
 }
 async procurement(actor,input,key){
  admin(actor);const region=String(input.region||'').toLowerCase().trim(),method=String(input.payment||'').trim();
  if(!/^[a-z]{2}(?:-[a-z0-9]{1,4})?$/.test(region)||!/^[/a-zA-Z0-9_-]{1,100}$/.test(method))fault('INVALID_FIELD','region');
  return this.core.operation(actor,'CHECKOUT_METAMASK_ROUTE',{region,method},key,async db=>{await db.query('UPDATE '+S+'crypto_basket_policy SET procurement_region=$1,procurement_method=$2,updated_by=$3,updated_at=now()',[region,method,actor.id]);return {region,method};});
 }
 async market(token,input,adminActor=null){
  if(adminActor)admin(adminActor);else await this.session(this.pool,token);
  if(!currencies.has(input.fiat))fault('INVALID_FIELD','fiat');
  const asset=(await this.pool.query(`SELECT a.currency_code AS asset,n.* FROM avis_core_v2.crypto_assets a JOIN avis_core_v2.crypto_asset_networks n USING(asset_id) WHERE a.currency_code=$1 AND n.network=$2 AND n.approved AND n.verified_at IS NOT NULL`,[input.asset,input.network])).rows[0];
  if(!asset)fault('CRYPTO_APPROVAL_REQUIRED','asset');const price=await this.tender.rate(this.pool,asset,input.fiat);
  const gas=adminActor?await this.pricing.networkGas(asset.network).catch(()=>null):null;
  const policy=(await this.pool.query('SELECT * FROM '+S+'crypto_basket_policy')).rows[0];
  const card=input.method==='CARD'?(await this.pool.query('SELECT fee_bps,fixed_minor FROM '+S+'crypto_basket_card_terms WHERE fiat=$1',[input.fiat])).rows[0]:null;
  let supplier=null,preview=null,budget=input.budget||'',quantity=input.quantity||'',supplierStatus=null;
  if(quantity){const q=money(quantity);if(!budget)budget=decimal(ceil(q*money(price.rate)*100n,unit*unit),2);
   const lot=(await this.pool.query(offerSql+' AND s.currency_code=$1 AND s.network=$2 AND p.currency_code=$3 AND l.gas_minor IS NOT NULL AND l.remaining >= $4 AND s.available_balance-s.locked_balance >= $4 ORDER BY o.created_at LIMIT 1',[asset.asset,asset.network,input.fiat,quantity])).rows[0];
   if(lot&&policy.markup_bps>0)preview=breakdown(quantity,lot.lot_quantity,lot.cost_minor,lot.gas_minor,price.rate,policy.markup_bps,card?.fee_bps||0,card?.fixed_minor||0);
  }
  if(budget&&price.assetId&&(adminActor||!preview)){
   money(budget,2);
   const address=(await this.pool.query(`SELECT COALESCE(specific.public_address,main.public_address) AS public_address
    FROM avis_core_v2.sovereign_users u LEFT JOIN avis_core_v2.crypto_asset_wallet_routes r ON r.user_id=u.user_id AND r.asset_id=$1 AND r.network=$2
    LEFT JOIN avis_core_v2.user_deposit_addresses specific ON specific.address_id=r.address_id
    LEFT JOIN avis_core_v2.user_deposit_addresses main ON main.user_id=u.user_id AND main.network=$2 AND main.is_primary
    WHERE u.account_role='INSTITUTION' AND u.full_name='AVISPay PLC' AND u.merged_into_user_id IS NULL`,[asset.asset_id,asset.network])).rows[0]?.public_address;
   try{supplier=await this.pricing.acquisition({assetId:price.assetId,fiat:input.fiat,budget,address,region:policy.procurement_region||undefined,payment:policy.procurement_method||undefined});}
   catch{supplierStatus='The MetaMask supplier quote could not be refreshed.';}
   if(!preview&&supplier&&quantity&&policy.markup_bps>0)preview=breakdown(quantity,supplier.quantity,supplier.totalMinor,supplier.gasMinor,price.rate,policy.markup_bps,card?.fee_bps||0,card?.fixed_minor||0);
  }
  return {asset:asset.asset,network:asset.network,fiat:input.fiat,...price,...(adminActor?{gas,supplier,supplierStatus}:{}),preview:preview?{principal:preview.principal,fee:preview.fee,total:preview.total}:null};
 }
 async state(token){
  const session=await this.session(this.pool,token);
  const assets=(await this.pool.query(`SELECT a.currency_code AS asset,a.name,n.network,n.decimals FROM avis_core_v2.crypto_assets a JOIN avis_core_v2.crypto_asset_networks n USING(asset_id)
   WHERE n.approved AND n.verified_at IS NOT NULL ORDER BY a.market_rank NULLS LAST,a.name,n.network`)).rows;
  const offers=(await this.pool.query(offerSql+' ORDER BY o.created_at')).rows;
  const card=(await this.pool.query('SELECT fiat FROM '+S+'crypto_basket_card_terms')).rows;
  const routes=(await this.pool.query(transferRoutesSql)).rows;
  const orders=(await this.pool.query(`SELECT order_id AS id,status,asset,network,quantity::text,fiat,method,request_key AS "requestKey",expires_at AS "expiresAt",terms->>'total' AS total,terms->>'principal' AS principal,terms->>'fee' AS fee,terms->'pay' AS pay,tender_wallet AS "walletId",CASE WHEN status='AWAITING_TRANSFER' THEN terms->'bankRoute' END AS transfer FROM avis_core_v2.crypto_basket_orders
   WHERE session_id=$1 ORDER BY created_at DESC LIMIT 8`,[session.session_id])).rows;
  const funds=await this.tender.choices(this.pool,session.buyer_id);
  return {assets,wallets:funds.map(w=>({id:w.account_id,asset:w.asset,network:w.network,available:w.spendable})),offers:offers.filter(r=>Number(r.available)>0).map(r=>({id:r.offer_id,asset:r.asset,network:r.network,fiat:r.fiat,available:r.available})),cardCurrencies:card.map(r=>r.fiat),transferMethods:routes.map(r=>({fiat:r.fiat,method:transferMethod(r.protocol)})),orders};
 }
 async quote(token,input){
  if(!uuid(input.requestKey)||!['ACCOUNT','CARD','WIRE','INTERBANK','CRYPTO'].includes(input.method)||!currencies.has(input.fiat))fault('INVALID_FIELD','method');
  const qty=money(input.quantity),asset=text(input.asset,'asset',25),network=text(input.network,'network',32);
  return this.transaction(async db=>{
   const s=await this.session(db,token);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['basket-buyer:'+s.buyer_id]);
   const prior=(await db.query('SELECT * FROM '+S+'crypto_basket_orders WHERE session_id=$1 AND request_key=$2',[s.session_id,input.requestKey])).rows[0];
   if(input.method==='CRYPTO'&&!uuid(input.walletId))fault('BASKET_WALLET','wallet');
   if(prior){if((prior.tender_wallet||null)!==(input.method==='CRYPTO'?input.walletId:null)||prior.method!==input.method||prior.fiat!==input.fiat||prior.asset!==asset||prior.network!==network||!sameQty(prior.quantity,input.quantity))fault('IDEMPOTENCY_CONFLICT',null,409);if(prior.status!=='SOURCING')return this.publicOrder(prior);}
   const accepted=(await db.query('SELECT n.decimals FROM '+S+'crypto_assets a JOIN '+S+'crypto_asset_networks n USING(asset_id) WHERE a.currency_code=$1 AND n.network=$2 AND n.approved AND n.verified_at IS NOT NULL',[asset,network])).rows[0];
   if(!accepted||accepted.decimals===null||qty%10n**BigInt(18-accepted.decimals)!==0n)fault('CRYPTO_AMOUNT_PRECISION','quantity');
   const card=input.method==='CARD'?(await db.query('SELECT * FROM '+S+'crypto_basket_card_terms WHERE fiat=$1',[input.fiat])).rows[0]:null;
   if(input.method==='CARD'&&!card)reject('BASKET_CARD','method');
   const policy=(await db.query('SELECT * FROM '+S+'crypto_basket_policy')).rows[0];
   const rows=(await db.query(offerSql+' AND s.currency_code=$1 AND s.network=$2 AND p.currency_code=$3 AND s.available_balance-s.locked_balance >= $4 AND (l.remaining IS NULL OR l.remaining >= $4) ORDER BY o.created_at,o.offer_id LIMIT 1',[asset,network,input.fiat,decimal(qty)])).rows;
   const offer=rows[0],available=offer&&(own(asset)||policy.markup_bps>0&&offer.gas_minor!==null);
   let bankRoute=null;
   if(bankTransfer(input.method)){
    const routes=(await db.query(transferRoutesSql+' AND b.currency_code=$1 ORDER BY b.bridge_id',[input.fiat])).rows;
    const route=routes.find(r=>transferMethod(r.protocol)===input.method&&(!offer||r.ledger_account_id===offer.proceeds_account_id));
    if(!route)reject('BASKET_METHOD','method');
    bankRoute={account:route.account,bic:route.bic,beneficiary:route.beneficiary,profile:route.profile};
   }
   if(prior&&!available)return this.publicOrder(prior);
   const recent=await db.query("SELECT count(*)::int AS n FROM avis_core_v2.crypto_basket_orders WHERE buyer_id=$1 AND created_at>now()-interval '1 hour'",[s.buyer_id]);if(!prior&&recent.rows[0].n>=60)reject('BASKET_LIMIT');
   let terms=null;
   if(available){const external=!own(asset);terms={...priceBasket({quantity:input.quantity,lotQuantity:offer.lot_quantity,lotCost:offer.cost_minor,unitPrice:offer.unit_price,markup:external?policy.markup_bps:0,cardBps:card?.fee_bps||0,fixedMinor:card?.fixed_minor||0}),
    markupBps:external?policy.markup_bps:0,participationBps:external?policy.participation_bps:0,
    bankRoute,publishableKey:card?.publishable_key||null,stock:offer.stock_account_id,proceeds:offer.proceeds_account_id,seller:String(offer.seller),source:external?'METAMASK':'TREASURY'};
    if(external){
     const price=await this.pricing.spot(offer,input.fiat);Object.assign(terms,breakdown(input.quantity,offer.lot_quantity,offer.cost_minor,offer.gas_minor,price.rate,policy.markup_bps,card?.fee_bps||0,card?.fixed_minor||0),{marketRate:price.rate,marketTime:price.observedAt});
    }else{terms.principal=decimal(BigInt(terms.costMinor),2);terms.fee=decimal(BigInt(terms.totalMinor)-BigInt(terms.costMinor),2);}
    if(input.method==='CRYPTO'){terms.pay=await this.tender.quote(db,s.buyer_id,input.walletId,terms.totalMinor,input.fiat);if(terms.pay.asset===asset&&terms.pay.network===network)reject('BASKET_WALLET','wallet');}
    if(input.method==='CARD'&&BigInt(terms.totalMinor)>99999999n)reject('BASKET_METHOD','method');}
   if(prior){const renewed=(await db.query("UPDATE avis_core_v2.crypto_basket_orders SET status='QUOTED',offer_id=$2,terms=$3,expires_at=now()+interval '60 seconds' WHERE order_id=$1 RETURNING *",[prior.order_id,offer.offer_id,JSON.stringify(terms)])).rows[0];return this.publicOrder(renewed);}
   const row=(await db.query(`INSERT INTO avis_core_v2.crypto_basket_orders(order_id,session_id,buyer_id,request_key,asset,network,quantity,fiat,method,offer_id,terms,status,tender_wallet,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+interval '60 seconds') RETURNING *`,[randomUUID(),s.session_id,s.buyer_id,input.requestKey,asset,network,decimal(qty),input.fiat,input.method,available?offer.offer_id:null,terms?JSON.stringify(terms):null,available?'QUOTED':'SOURCING',input.method==='CRYPTO'?input.walletId:null])).rows[0];
   return this.publicOrder(row);});
 }
 publicOrder(r){return {id:r.order_id,status:r.status,asset:r.asset,network:r.network,quantity:r.quantity,fiat:r.fiat,method:r.method,requestKey:r.request_key,walletId:r.tender_wallet||undefined,pay:r.terms?.pay,principal:r.terms?.principal,fee:r.terms?.fee,total:r.terms?.total,expiresAt:r.expires_at,...(r.status==='AWAITING_TRANSFER'?{transfer:r.terms.bankRoute}:{})};}
 async orderForBuyer(actor,id){if(!uuid(id))reject('BASKET_ORDER',null,404);
  const buyer=await this.buyer(this.pool,actor);
  const r=(await this.pool.query('SELECT * FROM '+S+'crypto_basket_orders WHERE order_id=$1 AND buyer_id=$2',[id,buyer])).rows[0];
  if(!r)reject('BASKET_ORDER',null,404);return this.publicOrder(r);}
 async reserve(db,r){
  if(r.status!=='QUOTED'||new Date(r.expires_at)<=new Date())reject('BASKET_REVIEW');
  if(String(r.buyer_id)===r.terms.seller)reject('BASKET_SELF');
  // Lock the stock before checking spendable units. Moving them into escrow also protects
  // this reservation from every other wallet action, including a simultaneous withdrawal.
  await db.query('SELECT account_id FROM '+S+'ledger_accounts WHERE account_id=$1 FOR UPDATE',[r.terms.stock]);
  const offer=(await db.query(offerSql+' AND o.offer_id=$1 AND s.available_balance-s.locked_balance >= $2',[r.offer_id,r.quantity])).rows[0];
  if(!offer)reject('BASKET_STOCK','quantity');
  if(offer.deposit_journal){const lot=await db.query('UPDATE '+S+'crypto_basket_lots SET remaining=remaining-$2 WHERE offer_id=$1 AND remaining >= $2 RETURNING offer_id',[r.offer_id,r.quantity]);if(!lot.rows[0])reject('BASKET_STOCK','quantity');}
  const escrow=await this.core.networkAccount(db,'MARKETPLACE_ESCROW',r.asset,r.network,'CRYPTO_BASKET');
  const journal=await this.core.post(db,{id:'system:crypto-basket'},'basket-reserve:'+r.order_id,'CRYPTO_BASKET_RESERVE',r.order_id,lines(r,r.terms.stock,escrow));
  await db.query("UPDATE avis_core_v2.crypto_basket_orders SET status='RESERVED',reserved_journal=$2,expires_at=date_trunc('second',now())+interval '60 minutes' WHERE order_id=$1",[r.order_id,journal]);
 }
 async settle(db,r,source){
  if(r.terms.source==='METAMASK'){
   const evidence=(await db.query(`SELECT l.deposit_journal FROM avis_core_v2.crypto_basket_lots l WHERE l.offer_id=$1
    AND NOT EXISTS(SELECT 1 FROM avis_core_v2.crypto_wallet_deposits d WHERE d.journal_id=l.deposit_journal AND d.reorg_detected_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM avis_core_v2.ledger_journals j WHERE j.reverses_journal_id=l.deposit_journal)`,[r.offer_id])).rows[0];
   if(!evidence){await db.query("UPDATE avis_core_v2.crypto_basket_orders SET status='REVIEW' WHERE order_id=$1",[r.order_id]);return {id:r.order_id,status:'REVIEW'};}
  }
  const escrow=await this.core.networkAccount(db,'MARKETPLACE_ESCROW',r.asset,r.network,'CRYPTO_BASKET');
  const target=await this.core.networkAccount(db,'USER',r.asset,r.network,'CRYPTO',r.buyer_id);
  const journal=await this.core.post(db,{id:'system:crypto-basket'},'basket-sale:'+r.order_id,'CRYPTO_BASKET_PURCHASE',r.order_id,
   [...(Array.isArray(source)?source:source?[entry(source,'DEBIT',r.terms.total),entry(r.terms.proceeds,'CREDIT',r.terms.total)]:[]),...lines(r,escrow,target)]);
  await db.query("UPDATE avis_core_v2.crypto_basket_orders SET status='PAID',settlement_journal=$2 WHERE order_id=$1",[r.order_id,journal]);
  return {id:r.order_id,status:'PAID',journalId:journal};}
 async confirmAccount(actor,input){
  if(!uuid(input.id))reject('BASKET_ORDER',null,404);
  return this.transaction(async db=>{const buyer=await this.buyer(db,actor);
   const r=(await db.query('SELECT * FROM '+S+'crypto_basket_orders WHERE order_id=$1 AND buyer_id=$2 FOR UPDATE',[input.id,buyer])).rows[0];
   if(!r||!['ACCOUNT','CRYPTO'].includes(r.method))reject('BASKET_ORDER',null,404);
   if(r.status==='PAID')return {id:r.order_id,status:r.status,journalId:r.settlement_journal};
   if(r.terms?.total!==input.total||r.method==='CRYPTO'&&(r.terms.pay.walletId!==input.walletId||r.terms.pay.quantity!==input.quantity))reject('BASKET_REVIEW');
   const source=r.method==='CRYPTO'?await this.tender.paymentLines(db,buyer,r.terms.pay,r.terms.seller):await this.core.userFunding(db,buyer,r.fiat);
   await this.reserve(db,r);return this.settle(db,r,source);});}
 async release(db,r,status){
  if(r.settlement_journal||!['RESERVED','CARD_OPEN','AWAITING_TRANSFER'].includes(r.status))return;
  const escrow=await this.core.networkAccount(db,'MARKETPLACE_ESCROW',r.asset,r.network,'CRYPTO_BASKET');
  await this.core.post(db,{id:'system:crypto-basket'},'basket-release:'+r.order_id,'CRYPTO_BASKET_RELEASE',r.order_id,lines(r,escrow,r.terms.stock));
  await db.query('UPDATE '+S+'crypto_basket_lots SET remaining=remaining+$2 WHERE offer_id=$1',[r.offer_id,r.quantity]);
  await db.query('UPDATE '+S+'crypto_basket_orders SET status=$2 WHERE order_id=$1',[r.order_id,status]);}
 async transfer(token,id){
  if(!uuid(id))reject('BASKET_ORDER',null,404);
  return this.transaction(async db=>{
   const session=await this.session(db,token);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['basket-buyer:'+session.buyer_id]);
   const r=(await db.query('SELECT * FROM '+S+'crypto_basket_orders WHERE order_id=$1 AND session_id=$2 FOR UPDATE',[id,session.session_id])).rows[0];
   if(!r||!bankTransfer(r.method))reject('BASKET_ORDER',null,404);
   if(r.status==='QUOTED'){
    const open=await db.query("SELECT count(*)::int n FROM avis_core_v2.crypto_basket_orders WHERE buyer_id=$1 AND status='AWAITING_TRANSFER'",[r.buyer_id]);if(open.rows[0].n>=3)reject('BASKET_LIMIT');
    await this.reserve(db,r);
    const fresh=(await db.query("UPDATE avis_core_v2.crypto_basket_orders SET status='AWAITING_TRANSFER',expires_at=now()+interval '48 hours' WHERE order_id=$1 RETURNING *",[id])).rows[0];return this.publicOrder(fresh);
   }
   return this.publicOrder(r);
  });
 }
 async recoverTransfers(){
  // Rotate the scan through all due records, including orders without an incoming payment.
  const rows=(await this.pool.query("SELECT order_id FROM avis_core_v2.crypto_basket_orders WHERE status='AWAITING_TRANSFER' ORDER BY last_checked NULLS FIRST,created_at LIMIT 40")).rows;
  for(const row of rows)await this.transaction(async db=>{
   const r=(await db.query("SELECT * FROM avis_core_v2.crypto_basket_orders WHERE order_id=$1 AND status='AWAITING_TRANSFER' FOR UPDATE SKIP LOCKED",[row.order_id])).rows[0];
   if(!r)return;
   const jid=await matchTransfer(db,r);
   if(jid){await db.query('UPDATE '+S+'crypto_basket_orders SET funding_journal=$2 WHERE order_id=$1',[r.order_id,jid]);await this.settle(db,r,null);}
   else if(Date.parse(r.expires_at)<=Date.now())await this.release(db,r,'EXPIRED');
   else await db.query('UPDATE '+S+'crypto_basket_orders SET last_checked=now() WHERE order_id=$1',[r.order_id]);
  });
 }
 stripeMode(publicKey){
  const k=this.stripe.secretKey(),pk=publicKey||this.stripe.env.STRIPE_PUBLISHABLE_KEY;
  if(!/^whsec_[A-Za-z0-9]+$/.test(this.stripe.env.STRIPE_WEBHOOK_SECRET||''))fault('STRIPE_CONFIGURATION',null,503);
  return {key:k,pk:typeof pk==='string'&&pk.startsWith('pk_'+k.split('_')[1]+'_')?pk:null,live:k.split('_')[1]==='live'};
 }
 async card(token,id){
  if(!uuid(id))reject('BASKET_ORDER',null,404);
  const r=await this.transaction(async db=>{
   const s=await this.session(db,token),order=(await db.query('SELECT * FROM '+S+'crypto_basket_orders WHERE order_id=$1 AND session_id=$2 FOR UPDATE',[id,s.session_id])).rows[0];
   if(!order||order.method!=='CARD')reject('BASKET_ORDER',null,404);
   if(order.status==='PAID')return order;
   const config=this.stripeMode(order.terms?.publishableKey);
   if(!(await db.query('SELECT 1 FROM '+S+'crypto_basket_card_terms WHERE fiat=$1',[order.fiat])).rows.length)reject('BASKET_CARD','method');
   if(order.status==='QUOTED'){
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['basket-buyer:'+order.buyer_id]);
    const active=await db.query("SELECT order_id FROM avis_core_v2.crypto_basket_orders WHERE buyer_id=$1 AND status IN ('RESERVED','CARD_OPEN') AND order_id<>$2",[order.buyer_id,id]);
    if(active.rows.length>=3)reject('BASKET_LIMIT');await this.reserve(db,order);
    await db.query('UPDATE '+S+'crypto_basket_orders SET stripe_mode=$2 WHERE order_id=$1',[id,config.pk?'embedded':'hosted']);
   }else if(!['RESERVED','CARD_OPEN'].includes(order.status))reject('BASKET_REVIEW');
   return (await db.query('SELECT * FROM '+S+'crypto_basket_orders WHERE order_id=$1',[id])).rows[0];
  });if(r.status==='PAID')return this.publicOrder(r);return this.providerSession(r);
 }
 async providerSession(r,config=this.stripeMode(r.terms?.publishableKey)){
  const base='https://api.stripe.com/v1/checkout/sessions',returnUrl='https://avis.land/avispay/checkout?source=crypto&own=1&order='+r.order_id;
  const embedded=r.stripe_mode==='embedded',form=new URLSearchParams({mode:'payment',client_reference_id:r.order_id,
   'metadata[source]':'AVISPAY_CRYPTO_BASKET','metadata[order_id]':r.order_id,'payment_intent_data[metadata][source]':'AVISPAY_CRYPTO_BASKET','payment_intent_data[metadata][order_id]':r.order_id,
   'line_items[0][price_data][currency]':r.fiat.toLowerCase(),'line_items[0][price_data][unit_amount]':r.terms.totalMinor,
   'line_items[0][price_data][product_data][name]':'AVISPay · '+r.quantity.replace(/\.?0+$/,'')+' '+r.asset+' · '+r.network,'line_items[0][quantity]':'1',
   expires_at:String(Math.floor(Date.parse(r.expires_at)/1000)),...(embedded?{ui_mode:'embedded_page',return_url:returnUrl}:{success_url:returnUrl,cancel_url:returnUrl})});
  let response;
  try{response=await this.stripe.fetcher(r.stripe_session?base+'/'+encodeURIComponent(r.stripe_session):base,{
   method:r.stripe_session?'GET':'POST',redirect:'error',headers:{authorization:'Bearer '+config.key,'Stripe-Version':'2026-11-18.endive','content-type':'application/x-www-form-urlencoded','idempotency-key':'crypto-basket-'+r.order_id},
   ...(r.stripe_session?{}:{body:form.toString()}),signal:AbortSignal.timeout(12000)});}catch{fault('STRIPE_PROVIDER_RESPONSE',null,503);}
  if(!response.ok){
   // An explicit validation rejection creates no Checkout Session. An ambiguous network/5xx
   // result retains the reservation and is recovered under the same provider idempotency key.
   if(!r.stripe_session&&response.status===400){
    await this.transaction(async db=>{const current=(await db.query('SELECT * FROM '+S+'crypto_basket_orders WHERE order_id=$1 FOR UPDATE',[r.order_id])).rows[0];
     if(current.status==='RESERVED'&&!current.stripe_session)await this.release(db,current,'FAILED');});
   }
   fault('STRIPE_PROVIDER_RESPONSE',null,503);
  }
  const session=await response.json();
  if(!/^cs_(live|test)_[A-Za-z0-9]+$/.test(session.id||'')||session.livemode!==config.live||session.client_reference_id!==r.order_id||session.metadata?.source!=='AVISPAY_CRYPTO_BASKET'||session.metadata?.order_id!==r.order_id||session.amount_total!==Number(r.terms.totalMinor)||session.currency?.toUpperCase()!==r.fiat)fault('STRIPE_EVENT_MISMATCH',null,422);
  await this.pool.query("UPDATE avis_core_v2.crypto_basket_orders SET stripe_session=$2,status=CASE WHEN status='RESERVED' THEN 'CARD_OPEN' ELSE status END WHERE order_id=$1 AND (stripe_session IS NULL OR stripe_session=$2)",[r.order_id,session.id]);
  if(session.status==='expired'){
   await this.transaction(async db=>{const current=(await db.query('SELECT * FROM '+S+'crypto_basket_orders WHERE order_id=$1 FOR UPDATE',[r.order_id])).rows[0];await this.release(db,current,'EXPIRED');});
   return {id:r.order_id,status:'EXPIRED'};}
  if(session.status==='complete'){
   if(session.payment_status!=='paid'||!session.payment_intent)return {id:r.order_id,status:'PROCESSING'};
   return this.transaction(async db=>{const saved=(await db.query('SELECT * FROM '+S+'crypto_basket_orders WHERE order_id=$1 FOR UPDATE',[r.order_id])).rows[0];
    if(saved.settlement_journal)return this.publicOrder(saved);
    if(!['CARD_OPEN','RESERVED'].includes(saved.status)||typeof session.payment_intent!=='string')reject('BASKET_REVIEW');
    await db.query('UPDATE '+S+'crypto_basket_orders SET stripe_intent=$2 WHERE order_id=$1',[r.order_id,session.payment_intent]);
    return this.settle(db,saved,await this.core.system(db,'EXCHANGE_CLEARING',saved.fiat,'STRIPE_CRYPTO','ASSET'));});
  }
  if(embedded){if(!config.pk||!session.client_secret)fault('STRIPE_PROVIDER_RESPONSE',null,503);return {id:r.order_id,clientSecret:session.client_secret,publishableKey:config.pk};}
  let url;try{url=new URL(session.url);}catch{fault('STRIPE_PROVIDER_RESPONSE',null,503);}
  if(url.origin!=='https://checkout.stripe.com'||url.username||url.password)fault('STRIPE_PROVIDER_RESPONSE',null,503);
  return {id:r.order_id,checkoutUrl:url.href};
 }
 async recover(){
  await this.recoverTransfers();
  const pending=(await this.pool.query("SELECT * FROM avis_core_v2.crypto_basket_orders WHERE (status='RESERVED' AND expires_at<now()+interval '58 minutes') OR (status='CARD_OPEN' AND expires_at<now()) ORDER BY expires_at LIMIT 20")).rows;
  for(const row of pending){try{await this.providerSession(row);}catch(e){console.error(JSON.stringify({operation:'CRYPTO_BASKET_RECOVERY',order:row.order_id,code:e.code||'STRIPE_PROVIDER_RESPONSE'}));}}
 }
 async event(event){
  const obj=event.data?.object,checkout=event.type?.startsWith('checkout.session.'),pi=typeof obj?.payment_intent==='string'?obj.payment_intent:obj?.payment_intent?.id;
  if(checkout&&obj?.metadata?.source!=='AVISPAY_CRYPTO_BASKET')return {received:true,ignored:true};
  if(!checkout&&(!pi||!['charge.refunded','charge.dispute.created'].includes(event.type)))return {received:true,ignored:true};
  if(checkout&&!uuid(obj.metadata.order_id))fault('STRIPE_EVENT_MISMATCH',null,422);
  return this.transaction(async db=>{
   const r=(await db.query('SELECT * FROM '+S+'crypto_basket_orders WHERE '+(checkout?'order_id=$1':'stripe_intent=$1')+' FOR UPDATE',[checkout?obj.metadata.order_id:pi])).rows[0];
   if(!r){if(checkout)fault('STRIPE_EVENT_MISMATCH',null,422);return {received:true,ignored:true};}
   if(event.livemode!==this.stripeMode().live||r.method!=='CARD'||checkout&&(obj.client_reference_id!==r.order_id||obj.mode!=='payment'||obj.currency?.toUpperCase()!==r.fiat||obj.amount_total!==Number(r.terms.totalMinor)||
    (r.stripe_session&&r.stripe_session!==obj.id)||!/^cs_(live|test)_[A-Za-z0-9]+$/.test(obj.id)||r.stripe_intent&&pi&&r.stripe_intent!==pi))fault('STRIPE_EVENT_MISMATCH',null,422);
   const receipt=await db.query('INSERT INTO '+S+'crypto_basket_stripe_events(event_id,order_id,event_type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id',[event.id,r.order_id,event.type]);
   if(!receipt.rows.length)return {received:true,duplicate:true};
   if(checkout)await db.query('UPDATE '+S+'crypto_basket_orders SET stripe_session=COALESCE(stripe_session,$2),stripe_intent=COALESCE(stripe_intent,$3) WHERE order_id=$1',[r.order_id,obj.id,pi||null]);
   if(!checkout){await db.query("UPDATE avis_core_v2.crypto_basket_orders SET status='REVIEW' WHERE order_id=$1",[r.order_id]);}
   else if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)&&obj.payment_status==='paid'&&!r.settlement_journal){
    if(!pi||!['RESERVED','CARD_OPEN'].includes(r.status))fault('STRIPE_EVENT_MISMATCH',null,422);
    await this.settle(db,r,await this.core.system(db,'EXCHANGE_CLEARING',r.fiat,'STRIPE_CRYPTO','ASSET'));
   }else if(['checkout.session.expired','checkout.session.async_payment_failed'].includes(event.type)){
    await this.release(db,r,event.type==='checkout.session.expired'?'EXPIRED':'FAILED');
   }
   return {received:true,orderId:r.order_id};});
 }
}
