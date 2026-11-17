import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountTradingPanel} from '../public/trading-panel.mjs';

const windows=[];
afterEach(()=>{for(const dom of windows.splice(0))dom.window.close();});
const securities=[{security_id:'eur-security',name:'EUR security',currency_code:'EUR'},{security_id:'usd-security',name:'USD security',currency_code:'USD'}];
const users=[{user_id:1,full_name:'Institution one',account_role:'INSTITUTION'},{user_id:2,full_name:'Institution two',account_role:'INSTITUTION'},{user_id:3,full_name:'Customer',account_role:'CUSTOMER'}];
const cash=(id,user,currency,extra={})=>({account_id:id,user_id:user,currency_code:currency,full_name:'Institution '+user,account_reference:'ABIQ-'+id,status:'ACTIVE',account_role:'INSTITUTION',network:null,...extra});
const bankAccounts=[cash('one-eur',1,'EUR'),cash('one-eur-second',1,'EUR'),cash('one-usd',1,'USD'),cash('two-eur',2,'EUR'),cash('suspended',1,'EUR',{status:'SUSPENDED'}),cash('closed',1,'EUR',{status:'CLOSED'}),cash('network',1,'EUR',{network:'ETHEREUM'})];
const ledger=[...bankAccounts.map(a=>({...a,owner_type:'USER',wallet_scope:'FUNDING',account_category:'LIABILITY'})),{...cash('margin',1,'EUR'),owner_type:'USER',wallet_scope:'MARGIN',account_category:'LIABILITY'},{...cash('custody',1,'EUR'),owner_type:'USER',wallet_scope:'CUSTODY',account_category:'LIABILITY'}];
async function setup(providers=[]){
 const dom=new JSDOM('<!doctype html><main><section id="host"></section></main>',{url:'https://bank.invalid'});windows.push(dom);
 const host=dom.window.document.querySelector('#host'),calls=[];let form,submit;
 const api=async(path,input,key)=>{
  calls.push({path,input,key});
  if(path==='crypto/trading/validate-providers')return {providers};
  if(path==='crypto/trading/configure')return {id:'configured'};
  if(path==='crypto/trading/testing')return {profiles:[],runs:[],limits:{},engine:{name:'NautilusTrader'}};
  if(path==='crypto/trading/live')return {profiles:[],selectedRobotId:null,market:null,audit:null,liquidity:null};
  if(path==='crypto/trading/index-policy')return {policyVersion:1,instructions:'Use sources.',taxonomy:[]};
  const rows={customers:users,securities,ledger,accountsummaries:bankAccounts}[path.slice(6)]||[];
  return {rows};
 };
 await mountTradingPanel({host,api,isAdmin:true,refresh:async()=>{},form:async(title,html,onSubmit)=>{
  form=dom.window.document.createElement('form');form.innerHTML=html;dom.window.document.body.append(form);submit=onSubmit;return form;
 }});
 return {host,calls,dom,open:async()=>{await host.querySelector('[data-new-robot]').onclick();return form;},submit:()=>submit(Object.fromEntries(new dom.window.FormData(form)),'configuration-test-key')};
}
const change=(form,name,value)=>{form.elements[name].value=value;form.elements[name].onchange?.();};
const options=form=>[...form.elements.accountId.options].map(o=>o.value).filter(Boolean);

test('AVIS configuration offers active cash accounts only for the chosen institution and security currency',async()=>{
 const ui=await setup(),form=await ui.open();
 change(form,'venue','AVIS');assert.deepEqual(options(form),[]);
 change(form,'userId','1');change(form,'securityId','eur-security');
 assert.deepEqual(options(form),['one-eur','one-eur-second']);
 assert.match(form.elements.accountId.options[1].textContent,/ABIQ-one-eur/);
 form.elements.accountId.value='one-eur-second';change(form,'securityId','eur-security');assert.equal(form.elements.accountId.value,'one-eur-second','valid selection survives refresh');
 change(form,'securityId','usd-security');assert.deepEqual(options(form),['one-usd']);assert.equal(form.elements.accountId.value,'','changing currency clears incompatible selection');
 change(form,'securityId','eur-security');form.elements.accountId.value='one-eur';change(form,'userId','2');assert.deepEqual(options(form),['two-eur']);assert.equal(form.elements.accountId.value,'','changing institution clears another holder account');
 assert.equal(ui.calls.some(c=>c.input),false,'configuration choices do not save or activate a robot');
});

test('venue changes retain valid AVIS choices while excluding inactive fields from the saved request',async()=>{
 const ui=await setup(),form=await ui.open();change(form,'venue','AVIS');change(form,'userId','1');change(form,'securityId','eur-security');form.elements.accountId.value='one-eur';
 change(form,'venue','BINANCE');assert.equal(form.elements.accountId.disabled,true);assert.equal(form.elements.securityId.disabled,true);assert.equal(form.elements.keyRef.disabled,false);
 await ui.submit();let request=ui.calls.findLast(c=>c.path==='crypto/trading/configure');assert.equal(Object.hasOwn(request.input,'accountId'),false);assert.equal(Object.hasOwn(request.input,'securityId'),false);
 change(form,'venue','AVIS');assert.equal(form.elements.securityId.value,'eur-security');assert.equal(form.elements.accountId.value,'one-eur');assert.equal(form.elements.keyRef.disabled,true);
 await ui.submit();request=ui.calls.findLast(c=>c.path==='crypto/trading/configure');assert.equal(request.input.accountId,'one-eur');assert.equal(Object.hasOwn(request.input,'keyRef'),false);
 assert.equal(ui.calls.some(c=>/toggle|order/.test(c.path)&&c.input),false);
});

test('provider validation renders market data, execution and node capabilities accurately',async()=>{
 const ui=await setup([{provider:'CoinAPI Market Data',configured:true,verified:true,capability:'Authenticated reference pricing'},{provider:'CoinAPI EMS',configured:true,verified:true,accounts:['VENUE_A'],capability:'Execution API account connection'},{provider:'Alchemy',configured:true,verified:true,blockNumber:25000000,capability:'Ethereum RPC and signed-transaction transport'}]);
 await ui.host.querySelector('[data-validate-providers]').onclick();
 const result=ui.host.querySelector('[data-provider-result]').textContent;
 assert.match(result,/CoinAPI Market Data: verified · Authenticated reference pricing/);
 assert.match(result,/CoinAPI EMS: verified · VENUE_A/);assert.match(result,/Alchemy: verified · Ethereum block 25000000/);
 assert.doesNotMatch(result,/undefined/);
});
