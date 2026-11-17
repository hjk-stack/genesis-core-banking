import {randomUUID} from 'node:crypto';
import {CardManagement} from './card-management.mjs';
import {ABIQ_PARTITIONS,ensureLedgerAbiq} from './avispay-core-accounts.mjs';
import {fault,text} from './core.mjs';
import {enrichPortfolioHistory} from './crypto-asset-routing.mjs';

const owners=['COMMON_POOL','SUSPENSE_INBOUND','SUSPENSE_OUTBOUND','SUSPENSE_CARD_FX'];
const accountSelect=`SELECT a.account_id,a.owner_type,b.abiq_iban,b.abiq_iban AS account_reference,p.abiq_bic,b.status,
 CASE WHEN a.owner_type='COMMON_POOL' THEN 'COMMON' ELSE 'SUSPENSE' END AS account_type,
 COALESCE(a.display_name,CASE WHEN a.owner_type='COMMON_POOL' THEN 'Common Account' ELSE 'Suspense Account' END) AS display_name,
 a.currency_code,a.network,a.wallet_scope,a.account_category,a.available_balance::text,a.locked_balance::text
 FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=a.account_id
 JOIN avis_core_v2.abiq_network_participants p USING(participant_code) WHERE a.owner_type=ANY($1::text[])`;
const balanceTotals=`LEFT JOIN LATERAL (SELECT
 COALESCE(sum(e.amount) FILTER(WHERE e.direction='CREDIT'),0)::text AS credit,
 COALESCE(sum(e.amount) FILTER(WHERE e.direction='DEBIT'),0)::text AS debit
 FROM avis_core_v2.ledger_entries e WHERE e.account_id=a.account_id) totals ON true
 LEFT JOIN LATERAL (SELECT j.reference_id FROM avis_core_v2.ledger_entries e JOIN avis_core_v2.ledger_journals j USING(journal_id)
 WHERE e.account_id=a.account_id ORDER BY e.entry_id DESC LIMIT 1) latest ON true`;
const bankSelect=`SELECT a.account_id,a.user_id,u.full_name,u.full_name AS display_name,u.account_type,u.account_role,u.postal_address,
 b.abiq_iban,b.abiq_iban AS account_reference,p.abiq_bic,b.status,a.currency_code,a.network,a.wallet_scope,a.account_category,
 a.available_balance::text,a.locked_balance::text
 FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=a.account_id
 JOIN avis_core_v2.sovereign_users u ON u.user_id=a.user_id JOIN avis_core_v2.abiq_network_participants p USING(participant_code)
 JOIN avis_core_v2.abiq_currencies c ON c.currency_code=a.currency_code`;
const cursor=value=>{if(value!==null&&(!/^[1-9][0-9]{0,18}$/.test(String(value))||BigInt(value)>9223372036854775807n))fault('INVALID_FIELD','before');};
const adminOnly=actor=>{if(!actor?.admin||actor.customerUserId)fault('FORBIDDEN',null,403);};

