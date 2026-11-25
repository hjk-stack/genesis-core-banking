import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {checkoutIpRegister,checkoutIpAdminControls,createCheckoutIpAdminControls,bindCheckoutIp,replaceCheckoutIpRegister,checkoutIpFingerprint,checkoutIpHandlerUrl,createCheckoutIpProof,expireCheckoutIpControls} from '../public/checkout-ip.mjs';

const id='5a056e8a-0d06-4de8-9cf2-4cb2b3ad5730';
const request=(extra={})=>({requestId:id,checkoutReference:'MILESTONE-1',title:'Project milestone',senderBankName:'Sender bank',
 senderIp:'192.0.2.12',authorizedPerson:'Authorised sender',senderAccount:'SENDER-IBAN',senderAccountName:'Sender account holder',
 amount:'200.00',currency:'EUR',source:'industrial',status:'REQUESTED',requestedAt:new Date().toISOString(),
 expiresAt:new Date(Date.now()+3600000).toISOString(),...extra});
const accounts=[{account_id:'common',owner_type:'COMMON_POOL',currency_code:'EUR',abiq_iban:'COMMON-IBAN'},
 {account_id:'suspense',owner_type:'SUSPENSE_INBOUND',currency_code:'EUR',abiq_iban:'SUSPENSE-IBAN'},
 {account_id:'usd',owner_type:'COMMON_POOL',currency_code:'USD',abiq_iban:'USD-IBAN'}];
const nostros=[{cash_account_id:'bank-a',currency_code:'EUR',is_active:true,institution_name:'Nostro A',iban_or_account_no:'NOSTRO-A',
 intermediaries:[{intermediaryId:'intermediary-a',bankName:'Intermediary A',reference:'A'}]},
 {cash_account_id:'bank-b',currency_code:'EUR',is_active:true,institution_name:'Nostro B',iban_or_account_no:'NOSTRO-B',
 intermediaries:[{intermediaryId:'intermediary-b',bankName:'Intermediary B',reference:'B'}]}];
const processing={bankName:'Processing bank',bankServerSentAmount:'199.999999999999999999',nostroIban:'NOSTRO-A',
 receivingAbiqIban:'COMMON-IBAN',amountCleared:'198.01',beneficiaryName:'Beneficiary name',beneficiaryAccount:'BENEFICIARY-IBAN',
 franchiseAllocatedPercent:'12.50',operationCompleted:true,manualReport100Digits:'0123456789'.repeat(10),
 transactionReference:'TRANSACTION-001',revision:4,proof:{available:true,fileName:'original-proof.pdf',sha256:'a'.repeat(64),sizeBytes:400}};
const domFor=rows=>new JSDOM('<!doctype html><body>'+checkoutIpRegister(rows,accounts,nostros)+'</body>',{url:'https://bank.example/'});
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('processing columns follow the supplied register and retain exact amounts, accounts, report and proof',()=>{
 const dom=domFor([request({processing,status:'ACTIVE',receivingAccountId:'common',nostroCashAccountId:'bank-a',intermediaryId:'intermediary-a'})]);
 try{
  const doc=dom.window.document,heads=[...doc.querySelectorAll('th')].map(x=>x.textContent),cells=[...doc.querySelectorAll('tbody tr td')];
  assert.deepEqual(heads,['Checkout / Request','Sender / Bank','Sender Account','Payment','Currency','NOSTRO','Amount Cleared','Beneficiary name','Beneficiary Account','Franchise Payment','Operation Completed','Proof of Payment']);
  assert.equal(cells.length,heads.length);
  assert.ok(cells[0].querySelector('[role=switch]'));assert.ok(cells[0].querySelector('[data-ip-handler]'));
  assert.match(cells[1].textContent,/Processing bank/);assert.match(cells[2].textContent,/SENDER-IBAN/);
  assert.match(cells[3].textContent,/199\.999999999999999999/);assert.equal(cells[4].textContent,'EUR');
  assert.match(cells[5].textContent,/NOSTRO-A/);assert.match(cells[6].textContent,/198\.01/);assert.match(cells[6].textContent,/COMMON-IBAN/);
  assert.equal(cells[7].textContent,'Beneficiary name');assert.equal(cells[8].textContent,'BENEFICIARY-IBAN');assert.match(cells[9].textContent,/12\.50 %/);
  assert.equal(cells[10].querySelector('textarea').value,processing.manualReport100Digits);assert.equal(cells[10].querySelector('textarea').readOnly,true);
  assert.ok(cells[11].querySelector('[data-ip-proof]'));assert.equal(doc.querySelector('[role=switch]').getAttribute('aria-checked'),'true');
  assert.equal(doc.querySelector('[data-ip-account]').disabled,true);
 }finally{dom.window.close();}
});

