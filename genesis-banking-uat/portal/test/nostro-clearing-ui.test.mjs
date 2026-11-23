import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {nostroRegisterTable,nostroMovementsTable,intermediaryBankTable,intermediaryFields,bindIntermediaryFields,combinedNostroInput,createNostroStatements} from '../public/nostro-clearing.mjs';

const cash='11000000-0000-4000-8000-000000000001',intermediaryId='12000000-0000-4000-8000-000000000001';
const statementId='13000000-0000-4000-8000-000000000001';
const account={cashAccountId:cash,institutionName:'External Fixture Bank',accountNumber:'EXTERNAL-ACCOUNT-01',bic:'TESTGB2LXXX',currency:'EUR'};
const header={statementId,reference:'BANK-STATEMENT-01',currency:'EUR',openingBalance:'125.000000000000000001',closingBalance:'225.250000000000000001',importedAt:'2026-11-23T09:30:00Z',entryCount:2};
const entries=[{bankReference:'BANK-CREDIT-01',direction:'CREDIT',amount:'110.250000000000000001'},{bankReference:'BANK-DEBIT-02',direction:'DEBIT',amount:'10.000000000000000001'}];
const row={cash_account_id:cash,institution_name:account.institutionName,institution_type:'CORRESPONDENT_BANK',iban_or_account_no:account.accountNumber,bic_code:account.bic,currency_code:'EUR',bank_address:'1 Bank Road',account_name:'Settlement holder',aba:'',bank_reference:'BANK-REG-01',available_balance:'999999999',locked_balance:'888888888',bank_connectors:'PRIVATE_CONNECTOR_VALUE',card_gateways:'PRIVATE_GATEWAY_VALUE',intermediaries:[]};
const record={intermediaryId,bankName:'Transit Fixture Bank',bankAddress:'2 Transit Road',accountName:'Transit holder',aba:'',reference:'TRANSIT-01',bic:'TESTGB2LXXX',accountNumber:'TRANSIT-ACCOUNT'};
const flush=async()=>{for(let n=0;n<4;n++)await new Promise(resolve=>setImmediate(resolve));};
const doc=html=>new JSDOM('<!doctype html><body>'+html+'</body>',{url:'https://bank.invalid/'});

test('NOSTRO register exposes actual bank details, four columns and every existing management action',()=>{
 const dom=doc(nostroRegisterTable([row]));try{
  const d=dom.window.document;
  assert.deepEqual([...d.querySelectorAll('th')].map(x=>x.textContent),['Bank / account details','External settlement account','Currency','Manage']);
  assert.equal(d.querySelectorAll('tbody tr td').length,4);assert.match(d.body.textContent,/EXTERNAL-ACCOUNT-01/);assert.match(d.body.textContent,/TESTGB2LXXX/);
  for(const action of ['edit','mirror','gateway','bank','statements'])assert.equal(d.querySelector('[data-nostro-'+action+']').dataset['nostro'+action[0].toUpperCase()+action.slice(1)],cash);
  assert.doesNotMatch(d.body.textContent,/999999999|888888888|PRIVATE_CONNECTOR_VALUE|PRIVATE_GATEWAY_VALUE/);
  assert.equal(d.querySelector('.nostro-intermediary-details'),null);
  assert.match(nostroMovementsTable([{created_at:'2026-11-23',institution_name:'Internal bank',direction:'DEBIT',amount:'1',running_balance:'3',external_reference:'LEDGER-REF',source:'MANUAL',event_type:'MIRROR'}]),/Internal clearing ledger/);
  assert.match(nostroMovementsTable([{external_reference:'LEDGER-REF'}]),/LEDGER-REF/);
 }finally{dom.window.close();}
});

