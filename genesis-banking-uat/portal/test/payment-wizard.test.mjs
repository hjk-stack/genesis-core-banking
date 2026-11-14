import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPaymentWizard} from '../public/payment-wizard.mjs';
let dom,wizard;const originalFormData=globalThis.FormData;
const account={abiq_iban:'TN89AVIP000978000011000101',full_name:'Sender',currency_code:'EUR',available_balance:'1234567890123456.120000000000000000'};
const address={street:'Receiver Road 1',city:'London',postalCode:'SW1A',country:'GB'};
function setup(handler){
 dom=new JSDOM('<!doctype html><body></body>',{url:'https://bank.invalid',pretendToBeVisual:true});globalThis.document=dom.window.document;globalThis.FormData=dom.window.FormData;
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const calls=[],notices=[];let refreshes=0;
 wizard=createPaymentWizard({api:async(path,body,key)=>{calls.push({path,body,key});if(handler)return handler(path,body,key);if(path==='payments/check-receiver')return {account:'TN62AVIP000978000011000102',bic:'AVIPTN64XXX',receiverName:'Internal Receiver',address,receiverBridgeId:'receiver'};
  if(path==='payments/review')return {id:'request',messageHash:'review-hash',message:'<message>exact</message>',format:'ISO20022',mode:'INTERNAL',instruction:body};
  if(path==='payments/transfer')return {current_status:'COMPLETED',delivery_mode:'INTERNAL'};
 },accounts:()=>[account],refresh:async()=>refreshes++,notice:s=>notices.push(s)});wizard.open();return {calls,notices,refreshes:()=>refreshes};
}
const q=s=>document.querySelector(s),fields=()=>q('form').elements;
const fill=(name,value)=>{fields()[name].value=value;fields()[name].dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
const next=()=>q('form').onsubmit({preventDefault(){}});
const back=()=>q('[data-back]').click();
afterEach(()=>{wizard?.close();dom?.window.close();delete globalThis.document;globalThis.FormData=originalFormData;});
test('sliding popup preserves inputs, displays exact available balance and waits for final Transfer',async()=>{
 const state=setup();fill('from',account.abiq_iban);fill('amount','12.50');
 assert.match(q('[data-balance]').textContent,/1,234,567,890,123,456.12 EUR/);assert.equal(q('[data-back]').hidden,true);
 await next();assert.match(q('.payment-track').className,/step-1/);assert.equal(fields().from.value,account.abiq_iban);assert.equal(fields().amount.value,'12.50');
 fill('receiverBic','OTHERGB2LXXX');fill('receiverAccount','000011000102');assert.equal(fields().receiverBic.value,'');await next();assert.match(q('.payment-track').className,/step-2/);
 assert.equal(fields().receiverBic.value,'AVIPTN64XXX');assert.equal(fields().receiverName.value,'Internal Receiver');assert.equal(fields().receiverName.readOnly,true);assert.equal(fields().street.value,address.street);assert.equal(fields().city.value,address.city);
 back();await next();assert.equal(fields().street.value,address.street);await next();fill('reference','Invoice & parts');await next();
 assert.match(q('.payment-track').className,/step-4/);assert.equal(q('[data-message]').textContent,'<message>exact</message>');assert.equal(q('[data-next]').textContent,'Transfer');
 assert.equal(state.calls.filter(c=>c.path==='payments/transfer').length,0);
 back();fill('reference','Invoice amended');await next();const reviews=state.calls.filter(c=>c.path==='payments/review');assert.equal(reviews.length,2);assert.notEqual(reviews[0].key,reviews[1].key);assert.equal(reviews[1].body.reference,'Invoice amended');
 await next();assert.equal(state.calls.filter(c=>c.path==='payments/transfer').length,1);assert.equal(q('dialog').open,false);assert.equal(state.refreshes(),1);assert.equal(state.notices[0],'Transfer completed');
});
test('field errors return to their panel and prevent advancing or posting a payment',async()=>{
 const state=setup(async()=>{throw Object.assign(new Error('Check the receiving account.'),{field:'receiverAccount'});});
 await next();assert.match(q('.payment-track').className,/step-0/);assert.equal(state.calls.length,0);
 fill('from',account.abiq_iban);fill('amount','1');await next();fill('receiverAccount','broken');await next();
 assert.match(q('.payment-track').className,/step-1/);assert.equal(fields().receiverAccount.getAttribute('aria-invalid'),'true');assert.equal(q('[data-error=receiverAccount]').textContent,'Check the receiving account.');
 assert.equal(state.calls.some(c=>c.path==='payments/transfer'),false);q('.payment-close').click();assert.equal(q('dialog').open,false);
});
test('double submit while lookup is in flight advances one panel only',async()=>{
 let resolve;setup(()=>new Promise(r=>resolve=r));fill('from',account.abiq_iban);fill('amount','1');await next();fill('receiverAccount','000011000102');
 const pending=next();await next();assert.equal(q('[data-next]').disabled,true);assert.equal(q('.payment-close').disabled,true);
 resolve({account:'TN62AVIP000978000011000102',bic:'AVIPTN64XXX',receiverName:'Internal Receiver',address,receiverBridgeId:'receiver'});await pending;
 assert.match(q('.payment-track').className,/step-2/);assert.equal(q('[data-next]').disabled,false);
});
