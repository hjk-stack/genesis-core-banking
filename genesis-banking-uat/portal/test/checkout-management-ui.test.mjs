import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {openCheckoutManagement} from '../public/crypto-basket.mjs';

test('checkout manager selects receiving currency/network with original icons and no purchasing controls',async()=>{
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://avispay.invalid/admin'});
 const previous=global.document;
 global.document=dom.window.document;
 const proto=dom.window.HTMLDialogElement.prototype;
 proto.showModal=function(){this.setAttribute('open','');};
 proto.close=function(){this.removeAttribute('open');this.dispatchEvent(new dom.window.Event('close'));};
 const rows=[
  {asset_id:'avispay-ag',asset:'AG',name:'AVIS Greens',network:'ETHEREUM',accepted:true,icon_url:'https://bad.invalid/ag.png'},
  {asset_id:'avispay-agi',asset:'AGi',name:'AVIS Greens Index',network:'ETHEREUM',accepted:false},
  {asset_id:'usdc',asset:'USDC',name:'USD Coin',network:'BASE',accepted:false,icon_url:'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png'},
  {asset_id:'usdc',asset:'USDC',name:'USD Coin',network:'ETHEREUM',accepted:false,icon_url:'https://coin-images.coingecko.com.evil.invalid/x.png'}
 ];
 const changes=[],api=async(action,body)=>{
  if(action==='views/checkouttenders')return {rows:rows.map(r=>({...r}))};
  if(action==='crypto/basket/tender'){changes.push(body);return {accepted:body.accepted};}
  throw Error('Unexpected endpoint: '+action);
 };
 try{
  await openCheckoutManagement(api);
  const root=dom.window.document.querySelector('[data-checkout-management]');
  assert.ok(root);
  assert.match(root.textContent,/Accepted crypto payments/);
  assert.doesNotMatch(root.textContent,/MetaMask|Purchase budget|Supplier settings|Refresh price and gas/);
  assert.equal(root.querySelectorAll('.checkout-coin-option').length,4);
  assert.equal(root.querySelector('img[src="/crypto-icons/ag.png"]')?.alt,'');
  assert.equal(root.querySelector('img[src="/crypto-icons/agi.png"]')?.alt,'');
  assert.ok(root.querySelector('img[src^="https://coin-images.coingecko.com/"]'));
  assert.equal(root.querySelectorAll('img[src*="evil.invalid"]').length,0);
  assert.match(root.querySelector('[data-count]').textContent,/1 of 4/);
  const target=root.querySelector('input[aria-label="Accept USD Coin (USDC) on BASE"]');
  assert.ok(target);target.checked=true;
  target.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(changes.length,1);
  assert.deepEqual(changes[0],{assetId:'usdc',network:'BASE',accepted:true});
  assert.match(root.querySelector('[data-count]').textContent,/2 of 4/);
  const filter=root.querySelector('[data-search]');filter.value='polygon';filter.dispatchEvent(new dom.window.Event('input'));
  assert.equal(root.querySelectorAll('.checkout-coin-option').length,0);
  assert.match(root.textContent,/No currencies match this selection/);
  filter.value='USD Coin';filter.dispatchEvent(new dom.window.Event('input'));
  assert.equal(root.querySelectorAll('.checkout-coin-option').length,2);
  root.querySelector('[data-close]').click();
  assert.equal(dom.window.document.querySelector('[data-checkout-management]'),null);
 }finally{if(previous===undefined)delete global.document;else global.document=previous;dom.window.close();}
});

test('checkout tender catalog provides verified coin icons without changing acceptance eligibility',()=>{
 const sql=readFileSync(new URL('../src/checkout-crypto-tender.mjs',import.meta.url),'utf8');
 assert.match(sql,/SELECT a\.asset_id,a\.currency_code AS asset,a\.name,a\.icon_url,n\.network/);
 assert.match(sql,/WHERE n\.approved AND n\.verified_at IS NOT NULL/);
 const ui=readFileSync(new URL('../public/crypto-basket.mjs',import.meta.url),'utf8').split('export async function openCheckoutManagement(api){')[1];
 assert.ok(ui);
 assert.doesNotMatch(ui,/MetaMask pricing|purchase budget|metamask purchasing|data-procurement|crypto\/basket\/price/ig);
});
