import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {accountSummaryTable,backofficeAccountTable,createAccountStatements} from '../public/accounts.mjs';
import {createPortfolio} from '../public/portfolio.mjs';

const originalDocument=globalThis.document,originalFormData=globalThis.FormData,windows=[];
afterEach(()=>{
 for(const dom of windows.splice(0))dom.window.close();
 if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;
 globalThis.FormData=originalFormData;
});
function setup(){
 const dom=new JSDOM('<!doctype html><main></main>',{url:'https://bank.invalid'});windows.push(dom);
 globalThis.document=dom.window.document;globalThis.FormData=dom.window.FormData;
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 return dom.window.document;
}
const funding={account_id:'funding-account',user_id:'1',full_name:'AVISPay PLC',display_name:'AVISPay PLC',account_type:'BUSINESS',wallet_scope:'FUNDING',status:'ACTIVE',currency_code:'EUR',network:null,abiq_iban:'TN89AVIP000978000011000101',account_reference:'FUNDING-INTERNAL',available_balance:'1000',locked_balance:'0',credit:'1000',debit:'0'};
const common={...funding,account_id:'common-account',account_type:'COMMON',wallet_scope:null,abiq_iban:'TN28AVIP97800000000900001',account_reference:'COMMON-INTERNAL',display_name:'Common settlement'};
const suspense={...common,account_id:'suspense-account',account_type:'SUSPENSE',abiq_iban:'TN98AVIP97800000000900002',account_reference:'SUSPENSE-INTERNAL',display_name:'Suspense review'};
const custody={...funding,account_id:'custody-account',wallet_scope:'CUSTODY',abiq_iban:'TN71AVIP97800000000900003',account_reference:'CUSTODY-INTERNAL'};
const margin={...funding,account_id:'margin-account',wallet_scope:'MARGIN',abiq_iban:'TN44AVIP97800000000900004',account_reference:'MARGIN-INTERNAL'};
const bankAccounts=[funding,common,suspense,custody,margin];
const compact=value=>value.replace(/\s/g,'');
const detail=(dialog,label)=>[...dialog.querySelectorAll('dt')].find(el=>el.textContent===label)?.nextElementSibling.textContent;

test('account rows display ABIQ IBANs without exposing internal references',()=>{
 const doc=setup(),main=doc.querySelector('main');main.innerHTML=accountSummaryTable([funding,custody,margin])+backofficeAccountTable([common,suspense]);
 assert.ok([...main.querySelectorAll('th')].some(th=>th.textContent==='ABIQ IBAN'));
 for(const account of bankAccounts){
  const row=main.querySelector('[data-account-row="'+account.account_id+'"]');
  assert.equal(compact(row.querySelector('.account-number').textContent),account.abiq_iban);
  assert.equal(row.querySelector('[data-movements-toggle]').getAttribute('aria-label'),'Show movements for '+account.abiq_iban);
  assert.equal(row.dataset.accountRow,account.account_id);
 }
 assert.equal(main.querySelector('[data-account-row="custody-account"]').cells[1].textContent,'Business · Custody');
 assert.equal(main.querySelector('[data-account-row="margin-account"]').cells[1].textContent,'Business · Margin');
 assert.doesNotMatch(main.textContent,/-INTERNAL/);
});

test('ABIQ reference compatibility never displays an internal account code as an IBAN',()=>{
 const doc=setup(),main=doc.querySelector('main');
 for(const account_reference of [funding.abiq_iban,common.abiq_iban]){
  main.innerHTML=accountSummaryTable([{...funding,abiq_iban:null,account_reference}]);
  assert.equal(compact(main.querySelector('.account-number').textContent),account_reference);
 }
 for(const account_reference of ['COMMON-INTERNAL','SUSPENSE-INTERNAL','TN28AVIP-INTERNAL','AQ12AVIP-INTERNAL']){
  main.innerHTML=accountSummaryTable([{...funding,abiq_iban:null,account_reference}]);
  assert.equal(main.querySelector('.account-number').textContent,'');assert.equal(main.textContent.includes(account_reference),false);
 }
});

