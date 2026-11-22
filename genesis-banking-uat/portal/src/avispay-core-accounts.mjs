import {ABIQ_COUNTRIES,abiqMod97,buildAbiqNumber} from '../public/abiq-number.mjs';
export {abiqMod97};
import { normalizeIban } from './avispay-correspondent-mapping.mjs';

// Server-side service for the isolated core schema. The authenticated caller supplies
// customer/participant identity; these functions are not anonymous HTTP endpoints.
export const ABIQ_PARTITIONS = Object.freeze({EUR:'0978',GBP:'0826',CHF:'0756',SEK:'0752',
 NOK:'0578',DKK:'0208',PLN:'0985',CZK:'0203',HUF:'0348',RON:'0946',USD:'0840',
 AED:'0784',SGD:'0702',JPY:'0392'});
export const ABIQ_ISSUER = Object.freeze({participantCode:'AVIP',abiqCode:'AVIPTN64XXX',countryCode:'TN',accountDigits:12});
export const ABIQ_ACCOUNT_SERIES = Object.freeze({EUR:1,USD:2,GBP:3,CHF:4,SEK:5,NOK:6,DKK:7,PLN:8,CZK:9,HUF:10,RON:11,AED:12,SGD:13,JPY:14});
const fail = code => { throw Object.assign(new Error(code),{code}); };
function field(value,code,max=128) {
 if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\x00-\x1f\x7f]/.test(value)) fail(code);
 return value.trim();
}
function nodeCode(value) {
 const node=field(value,'ABIQ_INVALID_PARTICIPANT',4).toUpperCase();
 if(!/^[A-Z0-9]{4}$/.test(node)) fail('ABIQ_INVALID_PARTICIPANT');
 return node;
}
function customerId(value) {
 // Never round IDs through Number; rejects scientific notation, decimals and signs.
 if(typeof value==='number'&&!Number.isSafeInteger(value)) fail('ABIQ_INVALID_CUSTOMER');
 if(!['string','number','bigint'].includes(typeof value)||!/^\d{1,14}$/.test(String(value))||BigInt(value)<1n) fail('ABIQ_INVALID_CUSTOMER');
 return BigInt(value).toString();
}
function currencyCode(value) {
 const code=field(value,'ABIQ_UNSUPPORTED_CURRENCY',3).toUpperCase();
 if(!Object.hasOwn(ABIQ_PARTITIONS,code)) fail('ABIQ_UNSUPPORTED_CURRENCY');
 return code;
}
export function generateAbiqIban({userId,participantCode,currency}) {
 const bban=nodeCode(participantCode)+ABIQ_PARTITIONS[currencyCode(currency)]+customerId(userId).padStart(14,'0');
 return 'AQ'+String(98-abiqMod97(bban+'AQ00')).padStart(2,'0')+bban;
}
export function generateIssuedAbiqIban({customerNumber,currency}) {
 const curr=currencyCode(currency),ref=String(customerNumber);
 if(!/^\d{7}$/.test(ref)||BigInt(ref)<1000101n) fail('ABIQ_INVALID_CUSTOMER_NUMBER');
 return buildAbiqNumber({country:ABIQ_ISSUER.countryCode,holderCode:ABIQ_ISSUER.participantCode,
  currencyBlock:'000'+ABIQ_PARTITIONS[curr].slice(1),series:String(ABIQ_ACCOUNT_SERIES[curr]).padStart(5,'0'),customerNumber:ref});
}
export function isAbiqIdentifier(value) {
 const compact=typeof value==='string'?value.replace(/\s/g,'').toUpperCase():'';
 return compact.startsWith('AQ')||/^TN.{2}AVIP/.test(compact)||(ABIQ_COUNTRIES.includes(compact.slice(0,2))&&/^[A-Z]{2}\d{2}[A-Z]{4}000\d{15}$/.test(compact));
}
export function parseAbiqIban(value) {
 const identifier=field(value,'ABIQ_INVALID_IDENTIFIER',40).replace(/\s/g,'').toUpperCase();
 const countryCode=identifier.slice(0,2);
 const numbered=ABIQ_COUNTRIES.includes(countryCode)&&/^[A-Z]{2}(\d{2})([A-Z]{4})000(\d{3})(\d{5})(\d{7})$/.exec(identifier);
 const current=/^TN(\d{2})(AVIP)(\d{3})(\d{14})$/.exec(identifier);
 const legacy=/^AQ(\d{2})([A-Z0-9]{4})(0\d{3})(\d{14})$/.exec(identifier);
 const match=numbered||current||legacy;
 if(!match||abiqMod97(identifier.slice(4)+identifier.slice(0,4))!==1) fail('ABIQ_INVALID_IDENTIFIER');
 const custody=Boolean(numbered && match[3]==='579');
 const currency=custody?'579':Object.keys(ABIQ_PARTITIONS).find(c=>ABIQ_PARTITIONS[c]===(numbered||current?'0'+match[3]:match[3]));
 if(!currency) fail('ABIQ_UNSUPPORTED_CURRENCY');
 if(numbered){
  if(Number(match[4])!==(custody?15:ABIQ_ACCOUNT_SERIES[currency])||Number(match[5])<1000101) fail('ABIQ_INVALID_IDENTIFIER');
  return {identifier,participantCode:match[2],currency,countryCode,...(countryCode===ABIQ_ISSUER.countryCode&&match[2]===ABIQ_ISSUER.participantCode?{abiqCode:ABIQ_ISSUER.abiqCode}:{}),accountNumber:match[4]+match[5],accountSeries:match[4],customerNumber:match[5]};
 }
 const sequence=customerId(match[4]);
 return {identifier,participantCode:match[2],currency,...(current?
  {countryCode:'TN',abiqCode:ABIQ_ISSUER.abiqCode,accountNumber:sequence.padStart(14,'0')}:{userId:sequence})};
}
export async function provisionAbiqAccounts(db,{userId,participantCode,currencies,idempotencyKey}) {
 if(!Array.isArray(currencies)||!currencies.length||currencies.length>14) fail('ABIQ_INVALID_CURRENCIES');
 const args=[customerId(userId),nodeCode(participantCode),[...new Set(currencies.map(currencyCode))].sort(),field(idempotencyKey,'ABIQ_INVALID_REQUEST_KEY')];
 const result=await db.query('SELECT avis_core_v2.provision_abiq_accounts($1::bigint,$2::text,$3::text[],$4::text) AS accounts',args);
 return result.rows[0].accounts;
}
// An issued account keeps its original book owner. New currencies use the primary holder,
// or the customer's existing restricted book when requested through a customer login.
export async function provisionHolderAccounts(db,{userId,participantCode,currencies,idempotencyKey,scopedUserId=null}){
 if(!Array.isArray(currencies)||!currencies.length||currencies.length>14)fail('ABIQ_INVALID_CURRENCIES');
 const requested=[...new Set(currencies.map(currencyCode))].sort(),node=nodeCode(participantCode);
 const id=customerId(userId);
 const holder=(await db.query(`SELECT u.user_id FROM avis_core_v2.sovereign_users u
  JOIN avis_core_v2.holder_identities h ON h.user_id=u.user_id
  WHERE h.record_user_id=$1 FOR UPDATE OF u`,[id])).rows[0];
 if(!holder)fail('ABIQ_CUSTOMER_NOT_FOUND');
 const scoped=scopedUserId==null?null:customerId(scopedUserId);
 if(scoped&&scoped!==id)fail('ABIQ_ROUTE_OWNER_MISMATCH');
 const routes=(await db.query(`SELECT b.currency_code,b.user_id FROM avis_core_v2.abiq_routing_bridge b
  JOIN avis_core_v2.holder_identities h ON h.record_user_id=b.user_id
  WHERE h.user_id=$1 AND b.participant_code=$2 AND b.currency_code=ANY($3::text[])
  ORDER BY (b.user_id=$4) DESC,b.user_id`,[holder.user_id,node,requested,id])).rows;
 const owners=new Map();
 for(const currency of requested){
  const route=routes.find(row=>row.currency_code===currency);
  if(scoped&&route&&String(route.user_id)!==scoped)fail('ABIQ_CURRENCY_ALREADY_HELD');
  const owner=String(route?.user_id??scoped??holder.user_id);
  if(!owners.has(owner))owners.set(owner,[]);
  owners.get(owner).push(currency);
 }
 const accounts=[];
 for(const [owner,group] of owners){
  accounts.push(...await provisionAbiqAccounts(db,{userId:owner,participantCode:node,currencies:group,idempotencyKey}));
 }
 return accounts;
}
export async function ensureLedgerAbiq(db,accountId) {
 const result=await db.query('SELECT avis_core_v2.ensure_ledger_abiq($1::uuid) AS abiq_iban',[accountId]);
 return result.rows[0].abiq_iban;
}
// Identification covers every bank account; payment routing remains restricted to
// the funding bridge in resolveAbiqAccount. Custody/system IDs do not grant routing.
export async function findAbiqAccountIdentifier(db,{identifier,currency}) {
 const route=parseAbiqIban(identifier);
 const curr=route.currency==='579' && currency==='579'?null:currencyCode(currency);
 if(route.currency!=='579' && route.currency!==curr)fail('ABIQ_CURRENCY_MISMATCH');
 const result=await db.query(`SELECT i.ledger_account_id,i.abiq_iban,i.participant_code,i.currency_code,i.identifier_source,a.user_id
  FROM avis_core_v2.abiq_account_identifiers i JOIN avis_core_v2.ledger_accounts a ON a.account_id=i.ledger_account_id
  JOIN avis_core_v2.abiq_network_participants p USING(participant_code)
  WHERE (i.abiq_iban=$1 OR i.ledger_account_id IN (
   SELECT b.ledger_account_id FROM avis_core_v2.abiq_identifier_routes r
   JOIN avis_core_v2.abiq_routing_bridge b USING(bridge_id) WHERE r.identifier=$1)
   OR i.ledger_account_id IN (SELECT ledger_account_id FROM avis_core_v2.abiq_number_bindings WHERE identifier=$1)
   OR i.ledger_account_id IN (SELECT ledger_account_id FROM avis_core_v2.abiq_ledger_identifiers WHERE abiq_iban=$1))
   AND ($2::text IS NULL OR i.currency_code=$2) AND i.status='ACTIVE' AND p.is_active`,[route.identifier,curr]);
 return result.rows[0]||null;
}
export function normalizeAbiqBankRoute(input) {
 const accountType=field(input.accountType,'ABIQ_INVALID_BANK_ACCOUNT_TYPE',8).toUpperCase();
 if(!['IBAN','LOCAL'].includes(accountType)) fail('ABIQ_INVALID_BANK_ACCOUNT_TYPE');
 const country=field(input.country,'ABIQ_INVALID_BANK_COUNTRY',2).toUpperCase();
 if(!/^[A-Z]{2}$/.test(country)||country==='AQ') fail('ABIQ_INVALID_BANK_COUNTRY');
 const raw=field(input.accountNumber,'ABIQ_INVALID_BANK_ACCOUNT');
 if(accountType==='IBAN'&&isAbiqIdentifier(raw)) fail('ABIQ_INVALID_BANK_ACCOUNT');
 const accountNumber=accountType==='IBAN'?normalizeIban(raw):raw;
 if(accountType==='IBAN'&&accountNumber.slice(0,2)!==country) fail('ABIQ_BANK_COUNTRY_MISMATCH');
 const bic=input.bic==null?null:field(input.bic,'ABIQ_INVALID_BANK_BIC',11).toUpperCase();
 if(bic&&!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) fail('ABIQ_INVALID_BANK_BIC');
 return {accountType,accountNumber,country,bic,
  localRoutingCode:accountType==='LOCAL'?field(input.localRoutingCode,'ABIQ_LOCAL_ROUTING_REQUIRED',35):null,
  connectorCode:field(input.connectorCode,'ABIQ_CONNECTOR_REQUIRED',35),
  providerAccountId:field(input.providerAccountId,'ABIQ_PROVIDER_ACCOUNT_REQUIRED'),
  providerReference:field(input.providerReference,'ABIQ_PROVIDER_REFERENCE_REQUIRED')};
}
export async function linkAbiqBankRoute(db,{userId,participantCode,abiqIban,bankRoute}) {
 const target=parseAbiqIban(abiqIban),uid=customerId(userId),node=nodeCode(participantCode);
 if((target.userId!==undefined&&target.userId!==uid)||target.participantCode!==node) fail('ABIQ_ROUTE_OWNER_MISMATCH');
 const r=normalizeAbiqBankRoute(bankRoute);
 const result=await db.query(`
 WITH eligible AS (
  SELECT b.bridge_id,b.currency_code FROM avis_core_v2.abiq_routing_bridge b
  JOIN avis_core_v2.abiq_network_participants p USING(participant_code)
  JOIN avis_core_v2.platform_connectors c ON c.connector_code=$4
  WHERE b.bridge_id IN (SELECT bridge_id FROM avis_core_v2.abiq_identifier_routes WHERE identifier=$1) AND b.user_id=$2 AND b.participant_code=$3
   AND b.status='ACTIVE' AND p.is_active AND c.is_enabled FOR SHARE OF b,p,c
 )
 INSERT INTO avis_core_v2.abiq_bank_routes AS old
 (bridge_id,currency_code,connector_code,provider_account_id,account_type,account_number,country_code,bank_bic,local_routing_code,provider_reference)
 SELECT bridge_id,currency_code,$4,$5,$6,$7,$8,$9,$10,$11 FROM eligible
 ON CONFLICT(bridge_id) DO UPDATE SET bridge_id=EXCLUDED.bridge_id
 WHERE (old.connector_code,old.provider_account_id,old.account_type,old.account_number,old.country_code,old.bank_bic,old.local_routing_code)
 IS NOT DISTINCT FROM (EXCLUDED.connector_code,EXCLUDED.provider_account_id,EXCLUDED.account_type,EXCLUDED.account_number,EXCLUDED.country_code,EXCLUDED.bank_bic,EXCLUDED.local_routing_code)
 RETURNING bridge_id,currency_code,account_type,account_number,bank_bic,local_routing_code`,
 [target.identifier,uid,node,r.connectorCode,r.providerAccountId,r.accountType,r.accountNumber,r.country,r.bic,r.localRoutingCode,r.providerReference]);
 if(result.rows.length!==1) fail('ABIQ_BANK_ROUTE_NOT_LINKED');
 return result.rows[0];
}
export async function resolveAbiqAccount(db,{identifier,currency}) {
 const curr=currencyCode(currency),raw=field(identifier,'ABIQ_INVALID_IDENTIFIER');
 if(isAbiqIdentifier(raw)) {
  const route=parseAbiqIban(raw);
  if(route.currency==='579') return null;
  if(route.currency!==curr) fail('ABIQ_CURRENCY_MISMATCH');
  const result=await db.query(`SELECT b.bridge_id,b.ledger_account_id,b.user_id,b.participant_code,b.currency_code
   FROM avis_core_v2.abiq_routing_bridge b JOIN avis_core_v2.abiq_network_participants p USING(participant_code)
   WHERE b.bridge_id IN (SELECT bridge_id FROM avis_core_v2.abiq_identifier_routes WHERE identifier=$1) AND b.currency_code=$2 AND b.status='ACTIVE' AND p.is_active`,[route.identifier,curr]);
  return result.rows[0]||null;
 }
 const iban=normalizeIban(raw);
 const result=await db.query(`SELECT b.bridge_id,b.ledger_account_id,b.user_id,b.participant_code,b.currency_code
  FROM avis_core_v2.abiq_bank_routes r JOIN avis_core_v2.abiq_routing_bridge b USING(bridge_id,currency_code)
  JOIN avis_core_v2.abiq_network_participants p USING(participant_code)
  JOIN avis_core_v2.platform_connectors c USING(connector_code)
  WHERE r.account_type='IBAN' AND r.account_number=$1 AND b.currency_code=$2
   AND b.status='ACTIVE' AND p.is_active AND c.is_enabled`,[iban,curr]);
 return result.rows[0]||null;
}