test('a request or approval without handler proof never becomes a proof button or completed payment',()=>{
 for(const status of ['REQUESTED','ACTIVE','CLOSED']){
  const dom=domFor([request({status})]);
  try{
   assert.equal(dom.window.document.querySelector('[data-ip-proof]'),null);
   assert.equal(dom.window.document.querySelector('tbody tr').children[10].textContent,'—');
   assert.equal(dom.window.document.querySelector('[data-ip-toggle]').dataset.state,status);
  }finally{dom.window.close();}
 }
});

test('an empty register does not fabricate request controls and handler links retain their normal destination',()=>{
 const dom=domFor([]);
 try{
  bindCheckoutIp({root:dom.window.document});
  assert.equal(dom.window.document.querySelector('[data-ip-handler-open]'),null);assert.equal(dom.window.document.querySelectorAll('[data-ip-toggle]').length,0);
  assert.equal(checkoutIpHandlerUrl(null),'https://avis.land/admin/bank/quantum/direct-transfer');
  assert.equal(new URL(checkoutIpHandlerUrl(request())).searchParams.get('checkoutRequest'),id);
 }finally{dom.window.close();}
});

class ManagementTestChannel{
 constructor(){
  const port=()=>({closed:false,onmessage:null,start(){},close(){this.closed=true;},postMessage(data){if(!this.closed&&!this.peer.closed)this.peer.onmessage?.({data});}});
  this.port1=port();this.port2=port();this.port1.peer=this.port2;this.port2.peer=this.port1;
 }
}
function adminHarness({rows=[],activateRequest=async()=>{},open,cooperate=true}={}){
 const dom=new JSDOM('<!doctype html><body><div id="mount">'+checkoutIpAdminControls()+'</div><div id="requests">'+checkoutIpRegister(rows,accounts,nostros)+'</div></body>',{url:'https://bank.example/'}),doc=dom.window.document;
 const tabs=[],calls=[],timers=new Map();let sequence=0;
 const windowApi={MessageChannel:ManagementTestChannel,open:(...args)=>{
  calls.push(args);if(open)return open(...args);
  const events=[],messages=[],tab={closed:false,opener:{},location:{href:'about:blank',origin:'null',replace:url=>{assert.equal(tab.opener,null);events.push(url);tab.location.href=url;tab.location.origin=new URL(url).origin;}},close(){this.closed=true;},events,messages,
   postMessage(data,targetOrigin,ports){
    messages.push({data,targetOrigin,ports});if(!cooperate)return;
    assert.equal(targetOrigin,'https://avis.land');assert.equal(data.type,'avis-ip-management-init');assert.equal(data.token,new URL(tab.location.href).hash.slice('#managementToken='.length));assert.equal(ports.length,1);
    ports[0].onmessage=({data:message})=>{if(message.type==='avis-ip-management-close'&&message.token===data.token)tab.closed=true;};
    ports[0].postMessage({type:'avis-ip-management-ready',token:data.token});
   }};
  tabs.push(tab);return tab;
 },setInterval:fn=>{timers.set(++sequence,fn);return sequence;},clearInterval:id=>timers.delete(id)};
 const controller=createCheckoutIpAdminControls({root:doc,windowApi,activateRequest});controller.bind(doc);controller.update(rows);
 return {dom,doc,tabs,calls,timers,controller,select:id=>{const field=doc.querySelector('[data-ip-admin-request]');field.value=id;field.dispatchEvent(new dom.window.Event('change'));},close(){controller.close();dom.window.close();}};
}