test('intermediary presentation hides placeholders while retaining real partial records and escaping bank text',()=>{
 const rows=[{...record,bankName:'TBA',bankAddress:'N/A',accountName:'NA',reference:'—',bic:'',accountNumber:''},{...record,intermediaryId:'partial',bankName:'',bankAddress:'',accountName:'',reference:'',bic:'TESTGB2LXXX',accountNumber:'<img src=x>'}];
 const before=structuredClone(rows),dom=doc(nostroRegisterTable([{...row,intermediaries:rows}]));try{
  const d=dom.window.document;assert.equal(d.querySelectorAll('[data-nostro-intermediary]').length,1);
  assert.match(d.body.textContent,/TESTGB2LXXX/);assert.match(d.body.textContent,/<img src=x>/);assert.equal(d.querySelector('img'),null);
  assert.doesNotMatch(d.querySelector('.nostro-intermediary-details').textContent,/TBA|N\/A|Account: NA|—/);assert.deepEqual(rows,before);
  const empty=doc(intermediaryBankTable([{bank_name:'TBA',bank_address:'N/A',account_name:'NA',reference:'—'}]));
  try{assert.equal(empty.window.document.querySelectorAll('tbody tr').length,0);}finally{empty.window.close();}
 }finally{dom.window.close();}
});

function formFixture(editing=false,rows=[]){
 const dom=doc('<form><input name="cashAccountId" value="'+cash+'"><input name="bankName" value="External Fixture Bank">'+intermediaryFields(editing)+'</form>'),form=dom.window.document.querySelector('form');
 if(editing)bindIntermediaryFields(form,rows);
 return {dom,form,build:()=>combinedNostroInput(new dom.window.FormData(form),form),select:id=>{form.elements.intermediarySelector.value=id;form.elements.intermediarySelector.dispatchEvent(new dom.window.Event('change'));}};
}

test('new intermediary fields are blank and optional; NOSTRO-only saves omit the intermediary object',()=>{
 const h=formFixture();try{
  for(const input of h.form.querySelectorAll('.incoming-intermediary-fields input')){assert.equal(input.value,'');assert.equal(input.required,false);}
  assert.equal(h.form.checkValidity(),true);assert.equal(Object.hasOwn(h.build(),'intermediary'),false);
  h.form.elements.intermediaryBankAddress.value='3 Optional Road';
  assert.deepEqual(h.build().intermediary,{bankName:'',bankAddress:'3 Optional Road',accountName:'',aba:'',reference:'',bic:'',accountNumber:''});
  h.form.elements.intermediaryAba.value='123';assert.equal(h.form.checkValidity(),false,'entered ABA retains its validation');
 }finally{h.dom.window.close();}
});

test('editing starts with no selected intermediary and preserves explicitly selected records unless changed',()=>{
 const original={...record,bic:'N/A'},snapshot=structuredClone(original),h=formFixture(true,[original,{intermediaryId:'blank',bankName:null,reference:null}]);try{
  assert.equal(h.form.elements.intermediarySelector.value,'');
  for(const input of h.form.querySelectorAll('.incoming-intermediary-fields input')){assert.equal(input.value,'');assert.equal(input.disabled,true);assert.equal(input.required,false);}
  assert.equal(h.build().intermediary,undefined);assert.equal(h.form.elements.intermediarySelector.options[3].textContent,'blank');
  h.select(intermediaryId);assert.equal(h.form.elements.intermediaryBankName.value,original.bankName);assert.equal(h.form.elements.intermediaryBic.value,'');assert.equal(h.build().intermediary,undefined);
  h.form.elements.bankName.value='Amended NOSTRO name';assert.equal(h.build().intermediary,undefined);
  h.form.elements.intermediaryBankAddress.value='Changed by operator';
  assert.deepEqual(h.build().intermediary,{...original,bankAddress:'Changed by operator'});assert.deepEqual(original,snapshot);
  h.select('');assert.equal(h.build().intermediary,undefined);
 }finally{h.dom.window.close();}
});

test('explicit clearing retains the intermediary ID and adding a new one starts without copied fields',()=>{
 const h=formFixture(true,[record]);try{
  h.select(intermediaryId);for(const input of h.form.querySelectorAll('.incoming-intermediary-fields input'))input.value='';
  assert.equal(h.build().intermediary.intermediaryId,intermediaryId);
  assert.equal(Object.values(h.build().intermediary).filter(Boolean).length,1);
  h.select('NEW');assert.equal(h.build().intermediary,undefined);
  for(const input of h.form.querySelectorAll('.incoming-intermediary-fields input')){assert.equal(input.value,'');assert.equal(input.disabled,false);}
  h.form.elements.intermediaryAccountNumber.value='NEW-ACCOUNT';assert.equal(h.build().intermediary.intermediaryId,undefined);assert.equal(h.build().intermediary.accountNumber,'NEW-ACCOUNT');
 }finally{h.dom.window.close();}
});

