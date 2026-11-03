'use strict';
const {createHash}=require('node:crypto');
const {findCommonByProduct,findSuspense}=require('./common-accounts');
const {normalizeFIN,normalizeISO20022}=require('./message-adapters');

// Pure routing functions. No externally reachable bank host and no ledger booking.
// Each currency must have one specifically activated COMMON account and one suspense
// account, both under the same payment clearing product; no cross-currency netting.
const ACCOUNT_PRODUCT='PAYMENT_CLEARING';
const COMMON=findCommonByProduct(ACCOUNT_PRODUCT);
const SUSPENSE=findSuspense(ACCOUNT_PRODUCT,'SETTLEMENT_UNCONFIRMED');
const CURRENCY_PATTERN=/^[A-Z]{3}$/;
const ACCOUNT_REF_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
function checkCurrency(currency){
 if(typeof currency!=='string'||!CURRENCY_PATTERN.test(currency))throw Error('INVALID_CURRENCY');
 return currency;
}
function checkRef(value,field){
 if(typeof value!=='string'||!ACCOUNT_REF_PATTERN.test(value))throw Error('INVALID_'+field);
 return value;
}
function mapCurrencyAccounts(allocations){
 if(!Array.isArray(allocations))throw Error('INVALID_ACCOUNT_ALLOCATIONS');
 const seen=new Set(),accounts=new Map(),references=new Set();
 for(const a of allocations){
  if(!a||typeof a!=='object'||Array.isArray(a))throw Error('INVALID_ACCOUNT_ALLOCATION');
  const currency=checkCurrency(a.currency);
  if(seen.has(currency))throw Error('DUPLICATE_CURRENCY_ALLOCATION');
  seen.add(currency);
  const commonRef=checkRef(a.commonAccountRef,'COMMON_REFERENCE');
  const suspenseRef=checkRef(a.suspenseAccountRef,'SUSPENSE_REFERENCE');
  if(commonRef===suspenseRef||references.has(commonRef)||references.has(suspenseRef))throw Error('ACCOUNT_REFERENCE_REUSED');
  references.add(commonRef);references.add(suspenseRef);
  if(a.commonAccountCode!==COMMON.code||a.suspenseAccountCode!==SUSPENSE.code)throw Error('ACCOUNT_PRODUCT_MISMATCH');
  if(a.status!=='activated')throw Error('ACCOUNT_NOT_ACTIVATED');
  accounts.set(currency,Object.freeze({currency,commonAccountCode:COMMON.code,suspenseAccountCode:SUSPENSE.code,commonAccountRef:commonRef,suspenseAccountRef:suspenseRef}));
 }
 return accounts;
}
function normalizePaymentMessage(message){
 if(!message||typeof message!=='object'||Array.isArray(message))throw Error('INVALID_MESSAGE');
 let normalized;
 if(message.format==='SWIFT_FIN')normalized=normalizeFIN(message.type,message.body);
 else if(message.format==='ISO20022')normalized=normalizeISO20022(message.type,message.metadata);
 else throw Error('UNSUPPORTED_FORMAT');
 return normalized;
}
function prepareInboundPayment(message,allocations){
 const normalized=normalizePaymentMessage(message);
 const currency=checkCurrency(normalized.settlement.currency);
 const accounts=mapCurrencyAccounts(allocations);
 const mapped=accounts.get(currency);
 if(!mapped)throw Error('NO_ACTIVE_CURRENCY_ACCOUNT');
 // Content is unverified; it must not mutate the COMMON account or claim funds.
 // Explicit suspense is the target for later authenticated, reconciled processing.
 const key=createHash('sha256').update([normalized.format,normalized.type,normalized.reference,normalized.relatedReference||'',currency,normalized.settlement.amount].join('|')).digest('hex');
 return Object.freeze({
  idempotencyKey:key,
  currency,reference:normalized.reference,format:normalized.format,type:normalized.type,
  correspondentRoute:'unconfigured',transport:'not_connected',
  commonAccountCode:mapped.commonAccountCode,commonAccountRef:mapped.commonAccountRef,
  suspenseAccountCode:mapped.suspenseAccountCode,suspenseAccountRef:mapped.suspenseAccountRef,
  externalAuthenticity:'unverified',settlementConfirmed:false,
  posting:'none',state:'awaiting_authenticated_correspondent_and_settlement',
  relatedReference:normalized.relatedReference||null
 });
}
function paymentServerSummary(){
 return {module:'Payment Server',transport:'ip_to_ip_adapter_not_connected',
  formats:['SWIFT_FIN','ISO20022'],accountProduct:ACCOUNT_PRODUCT,
  commonAccountTemplate:COMMON.code,suspenseAccountTemplate:SUSPENSE.code,
  currencyAccounts:'requires_explicit_activation',financialPosting:false,livePayments:false};
}
module.exports={mapCurrencyAccounts,normalizePaymentMessage,prepareInboundPayment,paymentServerSummary};
