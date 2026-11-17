import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createCryptoWorkspace} from '../public/crypto-workspace.mjs';
let dom,workspace;
const descriptors=new Map(['document','FormData','navigator'].map(n=>[n,Object.getOwnPropertyDescriptor(globalThis,n)]));
afterEach(()=>{workspace?.close();dom?.window.close();for(const [n,d] of descriptors){if(d)Object.defineProperty(globalThis,n,d);else delete globalThis[n];}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const wallet=(account_id,available_balance,address_id,extra={})=>({account_id,available_balance,address_id,locked_balance:'0',currency_code:'AG',asset_id:'avis-green',name:'AVIS Green',user_id:'1',full_name:'AVISPay PLC',account_role:'INSTITUTION',network:'ETHEREUM',wallet_scope:'FUNDING',wallet_visible:true,public_address:'0x'+String(address_id).repeat(40),...extra});
async function setup(wallets,{admin=false,action,send}={}){
 dom=new JSDOM('<!doctype html><body><main><div id="view"></div></main></body>',{url:'https://bank.invalid'});
 globalThis.document=dom.window.document;globalThis.FormData=dom.window.FormData;
 Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 const views={cryptowallets:wallets,cryptocatalogue:[{asset_id:'avis-green',name:'AVIS Green',currency_code:'AG',networks:[{network:'ETHEREUM',approved:true,verifiedAt:'2026-11-17T00:00:00Z'}]}],cryptonetworks:[{code:'ETHEREUM',name:'Ethereum',kind:'EVM'}],customers:[{user_id:'1',full_name:'AVISPay PLC',account_role:'INSTITUTION'}]};
 workspace=createCryptoWorkspace({api:async(path,input,key)=>{
  if(path.startsWith('views/'))return {rows:views[path.slice(6)]||[]};
  if(path==='crypto/trading/index-policy')return {policyVersion:0,instructions:'',taxonomy:[]};
  if(path.startsWith('crypto/trading/live'))return {profiles:[],selectedRobotId:null,market:null,audit:null,liquidity:null};
  return action?.(path,input,key)||{};
 },identity:()=>admin?{admin:true,customerUserId:null}:{admin:false,customerUserId:'1'},purchase(){},sell(){},send:send||(()=>{}),notice(){}});
 await workspace.mount(document.querySelector('#view'));await flush();
}

test('a visible empty duplicate cannot redirect Receive away from the funded card',async()=>{
 const calls=[],sent=[];
 const empty=wallet('empty','0','1'),funded=wallet('funded','10000000000','2');
 await setup([empty,funded],{send:row=>sent.push(row.account_id),action:(path,input)=>{
  calls.push({path,input});
  if(path==='crypto/wallet')return {address_id:'2',network:'ETHEREUM',public_address:funded.public_address,qr:'data:image/png;base64,fixture'};
 }});
 assert.equal(document.querySelector('[data-wallet]').dataset.wallet,'funded');
 assert.match(document.querySelector('[data-wallet] dl').textContent,/10,000,000,000/);
 document.querySelector('[data-send]').click();
 assert.deepEqual(sent,['funded']);
 document.querySelector('[data-receive]').click();await flush();await flush();
 assert.deepEqual(calls.filter(c=>c.path==='crypto/wallet').map(c=>c.input.addressId),['2']);
 assert.equal(calls.some(c=>c.path==='crypto/activate'),false);
 assert.match(document.querySelector('.crypto-receive').textContent,new RegExp(funded.public_address));
});

test('currency icon selection restores an archived booked AG wallet without adding an empty card',async()=>{
 const funded=wallet('funded','10000000000','2',{wallet_visible:false}),calls=[];
 await setup([funded],{admin:true,action:(path,input,key)=>{
  calls.push({path,input,key});
  if(path==='crypto/activate'){assert.equal(input.assetId,'avis-green');assert.equal(input.userId,'1');funded.wallet_visible=true;return {accountId:'funded',addressId:'2'};}
 }});
 assert.equal(document.querySelectorAll('[data-wallet]').length,0);
 document.querySelector('[data-add-asset]').click();await flush();
 const form=document.querySelector('.crypto-dialog form');form.elements.userId.value='1';
 const choice=form.querySelector('[data-currency-option="avis-green"]');assert.ok(choice.querySelector('img'));
 choice.click();
 form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await flush();await flush();
 assert.equal(document.querySelectorAll('[data-wallet]').length,1);
 assert.equal(document.querySelector('[data-wallet]').dataset.wallet,'funded');
 assert.equal(funded.available_balance,'10000000000');
 assert.equal(calls.filter(c=>c.path==='crypto/activate').length,1);
 assert.match(document.querySelector('[data-wallet]').textContent,/10,000,000,000/);
});
