'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {mapCurrencyAccounts,prepareInboundPayment,paymentServerSummary}=require('../src/payment-server');
const {encodeFrame,LengthPrefixedFrames}=require('../src/payment-server-framing');
const {findCommonByProduct,findSuspense}=require('../src/common-accounts');
const common=findCommonByProduct('PAYMENT_CLEARING').code;
const suspense=findSuspense('PAYMENT_CLEARING','SETTLEMENT_UNCONFIRMED').code;
const allocation=(currency)=>({currency,commonAccountCode:common,suspenseAccountCode:suspense,commonAccountRef:'COMMON-'+currency,suspenseAccountRef:'SUSPENSE-'+currency,status:'activated'});
const payment=()=>({format:'SWIFT_FIN',type:'MT103',body:{
 '20':'ROUTE0001','23B':'CRED','32A':'261103EUR100,00','50K':'Test Ordering Party','59':'Test Beneficiary'
}});

test('Currency-specific COMMON and suspense mappings are isolated',()=>{
 const routes=mapCurrencyAccounts([allocation('EUR'),allocation('USD'),allocation('CHF')]);
 assert.equal(routes.size,3);
 assert.equal(routes.get('EUR').commonAccountRef,'COMMON-EUR');
 assert.equal(routes.get('CHF').suspenseAccountRef,'SUSPENSE-CHF');
 assert.throws(()=>mapCurrencyAccounts([allocation('EUR'),allocation('EUR')]),/DUPLICATE_CURRENCY/);
 assert.throws(()=>mapCurrencyAccounts([{...allocation('EUR'),status:'pending'}]),/NOT_ACTIVATED/);
 assert.throws(()=>mapCurrencyAccounts([{...allocation('EUR'),suspenseAccountRef:'COMMON-EUR'}]),/REUSED/);
 assert.throws(()=>mapCurrencyAccounts([{...allocation('EUR'),commonAccountCode:'COM-0001'}]),/PRODUCT_MISMATCH/);
 assert.throws(()=>mapCurrencyAccounts([allocation('EUR'),{...allocation('USD'),commonAccountRef:'COMMON-EUR'}]),/REUSED/);
});

test('Inbound FIN is only staged for later authenticated matching; nothing is credited',()=>{
 const first=prepareInboundPayment(payment(),[allocation('EUR')]);
 const second=prepareInboundPayment(payment(),[allocation('EUR')]);
 assert.equal(first.idempotencyKey,second.idempotencyKey);
 assert.equal(first.commonAccountRef,'COMMON-EUR');
 assert.equal(first.suspenseAccountRef,'SUSPENSE-EUR');
 assert.equal(first.posting,'none');
 assert.equal(first.externalAuthenticity,'unverified');
 assert.equal(first.settlementConfirmed,false);
 assert.equal(first.transport,'not_connected');
 assert.throws(()=>prepareInboundPayment(payment(),[allocation('USD')]),/NO_ACTIVE_CURRENCY_ACCOUNT/);
});

test('ISO20022 metadata can only be staged into its matching currency',()=>{
 const request={format:'ISO20022',type:'pacs.008',metadata:{messageId:'MSG1',endToEndId:'E2E1',currency:'USD',amount:'10.20'}};
 const result=prepareInboundPayment(request,[allocation('USD')]);
 assert.equal(result.currency,'USD');
 assert.equal(result.commonAccountRef,'COMMON-USD');
 assert.equal(result.posting,'none');
});

test('Payment Server status does not falsely assert active correspondent connections',()=>{
 const summary=paymentServerSummary();
 assert.equal(summary.financialPosting,false);
 assert.equal(summary.livePayments,false);
 assert.match(summary.transport,/not_connected/);
});

test('Frame codec reassembles split packets and multiple messages',async()=>{
 const frame1=encodeFrame(Buffer.from('abc'));
 const frame2=encodeFrame(Buffer.from('swift'));
 const decoder=new LengthPrefixedFrames({maxFrame:20});
 const received=[];
 decoder.on('data',part=>received.push(part.toString('utf8')));
 decoder.write(frame1.subarray(0,1));
 decoder.write(Buffer.concat([frame1.subarray(1),frame2.subarray(0,3)]));
 decoder.end(frame2.subarray(3));
 await new Promise((resolve,reject)=>decoder.once('end',resolve).once('error',reject));
 assert.deepEqual(received,['abc','swift']);
});

test('Framing rejects zero, overflow, truncated packets',async()=>{
 assert.throws(()=>encodeFrame(Buffer.alloc(0)),/INVALID_FRAME/);
 const decoder=new LengthPrefixedFrames({maxFrame:4});
 await assert.rejects(async()=>{
  decoder.resume();
  decoder.write(Buffer.from([0,5,1,2,3,4,5]));
  await new Promise((resolve,reject)=>decoder.once('finish',resolve).once('error',reject));
 },/INVALID_FRAME_LENGTH/);
 const partial=new LengthPrefixedFrames();
 partial.resume();
 await assert.rejects(async()=>{
  partial.end(Buffer.from([0,4,0]));
  await new Promise((resolve,reject)=>partial.once('finish',resolve).once('error',reject));
 },/INCOMPLETE_FRAME/);
});
