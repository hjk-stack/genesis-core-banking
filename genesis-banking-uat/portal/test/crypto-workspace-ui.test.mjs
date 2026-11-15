import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createCryptoWorkspace} from '../public/crypto-workspace.mjs';

let dom,workspace;
afterEach(()=>{workspace?.close();dom?.window.close();delete globalThis.document;});
async function mount(views={},send=()=>{},action=()=>{throw new Error('Unexpected action');}){
 dom=new JSDOM('<!doctype html><body><main id="main"><div id="view"></div></main></body>',{url:'https://bank.invalid'});
 globalThis.document=dom.window.document;
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 workspace=createCryptoWorkspace({
  api:async(path,input,key)=>{
   if(path.startsWith('views/'))return {rows:views[path.slice(6)]||[]};
   if(path.startsWith('crypto/securities/'))return views.cryptosecurities.find(s=>path.endsWith(s.card_id));
   return action(path,input,key);
  },
  identity:()=>({admin:false,customerUserId:'1'}),purchase(){},sell(){},send,notice(){}
 });
 await workspace.mount(document.querySelector('#view'));
}
const holding=(currency_code,extra={})=>({account_id:currency_code,user_id:'1',currency_code,name:currency_code,network:'ETHEREUM',wallet_scope:'FUNDING',available_balance:'0',locked_balance:'0',...extra});
const market=(currency_code,market_rank,change24h,extra={})=>({currency_code,name:currency_code,market_rank,market_data:{usd:'1',eur:'0.9',chf:'0.8',change24h,...extra}});
const marketCards=()=>[...document.querySelectorAll('[data-markets] .crypto-market')];

test('wallet balances, security units and prices preserve every fractional digit without grouping the fraction',async()=>{
 const wallet=holding('AG',{available_balance:'1234567890123456789012345678.123456789012345678',locked_balance:'0.000000000000000001'});
 const security={card_id:'security',name:'Precision holding',symbol:'PRECISION',mode:'DEMO',state:'DRAFT',token_quantity:'1000.123456789012345678',dossier:{assetType:'STOCK',assetValue:'1000000.010000000000000000',currency:'CHF',faceValue:'0.000000000000000001',marginHaircutBps:1500,tradingFeeBps:10},actions:[]};
 const views={cryptowallets:[wallet,holding('AGi',{available_balance:'1000.100000000000000000',locked_balance:'0.000000000000000000'})],cryptosecurities:[security],cryptomarkets:[market('AG',1,1,{usd:'0.123456789012345678',eur:'1234567890123456.123456789012345678',chf:null})]};
 const original=structuredClone(views);
 await mount(views);
 assert.deepEqual([...document.querySelector('[data-wallet="AG"]').querySelectorAll('dd')].map(e=>e.textContent),['1,234,567,890,123,456,789,012,345,678.123456789012345678','0.000000000000000001']);
 assert.deepEqual([...document.querySelector('[data-wallet="AGi"]').querySelectorAll('dd')].map(e=>e.textContent),['1,000.1','0']);
 assert.equal(document.querySelector('.security-volume').textContent,'1,000.123456789012345678 units');
 assert.deepEqual([...marketCards()[0].querySelectorAll('dd')].map(e=>e.textContent),['0.123456789012345678','1,234,567,890,123,456.123456789012345678','—']);
 assert.deepEqual(views,original,'rendering must leave account and price data unchanged');
});

test('unknown and nonfinite returns do not claim zero performance or displace measured losses',async()=>{
 const missing=[null,undefined,'','  ',NaN,Infinity,-Infinity,'Infinity','not a return',false];
 const rows=[...missing.map((change,i)=>market('MISSING'+i,i+1,change)),market('LOSS5',11,-5),market('FLAT',12,0),market('GAIN',13,'3.25'),market('LOSS1',14,'-1')];
 await mount({cryptomarkets:rows});
 for(const card of marketCards().slice(0,missing.length)){
  assert.equal(card.querySelector('.market-change').textContent,'—');
  assert.equal(card.querySelector('.market-arrow').textContent,'—');
  assert.equal(card.querySelector('.market-arrow').getAttribute('aria-label'),'24-hour change not reported');
 }
 const filter=document.querySelector('[data-market-filter]');filter.value='performance';filter.dispatchEvent(new dom.window.Event('change'));
 assert.deepEqual(marketCards().map(e=>e.querySelector('strong').textContent),['GAIN','FLAT','LOSS1','LOSS5']);
 assert.deepEqual(marketCards().map(e=>e.querySelector('.market-change').textContent),['+3.25%','0.00%','-1.00%','-5.00%']);
 assert.deepEqual(marketCards().map(e=>e.querySelector('.market-arrow').textContent),['↑','→','↓','↓']);
});

test('AG and AGi use the original local artwork while external icons retain their host restriction',async()=>{
 await mount({cryptowallets:[holding('AG'),holding('AGi'),holding('ETH',{icon_url:'https://coin-images.coingecko.com/coins/images/279/large/ethereum.png'}),holding('UNTRUSTED',{icon_url:'https://coin-images.coingecko.com.evil.invalid/icon.png'})]});
 assert.equal(document.querySelector('[data-wallet="AG"] img').getAttribute('src'),'/crypto-icons/ag.png');
 assert.equal(document.querySelector('[data-wallet="AGi"] img').getAttribute('src'),'/crypto-icons/agi.png');
 assert.equal(document.querySelector('[data-wallet="ETH"] img').getAttribute('src'),'https://coin-images.coingecko.com/coins/images/279/large/ethereum.png');
 assert.equal(document.querySelector('[data-wallet="UNTRUSTED"] img'),null);
 assert.equal(document.querySelector('[data-wallet="UNTRUSTED"] .coin-monogram').textContent,'UNTRUSTED');
});

