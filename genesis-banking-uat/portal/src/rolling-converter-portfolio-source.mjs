// Booked portfolio positions supply holdings and valuation. Registry metadata
// supplies instrument identity only, never amounts or quantities.
import {createHash} from 'node:crypto';
import {securityValue} from './securities-portfolio.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const classes=Object.freeze({share:'corporate-stock',bond:'bond',note:'bond',cd:'cds'});
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const numeric=/^\d{1,36}(?:\.\d{1,18})?$/;
const positive=v=>numeric.test(String(v??''))&&/[1-9]/.test(String(v));
const clean=v=>String(v??'').trim();
const text=(v,max=200)=>clean(v).slice(0,max);
const quantity=v=>numeric.test(clean(v))?clean(v).replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1'):'';
export const portfolioKey=id=>'portfolio:'+hash('AVISPay portfolio position v1:'+String(id).toLowerCase());
function amountOf(p){
 if(!positive(p.available_quantity)||!positive(p.market_price)||!positive(p.denomination)||!['UNIT','PERCENT'].includes(p.quote_basis))return '';
 try{
  const result=securityValue(p.available_quantity,p.denomination,p.market_price,p.quote_basis,p.currency_code);
  const match=/^(\d{1,15})(?:\.(\d{1,18}))?$/.exec(String(result));
  if(!match)return '';
  const amount=match[1]+'.'+(match[2]||'').padEnd(2,'0').slice(0,2);
  return positive(amount)?amount:'';
 }catch{return '';}
}
function matchMetadata(p,metadata,assetClass){
 const matches=metadata.filter(m=>p.isin&&m.isinOrWkn===p.isin&&m.currency===p.currency_code&&m.assetClass===assetClass);
 const primary=matches.filter(m=>m.canonical===true);
 const candidates=primary.length?primary:matches;
 const unique=new Map(candidates.map(m=>[JSON.stringify([m.issuerName,m.issuerId,m.dateOfIssue]),m]));
 return unique.size===1?[...unique.values()][0]:null;
}
export function portfolioConverterAssets(rows,metadata=[]){
 if(!Array.isArray(rows)||!Array.isArray(metadata))throw Error('Portfolio source response');
 return rows.filter(p=>p&&p.account_role==='INSTITUTION'&&uuid.test(p.position_id)&&!['token','crypto'].includes(String(p.kind).toLowerCase())&&positive(p.quantity)).map(p=>{
  const assetClass=classes[p.kind]||'',m=matchMetadata(p,metadata,assetClass);
  const asset={key:portfolioKey(p.position_id),name:text(p.name),symbol:text(p.short_name,80),assetClass,
   issuerName:text(m?.issuerName),issuerId:text(m?.issuerId,40),isinOrWkn:text(p.isin,12),
   currency:text(p.currency_code,3),amount:amountOf(p),dateOfIssue:text(m?.dateOfIssue,10),amountOpen:false,
   quantity:quantity(p.quantity),availableQuantity:quantity(p.available_quantity),marketPrice:quantity(p.market_price),
   denomination:quantity(p.denomination),quoteBasis:text(p.quote_basis,10),source:'Portfolio Management'};
  const revision=hash(JSON.stringify([String(p.version??''),asset]));
  return {...asset,revision};
 });
}
export function portfolioSnapshot(asset){
 const {key,assetClass,issuerName,issuerId,isinOrWkn,currency,amount,dateOfIssue,revision}=asset;
 return {key,assetClass,issuerName,issuerId,isinOrWkn,currency,amount,dateOfIssue,revision};
}
