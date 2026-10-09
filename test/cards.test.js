'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const cards=require('../src/cards');
const customerId='123e4567-e89b-12d3-a456-426614174000';
test('card applications only accept metadata',()=>{
 assert.equal(cards.validateIssuanceRequest({customerId,formFactor:'virtual',productType:'debit',clientRequestId:'REQUEST-0000001'}),true);
 assert.throws(()=>cards.validateIssuanceRequest({customerId,formFactor:'virtual',productType:'debit',clientRequestId:'REQUEST-0000001',pan:'4111111111111111'}),/SENSITIVE_CARD_DATA_NOT_ACCEPTED/);
 assert.throws(()=>cards.validateIssuanceRequest({customerId,formFactor:'physical',productType:'credit',clientRequestId:'REQUEST-0000001'}),/INVALID_CARD_PRODUCT/);
});
test('merchant onboarding requires validated metadata',()=>{
 assert.equal(cards.validateMerchantApplication({customerId,displayName:'GENESIS Merchant',merchantCategory:'5999',clientRequestId:'MERCHANT-00001'}),true);
 assert.throws(()=>cards.validateMerchantApplication({customerId,displayName:'X',merchantCategory:'5999',clientRequestId:'MERCHANT-00001'}),/INVALID_MERCHANT_NAME/);
});
test('acquiring event is recorded as unverified only',()=>{
 assert.equal(cards.validateAcquiringEvent({merchantId:customerId,externalReference:'PROCESSOR-EVT001',currency:'USD',amountMinor:'1000',eventType:'authorization'}),true);
 assert.throws(()=>cards.validateAcquiringEvent({merchantId:customerId,externalReference:'PROCESSOR-EVT001',currency:'USD',amountMinor:'0',eventType:'authorization'}),/INVALID_AMOUNT/);
 assert.throws(()=>cards.validateAcquiringEvent({merchantId:customerId,externalReference:'PROCESSOR-EVT001',currency:'USD',amountMinor:'1000',eventType:'settlement'}),/INVALID_EVENT_TYPE/);
 assert.throws(()=>cards.validateAcquiringEvent({merchantId:customerId,externalReference:'PROCESSOR-EVT001',currency:'USD',amountMinor:'1000',eventType:'capture',cvv:'123'}),/SENSITIVE_CARD_DATA_NOT_ACCEPTED/);
});