test('permanent administrator switches render with no requests and no data fetch',()=>{
 const h=adminHarness();try{
  assert.equal(h.doc.querySelectorAll('[data-ip-admin-controls] [role=switch]').length,3);assert.equal(h.doc.querySelectorAll('[data-checkout-ip]').length,0);
  const access=h.doc.querySelector('[data-ip-admin-access]'),management=h.doc.querySelector('[data-ip-admin-management]');
  assert.equal(access.dataset.state,'CLOSED');assert.equal(access.getAttribute('aria-disabled'),'true');assert.equal(management.dataset.state,'CLOSED');assert.equal(management.disabled,false);assert.deepEqual(h.calls,[]);
  assert.equal(access.closest('.table-wrap'),null);assert.equal(management.closest('.table-wrap'),null);
 }finally{h.close();}
});

test('IP sliders keep an explicit knob and accessible three-state status without visible state labels',()=>{
 const record=request(),h=adminHarness({rows:[record]});try{
  const access=h.doc.querySelector('[data-ip-admin-access]'),management=h.doc.querySelector('[data-ip-admin-management]');
  assert.equal(access.getAttribute('aria-description'),'Closed');h.select(id);
  assert.equal(access.getAttribute('aria-description'),'Waiting for bank approval');assert.equal(access.getAttribute('aria-checked'),'false');
  h.controller.update([{...record,status:'ACTIVE'}]);assert.equal(h.doc.querySelector('[data-ip-admin-request]').value,id);
  assert.equal(access.getAttribute('aria-description'),'Approved');assert.equal(access.getAttribute('aria-checked'),'true');
  h.controller.update([record]);h.controller.expire(Date.parse(record.expiresAt));expireCheckoutIpControls(h.doc,Date.parse(record.expiresAt));
  for(const button of [access,h.doc.querySelector('[data-ip-toggle]')]){
   assert.equal(button.dataset.state,'CLOSED');assert.equal(button.getAttribute('aria-description'),'Closed');assert.equal(button.getAttribute('aria-disabled'),'true');
  }
  management.click();assert.equal(management.getAttribute('aria-description'),'Management tab open');
  for(const button of h.doc.querySelectorAll('[data-ip-admin-access],[data-ip-admin-management],[data-ip-toggle]')){
   assert.equal(button.tagName,'BUTTON');assert.equal(button.type,'button');assert.equal(button.classList.contains('ip-liquid-slider'),true);
   assert.equal(button.querySelectorAll(':scope > .pos-liquid-knob[aria-hidden=true]').length,1);assert.equal(button.textContent,'');
  }
  assert.equal(h.doc.querySelectorAll('.pos-activation-label,[data-ip-admin-access-state],[data-ip-admin-management-state]').length,0);
 }finally{h.close();}
});

test('access requires an explicit request and delegates validation to its actual row',async()=>{
 const record=request(),calls=[],h=adminHarness({rows:[record],activateRequest:async requestId=>{
  const row=[...h.doc.querySelectorAll('[data-checkout-ip]')].find(row=>row.dataset.checkoutIp===requestId),button=row.querySelector('[data-ip-toggle]');await button.onclick({currentTarget:button});
 }});try{
  bindCheckoutIp({root:h.doc,requests:[record],nostros,activate:async input=>{calls.push(input);return {};},onChange:()=>{},openHandler:()=>{}});
  const access=h.doc.querySelector('[data-ip-admin-access]');access.click();await settle();assert.equal(calls.length,0);assert.equal(access.dataset.state,'CLOSED');
  h.select(id);assert.equal(access.dataset.state,'REQUESTED');access.click();await settle();assert.equal(calls.length,0);assert.equal(h.doc.activeElement,h.doc.querySelector('[data-ip-account]'));
  h.doc.querySelector('[data-ip-account]').value='common';access.click();await settle();assert.equal(calls[0].requestId,id);assert.equal(calls[0].receivingAccountId,'common');
  h.controller.update([{...record,status:'ACTIVE'}]);assert.equal(access.dataset.state,'ACTIVE');assert.equal(access.getAttribute('aria-checked'),'true');
 }finally{h.close();}
});

