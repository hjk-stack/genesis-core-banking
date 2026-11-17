import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountWalletTradingScroller,eligibleAllowanceRows,allowanceText,allowanceIcon} from '../public/wallet-trading-scroller.mjs';
let dom,controller;
afterEach(()=>{controller?.close();dom?.window.close();});
const ag={account_id:'11111111-1111-4111-8111-111111111111',user_id:'1',currency_code:'AG',network:'ETHEREUM',name:'AVIS Green',full_name:'AVISPay PLC',quantity:'2000.000000000000000000',enabled:false,version:0};
const agi={...ag,account_id:'22222222-2222-4222-8222-222222222222',currency_code:'AGi',name:'AVIS Green Investment',quantity:'1000.000000000000000000'};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(initial=[ag,agi],override=null){
 dom=new JSDOM('<!doctype html><body><div id="strip"></div></body>',{url:'https://bank.invalid'});
 const host=dom.window.document.querySelector('#strip'),rows=structuredClone(initial),writes=[];
 const api=async(path,input,key)=>{
  if(override){const answer=await override(path,input,key);if(answer!==undefined)return answer;}
  if(path==='views/tradingallowances')return {rows:structuredClone(rows)};
  assert.equal(path,'crypto/trading/select-wallet');writes.push({path,input,key});
  const row=rows.find(r=>r.account_id===input.accountId);assert.equal(input.expectedVersion,row.version);
  row.enabled=input.enabled;row.version++;return structuredClone(row);
 };
 controller=mountWalletTradingScroller({host,api,pollMs:0});return {host,rows,writes,api};
}
test('accepted AG and AGi appear without depending on USD price or market rank',async()=>{
 const {host}=setup();await controller.ready;
 assert.equal(host.querySelectorAll('[data-trading-wallet]').length,2);
 assert.equal(host.querySelectorAll('button[role=switch]').length,2);
 assert.match(host.textContent,/2,000 AG/);assert.match(host.textContent,/1,000 AGi/);
 assert.deepEqual([...host.querySelectorAll('img')].map(i=>i.src),['https://bank.invalid/crypto-icons/ag.png','https://bank.invalid/crypto-icons/agi.png']);
});
test('multiple coins activate independently and reloading preserves both without replaying activation',async()=>{
 const state=setup();await controller.ready;
 await Promise.all([controller.toggle(ag.account_id),controller.toggle(agi.account_id)]);await flush();
 assert.ok(state.rows.every(r=>r.enabled));
 assert.equal(state.host.querySelectorAll('[aria-checked=true]').length,2);
 await controller.toggle(ag.account_id);await flush();
 assert.equal(state.rows[0].enabled,false);assert.equal(state.rows[1].enabled,true);
 assert.equal(state.writes.length,3);
 controller.close();controller=mountWalletTradingScroller({host:state.host,api:state.api,pollMs:0});await controller.ready;
 assert.equal(state.host.querySelectorAll('[aria-checked=true]').length,1);assert.equal(state.writes.length,3);
 assert.ok(state.writes.every(w=>w.path==='crypto/trading/select-wallet'));
});
test('a new consent appears on refresh and a revoked coin disappears without disturbing others',async()=>{
 const state=setup([ag]);await controller.ready;
 state.rows.push(structuredClone(agi));dom.window.dispatchEvent(new dom.window.Event('avispay:trade-allowance-changed'));await flush();
 assert.equal(state.host.querySelectorAll('[data-trading-wallet]').length,2);
 state.rows.shift();await controller.refresh();
 assert.equal(state.host.querySelectorAll('[data-trading-wallet]').length,1);
 assert.equal(state.host.querySelector('[data-trading-wallet]').dataset.tradingWallet,agi.account_id);
});
test('failed mutation leaves the previous selection intact and scopes the message to that coin',async()=>{
 const state=setup([ag,agi],async(path,input)=>{if(input)throw new Error('This wallet selection changed. Refresh this coin and retry.');});await controller.ready;
 await controller.toggle(ag.account_id);await flush();
 assert.equal(state.host.querySelectorAll('[aria-checked=true]').length,0);
 assert.match(state.host.querySelector('[data-wallet-selection-error]').textContent,/selection changed/);
 assert.equal(state.host.querySelectorAll('[data-wallet-selection-error]')[1].textContent,'');
});
test('an outstanding response cannot re-render a disconnected or replaced session',async()=>{
 let resolve;const response=new Promise(r=>resolve=r),state=setup([],async()=>response);
 controller.close();state.host.replaceChildren();resolve({rows:[ag,agi]});await controller.ready;
 assert.equal(state.host.children.length,0);
});
test('coin and network identity remain separate and decimal allowances retain all digits',()=>{
 const sameSymbol={...ag,account_id:'33333333-3333-4333-8333-333333333333',network:'POLYGON'};
 assert.equal(eligibleAllowanceRows([ag,agi,sameSymbol,ag,{...ag,account_id:'zero',quantity:'0'}]).length,3);
 assert.equal(allowanceText('0.123456789012345678'),'0.123456789012345678');
 assert.equal(allowanceText('123456789012345678.1'),'123,456,789,012,345,678.1');
 assert.equal(allowanceIcon({...ag,currency_code:'ETH',icon_url:'https://coin-images.coingecko.com.evil.invalid/key'}),null);
});
test('horizontal controls scroll only the authorised coin row',async()=>{
 const {host}=setup();await controller.ready;const calls=[];
 host.querySelector('[data-trading-allowance-coins]').scrollBy=options=>calls.push(options);
 host.querySelector('[data-wallet-scroll="1"]').click();host.querySelector('[data-wallet-scroll="-1"]').click();
 assert.ok(calls[0].left>0);assert.ok(calls[1].left<0);
});
