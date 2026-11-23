import {fault} from './core.mjs';

export const NOSTRO_STATEMENT_PAGE_SIZE=50;
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const identifier=(value,field)=>typeof value==='string'&&uuid.test(value)?value.toLowerCase():fault('INVALID_FIELD',field);
const adminOnly=actor=>{if(!actor?.admin||!actor.id||actor.customerUserId)fault('FORBIDDEN',null,403);};
const encodeCursor=(cashAccountId,statementId)=>Buffer.from(JSON.stringify([cashAccountId,statementId])).toString('base64url');
function decodeCursor(value,cashAccountId){
 if(value===undefined||value===null||value==='')return null;
 if(typeof value!=='string'||value.length>256||!/^[A-Za-z0-9_-]+$/.test(value))fault('INVALID_FIELD','before');
 let cursor;
 try{
  const bytes=Buffer.from(value,'base64url');
  if(bytes.toString('base64url')!==value)fault('INVALID_FIELD','before');
  cursor=JSON.parse(bytes.toString('utf8'));
 }catch{fault('INVALID_FIELD','before');}
 if(!Array.isArray(cursor)||cursor.length!==2||cursor[0]!==cashAccountId||typeof cursor[1]!=='string'||!uuid.test(cursor[1]))fault('INVALID_FIELD','before');
 return cursor[1].toLowerCase();
}
const headerSelect=`SELECT s.statement_id,s.provider_reference,s.currency_code,
 s.opening_balance::text,s.closing_balance::text,s.imported_at,
 (SELECT count(*)::int FROM avis_core_v2.clearing_statement_entries e WHERE e.statement_id=s.statement_id) AS entry_count
 FROM avis_core_v2.clearing_statements s`;
const header=row=>({statementId:row.statement_id,reference:row.provider_reference,currency:row.currency_code,
 openingBalance:row.opening_balance,closingBalance:row.closing_balance,
 importedAt:new Date(row.imported_at).toISOString(),entryCount:row.entry_count});

// Bank-reported balances and entries come only from retained clearing statements.
// Reading them never reconciles, mirrors, or derives movements from the internal ledger.
export class NostroStatements {
 constructor(pool){this.pool=pool;}
 async #account(cashAccountId){
  const row=(await this.pool.query(`SELECT cash_account_id,institution_name,iban_or_account_no,bic_code,currency_code
   FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1`,[cashAccountId])).rows[0];
  if(!row)fault('NOSTRO_ACCOUNT_NOT_FOUND','cashAccountId',404);
  return {cashAccountId:row.cash_account_id,institutionName:row.institution_name,
   accountNumber:row.iban_or_account_no,bic:row.bic_code,currency:row.currency_code};
 }
 async list(actor,input={}){
  adminOnly(actor);
  const cashAccountId=identifier(input?.cashAccountId,'cashAccountId'),before=decodeCursor(input?.before,cashAccountId);
  const account=await this.#account(cashAccountId);
  if(before&&!(await this.pool.query('SELECT statement_id FROM avis_core_v2.clearing_statements WHERE cash_account_id=$1 AND statement_id=$2',[cashAccountId,before])).rows.length)fault('INVALID_FIELD','before');
  const rows=(await this.pool.query(headerSelect+` WHERE s.cash_account_id=$1
   AND ($2::uuid IS NULL OR (s.imported_at,s.statement_id)<
    (SELECT imported_at,statement_id FROM avis_core_v2.clearing_statements WHERE cash_account_id=$1 AND statement_id=$2))
   ORDER BY s.imported_at DESC,s.statement_id DESC LIMIT $3`,[cashAccountId,before,NOSTRO_STATEMENT_PAGE_SIZE+1])).rows;
  const page=rows.slice(0,NOSTRO_STATEMENT_PAGE_SIZE);
  return {account,statements:page.map(header),nextCursor:rows.length>page.length?encodeCursor(cashAccountId,page.at(-1).statement_id):null};
 }
 async read(actor,input={}){
  adminOnly(actor);
  const cashAccountId=identifier(input?.cashAccountId,'cashAccountId'),statementId=identifier(input?.statementId,'statementId');
  const account=await this.#account(cashAccountId);
  const row=(await this.pool.query(headerSelect+' WHERE s.cash_account_id=$1 AND s.statement_id=$2',[cashAccountId,statementId])).rows[0];
  if(!row)fault('NOSTRO_STATEMENT_NOT_FOUND','statementId',404);
  // Reconciliation accepts at most 500 entries. Read the complete retained set;
  // bank references provide stable display ordering, not invented booking dates.
  const rows=(await this.pool.query(`SELECT bank_reference,direction,amount::text
   FROM avis_core_v2.clearing_statement_entries WHERE statement_id=$1 ORDER BY bank_reference`,[statementId])).rows;
  return {account,statement:header(row),entries:rows.map(entry=>({bankReference:entry.bank_reference,direction:entry.direction,amount:entry.amount}))};
 }
}
