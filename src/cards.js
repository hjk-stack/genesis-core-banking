'use strict';
// GENESIS ArtOfCards foundation. This service never accepts, logs or stores PAN,
// CVV/CVC, PIN, track data, cardholder authentication secrets or cryptographic keys.
const {randomUUID}=require('node:crypto');
const {minorUnits,currency}=require('./domain');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF=/^[A-Za-z0-9_.:-]{8,80}$/;
function id(v){if(typeof v!=='string'||!UUID.test(v))throw Error('INVALID_ID');return v}
function reference(v){if(typeof v!=='string'||!REF.test(v))throw Error('INVALID_REFERENCE');return v}
function actor(a,role){if(!a||a.authorized!==true||!a.id||a.role!==role)throw Error('NOT_AUTHORIZED')}
function rejectCardSecrets(input){
 const forbidden=/^(pan|cardNumber|cvv|cvc|pin|track1|track2|expiry|expiration|cardholderData|privateKey|secret|cryptogram|cardToken|token)$/i;
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('INVALID_INPUT');
 for(const key of Object.keys(input))if(forbidden.test(key))throw Error('SENSITIVE_CARD_DATA_NOT_ACCEPTED');
}
function validateIssuanceRequest(input){
 rejectCardSecrets(input);
 id(input.customerId);
 if(!['virtual','physical'].includes(input.formFactor))throw Error('INVALID_CARD_TYPE');
 if(!['debit','prepaid'].includes(input.productType))throw Error('INVALID_CARD_PRODUCT');
 reference(input.clientRequestId);
 return true;
}
function validateMerchantApplication(input){
 rejectCardSecrets(input);id(input.customerId);
 if(typeof input.merchantCategory!=='string'||!/^[0-9]{4}$/.test(input.merchantCategory))throw Error('INVALID_MCC');
 if(typeof input.displayName!=='string'||input.displayName.length<2||input.displayName.length>120)throw Error('INVALID_MERCHANT_NAME');
 reference(input.clientRequestId);return true;
}
function validateAcquiringEvent(input){
 rejectCardSecrets(input);id(input.merchantId);reference(input.externalReference);
 currency(input.currency);minorUnits(input.amountMinor);
 if(!['authorization','capture','refund','chargeback'].includes(input.eventType))throw Error('INVALID_EVENT_TYPE');
 // Records an untrusted processor report; it does not itself approve or settle money.
 return true;
}
async function draftCardApplication(db,a,input){
 actor(a,'card_operator');validateIssuanceRequest(input);
 const recordId=randomUUID();
 const r=await db.query("INSERT INTO banking.card_applications(id,customer_id,form_factor,product_type,client_request_id,status,created_by) VALUES($1,$2,$3,$4,$5,'pending_review',$6) ON CONFLICT(client_request_id) DO UPDATE SET client_request_id=EXCLUDED.client_request_id RETURNING id,status",
 [recordId,input.customerId,input.formFactor,input.productType,input.clientRequestId,a.id]);
 return r.rows[0];
}
async function draftMerchantApplication(db,a,input){
 actor(a,'merchant_operator');validateMerchantApplication(input);
 const recordId=randomUUID();
 const r=await db.query("INSERT INTO banking.merchant_applications(id,customer_id,display_name,merchant_category,client_request_id,status,created_by) VALUES($1,$2,$3,$4,$5,'pending_review',$6) ON CONFLICT(client_request_id) DO UPDATE SET client_request_id=EXCLUDED.client_request_id RETURNING id,status",
 [recordId,input.customerId,input.displayName,input.merchantCategory,input.clientRequestId,a.id]);
 return r.rows[0];
}
async function recordProcessorEventDraft(db,a,input){
 actor(a,'acquiring_operator');validateAcquiringEvent(input);
 const recordId=randomUUID();
 const r=await db.query("INSERT INTO banking.acquiring_event_reports(id,merchant_application_id,external_reference,event_type,asset_code,amount_minor,status,created_by) VALUES($1,$2,$3,$4,$5,$6,'unverified',$7) ON CONFLICT(merchant_application_id,external_reference,event_type) DO UPDATE SET external_reference=EXCLUDED.external_reference RETURNING id,status",
 [recordId,input.merchantId,input.externalReference,input.eventType,input.currency,minorUnits(input.amountMinor).toString(),a.id]);
 return r.rows[0];
}
module.exports={rejectCardSecrets,validateIssuanceRequest,validateMerchantApplication,validateAcquiringEvent,draftCardApplication,draftMerchantApplication,recordProcessorEventDraft};