test('refresh preserves explicit identity and focus without selecting a reordered or replacement request',async()=>{
 const other=request({requestId:'other',checkoutReference:'OTHER'}),calls=[],h=adminHarness({rows:[request(),other],activateRequest:async id=>calls.push(id)});try{
  assert.equal(h.doc.querySelector('[data-ip-admin-request]').value,'');h.select('other');h.doc.querySelector('[data-ip-admin-request]').focus();
  h.controller.update([other,request()]);assert.equal(h.doc.querySelector('[data-ip-admin-request]').value,'other');assert.equal(h.doc.activeElement,h.doc.querySelector('[data-ip-admin-request]'));
  h.doc.querySelector('[data-ip-admin-access]').click();await settle();assert.deepEqual(calls,['other']);
  h.controller.update([request()]);assert.equal(h.doc.querySelector('[data-ip-admin-request]').value,'');assert.equal(h.doc.querySelector('[data-ip-admin-access]').dataset.state,'CLOSED');
  h.doc.querySelector('[data-ip-admin-access]').click();await settle();assert.deepEqual(calls,['other']);
 }finally{h.close();}
});

test('remount blocks stale request activation until refresh completes and expiration closes the selected control',async()=>{
 const calls=[],record=request(),h=adminHarness({rows:[record],activateRequest:async id=>calls.push(id)});try{
  h.select(id);h.doc.querySelector('[data-ip-admin-access]').focus();h.doc.querySelector('#mount').innerHTML=checkoutIpAdminControls();h.controller.bind(h.doc.querySelector('#mount'));
  assert.equal(h.doc.activeElement,h.doc.querySelector('[data-ip-admin-access]'));h.doc.querySelector('[data-ip-admin-access]').click();await settle();assert.deepEqual(calls,[]);
  h.controller.update([record]);assert.equal(h.doc.querySelector('[data-ip-admin-request]').value,id);assert.equal(h.doc.querySelector('[data-ip-admin-access]').dataset.state,'REQUESTED');
  h.controller.expire(Date.parse(record.expiresAt));assert.equal(h.doc.querySelector('[data-ip-admin-access]').dataset.state,'CLOSED');assert.equal(h.doc.querySelector('[data-ip-admin-access]').getAttribute('aria-disabled'),'true');
  h.doc.querySelector('[data-ip-admin-access]').click();await settle();assert.deepEqual(calls,[]);
 }finally{h.close();}
});

test('pending approval prevents duplicate activation and cannot redirect its result to another selection',async()=>{
 let finish;const calls=[],h=adminHarness({rows:[request(),request({requestId:'other'})],activateRequest:requestId=>{calls.push(requestId);return new Promise(resolve=>finish=resolve);}});try{
  h.select(id);h.doc.querySelector('[data-ip-admin-access]').click();assert.equal(h.doc.querySelector('[data-ip-admin-access]').disabled,true);assert.equal(h.doc.querySelector('[data-ip-admin-request]').disabled,true);
  h.doc.querySelector('[data-ip-admin-access]').click();h.select('other');assert.equal(h.doc.querySelector('[data-ip-admin-request]').value,id);assert.deepEqual(calls,[id]);
  h.controller.update([request({requestId:'other'}),request({status:'ACTIVE'})]);finish();await settle();assert.equal(h.doc.querySelector('[data-ip-admin-request]').value,id);assert.equal(h.doc.querySelector('[data-ip-admin-access]').dataset.state,'ACTIVE');
 }finally{h.close();}
});

test('management owns a real tab independently, removes its opener before navigation and detects manual close',()=>{
 const h=adminHarness({rows:[request()]});try{
  h.select(id);const management=h.doc.querySelector('[data-ip-admin-management]');management.click();
  assert.equal(h.calls[0][0],'about:blank');assert.equal(h.calls[0].length,2);assert.match(h.calls[0][1],/^avis-ip-management-/);assert.equal(h.tabs[0].opener,null);
  const opened=new URL(h.tabs[0].events[0]);assert.equal(opened.origin+opened.pathname,checkoutIpHandlerUrl(null));assert.match(new URLSearchParams(opened.hash.slice(1)).get('managementToken'),/^[a-f0-9-]{36}$/i);
  assert.equal(management.dataset.state,'ACTIVE');assert.equal(h.doc.querySelector('[data-ip-admin-access]').dataset.state,'REQUESTED');
  h.tabs[0].closed=true;for(const poll of [...h.timers.values()])poll();assert.equal(management.dataset.state,'CLOSED');assert.equal(h.timers.size,0);
  management.click();assert.notEqual(h.calls[1][1],h.calls[0][1]);assert.equal(management.dataset.state,'ACTIVE');management.click();assert.equal(h.tabs[1].closed,true);assert.equal(management.dataset.state,'CLOSED');
 }finally{h.close();}
});

