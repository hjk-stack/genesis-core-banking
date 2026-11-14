import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPaymentWizard} from '../public/payment-wizard.mjs';
let dom,wizard;const originalFormData=globalThis.FormData;
const account={user_id:'1',abiq_iban:'TN89AVIP000978000011000101',full_name:'Sender',currency_code:'EUR',available_balance:'1234567890123456.120000000000000000'};
const address={street:'Receiver Road 1',city:'London',postalCode:'SW1A',country:'GB'};
function setup(handler,views={},options={}){
 dom=new JSDOM('<!doctype html><body></body>',{url:'https://bank.invalid',pretendToBeVisual:true});globalThis.document=dom.window.document;globalThis.FormData=dom.window.FormData;
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const calls=[],notices=[];let refreshes=0;
 wizard=createPaymentWizard({api:async(path,body,key)=>{calls.push({path,body,key});if(handler)return handler(path,body,key);if(path==='payments/check-receiver')return {account:'TN62AVIP000978000011000102',bic:'AVIPTN64XXX',receiverName:'Internal Receiver',address,addressSource:'REGISTERED',receiverBridgeId:'receiver'};
  if(path==='payments/crypto-receiver')return {receiverName:views.customers?.find(r=>String(r.user_id)===body.receiverUserId)?.full_name||'Crypto Receiver'};
  if(path==='payments/review')return {id:'request',messageHash:'review-hash',message:'<message>exact</message>',format:'ISO20022',mode:'INTERNAL',instruction:body};
  if(path==='payments/transfer')return {current_status:'COMPLETED',delivery_mode:'INTERNAL'};
 },accounts:()=>[account],data:v=>views[v]||[],refresh:async()=>refreshes++,notice:s=>notices.push(s),...options});wizard.open();return {calls,notices,refreshes:()=>refreshes};
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
 assert.equal(fields().receiverBic.value,'AVIPTN64XXX');assert.equal(fields().receiverName.value,'Internal Receiver');assert.equal(fields().receiverName.readOnly,true);assert.equal(fields().street.value,address.street);assert.equal(fields().city.value,address.city);assert.equal(fields().street.readOnly,true);assert.equal(fields().country.readOnly,true);
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
 resolve({account:'TN62AVIP000978000011000102',bic:'AVIPTN64XXX',receiverName:'Internal Receiver',address,addressSource:'REGISTERED',receiverBridgeId:'receiver'});await pending;
 assert.match(q('.payment-track').className,/step-2/);assert.equal(q('[data-next]').disabled,false);
});
test('crypto selector filters holdings by sender and preserves exact crypto quantity through review',async()=>{
 const views={cryptoholdings:[{account_id:'own-eth',user_id:'1',currency_code:'ETH',network:'ETHEREUM',available_balance:'2.123456789012345678'},{account_id:'other-eth',user_id:'2',currency_code:'ETH',network:'ETHEREUM',available_balance:'99'}],customers:[{user_id:'2',full_name:'Crypto Receiver'}]};
 const state=setup(undefined,views,{isAdmin:()=>false,userId:()=> '1'});fill('method','CRYPTO');fill('cryptoAccount','own-eth');fill('amount','0.123456789012345678');
 assert.equal(fields().cryptoAccount.querySelector('[value=other-eth]'),null);assert.match(q('[data-balance]').textContent,/2.123456789012345678 ETH/);
 await next();fill('receiverUserId','2');await next();assert.equal(fields().receiverName.value,'Crypto Receiver');assert.equal(fields().street.disabled,true);await next();fill('reference','Crypto fixture');await next();
 const reviewed=state.calls.find(c=>c.path==='payments/review');assert.equal(reviewed.body.method,'CRYPTO');assert.equal(reviewed.body.cryptoAccount,'own-eth');assert.equal(reviewed.body.amount,'0.123456789012345678');assert.equal(reviewed.body.receiverUserId,'2');
 assert.equal(state.calls.some(c=>c.path==='payments/check-receiver'),false);
});
const cards={transfercards:[{card_id:'own-card',user_id:'1',full_name:'Sender',card_number:'AVIS-1234',currency_code:'EUR',available_balance:'75',card_rail_mode:'AVIS_PROPRIETARY_ONLY'}]};
test('code-secured force payment uses the card balance, accepts a validity window and shows its six-digit receipt',async()=>{
 const state=setup(async(path,body)=>{
  if(path==='payments/review')return {id:'coded-request',mode:'INTERNAL',format:'AVIS_TRANSFER_V1',message:'Card instruction',messageHash:'hash',instruction:{...body,receiverName:'Sender',destinationLabel:'Code delivery'}};
  if(path==='payments/transfer')return {request_id:'coded-request',current_status:'COMPLETED',delivery_mode:'INTERNAL',hasDelivery:true};
  if(path==='payments/card-delivery')return {holder:'Sender',amount:'12',currency:'EUR',code:'012345',redemptionToken:'isolated-token',validFrom:'2098-12-31T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'};
 },cards);
 fill('method','CODED_CARD');fill('amount','12');fields().offlineDebit.checked=true;fields().offlineDebit.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
 assert.equal(fields().from.disabled,true);assert.equal(fields().sourceCardId.value,'own-card');assert.match(q('[data-balance]').textContent,/75.00 EUR/);assert.equal(fields().codeStart.disabled,false);
 await next();assert.equal(q('[data-code-delivery]').hidden,false);await next();assert.equal(fields().receiverName.value,'Sender');assert.equal(fields().street.disabled,true);await next();fill('reference','Coded card fixture');await next();await next();
 assert.equal(q('.card-code').textContent,'012345');assert.equal(q('dialog').open,true);assert.equal(q('[data-next]').hidden,true);
 const body=state.calls.find(c=>c.path==='payments/review').body;assert.equal(body.sourceCardId,'own-card');assert.equal(body.from,undefined);assert.equal(body.offlineDebit,true);assert.ok(Date.parse(body.codeEnd)-Date.parse(body.codeStart)<=48*3600000);
 await next();assert.equal(state.calls.filter(c=>c.path==='payments/transfer').length,1);
});
test('changing force payment to normal card clears the code option and restores recipient fields',async()=>{
 const state=setup(undefined,cards);fill('method','CODED_CARD');fields().offlineDebit.checked=true;fill('amount','10');fill('method','CARD');
 assert.equal(fields().offlineDebit.checked,false);assert.equal(fields().offlineDebit.disabled,true);assert.equal(fields().codeStart.disabled,true);assert.equal(fields().from.disabled,true);
 await next();fill('receiverAccount','000011000102');await next();await next();fill('reference','Card payment');await next();
 const body=state.calls.find(c=>c.path==='payments/review').body;assert.equal(body.method,'CARD');assert.equal(body.sourceCardId,'own-card');assert.equal(body.offlineDebit,false);assert.equal(body.from,undefined);
 assert.equal(body.receiverName,'Internal Receiver');assert.equal(q('.payment-error').textContent,'');
});
test('requested copy and labels replace redundant payment headings and sender prompts',()=>{
 setup(undefined,cards);assert.equal(q('.eyebrow'),null);assert.equal(q('dialog').textContent.includes('Account and amount'),false);assert.equal(q('dialog').textContent.includes('Select the account to display its balance.'),false);
 fill('method','CRYPTO');assert.equal(fields().from.disabled,true);assert.match(q('dialog').textContent,/AG and AGi as payment media/);assert.match(q('dialog').textContent,/purchase now/);
 assert.equal(fields().method.querySelector('[value=CODED_CARD]').textContent,'Make a force payment');
});
