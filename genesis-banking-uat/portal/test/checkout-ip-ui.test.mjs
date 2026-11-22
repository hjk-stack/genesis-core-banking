import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {checkoutIpRegister,bindCheckoutIp,replaceCheckoutIpRegister,checkoutIpFingerprint,checkoutIpHandlerUrl,createCheckoutIpProof,expireCheckoutIpControls} from '../public/checkout-ip.mjs';

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

test('handler action remains mounted on an empty register and request links use a normal web destination',()=>{
 const dom=domFor([]),opened=[];
 try{
  bindCheckoutIp({root:dom.window.document,openHandler:record=>opened.push(record)});
  dom.window.document.querySelector('[data-ip-handler-open]').click();
  assert.deepEqual(opened,[null]);assert.equal(dom.window.document.querySelectorAll('[data-ip-toggle]').length,0);
  assert.equal(checkoutIpHandlerUrl(null),'https://avis.land/admin/bank/quantum/direct-transfer');
  assert.equal(new URL(checkoutIpHandlerUrl(request())).searchParams.get('checkoutRequest'),id);
 }finally{dom.window.close();}
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