test('management close waits for its bound channel and never paints a still-open tab red',t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 const h=adminHarness({cooperate:false});try{
  const management=h.doc.querySelector('[data-ip-admin-management]');management.click();management.click();
  assert.equal(h.tabs[0].closed,false);assert.equal(management.dataset.state,'ACTIVE');assert.equal(management.disabled,true);
  const first=h.tabs[0].messages[0];first.ports[0].postMessage({type:'avis-ip-management-ready',token:'wrong-token'});
  assert.equal(h.tabs[0].closed,false);assert.equal(management.dataset.state,'ACTIVE');
  now+=5001;for(const poll of [...h.timers.values()])poll();
  assert.equal(management.disabled,false);assert.equal(management.dataset.state,'ACTIVE');assert.match(h.doc.querySelector('[data-ip-admin-management-error]').textContent,/Could not close/);assert.equal(h.doc.querySelector('[data-ip-admin-access-error]').textContent,'');
  h.tabs[0].closed=true;for(const poll of [...h.timers.values()])poll();assert.equal(management.dataset.state,'CLOSED');assert.equal(h.doc.querySelector('[data-ip-admin-management-error]').textContent,'');assert.equal(h.timers.size,0);
 }finally{h.close();}
});

test('a delayed first ready acknowledgement remains valid and closes only its own tab after cleanup',()=>{
 const h=adminHarness({cooperate:false});try{
  const management=h.doc.querySelector('[data-ip-admin-management]');management.click();
  for(let attempt=0;attempt<3;attempt++)for(const poll of [...h.timers.values()])poll();
  const previous=h.tabs[0],first=previous.messages[0],token=first.data.token;h.controller.close();management.click();
  const current=h.tabs[1];first.ports[0].onmessage=({data})=>{if(data.type==='avis-ip-management-close'&&data.token===token)previous.closed=true;};
  first.ports[0].postMessage({type:'avis-ip-management-ready',token});for(const poll of [...h.timers.values()])poll();
  assert.equal(previous.closed,true);assert.equal(current.closed,false);assert.equal(management.dataset.state,'ACTIVE');assert.equal(first.ports[0].peer.closed,true);
  current.closed=true;for(const poll of [...h.timers.values()])poll();assert.equal(h.timers.size,0);
 }finally{h.close();}
});

test('a refreshed handler rebinds its channel even when the previous disconnect was lost',t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 for(const disconnectDelivered of [true,false]){
  const h=adminHarness({cooperate:false});try{
   const management=h.doc.querySelector('[data-ip-admin-management]');management.click();for(const poll of [...h.timers.values()])poll();
   const tab=h.tabs[0],first=tab.messages[0],token=first.data.token;first.ports[0].postMessage({type:'avis-ip-management-ready',token});
   if(disconnectDelivered)first.ports[0].postMessage({type:'avis-ip-management-disconnect',token});
   else first.ports[0].close();
   management.click();now+=1001;for(const poll of [...h.timers.values()])poll();
   const replacement=tab.messages.at(-1);assert.notEqual(replacement,first);
   replacement.ports[0].onmessage=({data})=>{if(data.type==='avis-ip-management-close'&&data.token===token)tab.closed=true;};
   replacement.ports[0].postMessage({type:'avis-ip-management-ready',token});for(const poll of [...h.timers.values()])poll();
   assert.equal(tab.closed,true);assert.equal(management.dataset.state,'CLOSED');assert.equal(h.timers.size,0);assert.equal(first.ports[0].peer.closed,true);
  }finally{h.close();}
 }
});

