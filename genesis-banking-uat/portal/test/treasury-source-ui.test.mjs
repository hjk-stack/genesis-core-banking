import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {openTreasurySource} from '../public/treasury-source.mjs';

const BOOKING='10000000-0000-4000-8000-000000000001';
const SECURITY='20000000-0000-4000-8000-000000000001';
const POSITION='30000000-0000-4000-8000-000000000001';
const source={booking_id:BOOKING,asset_class:'SECURITY',asset_code:'AVISPAY-PLC-SHARES',asset_name:'AVISPay PLC source holding',quantity:'30000000000.000000000000000000',owner_user_id:'1',source_reference:'Original Treasury booking',isin:null};
const security={security_id:SECURITY,name:source.asset_name,short_name:'AVISP',isin:'CH0000000001',currency_code:'CHF',denomination:'1.000000000000000000',quote_basis:'UNIT',kind:'share'};
const receipt={bookingId:BOOKING,securityId:SECURITY,positionId:POSITION,created:true};
const deferred=()=>{let resolve,reject;return {promise:new Promise((yes,no)=>{resolve=yes;reject=no;}),resolve,reject};};
const windows=[],controllers=[];
const previousFormData=Object.getOwnPropertyDescriptor(globalThis,'FormData');
afterEach(()=>{
 for(const controller of controllers.splice(0))controller?.close();
 for(const dom of windows.splice(0))dom.window.close();
 if(previousFormData)Object.defineProperty(globalThis,'FormData',previousFormData);else delete globalThis.FormData;
});
function fixture(options={}){
 const dom=new JSDOM('<!doctype html><body></body>',{url:'https://bank.invalid'});windows.push(dom);
 globalThis.FormData=dom.window.FormData;
 dom.window.HTMLDialogElement.prototype.close=function(){this.dispatchEvent(new dom.window.Event('close'));};
 const state={securities:options.securities||[],positions:options.positions||[],source:{...source,...options.source},current:true};
 const calls=[],registered=[];let dialog=null;
 const modal=(title,body)=>{
  dialog?.remove();dialog=dom.window.document.createElement('dialog');dialog.innerHTML='<h2></h2><button type="button" data-close>×</button>'+body;dialog.querySelector('h2').textContent=title;
  dom.window.document.body.append(dialog);const own=dialog;
  own.querySelector('[data-close]').onclick=()=>own.close();own.addEventListener('close',()=>own.remove());
  return own;
 };
 const api=async(path,input,key)=>{
  calls.push({path,input:input?structuredClone(input):input,key});
  if(options.api){const custom=await options.api(path,input,key,state);if(custom!==undefined)return custom;}
  if(path==='views/treasurypositions')return {rows:[state.source]};
  if(path==='views/securities')return {rows:state.securities};
  if(path==='views/securitypositions')return {rows:state.positions};
  if(path==='portfolio/securities'){
   state.securities=[{security_id:SECURITY,name:input.name,short_name:input.shortName,currency_code:input.currency,isin:input.isin,cusip:input.cusip,kind:input.kind,denomination:input.denomination,quote_basis:input.quoteBasis,quantity_decimals:input.quantityDecimals}];
   return {id:SECURITY};
  }
  if(path==='portfolio/treasury-source')return {...receipt};
  throw Error('Unexpected API '+path);
 };
 const getDialog=()=>dom.window.document.querySelector('dialog');
 return {state,calls,registered,dom,dialog:getDialog,form:()=>getDialog()?.querySelector('form'),writes:()=>calls.filter(c=>c.input),
  open:async()=>{const controller=await openTreasurySource({api,modal,bookingId:options.bookingId||BOOKING,isCurrent:()=>state.current,onRegistered:async result=>registered.push(result)});controllers.push(controller);return controller;}};
}
const submit=form=>form.onsubmit({preventDefault(){}});
const set=(form,name,value)=>{form.elements[name].value=value;};
const choose=(form,id=SECURITY)=>{set(form,'securityId',id);form.elements.securityId.onchange();};
function metadata(form){
 for(const [name,value] of Object.entries({shortName:'AVISP',currency:'CHF',isin:'CH0000000001',cusip:'',denomination:'1',quoteBasis:'UNIT',quantityDecimals:'0'}))set(form,name,value);
}

