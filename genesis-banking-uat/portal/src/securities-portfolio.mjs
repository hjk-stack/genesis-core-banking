import {createHash,randomUUID} from 'node:crypto';
import {AccountManagement} from './account-management.mjs';
import {fault,text,money,decimal} from './core.mjs';
import {ABIQ_PARTITIONS} from './avispay-core-accounts.mjs';

const scale=10n**18n,units=v=>String(v).match(/^0(?:\.0+)?$/)?0n:money(String(v));
const line=(accountId,direction,amount)=>({accountId,direction,amount});
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const actualAdmin=a=>{if(!a?.admin||a.customerUserId)fault('FORBIDDEN',null,403);};
const access=(a,userId)=>{if(!a?.admin||(a.customerUserId&&String(a.customerUserId)!==String(userId)))fault('FORBIDDEN',null,403);};
const quantum=currency=>currency==='JPY'?scale:10n**16n;
const quantityUnits=(value,security)=>{const n=units(value);if(n%(10n**BigInt(18-security.quantity_decimals))!==0n)fault('SECURITY_QUANTITY_PRECISION','quantity');return n;};
export function securityValue(quantity,denomination,price,basis,currency){
 const q=units(quantity),p=units(price),d=money(String(denomination));
 const numerator=basis==='PERCENT'?q*d*p:q*p,divisor=basis==='PERCENT'?scale*scale*100n:scale;
 const cents=quantum(currency),result=((numerator+divisor*cents/2n)/(divisor*cents))*cents;
 if(result>=10n**36n)fault('INVALID_AMOUNT','total');return decimal(result);
}
function identifier(value,field,pattern){if(!value)return null;const s=text(value,field,20).toUpperCase();if(!pattern.test(s))fault('INVALID_FIELD',field);return s;}
export function securityMetadata(input){
 const name=text(input.name,'name',200),shortName=text(input.shortName,'shortName',80),currency=text(input.currency,'currency',3).toUpperCase();
 if(!Object.hasOwn(ABIQ_PARTITIONS,currency))fault('INVALID_FIELD','currency');
 const denomination=decimal(money(input.denomination));if(!['PERCENT','UNIT'].includes(input.quoteBasis))fault('INVALID_FIELD','quoteBasis');
 const isin=identifier(input.isin,'isin',/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/),cusip=identifier(input.cusip,'cusip',/^[A-Z0-9*@#]{8}[0-9]$/);
 if(isin){const digits=[...isin].map(c=>/[A-Z]/.test(c)?String(c.charCodeAt(0)-55):c).join('');let sum=0;[...digits].reverse().forEach((v,i)=>{let n=Number(v)*(i%2?2:1);sum+=n>9?n-9:n;});if(sum%10)fault('INVALID_FIELD','isin');}
 if(cusip){let sum=0;[...cusip.slice(0,8)].forEach((c,i)=>{let n=(/[A-Z]/.test(c)?c.charCodeAt(0)-55:/[0-9]/.test(c)?Number(c):{'*':36,'@':37,'#':38}[c])*(i%2?2:1);sum+=Math.floor(n/10)+n%10;});if((10-sum%10)%10!==Number(cusip[8]))fault('INVALID_FIELD','cusip');}
 const kind=['bond','note','cd','share','fund','token','other'].includes(input.kind)?input.kind:'other';
 const quantityDecimals=Number(input.quantityDecimals??0);if(!Number.isInteger(quantityDecimals)||quantityDecimals<0||quantityDecimals>18)fault('INVALID_FIELD','quantityDecimals');
 return {name,shortName,currency,denomination,quoteBasis:input.quoteBasis,quantityDecimals,isin,cusip,kind};
}
// The registered AVIS Greens assets are also portfolio-selectable, not duplicate treasury stock.
// Contract IDs identify the canonical Ethereum instruments; do not book the 10bn supply to clients.
export const AVIS_GREEN_PORTFOLIO_TOKENS=Object.freeze([
 {symbol:'AG',name:'AVIS Greens Stablecoin',contract:'0x713d3a1785219aeb37e52260ff8f96660851842b'},
 {symbol:'AGi',name:'AVIS Greens Invest Coin',contract:'0x0482213c1e5a9fefdee36d9b01c044938403a9af'}
]);
const registeredGreenToken=token=>({
 ...securityMetadata({name:token.name,shortName:token.symbol,currency:'USD',denomination:'1',quoteBasis:'UNIT',
  quantityDecimals:18,kind:'token'}),symbol:token.symbol.toUpperCase(),referencePrice:'0.000000000000000000'
});
function catalogueRow(s){
 const kind=String(s.kind||'').toLowerCase(),symbol=String(s.symbol||s.shortName||'').toUpperCase();
 if(!['bond','note','cd','share','fund','token','crypto','asset','commodity','future','other'].includes(kind)||!symbol)return null;
 // Preserve every registered identifier and distinguish token units from percentage-quoted notes.
 const crypto=['token','crypto','asset'].includes(kind);
 return {...securityMetadata({name:s.name||s.title||symbol,shortName:s.shortName||s.symbol||symbol,
  currency:s.currency||s.currency_code||'USD',denomination:String(s.nominal||s.denomination||'1'),
  quoteBasis:['bond','note','cd'].includes(kind)?'PERCENT':'UNIT',
  quantityDecimals:s.decimals??s.quantityDecimals??(crypto?18:0),
  isin:s.isin||null,cusip:s.cusip||null,kind:crypto?'token':kind==='future'?'other':kind}),
  symbol,referencePrice:decimal(money(String(s.last||s.refPrice||s.referencePrice||'0'))) };
}
export async function greenBondCatalogue(fetcher=fetch){
 const privateUrl=process.env.GREEN_BOND_DATABANK_CATALOGUE_URL?.trim();
 const token=process.env.GREEN_BOND_DATABANK_CATALOGUE_TOKEN?.trim();
 // A separate authenticated administrative feed returns ALL Green Bond Databank securities,
 // including drafts and privately registered instruments. The public feed cannot do that.
 const url=privateUrl&&token?privateUrl:'https://avis.land/api/xchg/markets';
 const headers={accept:'application/json',...(privateUrl&&token?{'x-avis-portfolio-token':token}:{})};
 const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(20000),headers});
 if(!response.ok)fault('SECURITY_CATALOGUE_READ',null,503);
 const raw=await response.text();if(Buffer.byteLength(raw)>8_000_000)fault('SECURITY_CATALOGUE_READ',null,503);
 let feed;try{feed=JSON.parse(raw);}catch{fault('SECURITY_CATALOGUE_READ',null,503);}
 const rows=Array.isArray(feed.securities)?feed.securities:Array.isArray(feed.markets)?feed.markets:null;
 if(!rows)fault('SECURITY_CATALOGUE_READ',null,503);
 const registry=(Array.isArray(feed.securities)?rows:rows.filter(s=>s.status==='listed')).map(catalogueRow).filter(Boolean);
 const bySymbol=new Map(registry.map(s=>[s.symbol,s]));
 for(const token of AVIS_GREEN_PORTFOLIO_TOKENS)if(!bySymbol.has(token.symbol.toUpperCase()))bySymbol.set(token.symbol.toUpperCase(),registeredGreenToken(token));
 return [...bySymbol.values()];
}

