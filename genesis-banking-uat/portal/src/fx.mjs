import {randomUUID} from 'node:crypto';
import {XMLParser} from 'fast-xml-parser';
import {CardPaymentServer} from './offline-cards.mjs';
import {fault,money,decimal} from './core.mjs';
const line=(accountId,direction,amount)=>({accountId,direction,amount});
const parser=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false,parseAttributeValue:false,processEntities:false});
export async function fetchEcbRates(fetcher=fetch){
 const response=await fetcher('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',{signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!response.ok)fault('FX_SOURCE_RESPONSE',null,502);const xml=await response.text();
 if(Buffer.byteLength(xml)>100000||/<!DOCTYPE|<!ENTITY/i.test(xml))fault('FX_SOURCE_RESPONSE',null,502);
 const day=parser.parse(xml)?.Envelope?.Cube?.Cube,date=day?.['@_time'],rows=Array.isArray(day?.Cube)?day.Cube:day?.Cube?[day.Cube]:[];
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!rows.length||Date.parse(date)>Date.now()||Date.parse(date)<Date.now()-7*86400000)fault('FX_SOURCE_DATE','rate');
 const rates=[{currency:'EUR',rate:'1'}];
 for(const r of rows){if(!/^[A-Z]{3}$/.test(r['@_currency']))fault('FX_SOURCE_RESPONSE');money(r['@_rate']);rates.push({currency:r['@_currency'],rate:r['@_rate']});}
 return {date,rates,source:'ECB reference rates'};
}
export class FxBankingServer extends CardPaymentServer {
 async refreshFxRates(actor,input,key){
  const snapshot=await fetchEcbRates();
  return this.operation(actor,'REFRESH_FX_RATES',input,key,async db=>{
   let updated=0;for(const rate of snapshot.rates){
    const r=await db.query("INSERT INTO avis_core_v2.fx_reference_rates(currency_code,units_per_eur,source,source_date) SELECT currency_code,$2,$3,$4 FROM avis_core_v2.abiq_currencies WHERE currency_code=$1 ON CONFLICT(currency_code) DO UPDATE SET units_per_eur=EXCLUDED.units_per_eur,source=EXCLUDED.source,source_date=EXCLUDED.source_date,observed_at=now() WHERE fx_reference_rates.source_date<=EXCLUDED.source_date RETURNING currency_code",[rate.currency,rate.rate,snapshot.source,snapshot.date]);updated+=r.rows.length;
   }
   return {updated,source:snapshot.source,date:snapshot.date};
  });
 }
 async expireFxQuotes(db,actor){
  const quotes=(await db.query("SELECT * FROM avis_core_v2.fx_quotes WHERE status='OPEN' AND expires_at<=now() ORDER BY quote_id FOR UPDATE SKIP LOCKED")).rows;
  for(const q of quotes)await this.releaseFxQuote(db,actor,q,'EXPIRED','FX-EXPIRY:'+q.quote_id);
 }
 async releaseFxQuote(db,actor,q,status,key){
  const treasury=await this.system(db,'TREASURY',q.to_currency),hold=await this.system(db,'EXCHANGE_CLEARING',q.to_currency,'FX:'+q.quote_id);
  const journalId=await this.post(db,actor,key,'FX_QUOTE_RELEASE',q.quote_id,[line(hold,'DEBIT',q.to_amount),line(treasury,'CREDIT',q.to_amount)]);
  await db.query('UPDATE avis_core_v2.fx_quotes SET status=$2,execution_journal_id=$3 WHERE quote_id=$1',[q.quote_id,status,journalId]);return journalId;
 }
 async quoteFx(actor,input,key){
  const gross=money(input.amount,6);
  if(!Number.isInteger(input.commissionBps)||input.commissionBps<0||input.commissionBps>=10000)fault('INVALID_FIELD','commissionBps');
  return this.operation(actor,'CREATE_FX_QUOTE',input,key,async(db,k)=>{
   await this.expireFxQuotes(db,actor);
   const from=await this.route(db,input.from,input.fromCurrency,'from'),to=await this.route(db,input.to,input.toCurrency,'to');
   if(from.user_id!==to.user_id||from.currency_code===to.currency_code)fault('FX_ACCOUNT_PAIR','to');
   const rates=(await db.query("SELECT * FROM avis_core_v2.fx_reference_rates WHERE currency_code=ANY($1::text[]) AND source_date>=current_date-7 FOR SHARE",[[from.currency_code,to.currency_code]])).rows;
   const a=rates.find(r=>r.currency_code===from.currency_code),b=rates.find(r=>r.currency_code===to.currency_code);
   if(!a||!b||String(a.source_date)!==String(b.source_date)||a.source!==b.source)fault('FX_RATE_REQUIRED','toCurrency');
   const rate=money(b.units_per_eur)*10n**18n/money(a.units_per_eur),fee=(gross*BigInt(input.commissionBps)+5000n)/10000n,net=gross-fee,received=net*rate/10n**18n;
   if(!received||fee>=gross)fault('INVALID_AMOUNT','amount');
   const id=randomUUID(),treasury=await this.system(db,'TREASURY',to.currency_code),hold=await this.system(db,'EXCHANGE_CLEARING',to.currency_code,'FX:'+id);
   const inventory=(await db.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1 FOR UPDATE',[treasury])).rows[0];
   if(!/[1-9]/.test(inventory.available_balance)||money(inventory.available_balance)<received*10n**12n)fault('FX_LIQUIDITY_REQUIRED','toCurrency');
   const journalId=await this.post(db,actor,k,'FX_QUOTE_RESERVED',id,[line(treasury,'DEBIT',decimal(received,6)),line(hold,'CREDIT',decimal(received,6))]);
   const q=(await db.query("INSERT INTO avis_core_v2.fx_quotes(quote_id,user_id,from_account_id,to_account_id,from_currency,to_currency,from_amount,fee_amount,to_amount,rate,rate_source,rate_date,expires_at,reserve_journal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+interval '30 seconds',$13) RETURNING quote_id,from_amount::text,fee_amount::text,to_amount::text,rate::text,rate_source,rate_date,expires_at",[id,from.user_id,from.ledger_account_id,to.ledger_account_id,from.currency_code,to.currency_code,decimal(gross,6),decimal(fee,6),decimal(received,6),decimal(rate),a.source,a.source_date,journalId])).rows[0];
   return {id,journalId,...q};
  });
 }
 async executeFx(actor,input,key){
  return this.operation(actor,'EXECUTE_FX_QUOTE',input,key,async(db,k)=>{
   const q=(await db.query('SELECT *,expires_at>now() AS valid FROM avis_core_v2.fx_quotes WHERE quote_id=$1 FOR UPDATE',[input.quoteId])).rows[0];
   if(!q||q.status!=='OPEN')fault('FX_QUOTE_CLOSED','quoteId');
   if(!q.valid){const journalId=await this.releaseFxQuote(db,actor,q,'EXPIRED',k);return {id:q.quote_id,status:'EXPIRED',journalId};}
   const sourceTreasury=await this.system(db,'TREASURY',q.from_currency),hold=await this.system(db,'EXCHANGE_CLEARING',q.to_currency,'FX:'+q.quote_id);
   const fee=/^0(?:\.0+)?$/.test(q.fee_amount)?0n:money(q.fee_amount,6),net=money(q.from_amount,6)-fee;
   const lines=[line(q.from_account_id,'DEBIT',q.from_amount),line(sourceTreasury,'CREDIT',decimal(net,6)),line(hold,'DEBIT',q.to_amount),line(q.to_account_id,'CREDIT',q.to_amount)];
   if(fee)lines.push(line(await this.system(db,'REVENUE',q.from_currency,'FX_FEES','REVENUE'),'CREDIT',q.fee_amount));
   const journalId=await this.post(db,actor,k,'FX_CONVERSION',q.quote_id,lines);
   await db.query("UPDATE avis_core_v2.fx_quotes SET status='EXECUTED',execution_journal_id=$2 WHERE quote_id=$1",[q.quote_id,journalId]);return {id:q.quote_id,status:'EXECUTED',journalId};
  });
 }
 async cancelFx(actor,input,key){return this.operation(actor,'CANCEL_FX_QUOTE',input,key,async(db,k)=>{
  const q=(await db.query('SELECT * FROM avis_core_v2.fx_quotes WHERE quote_id=$1 FOR UPDATE',[input.quoteId])).rows[0];
  if(!q||q.status!=='OPEN')fault('FX_QUOTE_CLOSED','quoteId');
  return {id:q.quote_id,journalId:await this.releaseFxQuote(db,actor,q,'CANCELLED',k),status:'CANCELLED'};
 });}
 async list(actor,view){
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  if(view==='fxrates')return(await this.pool.query('SELECT currency_code,units_per_eur::text,source,source_date,observed_at FROM avis_core_v2.fx_reference_rates ORDER BY currency_code')).rows;
  if(view==='fxquotes')return(await this.pool.query('SELECT quote_id,user_id,from_currency,to_currency,from_amount::text,to_amount::text,fee_amount::text,rate::text,rate_source,rate_date,expires_at,status FROM avis_core_v2.fx_quotes ORDER BY created_at DESC LIMIT 300')).rows;
  return super.list(actor,view);
 }
}