test('empty catalogue collects explicit security metadata and prices before linking the exact Treasury booking',async()=>{
 const ui=fixture();await ui.open();let form=ui.form();
 assert.equal(ui.writes().length,0);assert.equal(form.elements.securityId.options.length,1);
 assert.equal(form.elements.issuingPrice.value,'');assert.equal(form.elements.marketPrice.value,'');
 assert.match(form.querySelector('[data-treasury-source]').textContent,/30000000000/);
 await submit(form);assert.equal(ui.writes().length,0,'missing security and prices cannot submit');
 form.querySelector('[data-source-add-security]').click();form=ui.form();
 assert.equal(form.elements.name.value,source.asset_name);assert.equal(form.elements.name.readOnly,true);
 for(const name of ['currency','isin','cusip','denomination','quoteBasis','quantityDecimals'])assert.equal(form.elements[name].value,'',name+' must not be invented');
 assert.equal(form.elements.kind.value,'share');assert.equal(form.elements.kind.disabled,true);
 await submit(form);assert.equal(ui.writes().length,0,'metadata requires explicit values');
 metadata(form);await submit(form);
 const saved=ui.writes()[0];assert.equal(saved.path,'portfolio/securities');
 assert.deepEqual(saved.input,{name:source.asset_name,shortName:'AVISP',currency:'CHF',isin:'CH0000000001',cusip:'',denomination:'1',quoteBasis:'UNIT',quantityDecimals:0,kind:'share'});
 assert.match(saved.key,/^[a-f0-9-]{36}$/);
 form=ui.form();assert.equal(form.elements.securityId.value,SECURITY);
 assert.equal(form.elements.issuingPrice.value,'');assert.equal(form.elements.marketPrice.value,'');
 assert.match(form.querySelector('[data-source-metadata]').textContent,/CurrencyCHF/);
 await submit(form);assert.equal(ui.writes().length,1,'security save does not invent prices or register the holding');
 set(form,'issuingPrice','0.123456789012345678');set(form,'marketPrice','1.000000000000000001');await submit(form);
 const linked=ui.writes()[1];assert.equal(linked.path,'portfolio/treasury-source');
 assert.deepEqual(linked.input,{bookingId:BOOKING,securityId:SECURITY,issuingPrice:'0.123456789012345678',marketPrice:'1.000000000000000001'});
 assert.deepEqual(ui.registered,[receipt]);assert.equal(ui.dialog(),null);
});

test('an existing owner position retains its recorded prices and is reused without recording a second holding',async()=>{
 const ui=fixture({source:{security_id:SECURITY},securities:[security],positions:[{position_id:POSITION,user_id:1,security_id:SECURITY,issuing_price:'0.000000000000000000',market_price:'12.123456789012345678'}]});
 await ui.open();const form=ui.form();
 assert.equal(form.elements.securityId.value,SECURITY);assert.equal(form.elements.issuingPrice.readOnly,true);assert.equal(form.elements.marketPrice.readOnly,true);
 assert.equal(form.elements.issuingPrice.value,'0');assert.equal(form.elements.marketPrice.value,'12.123456789012345678');
 assert.equal(ui.writes().length,0);await submit(form);
 assert.deepEqual(ui.writes().map(c=>c.path),['portfolio/treasury-source']);
 assert.equal(ui.writes()[0].input.issuingPrice,'0');assert.equal(ui.writes()[0].input.marketPrice,'12.123456789012345678');
});

test('another holder position supplies no default prices and recorded source identity restricts security choices',async()=>{
 const matching={...security,security_id:'matching'},wrongIsin={...security,security_id:'wrong-isin',isin:'US0378331005'},wrongKind={...security,security_id:'wrong-kind',kind:'bond'};
 const ui=fixture({source:{isin:security.isin},securities:[matching,wrongIsin,wrongKind],positions:[{user_id:'2',security_id:'matching',issuing_price:'50',market_price:'75'}]});await ui.open();const form=ui.form();
 assert.deepEqual([...form.elements.securityId.options].map(o=>o.value),['','matching']);choose(form,'matching');
 assert.equal(form.elements.issuingPrice.readOnly,false);assert.equal(form.elements.issuingPrice.value,'');assert.equal(form.elements.marketPrice.value,'');
 form.querySelector('[data-source-add-security]').click();assert.equal(ui.form().elements.isin.value,security.isin);assert.equal(ui.form().elements.isin.readOnly,true);
 ui.dialog().querySelector('[data-close]').click();assert.equal(ui.writes().length,0);
});