const securitySelect=`SELECT security_id,name,short_name,currency_code,isin,cusip,denomination::text,quote_basis,quantity_decimals,kind,source,exchange_symbol,reference_price::text,source_updated_at FROM avis_core_v2.portfolio_securities`;
const positionSelect=`SELECT p.position_id,p.user_id,u.full_name,s.security_id,s.name,s.short_name,s.currency_code,s.isin,s.cusip,s.denomination::text,s.quote_basis,s.source,s.exchange_symbol,
 p.quantity::text,p.reserved_quantity::text,(p.quantity-p.reserved_quantity)::text AS available_quantity,p.issuing_price::text,p.market_price::text,p.version,p.updated_at
 FROM avis_core_v2.portfolio_positions p JOIN avis_core_v2.portfolio_securities s USING(security_id) JOIN avis_core_v2.sovereign_users u USING(user_id)`;

export class SecuritiesPortfolio extends AccountManagement {
 constructor(pool,options={}){super(pool,options);this.readCatalogue=options.readCatalogue||greenBondCatalogue;}
 async upsertSecurity(db,s,actorId){
  s={...s,symbol:String(s.symbol).toUpperCase()};
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['catalogue:'+s.symbol]);
    const old=(await db.query('SELECT * FROM avis_core_v2.portfolio_securities WHERE upper(exchange_symbol)=$1 OR (isin IS NOT NULL AND isin=$2) FOR UPDATE',[s.symbol,s.isin])).rows[0];
    if(old){
     if(old.currency_code!==s.currency||money(old.denomination)!==money(s.denomination)||old.quote_basis!==s.quoteBasis||old.quantity_decimals!==s.quantityDecimals||(old.isin&&s.isin&&old.isin!==s.isin))fault('SECURITY_TERMS_CHANGED','securityId',409);
     await db.query(`UPDATE avis_core_v2.portfolio_securities SET name=$2,short_name=$3,cusip=COALESCE($4,cusip),exchange_symbol=$5,source='GREEN_BOND',reference_price=$6,source_updated_at=now() WHERE security_id=$1`,[old.security_id,s.name,s.shortName,s.cusip,s.symbol,s.referencePrice]);
    }else await db.query(`INSERT INTO avis_core_v2.portfolio_securities(name,short_name,currency_code,isin,cusip,denomination,quote_basis,kind,source,exchange_symbol,reference_price,source_updated_at,created_by,quantity_decimals) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'GREEN_BOND',$9,$10,now(),$11,$12)`,[s.name,s.shortName,s.currency,s.isin,s.cusip,s.denomination,s.quoteBasis,s.kind,s.symbol,s.referencePrice,actorId,s.quantityDecimals]);
  return (await db.query(securitySelect+' WHERE exchange_symbol=$1',[s.symbol])).rows[0];
 }
 async publishedSecurity(symbol){
  if(typeof symbol!=='string'||! /^[A-Z0-9._-]{1,80}$/.test(symbol))fault('INVALID_FIELD','symbol');
  if(!this.catalogueCache||Date.now()-this.catalogueCache.at>5000){
   if(!this.cataloguePending)this.cataloguePending=this.readCatalogue().then(rows=>{rows=rows.map(s=>({...s,symbol:String(s.symbol).toUpperCase()}));this.catalogueCache={at:Date.now(),rows};return rows;}).finally(()=>{this.cataloguePending=null;});
   await this.cataloguePending;
  }
  const published=this.catalogueCache.rows.find(s=>s.symbol===symbol||s.isin===symbol);
  if(!published)fault('SECURITY_NOT_FOUND','symbol',404);return published;
 }
 async resolveExchangeSecurity(actor,input,key){
  const symbol=text(input.symbol,'symbol',80).toUpperCase();
  return this.operation(actor,'RESOLVE_EXCHANGE_SECURITY',{symbol},key,async db=>{
   const s=await this.publishedSecurity(symbol),registered=await this.upsertSecurity(db,s,actor.id);
   return {id:registered.security_id,symbol:s.symbol};
  });
 }
 async publicExchangeMarket(symbol){
  const published=await this.publishedSecurity(symbol);
  const s=(await this.pool.query(securitySelect+" WHERE upper(exchange_symbol)=$1 AND source='GREEN_BOND'",[published.symbol])).rows[0];
  if(s&&(s.currency_code!==published.currency||money(s.denomination)!==money(published.denomination)||s.quote_basis!==published.quoteBasis||s.quantity_decimals!==published.quantityDecimals||(s.isin&&published.isin&&s.isin!==published.isin)))fault('SECURITY_TERMS_CHANGED','symbol',409);
  const offers=s?(await this.pool.query(`SELECT side,price::text,quantity::text,count(*)::int AS orders FROM avis_core_v2.securities_orders WHERE security_id=$1 AND status='OPEN' GROUP BY side,price,quantity ORDER BY side,price,quantity LIMIT 200`,[s.security_id])).rows:[];
  // One BUY row per settled pair; no customer, order, journal or account identifiers.
  const trades=s?(await this.pool.query(`SELECT price::text,quantity::text,executed_at FROM avis_core_v2.securities_orders WHERE security_id=$1 AND status='FILLED' AND side='BUY' ORDER BY executed_at DESC LIMIT 100`,[s.security_id])).rows:[];
  return {symbol:published.symbol,currency:published.currency,quoteBasis:published.quoteBasis,denomination:published.denomination,offers,trades};
 }
 async syncSecurities(actor,input,key){
  actualAdmin(actor);
  return this.operation(actor,'SYNC_SECURITIES_CATALOGUE',{},key,async db=>{
   const rows=await this.readCatalogue();
   let imported=0;
   for(const s of rows){
    await this.upsertSecurity(db,s,actor.id);
    imported++;
   }
   return {imported,source:'https://avis.land/api/xchg/markets'};
  });
 }
 async addSecurity(actor,input,key){
  actualAdmin(actor);const s=securityMetadata(input);
  return this.operation(actor,'ADD_PORTFOLIO_SECURITY',input,key,async db=>{
   const id=randomUUID();await db.query(`INSERT INTO avis_core_v2.portfolio_securities(security_id,name,short_name,currency_code,isin,cusip,denomination,quote_basis,kind,source,created_by,quantity_decimals) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'MANUAL',$10,$11)`,[id,s.name,s.shortName,s.currency,s.isin,s.cusip,s.denomination,s.quoteBasis,s.kind,actor.id,s.quantityDecimals]);return {id};
  });
 }
 async security(db,id){const s=(await db.query(securitySelect+' WHERE security_id=$1',[id])).rows[0];if(!s)fault('SECURITY_NOT_FOUND','securityId',404);return s;}
 async recordPosition(actor,input,key){
  actualAdmin(actor);const qty=decimal(units(input.quantity)),issue=decimal(units(input.issuingPrice)),market=decimal(units(input.marketPrice)),reference=text(input.reference,'reference',128);
  return this.operation(actor,'RECORD_PORTFOLIO_POSITION',input,key,async(db,k)=>{
   quantityUnits(qty,await this.security(db,input.securityId));
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['securities:'+input.securityId]);
   const old=(await db.query('SELECT * FROM avis_core_v2.portfolio_positions WHERE user_id=$1 AND security_id=$2 FOR UPDATE',[input.userId,input.securityId])).rows[0];
   if(old&&Number(input.version)!==old.version)fault('POSITION_CHANGED','quantity',409);
   if(old&&units(qty)<units(old.reserved_quantity))fault('SECURITY_QUANTITY_RESERVED','quantity');
   const id=old?.position_id||randomUUID();
   await db.query(`INSERT INTO avis_core_v2.portfolio_positions(position_id,user_id,security_id,quantity,issuing_price,market_price) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(user_id,security_id) DO UPDATE SET quantity=$4,issuing_price=$5,market_price=$6,version=portfolio_positions.version+1,updated_at=now()`,[id,input.userId,input.securityId,qty,issue,market]);
   await db.query(`INSERT INTO avis_core_v2.portfolio_movements(position_id,quantity_delta,resulting_quantity,reference,actor_id) VALUES($1,$2,$3,$4,$5)`,[id,decimal(units(qty)-units(old?.quantity||'0')),qty,reference,actor.id]);
   return {id,quantity:qty};
  });
 }
 async orderSource(db,actor,input,s){
  const source=(await db.query(`SELECT a.*,u.full_name FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.sovereign_users u USING(user_id)
   WHERE account_id=$1 AND a.owner_type='USER' AND a.account_category='LIABILITY' AND a.wallet_scope='FUNDING'`,[input.accountId])).rows[0];
  if(!source)fault('ACCOUNT_NOT_FOUND','accountId');access(actor,source.user_id);
  if(!['ACCOUNT','CARD','CRYPTO'].includes(input.paymentMethod))fault('INVALID_FIELD','paymentMethod');
  let card=null,offer=null;
  if(input.paymentMethod==='ACCOUNT'){
   const bridge=(await db.query(`SELECT status FROM avis_core_v2.abiq_routing_bridge WHERE ledger_account_id=$1 AND status='ACTIVE'`,[source.account_id])).rows[0];
   if(!bridge||source.currency_code!==s.currency_code||source.network)fault('ACCOUNT_NOT_FOUND','accountId');
  }else if(input.paymentMethod==='CARD'){
   card=(await db.query(`SELECT * FROM avis_core_v2.avis_cards WHERE card_id=$1 AND user_id=$2 AND COALESCE(stored_value_account_id,funding_account_id)=$3 AND status='ACTIVE' AND card_rail_mode<>'GLOBAL_SCHEME_ONLY' AND (expires_at IS NULL OR expires_at>now())`,[input.cardId,source.user_id,source.account_id])).rows[0];
   if(!card||source.currency_code!==s.currency_code||source.network)fault('SELECT_AVIS_CARD','cardId');
  }else{
   if(!source.network)fault('CRYPTO_HOLDING_REQUIRED','accountId');
   offer=(await db.query(`SELECT o.*,s.user_id AS dealer_id,s.currency_code AS asset,s.network,p.currency_code AS fiat FROM avis_core_v2.crypto_sale_offers o JOIN avis_core_v2.ledger_accounts s ON s.account_id=o.stock_account_id JOIN avis_core_v2.ledger_accounts p ON p.account_id=o.proceeds_account_id WHERE offer_id=$1 AND is_active FOR SHARE OF o`,[input.offerId])).rows[0];
   if(!offer||offer.asset!==source.currency_code||offer.network!==source.network||offer.fiat!==s.currency_code||String(offer.dealer_id)===String(source.user_id))fault('CRYPTO_OFFER_REQUIRED','offerId');
  }
  return {source,card,offer};
 }
 async reviewSecurityOrder(actor,input,key){
  if(!['BUY','SELL'].includes(input.side))fault('INVALID_FIELD','side');
  const quantity=decimal(money(input.quantity)),price=decimal(money(input.price)),reference=text(input.reference,'reference',128);
  return this.operation(actor,'REVIEW_SECURITY_ORDER',input,key,async db=>{
   const s=await this.security(db,input.securityId),{source,offer}=await this.orderSource(db,actor,input,s);
   quantityUnits(quantity,s);
   if(money(input.denomination)!==money(s.denomination))fault('SECURITY_TERMS_CHANGED','denomination');
   const total=securityValue(quantity,s.denomination,price,s.quote_basis,s.currency_code);
   if(units(total)<=0n||units(total)!==money(input.total))fault('ORDER_TOTAL_CHANGED','total');
   if(input.side==='SELL'){
    const p=(await db.query('SELECT quantity-reserved_quantity AS available FROM avis_core_v2.portfolio_positions WHERE user_id=$1 AND security_id=$2',[source.user_id,s.security_id])).rows[0];
    if(!p||units(p.available)<money(quantity))fault('INSUFFICIENT_SECURITIES','quantity');
   }
   const cryptoAmount=offer?decimal((money(total)*scale+(input.side==='BUY'?money(offer.unit_price)-1n:0n))/money(offer.unit_price)):null;
   if(offer&&units(cryptoAmount)<=0n)fault('INVALID_AMOUNT','quantity');
   if(input.side==='BUY'&&units(source.available_balance)-units(source.locked_balance)<money(cryptoAmount||total))fault('INSUFFICIENT_FUNDS','accountId');
   const instruction={securityId:s.security_id,name:s.name,shortName:s.short_name,isin:s.isin,cusip:s.cusip,currency:s.currency_code,denomination:s.denomination,quoteBasis:s.quote_basis,side:input.side,
    quantity,price,total,paymentMethod:input.paymentMethod,accountId:source.account_id,accountLabel:source.full_name+' · '+source.currency_code,userId:String(source.user_id),cardId:input.cardId||null,
    offerId:offer?.offer_id||null,cryptoAmount,cryptoCurrency:offer?.asset||null,network:offer?.network||null,unitPrice:offer?.unit_price||null,dealerCash:offer?.proceeds_account_id||null,dealerStock:offer?.stock_account_id||null,reference};
   const id=randomUUID(),reviewHash=hash(instruction);
   await db.query(`INSERT INTO avis_core_v2.securities_orders(order_id,user_id,security_id,side,instruction,review_hash,quantity,price,total,cash_account_id,source_account_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,source.user_id,s.security_id,input.side,JSON.stringify(instruction),reviewHash,quantity,price,total,offer?.proceeds_account_id||source.account_id,source.account_id,actor.id]);
   const {dealerCash,dealerStock,...visible}=instruction;
   return {id,reviewHash,instruction:visible};
  });
 }
 async lockedOrder(db,actor,id){
  const hint=(await db.query('SELECT security_id,user_id FROM avis_core_v2.securities_orders WHERE order_id=$1',[id])).rows[0];
  if(!hint)fault('ORDER_NOT_FOUND','orderId',404);access(actor,hint.user_id);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['securities:'+hint.security_id]);
  return (await db.query('SELECT * FROM avis_core_v2.securities_orders WHERE order_id=$1 FOR UPDATE',[id])).rows[0];
 }
 async reserveOrder(db,actor,r,k){
  const v=r.instruction,lines=[];let cash=null,cryptoHold=null;
  if(v.paymentMethod==='CRYPTO'){
   cryptoHold=await this.networkAccount(db,'EXCHANGE_CLEARING',v.cryptoCurrency,v.network,'SEC:'+r.order_id);
   lines.push(line(r.side==='BUY'?r.source_account_id:v.dealerStock,'DEBIT',v.cryptoAmount),line(cryptoHold,'CREDIT',v.cryptoAmount));
  }
  if(r.side==='BUY'){
   cash=await this.system(db,'EXCHANGE_CLEARING',v.currency,'SEC:'+r.order_id);
   lines.push(line(r.cash_account_id,'DEBIT',r.total),line(cash,'CREDIT',r.total));
  }else{
   const changed=await db.query('UPDATE avis_core_v2.portfolio_positions SET reserved_quantity=reserved_quantity+$3,version=version+1 WHERE user_id=$1 AND security_id=$2 AND quantity-reserved_quantity>=$3 RETURNING position_id',[r.user_id,r.security_id,r.quantity]);
   if(!changed.rows.length)fault('INSUFFICIENT_SECURITIES','quantity');
  }
  if(lines.length)await this.post(db,actor,k+':reserve','SECURITIES_ORDER_RESERVED',v.reference,lines);
  await db.query("UPDATE avis_core_v2.securities_orders SET status='OPEN',cash_hold_id=$2,crypto_hold_id=$3,submitted_at=now() WHERE order_id=$1",[r.order_id,cash,cryptoHold]);
  return {...r,status:'OPEN',cash_hold_id:cash,crypto_hold_id:cryptoHold};
 }
 async executePair(db,actor,buy,sell,k){
  const b=buy.instruction,s=sell.instruction,reference='XCHG-'+buy.order_id,lines=[line(buy.cash_hold_id,'DEBIT',buy.total),line(sell.cash_account_id,'CREDIT',sell.total)];
  if(buy.crypto_hold_id)lines.push(line(buy.crypto_hold_id,'DEBIT',b.cryptoAmount),line(b.dealerStock,'CREDIT',b.cryptoAmount));
  if(sell.crypto_hold_id)lines.push(line(sell.crypto_hold_id,'DEBIT',s.cryptoAmount),line(sell.source_account_id,'CREDIT',s.cryptoAmount));
  const journalId=await this.post(db,actor,k+':execution','SECURITIES_EXCHANGE_TRADE',reference,lines);
  const sold=(await db.query(`UPDATE avis_core_v2.portfolio_positions SET quantity=quantity-$3,reserved_quantity=reserved_quantity-$3,market_price=$4,version=version+1,updated_at=now() WHERE user_id=$1 AND security_id=$2 AND reserved_quantity>=$3 RETURNING position_id,quantity`,[sell.user_id,sell.security_id,sell.quantity,sell.price])).rows[0];
  if(!sold)fault('INSUFFICIENT_SECURITIES','quantity');
  const bought=(await db.query(`INSERT INTO avis_core_v2.portfolio_positions(user_id,security_id,quantity,issuing_price,market_price) VALUES($1,$2,$3,$4,$4) ON CONFLICT(user_id,security_id) DO UPDATE SET quantity=portfolio_positions.quantity+$3,market_price=$4,version=portfolio_positions.version+1,updated_at=now() RETURNING position_id,quantity`,[buy.user_id,buy.security_id,buy.quantity,buy.price])).rows[0];
  for(const [p,o,delta] of [[sold,sell,decimal(-money(sell.quantity))],[bought,buy,buy.quantity]])await db.query('INSERT INTO avis_core_v2.portfolio_movements(position_id,order_id,quantity_delta,resulting_quantity,reference,actor_id) VALUES($1,$2,$3,$4,$5,$6)',[p.position_id,o.order_id,delta,p.quantity,reference,actor.id]);
  await db.query("UPDATE avis_core_v2.securities_orders SET status='FILLED',executed_at=now(),journal_id=$3,execution_reference=$4,matched_order_id=CASE WHEN order_id=$1 THEN $2::uuid ELSE $1::uuid END WHERE order_id IN ($1,$2)",[buy.order_id,sell.order_id,journalId,reference]);
  return {status:'FILLED',journalId,executionReference:reference};
 }
 async submitSecurityOrder(actor,input,key){
  return this.operation(actor,'SUBMIT_SECURITY_ORDER',input,key,async(db,k)=>{
   let r=await this.lockedOrder(db,actor,input.orderId);
   if(r.status!=='REVIEW')return {id:r.order_id,status:r.status};
   if(r.review_hash!==input.reviewHash||new Date(r.expires_at)<=new Date())fault('ORDER_REVIEW_CHANGED','orderId',409);
   const s=await this.security(db,r.security_id),v=r.instruction;
   if(money(s.denomination)!==money(v.denomination)||s.currency_code!==v.currency||s.quote_basis!==v.quoteBasis)fault('SECURITY_TERMS_CHANGED','securityId',409);
   const {offer}=await this.orderSource(db,actor,{...v,accountId:r.source_account_id},s);
   if(offer&&(money(offer.unit_price)!==money(v.unitPrice)||offer.proceeds_account_id!==v.dealerCash||offer.stock_account_id!==v.dealerStock))fault('CRYPTO_PRICE_CHANGED','offerId',409);
   r=await this.reserveOrder(db,actor,r,k);
   // All-or-none limit orders: exact quantity and reviewed price. Every fill is
   // delivery versus payment in the same database transaction, never a UI balance edit.
   const other=(await db.query(`SELECT * FROM avis_core_v2.securities_orders WHERE security_id=$1 AND side<>$2 AND user_id<>$3 AND status='OPEN' AND quantity=$4 AND price=$5 AND total=$6 ORDER BY submitted_at,order_id LIMIT 1 FOR UPDATE`,[r.security_id,r.side,r.user_id,r.quantity,r.price,r.total])).rows[0];
   if(!other)return {id:r.order_id,status:'OPEN'};
   const result=await this.executePair(db,actor,r.side==='BUY'?r:other,r.side==='SELL'?r:other,k);return {id:r.order_id,...result};
  });
 }
 async cancelSecurityOrder(actor,input,key){
  return this.operation(actor,'CANCEL_SECURITY_ORDER',input,key,async(db,k)=>{
   const r=await this.lockedOrder(db,actor,input.orderId);if(r.status==='CANCELLED')return {id:r.order_id,status:r.status};
   if(r.status==='FILLED')fault('ORDER_ALREADY_FILLED','orderId',409);
   const v=r.instruction,lines=[];
   if(r.status==='OPEN'){
    if(r.cash_hold_id)lines.push(line(r.cash_hold_id,'DEBIT',r.total),line(r.cash_account_id,'CREDIT',r.total));
    if(r.crypto_hold_id)lines.push(line(r.crypto_hold_id,'DEBIT',v.cryptoAmount),line(r.side==='BUY'?r.source_account_id:v.dealerStock,'CREDIT',v.cryptoAmount));
    if(r.side==='SELL')await db.query('UPDATE avis_core_v2.portfolio_positions SET reserved_quantity=reserved_quantity-$3,version=version+1 WHERE user_id=$1 AND security_id=$2',[r.user_id,r.security_id,r.quantity]);
    if(lines.length)await this.post(db,actor,k,'SECURITIES_ORDER_CANCELLED',v.reference,lines);
   }
   await db.query("UPDATE avis_core_v2.securities_orders SET status='CANCELLED' WHERE order_id=$1",[r.order_id]);return {id:r.order_id,status:'CANCELLED'};
  });
 }
 async securityOrderDetails(actor,{orderId}){
  const r=(await this.pool.query(`SELECT order_id,user_id,status,instruction,submitted_at,executed_at,execution_reference FROM avis_core_v2.securities_orders WHERE order_id=$1`,[orderId])).rows[0];
  if(!r)fault('ORDER_NOT_FOUND','orderId',404);access(actor,r.user_id);
  const {dealerCash,dealerStock,...instruction}=r.instruction;return {...r,instruction};
 }
 async list(actor,view){
  if(['securities','securitypositions','securityorders','exchangebook'].includes(view)){
   if(!actor?.admin)fault('FORBIDDEN',null,403);
   if(view==='securities')return (await this.pool.query(securitySelect+' ORDER BY name,security_id')).rows;
   if(view==='securitypositions')return (await this.pool.query(positionSelect+' WHERE ($1::bigint IS NULL OR p.user_id=$1) ORDER BY p.user_id,s.name',[actor.customerUserId||null])).rows.map(p=>({...p,portfolio_value:securityValue(p.quantity,p.denomination,p.market_price,p.quote_basis,p.currency_code)}));
   if(view==='exchangebook')return (await this.pool.query(`SELECT s.security_id,s.short_name,s.currency_code,s.denomination::text,s.quote_basis,o.side,o.price::text,o.quantity::text,count(*)::int AS orders FROM avis_core_v2.securities_orders o JOIN avis_core_v2.portfolio_securities s USING(security_id) WHERE o.status='OPEN' GROUP BY s.security_id,o.side,o.price,o.quantity ORDER BY s.short_name,o.side,o.price`)).rows;
   return (await this.pool.query(`SELECT o.order_id,o.user_id,u.full_name,s.short_name,s.currency_code,o.side,o.status,o.quantity::text,o.price::text,o.total::text,o.instruction->>'paymentMethod' AS payment_method,o.instruction->>'reference' AS reference,o.submitted_at,o.created_at,o.execution_reference FROM avis_core_v2.securities_orders o JOIN avis_core_v2.portfolio_securities s USING(security_id) JOIN avis_core_v2.sovereign_users u USING(user_id) WHERE o.status<>'REVIEW' AND ($1::bigint IS NULL OR o.user_id=$1) ORDER BY o.created_at DESC LIMIT 300`,[actor.customerUserId||null])).rows;
  }
  return super.list(actor,view);
 }
}
