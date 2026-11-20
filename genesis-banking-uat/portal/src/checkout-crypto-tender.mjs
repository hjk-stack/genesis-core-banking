import {money,decimal,fault} from './core.mjs';
import {valuedTender} from './metamask-pricing.mjs';
const s='avis_core_v2.',unit=10n**18n;
const accepted=`SELECT a.asset_id,a.currency_code AS asset,a.name,n.network,n.contract_address,n.decimals
 FROM avis_core_v2.crypto_assets a JOIN avis_core_v2.crypto_asset_networks n USING(asset_id)
 WHERE n.approved AND n.verified_at IS NOT NULL AND n.decimals IS NOT NULL`;
const wallets=`SELECT w.account_id,w.currency_code AS asset,w.network,n.asset_id,n.contract_address,n.decimals,(w.available_balance-w.locked_balance)::text AS spendable,h.user_id AS holder
 FROM avis_core_v2.ledger_accounts w JOIN avis_core_v2.holder_identities h ON h.record_user_id=w.user_id
 JOIN avis_core_v2.crypto_assets a ON a.currency_code=w.currency_code JOIN avis_core_v2.checkout_crypto_tenders t ON t.asset_id=a.asset_id AND t.network=w.network
 JOIN avis_core_v2.crypto_asset_networks n ON n.asset_id=t.asset_id AND n.network=t.network AND n.approved AND n.verified_at IS NOT NULL
 WHERE w.owner_type='USER' AND w.wallet_scope='FUNDING' AND w.account_category='LIABILITY' AND w.available_balance>w.locked_balance`;
const isAdmin=actor=>{if(!actor?.admin||actor.customerUserId)fault('FORBIDDEN',null,403);};
export class CheckoutTender {
 constructor(core,pricing){this.core=core;this.pool=core.pool;this.pricing=pricing;}
 async catalog(actor){isAdmin(actor);return (await this.pool.query('SELECT a.*,t.asset_id IS NOT NULL AS accepted FROM ('+accepted+') a LEFT JOIN '+s+'checkout_crypto_tenders t USING(asset_id,network) ORDER BY a.name,a.network')).rows;}
 async configure(actor,input,key){isAdmin(actor);if(typeof input.accepted!=='boolean'||typeof input.assetId!=='string'||typeof input.network!=='string')fault('INVALID_FIELD','accepted');
  return this.core.operation(actor,'CHECKOUT_TENDER_ACCEPTANCE',input,key,async db=>{
   if(input.accepted){const result=await db.query('INSERT INTO '+s+'checkout_crypto_tenders(asset_id,network,updated_by) SELECT asset_id,network,$3 FROM ('+accepted+') a WHERE asset_id=$1 AND network=$2 ON CONFLICT(asset_id,network) DO UPDATE SET updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING asset_id',[input.assetId,input.network,actor.id]);if(!result.rows.length)fault('CRYPTO_APPROVAL_REQUIRED','assetId');}
   else await db.query('DELETE FROM '+s+'checkout_crypto_tenders WHERE asset_id=$1 AND network=$2',[input.assetId,input.network]);return {id:input.assetId,accepted:input.accepted};});
 }
 async choices(db,buyer){return (await db.query(wallets+' AND h.user_id=$1 ORDER BY w.currency_code,w.network,w.account_id',[buyer])).rows;}
 async rate(db,asset,fiat){
  if(['AG','AGi'].includes(asset.asset)){
   if(asset.asset==='AG'&&fiat==='USD')return {rate:'1',source:'AVIS treasury',observedAt:Date.now()};
   const value=(await db.query(`SELECT o.unit_price::text FROM avis_core_v2.crypto_sale_offers o JOIN avis_core_v2.ledger_accounts stock ON stock.account_id=o.stock_account_id
    JOIN avis_core_v2.holder_identities h ON h.record_user_id=stock.user_id AND h.account_role='INSTITUTION'
    JOIN avis_core_v2.ledger_accounts p ON p.account_id=o.proceeds_account_id WHERE o.is_active AND stock.currency_code=$1 AND stock.network=$2 AND p.currency_code=$3 ORDER BY o.created_at DESC LIMIT 1`,[asset.asset,asset.network,fiat])).rows[0];
   if(!value&&asset.asset==='AG'){
    const rows=(await db.query("SELECT currency_code,units_per_eur::text,source_date FROM avis_core_v2.fx_reference_rates WHERE currency_code=ANY($1::text[]) AND source_date>=current_date-7",[['USD',fiat]])).rows;
    const usd=rows.find(r=>r.currency_code==='USD'),target=rows.find(r=>r.currency_code===fiat);
    if(usd&&(target||fiat==='EUR')&&(!target||String(usd.source_date)===String(target.source_date)))return {rate:decimal((target?money(target.units_per_eur):unit)*unit/money(usd.units_per_eur)),source:'AVIS treasury / ECB',observedAt:new Date(usd.source_date).getTime()};
   }
   if(!value)fault('BASKET_PRICE','wallet');return {rate:value.unit_price,source:'AVIS treasury',observedAt:Date.now()};
  }
  return this.pricing.spot(asset,fiat);
 }
 async quote(db,buyer,id,totalMinor,fiat){
  const w=(await db.query(wallets+' AND h.user_id=$1 AND w.account_id=$2',[buyer,id])).rows[0];if(!w)fault('BASKET_WALLET','wallet');
  const price=await this.rate(db,w,fiat),quantity=valuedTender(totalMinor,price.rate,w.decimals);
  if(money(quantity)>money(w.spendable))fault('INSUFFICIENT_FUNDS','wallet');
  return {walletId:w.account_id,asset:w.asset,network:w.network,quantity,rate:price.rate,observedAt:price.observedAt};
 }
 async paymentLines(db,buyer,pay,merchantId){
  const w=(await db.query(wallets+' AND h.user_id=$1 AND w.account_id=$2 FOR UPDATE OF w',[buyer,pay.walletId])).rows[0];
  if(!w||w.asset!==pay.asset||w.network!==pay.network||money(w.spendable)<money(pay.quantity))fault('BASKET_WALLET','wallet');
  const target=await this.core.networkAccount(db,'USER',pay.asset,pay.network,'CRYPTO',merchantId);
  if(target===w.account_id)fault('BASKET_SELF','wallet');
  return [{accountId:w.account_id,direction:'DEBIT',amount:pay.quantity},{accountId:target,direction:'CREDIT',amount:pay.quantity}];
 }
}
export function breakdown(quantity,lotQuantity,cost,gas,liveRate,markup,cardBps=0,fixedMinor=0){
 const ceil=(n,d)=>(n+d-1n)/d,q=money(quantity),lot=money(lotQuantity),actual=ceil(q*BigInt(cost),lot);
 const allocatedGas=ceil(q*BigInt(gas),lot),market=ceil(q*money(liveRate)*100n,unit*unit);
 const principal=market>actual-allocatedGas?market:actual-allocatedGas;
 const commission=ceil((principal+allocatedGas)*BigInt(markup),10000n);
 const total=ceil((principal+allocatedGas+commission+BigInt(fixedMinor))*10000n,10000n-BigInt(cardBps));
 if(total<=0n||total>=10n**20n)fault('INVALID_AMOUNT','quantity');
 return {costMinor:String(actual),principalMinor:String(principal),gasMinor:String(allocatedGas),markupMinor:String(commission),collectionCostMinor:String(total-principal-allocatedGas-commission),
  feeMinor:String(total-principal),principal:decimal(principal,2),fee:decimal(total-principal,2),totalMinor:String(total),total:decimal(total,2)};
}
