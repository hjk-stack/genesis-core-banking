import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {SovereignCore,fault} from './core.mjs';

// Helmut's explicit 2026-11-14 instruction: 1,000 opening units in each of
// the existing seven UAT funding accounts. Never exposed as an HTTP operation.
export const OPENING_REQUEST='uat-opening-2026-11-14-seven-accounts';
const actor={id:'operator-request:helmut:2026-11-14:uat-opening',admin:true};
const currencies=['EUR','USD','GBP','CHF'];
const holders=[{id:'1',name:'AVISPay PLC',role:'INSTITUTION',currencies:['EUR','USD','GBP']},{id:'2',name:'Frontend user',role:'CUSTOMER',currencies:['EUR','USD','GBP']},{id:'3',name:'AVISPay PLC',role:'CUSTOMER',currencies:['CHF']}];
export async function applyAuthorizedUatOpening(pool,env=process.env){
 if(env.CONTAINER_APP_NAME!=='genesis-banking-uat'||
    env.CONTAINER_APP_ENV_DNS_SUFFIX!=='orangemushroom-9faae382.italynorth.azurecontainerapps.io'||
    env.PGDATABASE!=='fineract_default')fault('UAT_OPENING_TARGET_MISMATCH');
 const core=new SovereignCore(pool),request={requestId:OPENING_REQUEST,amount:'1000',currencies,holders};
 return core.operation(actor,'AUTHORIZED_UAT_OPENING',request,OPENING_REQUEST,async(db,k)=>{
  const rows=(await db.query(`SELECT b.bridge_id,b.ledger_account_id,b.abiq_iban,b.user_id::text,b.currency_code,b.status,
   u.full_name,u.account_role,a.owner_type,a.wallet_scope,a.account_category,a.available_balance::text,a.locked_balance::text
   FROM avis_core_v2.abiq_routing_bridge b JOIN avis_core_v2.sovereign_users u USING(user_id)
   JOIN avis_core_v2.ledger_accounts a ON a.account_id=b.ledger_account_id
   WHERE b.participant_code='AVIP' AND (b.user_id::text || ':' || b.currency_code)=ANY($1::text[])
   ORDER BY a.account_id FOR UPDATE OF a,b,u`,[holders.flatMap(h=>h.currencies.map(c=>h.id+':'+c))])).rows;
  if(rows.length!==7)fault('UAT_OPENING_ACCOUNT_SET');
  for(const h of holders)for(const currency of h.currencies){
   const r=rows.find(r=>r.user_id===h.id&&r.currency_code===currency);
   if(!r||r.full_name!==h.name||r.account_role!==h.role||r.status!=='ACTIVE'||
      r.owner_type!=='USER'||r.wallet_scope!=='FUNDING'||r.account_category!=='LIABILITY')fault('UAT_OPENING_ACCOUNT_SET');
   if(!/^0(?:\.0+)?$/.test(r.available_balance)||!/^0(?:\.0+)?$/.test(r.locked_balance))fault('UAT_OPENING_ACCOUNT_NOT_EMPTY');
  }
  const entries=[];
  for(const currency of currencies){
   // Dedicated opening offset: no external bank, correspondent cash or settlement is invented.
   const offset=await core.system(db,'TREASURY',currency,'UAT_OPENING_20261114','ASSET');
   const prior=(await db.query('SELECT available_balance::text,locked_balance::text,account_category FROM avis_core_v2.ledger_accounts WHERE account_id=$1 FOR UPDATE',[offset])).rows[0];
   if(prior.account_category!=='ASSET'||!/^0(?:\.0+)?$/.test(prior.available_balance)||!/^0(?:\.0+)?$/.test(prior.locked_balance))fault('UAT_OPENING_OFFSET_NOT_EMPTY');
   const recipients=rows.filter(r=>r.currency_code===currency);
   entries.push({accountId:offset,direction:'DEBIT',amount:String(recipients.length*1000)});
   for(const r of recipients)entries.push({accountId:r.ledger_account_id,direction:'CREDIT',amount:'1000'});
  }
  const journalId=await core.post(db,actor,k,'UAT_OPENING_BALANCE',OPENING_REQUEST,entries);
  return {journalId,requestId:OPENING_REQUEST,accounts:rows.map(r=>({accountId:r.ledger_account_id,abiq:r.abiq_iban,currency:r.currency_code,credited:'1000'}))};
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const pool=new pg.Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT||5432),database:process.env.PGDATABASE,
  user:process.env.PGUSER,password:process.env.PGPASSWORD,ssl:{rejectUnauthorized:true},max:1,connectionTimeoutMillis:15000});
 try{
  const result=await applyAuthorizedUatOpening(pool);
  const posted=(await pool.query(`SELECT a.currency_code,count(*)::int AS entries,
   sum(CASE e.direction WHEN 'DEBIT' THEN e.amount ELSE 0 END)::text AS debits,
   sum(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE 0 END)::text AS credits
   FROM avis_core_v2.ledger_entries e JOIN avis_core_v2.ledger_accounts a USING(account_id)
   WHERE e.journal_id=$1 GROUP BY a.currency_code`,[result.journalId])).rows;
  if(posted.length!==4||posted.some(r=>{const n=result.accounts.filter(a=>a.currency===r.currency_code).length;return !n||r.entries!==n+1||Number(r.debits)!==n*1000||Number(r.credits)!==n*1000;}))fault('UAT_OPENING_RECEIPT_MISMATCH');
  await pool.end();
  console.log('AVIS_UAT_OPENING_OK '+JSON.stringify({journalId:result.journalId,requestId:result.requestId,creditedAccounts:result.accounts.length}));
 }catch(e){
  await pool.end().catch(()=>{});
  console.error('AVIS_UAT_OPENING_FAILED '+(/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'OPERATION_FAILED'));process.exitCode=1;
 }
}