test('blocked and unsafe management tabs remain red with errors confined to the clicked control',()=>{
 for(const open of [()=>null,()=>({closed:false,get opener(){return {};},set opener(value){},location:{replace(){throw Error('must not navigate');}},close(){this.closed=true;}})]){
  const h=adminHarness({open});try{
   h.doc.querySelector('[data-ip-admin-management]').click();assert.equal(h.doc.querySelector('[data-ip-admin-management]').dataset.state,'CLOSED');assert.notEqual(h.doc.querySelector('[data-ip-admin-management-error]').textContent,'');assert.equal(h.doc.querySelector('[data-ip-admin-access-error]').textContent,'');assert.equal(h.timers.size,0);
  }finally{h.close();}
 }
});

test('session cleanup resets request selection, closes the owned tab and ignores late action failure',async()=>{
 let reject;const h=adminHarness({rows:[request()],activateRequest:()=>new Promise((resolve,no)=>reject=no)});try{
  h.select(id);h.doc.querySelector('[data-ip-admin-management]').click();h.doc.querySelector('[data-ip-admin-access]').click();h.controller.close();
  assert.equal(h.tabs[0].closed,true);assert.equal(h.timers.size,0);assert.equal(h.doc.querySelector('[data-ip-admin-request]').value,'');assert.equal(h.doc.querySelector('[data-ip-admin-management]').dataset.state,'CLOSED');
  reject(Error('Late previous-session response'));await settle();assert.equal(h.doc.querySelector('[data-ip-admin-access-error]').textContent,'');assert.equal(h.doc.querySelector('[data-ip-admin-access]').dataset.state,'CLOSED');
 }finally{h.close();}
});

test('activation requires a receiving account and sends the chosen owned intermediary, while proof opens its own record',async()=>{
 const record=request({processing}),dom=domFor([record]),calls=[],proofs=[];
 try{
  const doc=dom.window.document;
  bindCheckoutIp({root:doc,requests:[record],nostros,activate:async payload=>{calls.push(payload);return {};},onChange:()=>{},openHandler:()=>{},openProof:row=>proofs.push(row)});
  doc.querySelector('[data-ip-toggle]').click();assert.equal(calls.length,0);assert.equal(doc.activeElement,doc.querySelector('[data-ip-account]'));
  doc.querySelector('[data-ip-account]').value='common';
  const bank=doc.querySelector('[data-ip-nostro]');bank.value='bank-a';bank.dispatchEvent(new dom.window.Event('change'));
  const intermediary=doc.querySelector('[data-ip-intermediary]');intermediary.value='intermediary-a';
  bank.value='bank-b';bank.dispatchEvent(new dom.window.Event('change'));
  assert.equal(intermediary.value,'');assert.equal([...intermediary.options].some(x=>x.value==='intermediary-a'),false);
  intermediary.value='intermediary-b';doc.querySelector('[data-ip-toggle]').click();await settle();
  assert.deepEqual(calls,[{requestId:id,active:true,receivingAccountId:'common',nostroCashAccountId:'bank-b',intermediaryId:'intermediary-b'}]);
  doc.querySelector('[data-ip-proof]').click();assert.deepEqual(proofs,[record]);
 }finally{dom.window.close();}
});