test('Back retains the registration draft and Cancel or Close never writes metadata',async()=>{
 const ui=fixture({securities:[security]});await ui.open();let form=ui.form();choose(form);
 set(form,'issuingPrice','10.25');set(form,'marketPrice','12.50');form.querySelector('[data-source-add-security]').click();
 form=ui.form();metadata(form);form.querySelector('[data-source-back]').click();form=ui.form();
 assert.equal(form.elements.securityId.value,SECURITY);assert.equal(form.elements.issuingPrice.value,'10.25');assert.equal(form.elements.marketPrice.value,'12.50');
 form.querySelector('[data-source-cancel]').click();assert.equal(ui.dialog(),null);assert.equal(ui.writes().length,0);
 await ui.open();ui.dialog().querySelector('[data-close]').click();assert.equal(ui.writes().length,0);
});

test('source-registration retry retains its identity and edits receive a new key',async()=>{
 let attempts=0;const ui=fixture({securities:[security],api:async(path,input)=>{
  if(path==='portfolio/treasury-source'&&++attempts<3)throw Object.assign(Error('Review the market price.'),{field:'marketPrice'});
 }});await ui.open();const form=ui.form();choose(form);set(form,'issuingPrice','1');set(form,'marketPrice','2');
 await submit(form);assert.equal(form.querySelector('fieldset').disabled,false);assert.equal(form.elements.marketPrice.getAttribute('aria-invalid'),'true');assert.equal(form.elements.marketPrice.value,'2');
 assert.equal(form.querySelector('.form-error').textContent,'Review the market price.');await submit(form);
 assert.equal(ui.writes()[0].key,ui.writes()[1].key);
 set(form,'marketPrice','3');await submit(form);assert.notEqual(ui.writes()[2].key,ui.writes()[1].key);assert.equal(ui.registered.length,1);
});

test('security metadata retry after a failed reload reuses the save key',async()=>{
 let saves=0,reads=0;const ui=fixture({api:async(path,input,key,state)=>{
  if(path==='portfolio/securities'){saves++;state.securities=[security];return {id:SECURITY};}
  if(path==='views/securities'&&++reads===2)throw Error('Temporary catalogue read failure.');
 }});await ui.open();ui.form().querySelector('[data-source-add-security]').click();const form=ui.form();metadata(form);
 await submit(form);assert.match(form.querySelector('.form-error').textContent,/Temporary catalogue/);assert.equal(form.querySelector('fieldset').disabled,false);
 await submit(form);assert.equal(saves,2);assert.equal(ui.writes()[0].key,ui.writes()[1].key);assert.equal(ui.form().elements.securityId.value,SECURITY);assert.equal(ui.registered.length,0);
});

test('a changed workspace discards delayed initial reads without opening a window',async()=>{
 const pending=deferred(),ui=fixture({api:async path=>path==='views/treasurypositions'?pending.promise:undefined});
 const opening=ui.open();ui.state.current=false;pending.resolve({rows:[source]});assert.equal(await opening,null);
 assert.equal(ui.dialog(),null);assert.equal(ui.writes().length,0);
});

test('closing a pending registration prevents duplicate submission and late continuation',async()=>{
 const pending=deferred(),ui=fixture({securities:[security],api:async path=>path==='portfolio/treasury-source'?pending.promise:undefined});
 const controller=await ui.open(),form=ui.form();choose(form);set(form,'issuingPrice','1');set(form,'marketPrice','2');
 const saving=submit(form);await submit(form);assert.equal(ui.writes().length,1);assert.equal(form.querySelector('fieldset').disabled,true);
 controller.close();pending.resolve(receipt);await saving;
 assert.equal(ui.registered.length,0);assert.equal(ui.dialog(),null);
});

test('a disconnected metadata dialog discards the save response without reopening registration',async()=>{
 const pending=deferred(),ui=fixture({api:async path=>path==='portfolio/securities'?pending.promise:undefined});
 await ui.open();ui.form().querySelector('[data-source-add-security]').click();const form=ui.form();metadata(form);
 const saving=submit(form);ui.dialog().remove();pending.resolve({id:SECURITY});await saving;
 assert.equal(ui.dialog(),null);assert.equal(ui.registered.length,0);assert.equal(ui.calls.filter(c=>c.path==='views/securities').length,1);
});

test('mismatched registration receipts stay in the form and do not continue to tokenisation',async()=>{
 const ui=fixture({securities:[security],api:async path=>path==='portfolio/treasury-source'?{...receipt,bookingId:'another-booking'}:undefined});await ui.open();const form=ui.form();choose(form);set(form,'issuingPrice','1');set(form,'marketPrice','2');await submit(form);
 assert.match(form.querySelector('.form-error').textContent,/receipt did not match/);assert.equal(ui.registered.length,0);assert.equal(form.querySelector('fieldset').disabled,false);
});