export class AccountManagement extends CardManagement {
 async openAccount(actor,input,key){
  adminOnly(actor);
  if(['PERSONAL','BUSINESS'].includes(input.accountType))return this.openCustomer(actor,input,key);
  if(!['COMMON','SUSPENSE'].includes(input.accountType))fault('INVALID_FIELD','accountType');
  const name=text(input.fullName,'fullName',120),currencies=input.currencies;
  if(!Array.isArray(currencies)||!currencies.length||currencies.length>14||currencies.some(c=>!Object.hasOwn(ABIQ_PARTITIONS,c)))fault('INVALID_FIELD','currencies');
  return this.operation(actor,'OPEN_BACKOFFICE_ACCOUNT',input,key,async db=>{
   const group='MANAGED:'+randomUUID(),accounts=[];
   for(const currency of new Set(currencies)){
    const id=await this.system(db,input.accountType==='COMMON'?'COMMON_POOL':'SUSPENSE_INBOUND',currency,group);
    await db.query('UPDATE avis_core_v2.ledger_accounts SET display_name=$2 WHERE account_id=$1',[id,name]);
    const abiqIban=await ensureLedgerAbiq(db,id);
    accounts.push({id,currency,abiqIban});
   }
   return {id:accounts[0].id,accountType:input.accountType,managedAccounts:accounts};
  });
 }
 async findAccount(db,actor,accountId,backofficeOnly=false){
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  if(!backofficeOnly){
   const bank=(await db.query(bankSelect+' WHERE a.account_id=$1 AND ($2::bigint IS NULL OR a.user_id=$2)',[accountId,actor.customerUserId||null])).rows[0];
   if(bank)return bank;
  }
  if(!actor.customerUserId){const backoffice=(await db.query(accountSelect+' AND a.account_id=$2',[owners,accountId])).rows[0];if(backoffice)return backoffice;}
  fault('ACCOUNT_NOT_FOUND','accountId',404);
 }
 async accountStatement(actor,input){adminOnly(actor);return this.accountDetails(actor,input,true);}
 async accountDetails(actor,{accountId,before=null},backofficeOnly=false){
  cursor(before);const db=await this.pool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const account=await this.findAccount(db,actor,accountId,backofficeOnly);
   const all=(await db.query(`SELECT e.entry_id,e.journal_id,e.direction,e.amount::text,e.running_balance::text,j.created_at,j.reference_id,j.event_type
    FROM avis_core_v2.ledger_entries e JOIN avis_core_v2.ledger_journals j USING(journal_id)
    WHERE e.account_id=$1 AND ($2::bigint IS NULL OR e.entry_id<$2) ORDER BY e.entry_id DESC LIMIT 101`,[accountId,before])).rows;
   const entries=all.slice(0,100),totals=(await db.query(`SELECT
    COALESCE(sum(amount) FILTER(WHERE direction='CREDIT'),0)::text AS incoming,
    COALESCE(sum(amount) FILTER(WHERE direction='DEBIT'),0)::text AS outgoing
    FROM avis_core_v2.ledger_entries WHERE account_id=$1`,[accountId])).rows[0];
   await db.query('COMMIT');
   return {account,entries,totals,nextCursor:all.length>100?String(entries.at(-1).entry_id):null};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async movementDetails(actor,{accountId,entryId}){
  cursor(entryId);if(entryId===null)fault('INVALID_FIELD','entryId');
  const account=await this.findAccount(this.pool,actor,accountId);
  const entry=(await this.pool.query(`SELECT e.entry_id,e.journal_id,e.direction,e.amount::text,e.running_balance::text,
   j.created_at,j.reference_id,j.event_type,j.reverses_journal_id
   FROM avis_core_v2.ledger_entries e JOIN avis_core_v2.ledger_journals j USING(journal_id)
   WHERE e.account_id=$1 AND e.entry_id=$2`,[accountId,entryId])).rows[0];
  if(!entry)fault('NOT_FOUND','entryId',404);return {account,entry};
 }
 async portfolio(actor){
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  // Aggregate holdings once, by asset and network. Exclude cash accounts,
  // customer records and matching system-side accounting entries.
  const rows=(await this.pool.query(`SELECT a.currency_code,a.network,
   sum(a.available_balance)::text AS available_balance,sum(a.locked_balance)::text AS locked_balance
   FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.sovereign_users u USING(user_id)
   WHERE a.owner_type='USER' AND a.account_category='LIABILITY' AND a.wallet_scope='FUNDING' AND a.network IS NOT NULL
   AND (($1::bigint IS NULL AND u.account_role='INSTITUTION') OR a.user_id=$1)
   GROUP BY a.currency_code,a.network ORDER BY a.currency_code,a.network`,[actor.customerUserId||null])).rows;
  return enrichPortfolioHistory(this.pool,actor,rows);
 }
 async list(actor,view){
  if(view==='backofficeaccounts'){adminOnly(actor);return (await this.pool.query(accountSelect.replace('SELECT a.account_id','SELECT totals.credit,totals.debit,latest.reference_id, a.account_id').replace(' WHERE a.owner_type',' '+balanceTotals+' WHERE a.owner_type')+' ORDER BY account_type,a.currency_code,b.abiq_iban,a.account_id',[owners])).rows;}
  if(view==='accountsummaries'){
   if(!actor?.admin)fault('FORBIDDEN',null,403);
   return (await this.pool.query(bankSelect.replace('SELECT a.account_id','SELECT totals.credit,totals.debit,latest.reference_id, a.account_id')+' '+balanceTotals+' WHERE ($1::bigint IS NULL OR a.user_id=$1) ORDER BY a.user_id,c.account_series,CASE a.wallet_scope WHEN \'FUNDING\' THEN 0 WHEN \'MARGIN\' THEN 1 ELSE 2 END,b.abiq_iban',[actor.customerUserId||null])).rows;
  }
  if(view==='portfolio')return this.portfolio(actor);
  return super.list(actor,view);
 }
}