test('handler-only report changes refresh rows while pending route selection, dependent options, focus and scroll survive',()=>{
 const record=request(),dom=domFor([record]);
 try{
  const doc=dom.window.document;
  bindCheckoutIp({root:doc,requests:[record],nostros,activate:()=>{},onChange:()=>{},openHandler:()=>{}});
  doc.querySelector('[data-ip-account]').value='suspense';
  const bank=doc.querySelector('[data-ip-nostro]');bank.value='bank-b';bank.dispatchEvent(new dom.window.Event('change'));
  const intermediary=doc.querySelector('[data-ip-intermediary]');intermediary.value='intermediary-b';intermediary.focus();
  doc.querySelector('.table-wrap').scrollLeft=600;
  const changed={...record,processing:{...processing,revision:5,operationCompleted:false,proof:{available:false}}};
  assert.notEqual(checkoutIpFingerprint([record]),checkoutIpFingerprint([changed]));
  replaceCheckoutIpRegister(doc.querySelector('[data-checkout-ip-register]'),[changed],accounts,nostros);
  assert.equal(doc.querySelector('[data-ip-account]').value,'suspense');assert.equal(doc.querySelector('[data-ip-nostro]').value,'bank-b');
  assert.equal(doc.querySelector('[data-ip-intermediary]').value,'intermediary-b');assert.equal(doc.activeElement,doc.querySelector('[data-ip-intermediary]'));
  assert.equal(doc.querySelector('.table-wrap').scrollLeft,600);
  replaceCheckoutIpRegister(doc.querySelector('[data-checkout-ip-register]'),[{...changed,status:'ACTIVE',receivingAccountId:'common',nostroCashAccountId:'bank-a',intermediaryId:'intermediary-a'}],accounts,nostros);
  assert.equal(doc.querySelector('[data-ip-account]').value,'common');assert.equal(doc.querySelector('[data-ip-nostro]').value,'bank-a');assert.equal(doc.querySelector('[data-ip-account]').disabled,true);
 }finally{dom.window.close();}
});

test('partially supplied intermediary details stay optional and are never selected by default',async()=>{
 const banks=[{...nostros[0],intermediaries:[
  {intermediaryId:'bic-only',bankName:null,reference:null,bic:'BCMAMAMC'},
  {intermediaryId:'retained-empty',bankName:'TBA',reference:'NA',bic:null}
 ]}],record=request({receivingAccountId:'common',nostroCashAccountId:'bank-a'}),calls=[];
 const dom=new JSDOM('<body>'+checkoutIpRegister([record],accounts,banks)+'</body>',{url:'https://bank.example/'});
 try{
  const doc=dom.window.document,select=doc.querySelector('[data-ip-intermediary]');
  assert.equal(select.value,'');
  assert.deepEqual([...select.options].map(option=>option.textContent),['No intermediary','BCMAMAMC','retained-empty']);
  bindCheckoutIp({root:doc,requests:[record],nostros:banks,activate:async payload=>{calls.push(payload);return {};},onChange:()=>{},openHandler:()=>{}});
  doc.querySelector('[data-ip-nostro]').dispatchEvent(new dom.window.Event('change'));
  assert.equal(select.value,'');assert.equal(select.options[1].textContent,'BCMAMAMC');
  doc.querySelector('[data-ip-toggle]').click();await settle();assert.equal(calls[0].intermediaryId,null);
  select.value='bic-only';doc.querySelector('[data-ip-toggle]').click();await settle();assert.equal(calls[1].intermediaryId,'bic-only');
 }finally{dom.window.close();}
});

test('untrusted handler text stays text in the register',()=>{
 const injected='<img src=x onerror=alert(1)>',dom=domFor([request({senderAccount:injected,processing:{...processing,bankName:injected,beneficiaryName:injected,proof:{...processing.proof,fileName:injected}}})]);
 try{assert.equal(dom.window.document.querySelector('img'),null);assert.match(dom.window.document.body.textContent,/<img src=x/);}
 finally{dom.window.close();}
});

test('pending IP switches close at their deadline even if network polling is delayed',()=>{
 const row=request(),dom=domFor([row]);
 try{
  const doc=dom.window.document;expireCheckoutIpControls(doc,Date.parse(row.expiresAt));
  assert.equal(doc.querySelector('[data-ip-toggle]').dataset.state,'CLOSED');
  assert.equal(doc.querySelector('[data-ip-toggle]').getAttribute('aria-disabled'),'true');
  assert.equal(doc.querySelector('[data-ip-account]').disabled,true);
  assert.equal(doc.querySelector('[data-ip-pending]').textContent,'0 awaiting activation');
 }finally{dom.window.close();}
});

function proofHarness(fetcher,onUnauthorized=()=>{}){
 const dom=new JSDOM('<!doctype html><body><button id="source">View proof</button></body>',{url:'https://bank.example/'});
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const created=[],revoked=[],urlApi={createObjectURL:blob=>{created.push(blob);return 'blob:https://bank.example/proof-'+created.length;},revokeObjectURL:url=>revoked.push(url)};
 const viewer=createCheckoutIpProof({root:dom.window.document,fetcher,urlApi,onUnauthorized});
 return {dom,viewer,created,revoked};
}

