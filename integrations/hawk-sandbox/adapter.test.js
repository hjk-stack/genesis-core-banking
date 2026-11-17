'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{mapSynthetic,getConfiguration,checkSynthetic}=require('./adapter');
const sample={synthetic:true,transactionId:'SYN-DEMO_00000001',currency:'EUR',amountMinor:'12345'};
test('maps synthetic only',()=>assert.deepEqual(mapSynthetic(sample),{tenantTransactionId:sample.transactionId,settledAmount:123.45,settledCurrency:'EUR'}));
test('rejects customer data',()=>assert.throws(()=>mapSynthetic({...sample,iban:'DE123'}),/REAL_CUSTOMER_DATA_NOT_PERMITTED/));
test('disabled by default',()=>assert.throws(()=>getConfiguration({}),/HAWK_DISABLED/));
test('rejects insecure URL',()=>assert.throws(()=>getConfiguration({HAWK_ENVIRONMENT:'sandbox',HAWK_ALLOW_SANDBOX_CALLS:'YES',HAWK_SANDBOX_URL:'http://localhost/',HAWK_SANDBOX_API_KEY:'synthetic-test-token'}),/INVALID_HAWK_URL/));
test('mocked dry-run only',async()=>{let called=false;const result=await checkSynthetic(sample,{env:{HAWK_ENVIRONMENT:'sandbox',HAWK_ALLOW_SANDBOX_CALLS:'YES',HAWK_SANDBOX_URL:'https://sandbox.example.test/',HAWK_SANDBOX_API_KEY:'synthetic-test-token'},fetchImpl:async(url,opts)=>{called=true;assert.match(String(url),/dryRun=True/);assert.equal(opts.method,'POST');return {ok:true}}});assert.equal(called,true);assert.equal(result.dryRun,true)});