test('Send retains all funding wallets and Ethereum custody while other custody wallets retain Receive',async()=>{
 const wallets=[
  holding('ETH',{account_id:'funding-ethereum'}),
  holding('POL',{account_id:'funding-polygon',network:'POLYGON'}),
  holding('ETH',{account_id:'custody-ethereum',wallet_scope:'CUSTODY'}),
  holding('POL',{account_id:'custody-polygon',wallet_scope:'CUSTODY',network:'POLYGON'}),
  holding('SOL',{account_id:'custody-solana',wallet_scope:'CUSTODY',network:'SOLANA'})
 ],sent=[];
 await mount({cryptowallets:wallets},wallet=>sent.push(wallet));
 const buttons=[...document.querySelectorAll('[data-send]')];
 assert.deepEqual(buttons.map(button=>button.dataset.send),['funding-ethereum','funding-polygon','custody-ethereum']);
 assert.equal(document.querySelector('[data-wallet="custody-polygon"] [data-send]'),null);
 assert.equal(document.querySelector('[data-wallet="custody-solana"] [data-send]'),null);
 assert.deepEqual([...document.querySelectorAll('[data-receive]')].map(button=>button.dataset.receive),wallets.map(wallet=>wallet.account_id));
 for(const button of buttons)button.click();
 assert.deepEqual(sent,wallets.slice(0,3),'Send must pass the selected funding or Ethereum custody wallet to the payment flow');
});

test('Receive keeps balance reads separate from receipt booking and retries the selected transaction without duplicate submission',async()=>{
 const wallet=holding('ETH',{asset_id:'ethereum',address_id:'wallet-one'}),views={cryptowallets:[wallet]},calls=[];
 const txHash='0x'+'a'.repeat(64),publicAddress='0x'+'1'.repeat(40);let release,attempt=0;
 await mount(views,()=>{},async(path,input,key)=>{
  calls.push({path,input,key});
  if(path==='crypto/wallet')return {address_id:wallet.address_id,public_address:publicAddress,network:'ETHEREUM',destination_tag:null,qr:'data:image/png;base64,AA=='};
  if(path==='crypto/balance')return {balance:'2.125',observedAt:'2026-11-15T12:00:00Z'};
  assert.equal(path,'crypto/deposits/reconcile');
  assert.deepEqual(input,{accountId:wallet.account_id,addressId:wallet.address_id,txHash});
  if(!attempt++){await new Promise(resolve=>{release=resolve;});return {status:'PENDING',confirmations:14,finalized:false};}
  wallet.available_balance='2.125';return {status:'CONFIRMED',amount:'2.125',currency:'ETH',txHash,confirmations:64,finalized:true};
 });
 await document.querySelector('[data-receive]').onclick();
 const balanceButton=document.querySelector('[data-chain-balance]');await balanceButton.onclick({currentTarget:balanceButton});
 assert.match(document.querySelector('[data-balance-result]').textContent,/Blockchain: 2\.125 ETH/);
 assert.equal(calls.filter(c=>c.path==='crypto/deposits/reconcile').length,0);
 assert.equal(document.querySelector('[data-wallet] dd').textContent,'0');
 const form=document.querySelector('[data-deposit-form]'),submit=()=>form.onsubmit({preventDefault(){}});form.elements.txHash.value=txHash;
 const first=submit();assert.equal(form.querySelector('button').disabled,true);await submit();
 assert.equal(calls.filter(c=>c.path==='crypto/deposits/reconcile').length,1);
 release();await first;assert.match(form.querySelector('[data-deposit-result]').textContent,/14 \/ 12 · Awaiting blockchain finalization/);
 assert.equal(document.querySelector('[data-wallet] dd').textContent,'0');assert.equal(form.querySelector('button').disabled,false);
 await submit();assert.match(form.querySelector('[data-deposit-result]').textContent,/Received 2\.125 ETH/);
 assert.equal(document.querySelector('[data-wallet] dd').textContent,'2.125');
 const reconciliation=calls.filter(c=>c.path==='crypto/deposits/reconcile');assert.equal(reconciliation.length,2);assert.equal(reconciliation[0].key,reconciliation[1].key);
});

test('Receive places reconciliation errors beside the transaction hash and exposes the action only for Ethereum',async()=>{
 const wallets=[holding('ETH',{address_id:'eth-wallet'}),holding('SOL',{address_id:'sol-wallet',network:'SOLANA'})];
 await mount({cryptowallets:wallets},()=>{},async(path,input)=>{
  if(path==='crypto/wallet')return {address_id:input.addressId,public_address:'fixture-address',network:input.addressId==='eth-wallet'?'ETHEREUM':'SOLANA',destination_tag:null,qr:'data:image/png;base64,AA=='};
  assert.equal(path,'crypto/deposits/reconcile');throw Object.assign(new Error('Select the matching Ethereum wallet for this incoming transfer.'),{field:'accountId'});
 });
 await document.querySelector('[data-receive="ETH"]').onclick();const form=document.querySelector('[data-deposit-form]');form.elements.txHash.value='0x'+'b'.repeat(64);
 await form.onsubmit({preventDefault(){}});
 assert.equal(form.querySelector('[data-deposit-error]').textContent,'Select the matching Ethereum wallet for this incoming transfer.');
 assert.equal(document.querySelector('[data-crypto-error]').textContent,'');assert.equal(form.querySelector('button').disabled,false);
 await document.querySelector('[data-receive="SOL"]').onclick();assert.equal(document.querySelector('[data-deposit-form]'),null);
 assert.ok(document.querySelector('[data-chain-balance]'));
});