function statementFixture(api){
 const dom=doc('<button id="origin">Open</button><p id="unrelated"></p>');
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const calls=[],manager=createNostroStatements({root:dom.window.document,api:async path=>{calls.push(path);return api(path);}});
 return {dom,calls,manager,dialog:()=>dom.window.document.querySelector('[data-nostro-statement-dialog]'),close(){manager.close();dom.window.close();}};
}

test('external statements render only bank headers and entries with exact money and external credit/debit direction',async()=>{
 const h=statementFixture(path=>path.endsWith('/'+statementId)?{account,statement:header,entries}:{account,statements:[header],nextCursor:null});try{
  await h.manager.open(cash);const d=h.dom.window.document;assert.equal(h.dialog().open,true);
  assert.match(h.dialog().textContent,/125\.000000000000000001/);assert.match(h.dialog().textContent,/Imported/);
  d.querySelector('[data-nostro-statement]').click();await flush();
  assert.equal(d.querySelectorAll('dialog').length,1);assert.match(h.dialog().textContent,/BANK-CREDIT-01/);assert.match(h.dialog().textContent,/Incoming \(credit\)/);assert.match(h.dialog().textContent,/Outgoing \(debit\)/);assert.match(h.dialog().textContent,/110\.250000000000000001/);
  assert.doesNotMatch(h.dialog().textContent,/Running balance|Balance after|Booked balance|LEDGER-REF/);
  assert.deepEqual(h.calls,['nostro/'+cash+'/statements','nostro/'+cash+'/statements/'+statementId]);
  d.querySelector('[data-nostro-back]').click();await flush();assert.ok(d.querySelector('[data-nostro-statement]'));
 }finally{h.close();}
});

test('statement paging is bound to the selected external account and failures stay in its popup',async()=>{
 let fail=true;const cursor='opaque+account/cursor';
 const h=statementFixture(path=>{if(path.includes('?before=')){if(fail)throw Error('Could not read the selected statement page.');return {account,statements:[{...header,statementId:'older',reference:'OLDER-STATEMENT'}],nextCursor:null};}return {account,statements:[header],nextCursor:cursor};});try{
  await h.manager.open(cash);h.dialog().querySelector('[data-nostro-older]').click();await flush();
  assert.equal(h.dialog().querySelector('[data-nostro-older]').disabled,false);assert.match(h.dialog().querySelector('[role=alert]').textContent,/selected statement page/);assert.equal(h.dom.window.document.querySelector('#unrelated').textContent,'');
  fail=false;h.dialog().querySelector('[data-nostro-older]').click();await flush();
  assert.equal(h.calls[2],'nostro/'+cash+'/statements?before='+encodeURIComponent(cursor));assert.equal(h.dialog().querySelectorAll('[data-nostro-statement-row]').length,2);assert.equal(h.dialog().querySelector('[data-nostro-older]').hidden,true);assert.equal(h.dialog().querySelector('[role=alert]').textContent,'');
 }finally{h.close();}
});

test('closing or switching external accounts discards late statement responses and restores the launching control',async()=>{
 let respond;const h=statementFixture(path=>path.includes('/other/')?{account:{...account,cashAccountId:'other'},statements:[],nextCursor:null}:new Promise(resolve=>respond=resolve));try{
  const origin=h.dom.window.document.querySelector('#origin');origin.focus();const pending=h.manager.open(cash,origin);
  h.dialog().querySelector('.close').click();assert.equal(h.dialog(),null);assert.equal(h.dom.window.document.activeElement,origin);
  respond({account,statements:[header],nextCursor:null});await pending;assert.equal(h.dialog(),null);
  const previous=h.manager.open(cash,origin);await h.manager.open('other',origin);respond({account,statements:[header],nextCursor:null});await previous;
  assert.equal(h.dialog().querySelectorAll('[data-nostro-statement-row]').length,0);assert.doesNotMatch(h.dialog().textContent,/BANK-STATEMENT-01/);
  assert.match(h.dialog().textContent,/No external statements have been imported for this account/);
 }finally{h.close();}
});