test('statements and movement details preserve account identity and show ABIQ IBANs',async()=>{
 const doc=setup(),requests=[];
 const manager=createAccountStatements({api:async path=>{
  requests.push(path);const id=path.split('/')[1].split('?')[0],account=bankAccounts.find(a=>a.account_id===id),older=path.includes('?before=');
  const entry={entry_id:older?'1':'2',journal_id:'preserved-journal',event_type:'OPENING',reference_id:'Statement entry',created_at:'2026-11-17T12:00:00Z',direction:'CREDIT',amount:'100',running_balance:'100'};
  return path.includes('/movements/')?{account,entry}:{account,totals:{incoming:'100',outgoing:'0'},entries:[entry],nextCursor:older?null:'2'};
 }});
 for(const account of bankAccounts){
  const backoffice=['COMMON','SUSPENSE'].includes(account.account_type);await manager.open(account.account_id,backoffice);
  const dialog=doc.querySelector('.account-statement-dialog');assert.equal(dialog.open,true);
  assert.equal(compact(detail(dialog,'ABIQ IBAN')),account.abiq_iban);assert.doesNotMatch(dialog.textContent,/-INTERNAL/);
  assert.equal(requests.at(-1),backoffice?'backoffice-accounts/'+account.account_id+'/statement':'accounts/'+account.account_id);
  if(account.wallet_scope)assert.equal(detail(dialog,'Account purpose'),{FUNDING:'Funding',CUSTODY:'Custody',MARGIN:'Margin'}[account.wallet_scope]);
  await dialog.querySelector('[data-older]').onclick();assert.equal(dialog.querySelectorAll('.account-movements tbody tr').length,2);assert.equal(dialog.querySelector('[data-older]').hidden,true);assert.equal(requests.at(-1),'accounts/'+account.account_id+'?before=2');
  dialog.querySelector('[data-movement="2"]').onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(dialog.querySelector('h2').textContent,'Movement details');assert.equal(compact(detail(dialog,'ABIQ IBAN')),account.abiq_iban);assert.equal(detail(dialog,'Journal reference'),'preserved-journal');assert.equal(requests.at(-1),'accounts/'+account.account_id+'/movements/2');
  await dialog.querySelector('[data-back-account]').onclick();assert.equal(compact(detail(dialog,'ABIQ IBAN')),account.abiq_iban);
  manager.close();assert.equal(dialog.open,false);assert.equal(dialog.childElementCount,0);
 }
});

const security={security_id:'eur-security',name:'EUR security',short_name:'EUR SECURITY',currency_code:'EUR',denomination:'1000',quote_basis:'PERCENT',reference_price:'98'};
for(const action of ['buysecurity','sellsecurity'])test(action+' offers only active funding accounts with the security currency and no network',async()=>{
 const doc=setup(),requests=[],accounts=[funding,custody,margin,{...funding,account_id:'suspended',status:'SUSPENDED'},{...funding,account_id:'network',network:'ETHEREUM'},{...funding,account_id:'wrong-currency',currency_code:'USD'},{...funding,account_id:'unclassified',wallet_scope:null}];
 const manager=createPortfolio({api:async(...args)=>{requests.push(args);return {};},getRows:async()=>{},data:view=>({securities:[security],accountsummaries:accounts})[view]||[],refresh:async()=>{},notice:()=>{},isAdmin:()=>true});
 await manager.open(action);const form=doc.querySelector('#portfolio-dialog form');form.elements.securityId.value=security.security_id;form.elements.securityId.onchange();
 assert.deepEqual([...form.elements.source.options].map(option=>option.value).filter(Boolean),[funding.account_id]);
 assert.equal(form.elements.source.value,funding.account_id);assert.match(form.elements.source.selectedOptions[0].textContent,new RegExp(funding.abiq_iban));
 assert.equal(doc.querySelector('[data-balance]').textContent,'Available balance: 1,000.00 EUR');assert.equal(requests.length,0);
 manager.close();assert.equal(doc.querySelector('#portfolio-dialog').childElementCount,0);
});
