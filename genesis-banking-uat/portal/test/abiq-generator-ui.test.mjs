import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {buildAbiqNumber} from '../public/abiq-number.mjs';
import {createAbiqGenerator} from '../public/abiq-generator.mjs';

test('floating generator keeps the holder editable and fills the read-only series from currency',async t=>{
 const dom=new JSDOM('<body></body>');t.after(()=>dom.window.close());
 for(const name of ['document','Option','FormData']){
  const original=Object.getOwnPropertyDescriptor(globalThis,name);
  Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true,writable:true});
  t.after(()=>{if(original)Object.defineProperty(globalThis,name,original);else delete globalThis[name];});
 }
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 const calls=[],currencies=[{currency:'EUR',series:'00001',currencyBlock:'000978'},{currency:'CHF',series:'00004',currencyBlock:'000756'},{currency:'579',label:'Custodial account',series:'00015',currencyBlock:'000579'}];
 const api=async(path,input,key)=>{
  calls.push({path,input,key});
  if(input)return {identifier:buildAbiqNumber({...input,currencyBlock:currencies.find(c=>c.currency===input.currency).currencyBlock})};
  return {countries:['DE','TN'],currencies,customerNumbers:path.endsWith('holder=')?[]:['1000101','1000103'],reusable:[],recent:[]};
 };
 const generator=createAbiqGenerator({api});generator.open();await new Promise(setImmediate);
 const {document,Event}=dom.window,form=document.querySelector('dialog form'),f=form.elements;
 assert.equal(document.querySelector('dialog').parentElement,document.body);
 assert.deepEqual([...form.querySelectorAll('input')].map(x=>x.name),['holderCode']);
 assert.equal(form.querySelectorAll('select').length,4);
 const submit=form.querySelector('[type=submit]');
 assert.equal(f.country.value,'');assert.equal(f.currency.value,'');assert.equal(f.holderCode.value,'');
 assert.equal(f.holderCode.type,'text');assert.equal(f.series.value,'');assert.equal(f.preview.textContent,'');assert.equal(submit.disabled,true);
 const choose=(control,value)=>{control.value=value;control.dispatchEvent(new Event('input',{bubbles:true}));};
 choose(f.currency,'EUR');assert.equal(f.series.value,'00001');assert.equal(f.country.value,'');
 choose(f.country,'DE');assert.equal(f.currency.value,'EUR');assert.equal(submit.disabled,true);
 choose(f.holderCode,'abcd');await new Promise(setImmediate);assert.equal(f.holderCode.value,'ABCD');
 assert.match(f.preview.textContent,/^DE[0-9]{2}ABCD000978/);assert.equal(submit.disabled,false);
 assert.equal(f.series.tagName,'OUTPUT');
 choose(f.currency,'579');assert.equal(f.series.value,'00015');assert.match(f.preview.textContent,/ABCD000579 00015/);
 choose(f.currency,'CHF');assert.equal(f.series.value,'00004');assert.equal(f.country.value,'DE');
 choose(f.country,'TN');assert.equal(f.currency.value,'CHF');
 choose(f.currency,'');assert.equal(f.series.value,'');assert.equal(f.preview.textContent,'');assert.equal(submit.disabled,true);
 choose(f.currency,'EUR');choose(f.customerNumber,'1000103');
 const checkDigits=f.checkDigits.value;
 form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await new Promise(setImmediate);
 const write=calls.find(x=>x.input);
 assert.deepEqual(write.input,{country:'TN',checkDigits,holderCode:'ABCD',currency:'EUR',series:'00001',customerNumber:'1000103'});
 assert.match(document.querySelector('[role=status]').textContent,/Issued TN[0-9]{2}ABCD000978/);
 assert.equal(f.country.value,'TN');assert.equal(f.currency.value,'EUR');
 generator.close();generator.open();await new Promise(setImmediate);
 const next=document.querySelector('dialog form').elements;
 assert.equal(next.country.value,'');assert.equal(next.currency.value,'');assert.equal(next.holderCode.value,'');
 generator.close();assert.equal(document.querySelector('dialog'),null);
});