test('proof popup previews and downloads the original PDF, invokes print, closes with X and revokes its data',async()=>{
 const bytes=Buffer.from('%PDF-1.7\noriginal handler document\n%%EOF'),calls=[];
 const h=proofHarness(async(...args)=>{calls.push(args);return new Response(bytes,{headers:{'content-type':'application/pdf'}});});
 try{
  const doc=h.dom.window.document;doc.querySelector('#source').focus();await h.viewer.open(request({processing}));
  const dialog=doc.querySelector('[data-ip-proof-dialog]'),frame=dialog.querySelector('iframe'),print=dialog.querySelector('[data-ip-print]'),download=dialog.querySelector('[data-ip-download]');
  assert.equal(dialog.open,true);assert.equal(h.created.length,1);assert.deepEqual(Buffer.from(await h.created[0].arrayBuffer()),bytes);
  assert.equal(calls[0][0],'/api/checkout-ip/'+id+'/proof.pdf');assert.equal(calls[0][1].credentials,'same-origin');
  assert.equal(download.href,frame.src);assert.equal(download.download,'original-proof.pdf');assert.equal(print.disabled,true);
  frame.dispatchEvent(new h.dom.window.Event('load'));let printed=0;frame.contentWindow.focus=()=>{};frame.contentWindow.print=()=>printed++;
  print.click();assert.equal(printed,1);
  dialog.querySelector('.close').click();assert.equal(doc.querySelector('[data-ip-proof-dialog]'),null);
  assert.deepEqual(h.revoked,[download.href]);assert.equal(doc.activeElement,doc.querySelector('#source'));
 }finally{h.viewer.close();h.dom.window.close();}
});

test('closing a loading proof prevents late responses from reopening it or retaining a document',async()=>{
 let respond,signal;const h=proofHarness((url,options)=>{signal=options.signal;return new Promise(resolve=>respond=resolve);});
 try{
  const pending=h.viewer.open(request({processing}));h.viewer.close();assert.equal(signal.aborted,true);
  respond(new Response('%PDF-1.7\n%%EOF',{headers:{'content-type':'application/pdf'}}));await pending;
  assert.equal(h.created.length,0);assert.equal(h.dom.window.document.querySelector('dialog'),null);
 }finally{h.viewer.close();h.dom.window.close();}
});

test('proof errors remain in their popup and unauthorized access invokes session cleanup',async()=>{
 let unauthorized=0;const h=proofHarness(async()=>new Response(JSON.stringify({message:'Sign in again.'}),{status:401,headers:{'content-type':'application/json'}}),()=>unauthorized++);
 try{
  await h.viewer.open(request({processing}));assert.equal(unauthorized,1);assert.equal(h.created.length,0);
  assert.match(h.dom.window.document.querySelector('[data-ip-proof-error]').textContent,/Sign in/);
  assert.equal(h.dom.window.document.querySelector('[data-ip-download]').hidden,true);
 }finally{h.viewer.close();h.dom.window.close();}
});

test('sender desk opens independently of approval, binding only an approved checkout, and performs no activation',()=>{
 for(const status of ['REQUESTED','ACTIVE']){
  const h=adminHarness({rows:[request({status})],activateRequest:()=>assert.fail('unexpected approval')});
  try{
   h.select(id);const control=h.doc.querySelector('[data-ip-admin-receiver]');control.click();
   const url=new URL(h.tabs[0].events[0]);
   assert.equal(url.searchParams.get('view'),'sender-access');
   assert.equal(url.searchParams.get('checkoutRequest'),status==='ACTIVE'?id:null);
   assert.equal(control.dataset.state,'ACTIVE');assert.equal(h.doc.querySelector('[data-ip-admin-management]').dataset.state,'CLOSED');
   for(const poll of h.timers.values())poll();
   control.click();assert.equal(h.tabs[0].closed,true);assert.equal(control.dataset.state,'CLOSED');
  }finally{h.close()}
 }
});
