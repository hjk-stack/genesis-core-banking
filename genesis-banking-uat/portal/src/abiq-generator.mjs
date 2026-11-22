import {fault} from './core.mjs';
import {ABIQ_COUNTRIES,buildAbiqNumber} from '../public/abiq-number.mjs';

function holderCode(value) {
 if (typeof value !== 'string' || !/^[a-zA-Z]{4}$/.test(value.trim())) fault('ABIQ_HOLDER_CODE','holderCode');
 return value.trim().toUpperCase();
}

const catalogue = `SELECT currency_code AS currency,'000'||right(iso_numeric_partition,3) AS "currencyBlock",
 lpad(account_series::text,5,'0') AS series,label FROM avis_core_v2.abiq_number_codes`;

export async function generatorOptions(db, actor, code) {
 const holder = code ? holderCode(code) : null;
 const currencies = (await db.query(catalogue+' ORDER BY account_series')).rows;
 const numbers = (await db.query('SELECT n::text AS number FROM avis_core_v2.abiq_number_choices($1) n',[holder])).rows;
 const recent = (await db.query(`SELECT g.identifier,g.currency_code AS currency,b.ledger_account_id AS "accountId"
  FROM avis_core_v2.abiq_generated_numbers g LEFT JOIN avis_core_v2.abiq_number_bindings b USING(identifier)
  WHERE g.issued_by=$1 ORDER BY g.created_at DESC,g.identifier LIMIT 20`,[actor.id])).rows;
 const reusable=(await db.query(`SELECT customer_number::text AS number,array_agg(country_code || ':' || currency_code) AS combinations
  FROM avis_core_v2.abiq_generated_numbers WHERE issued_by=$1 AND holder_code=$2
  GROUP BY customer_number ORDER BY customer_number DESC LIMIT 50`,[actor.id,holder])).rows;
 return {countries:ABIQ_COUNTRIES,currencies,customerNumbers:numbers.map(row=>row.number),reusable,recent};
}

export function issueGeneratorNumber(core, actor, input, key) {
 return core.operation(actor,'ISSUE_ABIQ_NUMBER',input,key,async db=>{
  const holder=holderCode(input.holderCode);
  const currency=(await db.query(catalogue+' WHERE currency_code=$1',[input.currency])).rows[0];
  if (!currency) fault('ABIQ_UNSUPPORTED_CURRENCY','currency');
  if (input.series!==currency.series) fault('INVALID_FIELD','series');
  const identifier=buildAbiqNumber({...currency,country:input.country,holderCode:holder,customerNumber:input.customerNumber});
  if (input.checkDigits!==identifier.slice(2,4)) fault('ABIQ_CHECK_DIGITS','checkDigits');
  try {
   const issued=(await db.query('SELECT avis_core_v2.issue_abiq_number($1,$2,$3,$4,$5) AS identifier',
    [input.country,holder,currency.currency,input.customerNumber,actor.id])).rows[0];
   if (issued.identifier!==identifier) throw Error('ABIQ_GENERATOR_MISMATCH');
   return {id:identifier,identifier,currency:currency.currency};
  } catch (error) {
   if (error.message==='ABIQ_NUMBER_TAKEN') fault('ABIQ_NUMBER_TAKEN','customerNumber',409);
   throw error;
  }
 });
}

export function assignGeneratorNumber(core, actor, input, key) {
 return core.operation(actor,'ASSIGN_ABIQ_NUMBER',input,key,async db=>{
  const account=(await db.query(`SELECT a.currency_code,a.wallet_scope FROM avis_core_v2.ledger_accounts a
   JOIN avis_core_v2.abiq_currencies c USING(currency_code)
   WHERE a.account_id=$1 AND a.network IS NULL AND ($2::bigint IS NULL OR a.user_id=$2) FOR UPDATE OF a`,
   [input.accountId,actor.customerUserId||null])).rows[0];
  if (!account) fault('ACCOUNT_NOT_FOUND','accountId',404);
  const number=(await db.query(`SELECT identifier,currency_code FROM avis_core_v2.abiq_generated_numbers
   WHERE identifier=$1 AND issued_by=$2 FOR UPDATE`,[input.identifier,actor.id])).rows[0];
  if (!number) fault('ABIQ_INVALID_IDENTIFIER','identifier');
  if (number.currency_code!==account.currency_code && !(number.currency_code==='579' && account.wallet_scope==='CUSTODY')) fault('ABIQ_CURRENCY_MISMATCH','identifier');
  const binding=(await db.query('SELECT ledger_account_id FROM avis_core_v2.abiq_number_bindings WHERE identifier=$1',[number.identifier])).rows[0];
  if (binding && binding.ledger_account_id!==input.accountId) fault('ABIQ_ALREADY_ASSIGNED','identifier',409);
  if (!binding) await db.query('INSERT INTO avis_core_v2.abiq_number_bindings(identifier,currency_code,ledger_account_id) VALUES($1,$2,$3)',
   [number.identifier,number.currency_code,input.accountId]);
  return {id:number.identifier,identifier:number.identifier,accountId:input.accountId};
 });
}

export async function availableGeneratorNumbers(db,actor,currency,after,accountId=null) {
 const rows=(await db.query(`SELECT g.identifier FROM avis_core_v2.abiq_generated_numbers g
  WHERE g.issued_by=$1 AND g.identifier>$3
  AND (($4::uuid IS NULL AND g.currency_code=$2) OR EXISTS(
   SELECT FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.abiq_currencies c USING(currency_code)
   WHERE a.account_id=$4 AND a.network IS NULL AND ($5::bigint IS NULL OR a.user_id=$5)
    AND (a.currency_code=g.currency_code OR (a.wallet_scope='CUSTODY' AND g.currency_code='579'))))
  AND NOT EXISTS(SELECT FROM avis_core_v2.abiq_number_bindings b WHERE b.identifier=g.identifier)
  ORDER BY g.identifier LIMIT 51`,[actor.id,currency,after||'',accountId,actor.customerUserId||null])).rows;
 const numbers=rows.slice(0,50).map(row=>row.identifier);
 return {numbers,next:rows.length>50?numbers.at(-1):null};
}
