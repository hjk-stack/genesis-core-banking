import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createCryptoWorkspace} from '../public/crypto-workspace.mjs';

let dom,workspace;
const globals=new Map(['document','FormData','navigator'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
afterEach(()=>{workspace?.close();dom?.window.close();for(const [name,descriptor] of globals)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];});
async function mount(views={},send=()=>{},action=()=>{throw new Error('Unexpected action');},identity=()=>({admin:false,customerUserId:'1'})){
 dom=new JSDOM('<!doctype html><body><main id="main"><div id="view"></div></main></body>',{url:'https://bank.invalid'});
 globalThis.document=dom.window.document;
 globalThis.FormData=dom.window.FormData;
 Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 workspace=createCryptoWorkspace({
  api:async(path,input,key)=>{
   if(path.startsWith('views/'))return {rows:views[path.slice(6)]||[]};
   if(path==='crypto/trading/index-policy'&&input===undefined)return {policyVersion:0,instructions:'Use primary-source event evidence.',taxonomy:[]};
   if(path.startsWith('crypto/trading/live')&&input===undefined)return {schemaVersion:1,observedAt:new Date().toISOString(),profiles:[],selectedRobotId:null,market:null,audit:null,liquidity:null};
   if(path.startsWith('crypto/securities/'))return views.cryptosecurities.find(s=>path.endsWith(s.card_id));
   return action(path,input,key);
  },
  identity,purchase(){},sell(){},send,notice(){}
 });
 await workspace.mount(document.querySelector('#view'));
}
const holding=(currency_code,extra={})=>({account_id:currency_code,user_id:'1',currency_code,name:currency_code,network:'ETHEREUM',wallet_scope:'FUNDING',available_balance:'0',locked_balance:'0',...extra});
const market=(currency_code,market_rank,change24h,extra={})=>({currency_code,name:currency_code,market_rank,market_data:{usd:'1',eur:'0.9',chf:'0.8',change24h,...extra}});
const marketCards=()=>[...document.querySelectorAll('[data-markets] .crypto-market')];
const networkRows=[{code:'ETHEREUM',name:'Ethereum'},{code:'SOLANA',name:'Solana'},{code:'POLYGON',name:'Polygon'},{code:'BSC',name:'BNB Smart Chain'}];
const approved=(network,extra={})=>({network,approved:true,verifiedAt:'2026-11-15T12:00:00Z',...extra});
const usdcAsset=(networks=[approved('ETHEREUM'),approved('SOLANA')])=>({asset_id:'usd-coin',currency_code:'USDC',name:'USD Coin',networks});
const usdcHolding=(network,extra={})=>holding('USDC',{asset_id:'usd-coin',name:'USD Coin',network,account_id:'usdc-'+network,address_id:'address-'+network,available_balance:network==='ETHEREUM'?'123.456789012345678001':'987.654321',locked_balance:network==='ETHEREUM'?'0.000000000000000009':'7',...extra});
const walletResponse=wallet=>({address_id:wallet.address_id,network:wallet.network,public_address:'public-'+wallet.address_id,destination_tag:null,qr:'data:image/png;base64,'+Buffer.from(wallet.address_id).toString('base64')});
const options=element=>[...element.options].map(option=>option.value);
const choose=(selector,value)=>{const element=typeof selector==='string'?document.querySelector(selector):selector;element.value=value;return element.onchange();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('wallet balances, security units and prices preserve every fractional digit without grouping the fraction',async()=>{
 const wallet=holding('AG',{available_balance:'1234567890123456789012345678.123456789012345678',locked_balance:'0.000000000000000001'});
 const security={card_id:'security',name:'Precision holding',symbol:'PRECISION',mode:'DEMO',state:'DRAFT',token_quantity:'1000.123456789012345678',dossier:{assetType:'STOCK',assetValue:'1000000.010000000000000000',currency:'CHF',faceValue:'0.000000000000000001',marginHaircutBps:1500,tradingFeeBps:10},actions:[]};
 const views={cryptowallets:[wallet,holding('AGi',{available_balance:'1000.100000000000000000',locked_balance:'0.000000000000000000'})],cryptosecurities:[security],cryptomarkets:[market('AG',1,1,{usd:'0.123456789012345678',eur:'1234567890123456.123456789012345678',chf:null})]};
 const original=structuredClone(views);
 await mount(views);
 assert.deepEqual([...document.querySelector('[data-wallet="AG"]').querySelectorAll('dd')].map(e=>e.textContent),['1,234,567,890,123,456,789,012,345,678.123456789012345677','0.000000000000000001']);
 assert.deepEqual([...document.querySelector('[data-wallet="AGi"]').querySelectorAll('dd')].map(e=>e.textContent),['1,000.1','0']);
 assert.equal(document.querySelector('.security-volume'),null,'demo securities are omitted from the live workspace');
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

test('one currency tile selects exact per-chain balances and Send accounts without combining holdings',async()=>{
 const wallets=[usdcHolding('ETHEREUM'),usdcHolding('SOLANA')],sent=[],views={cryptowallets:wallets,cryptonetworks:networkRows,cryptocatalogue:[usdcAsset([approved('ETHEREUM'),approved('SOLANA'),approved('BSC',{approved:false}),approved('POLYGON',{verifiedAt:null}),approved('UNSUPPORTED')])]};
 const original=structuredClone(views);await mount(views,wallet=>sent.push(wallet));
 assert.equal(document.querySelectorAll('[data-wallet-group]').length,1);
 assert.deepEqual(options(document.querySelector('[data-wallet-network]')),['ETHEREUM','SOLANA']);
 const oldSend=document.querySelector('[data-send]');oldSend.click();
 assert.deepEqual([...document.querySelectorAll('[data-wallet-group] dd')].map(el=>el.textContent),['123.456789012345677992','0.000000000000000009']);
 await choose('[data-wallet-network]','SOLANA');
 assert.equal(document.querySelector('[data-wallet-group]').dataset.wallet,wallets[1].account_id);
 assert.deepEqual([...document.querySelectorAll('[data-wallet-group] dd')].map(el=>el.textContent),['980.654321','7']);
 assert.equal(document.querySelector('[data-receive]').dataset.receive,wallets[1].account_id);
 oldSend.onclick();assert.deepEqual(sent,[wallets[0]],'a detached Send handler must not send from the previously selected chain');
 document.querySelector('[data-send]').click();assert.deepEqual(sent,wallets);
 await workspace.mount(document.querySelector('#view'));
 assert.equal(document.querySelector('[data-wallet-network]').value,'SOLANA','refresh must preserve the selected blockchain');
 assert.equal(document.querySelector('[data-wallet-group]').dataset.wallet,wallets[1].account_id);
 assert.deepEqual(views,original,'grouping must not modify or aggregate source account data');
});

test('Activate currency submits all eligible blockchains together once without a network field',async()=>{
 const asset=usdcAsset([approved('ETHEREUM'),approved('SOLANA'),approved('BSC',{approved:false}),approved('POLYGON',{verifiedAt:null}),approved('UNSUPPORTED')]),views={cryptonetworks:networkRows,cryptocatalogue:[asset],cryptowallets:[]},calls=[],activation=deferred();
 await mount(views,()=>{},async(path,input,key)=>{calls.push({path,input,key});assert.equal(path,'crypto/activate');await activation.promise;views.cryptowallets=[usdcHolding('ETHEREUM'),usdcHolding('SOLANA')];return {wallets:[]};});
 await document.querySelector('[data-add-asset]').onclick();const form=document.querySelector('dialog form');
 assert.equal(form.querySelector('[name=network]'),null);assert.equal(form.querySelector('[name=userId]'),null);
 form.elements.assetId.value=asset.asset_id;form.elements.assetId.onchange();
 assert.equal(form.querySelector('[data-included-networks]').textContent,'Ethereum · Solana');
 assert.equal(form.querySelector('[type=submit]').textContent,'Activate currency');
 const submitted=form.onsubmit({preventDefault(){}});await form.onsubmit({preventDefault(){}});
 assert.equal(calls.length,1);assert.equal(form.querySelector('[type=submit]').disabled,true);
 assert.deepEqual(calls[0].input,{assetId:'usd-coin',userId:'1'});assert.match(calls[0].key,/^[0-9a-f-]{36}$/i);
 activation.resolve();await submitted;
 assert.equal(document.querySelector('dialog'),null);assert.equal(document.querySelectorAll('[data-wallet-group]').length,1);
 assert.deepEqual(options(document.querySelector('[data-wallet-network]')),['ETHEREUM','SOLANA']);
});

test('legacy currency exposes missing approved chains and shares one activation across rapid selections and Receive',async()=>{
 const eth=usdcHolding('ETHEREUM'),sol=usdcHolding('SOLANA'),polygon=usdcHolding('POLYGON',{available_balance:'3.000000000000000001',locked_balance:'0'}),views={cryptowallets:[eth],cryptonetworks:networkRows,cryptocatalogue:[usdcAsset([approved('ETHEREUM'),approved('SOLANA'),approved('POLYGON')])]},calls=[],activation=deferred();
 await mount(views,()=>{},async(path,input,key)=>{
  calls.push({path,input,key});if(path==='crypto/activate'){await activation.promise;views.cryptowallets=[eth,sol,polygon];return {wallets:[]};}
  assert.equal(path,'crypto/wallet');return walletResponse(views.cryptowallets.find(w=>w.address_id===input.addressId));
 });
 assert.deepEqual(options(document.querySelector('[data-wallet-network]')),['ETHEREUM','SOLANA','POLYGON']);
 const solSelection=choose('[data-wallet-network]','SOLANA');
 assert.equal(document.querySelector('[data-wallet-group]').dataset.wallet,'');
 assert.deepEqual([...document.querySelectorAll('[data-wallet-group] dd')].map(el=>el.textContent),['—','—'],'a route being activated must not borrow another chain balance or show an invented zero');
 assert.equal(document.querySelector('[data-send]'),null);
 const polygonSelection=choose('[data-wallet-network]','POLYGON'),receiving=document.querySelector('[data-receive]').onclick(),duplicateReceive=document.querySelector('[data-receive]').onclick();
 assert.equal(document.querySelectorAll('dialog').length,1);assert.equal(document.querySelector('[data-receive-network]').value,'POLYGON');
 assert.deepEqual(options(document.querySelector('[data-receive-network]')),['ETHEREUM','SOLANA','POLYGON']);
 assert.equal(document.querySelector('.crypto-qr'),null);assert.equal(calls.filter(c=>c.path==='crypto/activate').length,1);
 assert.deepEqual(calls[0].input,{userId:'1',assetId:'usd-coin'});
 activation.resolve();await Promise.all([solSelection,polygonSelection,receiving,duplicateReceive]);
 assert.equal(document.querySelectorAll('[data-wallet-group]').length,1);assert.equal(document.querySelector('[data-wallet-network]').value,'POLYGON');
 assert.equal(document.querySelector('[data-wallet-group]').dataset.wallet,polygon.account_id);assert.equal(document.querySelector('[data-wallet-group] dd').textContent,'3.000000000000000001');
 assert.equal(document.querySelector('.crypto-receive code').textContent,'public-'+polygon.address_id);
 assert.deepEqual(calls.filter(c=>c.path==='crypto/wallet').map(c=>c.input),[{addressId:polygon.address_id}]);
 assert.equal(calls.filter(c=>c.path==='crypto/activate').length,1,'all selected missing networks must use one currency activation');
});

test('rapid QR changes clear previous details immediately and reject out-of-order addresses, balance reads and detached actions',async()=>{
 const wallets=[usdcHolding('ETHEREUM'),usdcHolding('SOLANA')],views={cryptowallets:wallets,cryptocatalogue:[usdcAsset()],cryptonetworks:networkRows},walletReads=[],balance=deferred(),sent=[],copied=[],shared=[];let delay=false;
 await mount(views,wallet=>sent.push(wallet),async(path,input)=>{
  if(path==='crypto/balance')return balance.promise;
  assert.equal(path,'crypto/wallet');const response=walletResponse(wallets.find(w=>w.address_id===input.addressId));if(!delay)return response;
  const pending=deferred();walletReads.push({input,response,...pending});return pending.promise;
 });
 Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>copied.push(text)},configurable:true});navigator.share=async data=>shared.push(data);
 await document.querySelector('[data-receive]').onclick();const oldCopy=document.querySelector('[data-copy]').onclick,oldShare=document.querySelector('[data-share]').onclick,oldSend=document.querySelector('[data-send]').onclick;
 const staleBalance=document.querySelector('[data-chain-balance]').onclick();delay=true;
 const solSelection=choose('[data-receive-network]','SOLANA');
 assert.equal(document.querySelector('.crypto-qr'),null);assert.equal(document.querySelector('.crypto-receive code'),null);
 assert.equal(document.querySelector('[data-copy]'),null);assert.equal(document.querySelector('[data-share]'),null);assert.equal(document.querySelector('[data-deposit-form]'),null);
 assert.equal(document.querySelector('[data-wallet-network]').value,'SOLANA');assert.equal(document.querySelector('[data-wallet-group] dd').textContent,'980.654321');
 assert.equal(document.querySelector('[data-send]').dataset.send,wallets[1].account_id);assert.equal(document.querySelector('[data-send]').disabled,true);
 oldSend();await oldCopy();await oldShare();assert.deepEqual(sent,[]);assert.deepEqual(copied,[]);assert.deepEqual(shared,[]);
 const repeatedReceive=document.querySelector('[data-receive]').onclick();await flush();assert.equal(walletReads.length,1);
 const ethSelection=choose('[data-receive-network]','ETHEREUM');await flush();assert.equal(walletReads.length,2);
 assert.equal(document.querySelector('.crypto-qr'),null);assert.equal(document.querySelector('[data-send]').disabled,true);
 walletReads[1].resolve(walletReads[1].response);await ethSelection;
 assert.equal(document.querySelector('.crypto-qr').getAttribute('src'),walletReads[1].response.qr);
 assert.equal(document.querySelector('.crypto-receive code').textContent,walletReads[1].response.public_address);
 assert.equal(document.querySelector('[data-send]').disabled,false);
 walletReads[0].resolve(walletReads[0].response);balance.resolve({balance:'999999',observedAt:'2026-11-15T13:00:00Z'});await Promise.all([solSelection,repeatedReceive,staleBalance]);
 assert.equal(document.querySelectorAll('dialog').length,1);assert.equal(document.querySelector('[data-receive-network]').value,'ETHEREUM');
 assert.equal(document.querySelector('.crypto-qr').getAttribute('src'),walletReads[1].response.qr);assert.equal(document.querySelector('[data-balance-result]').textContent,'');
 await oldCopy();await oldShare();assert.deepEqual(copied,[]);assert.deepEqual(shared,[],'a previous request remains obsolete even after returning to its blockchain');
 await document.querySelector('[data-copy]').onclick();await document.querySelector('[data-share]').onclick();document.querySelector('[data-send]').click();
 assert.deepEqual(copied,[walletReads[1].response.public_address]);assert.equal(shared[0].text,'USDC · ETHEREUM\n'+walletReads[1].response.public_address);assert.deepEqual(sent,[wallets[0]]);
});

test('holder and wallet scope stay separate while legacy receiving addresses remain selectable after approval withdrawal',async()=>{
 const wallets=[usdcHolding('ETHEREUM',{full_name:'First holder'}),usdcHolding('SOLANA',{full_name:'First holder'}),usdcHolding('ETHEREUM',{account_id:'second-eth',address_id:'second-address',user_id:'2',full_name:'Second holder'}),usdcHolding('POLYGON',{account_id:'second-polygon',address_id:'second-polygon-address',user_id:'2',full_name:'Second holder'}),usdcHolding('ETHEREUM',{account_id:'custody-eth',wallet_scope:'CUSTODY',full_name:'First holder'})],calls=[];
 const views={cryptowallets:wallets,cryptonetworks:networkRows,cryptocatalogue:[usdcAsset([approved('ETHEREUM',{approved:false}),approved('SOLANA'),approved('POLYGON')])]};
 await mount(views,()=>{},async(path,input)=>{if(path==='crypto/trading/testing')return {engine:{name:'NautilusTrader',version:'1.231.0',fingerprint:'a'.repeat(64)},profiles:[],runs:[]};calls.push({path,input});assert.equal(path,'crypto/wallet');return walletResponse(wallets.find(w=>w.address_id===input.addressId));},()=>({admin:true}));
 assert.equal(document.querySelectorAll('[data-wallet-group]').length,3);
 const card=(holder,scope)=>document.querySelector(`[data-wallet-group][data-holder="${holder}"][data-wallet-scope="${scope}"]`);
 assert.deepEqual(options(card('1','CUSTODY').querySelector('[data-wallet-network]')),['ETHEREUM'],'a custody tile must not offer catalogue routes that would provision funding accounts');
 assert.match(card('1','CUSTODY').textContent,/Security/);assert.match(card('1','FUNDING').textContent,/Funding/);
 assert.deepEqual(options(card('1','FUNDING').querySelector('[data-wallet-network]')),['ETHEREUM','SOLANA','POLYGON'],'existing withdrawn Ethereum remains alongside approved new routes');
 await card('1','FUNDING').querySelector('[data-receive]').onclick();assert.equal(document.querySelector('.crypto-receive code').textContent,'public-address-ETHEREUM');
 await choose(card('2','FUNDING').querySelector('[data-wallet-network]'),'POLYGON');await card('2','FUNDING').querySelector('[data-receive]').onclick();
 assert.equal(document.querySelector('.crypto-receive code').textContent,'public-second-polygon-address');
 assert.equal(document.querySelector('[data-receive-network]').value,'POLYGON');assert.equal(card('1','FUNDING').dataset.wallet,'usdc-ETHEREUM');
 await card('1','CUSTODY').querySelector('[data-receive]').onclick();
 assert.deepEqual(options(document.querySelector('[data-receive-network]')),['ETHEREUM']);
 assert.deepEqual(calls.map(c=>c.input),[{addressId:'address-ETHEREUM'},{addressId:'second-polygon-address'},{addressId:'address-ETHEREUM'}]);
 assert.equal(document.querySelectorAll('dialog').length,1);assert.equal(document.querySelector('[data-crypto-error]').textContent,'');
});

test('customer identity changes discard pending receiving details and never expose another holder group',async()=>{
 const first=usdcHolding('ETHEREUM'),second=usdcHolding('ETHEREUM',{user_id:'2',account_id:'second-account',address_id:'second-address'}),views={cryptowallets:[first,second],cryptocatalogue:[usdcAsset()],cryptonetworks:networkRows},pending=deferred(),sent=[];let customerUserId='1';
 await mount(views,wallet=>sent.push(wallet),async(path,input)=>{assert.equal(path,'crypto/wallet');assert.equal(input.addressId,first.address_id);return pending.promise;},()=>({admin:false,customerUserId}));
 assert.equal(document.querySelectorAll('[data-wallet-group]').length,1);assert.equal(document.querySelector('[data-wallet-group]').dataset.holder,'1');
 const oldSend=document.querySelector('[data-send]').onclick,receiving=document.querySelector('[data-receive]').onclick();await flush();
 customerUserId='2';await workspace.mount(document.querySelector('#view'));pending.resolve(walletResponse(first));await receiving;
 assert.equal(document.querySelector('dialog'),null);assert.equal(document.querySelectorAll('[data-wallet-group]').length,1);assert.equal(document.querySelector('[data-wallet-group]').dataset.wallet,second.account_id);
 oldSend();assert.deepEqual(sent,[]);document.querySelector('[data-send]').click();assert.deepEqual(sent,[second]);
});

test('a confirmed deposit refreshes holdings without replacing a subsequently selected chain or its QR',async()=>{
 const eth=usdcHolding('ETHEREUM'),sol=usdcHolding('SOLANA'),views={cryptowallets:[eth,sol],cryptocatalogue:[usdcAsset()],cryptonetworks:networkRows},pending=deferred(),calls=[],txHash='0x'+'d'.repeat(64);
 await mount(views,()=>{},async(path,input,key)=>{
  calls.push({path,input,key});if(path==='crypto/wallet')return walletResponse(views.cryptowallets.find(w=>w.address_id===input.addressId));
  assert.equal(path,'crypto/deposits/reconcile');await pending.promise;eth.available_balance='124.456789012345678001';return {status:'CONFIRMED',currency:'USDC',amount:'1',txHash};
 });
 await document.querySelector('[data-receive]').onclick();const form=document.querySelector('[data-deposit-form]');form.elements.txHash.value=txHash;
 const deposit=form.onsubmit({preventDefault(){}});await choose('[data-receive-network]','SOLANA');
 assert.equal(document.querySelector('[data-deposit-form]'),null);pending.resolve();await deposit;
 assert.deepEqual(calls.find(c=>c.path==='crypto/deposits/reconcile').input,{accountId:eth.account_id,addressId:eth.address_id,txHash});
 assert.equal(document.querySelector('[data-wallet-network]').value,'SOLANA');assert.equal(document.querySelector('[data-wallet-group]').dataset.wallet,sol.account_id);
 assert.equal(document.querySelector('[data-wallet-group] dd').textContent,'980.654321');assert.equal(document.querySelector('[data-receive-network]').value,'SOLANA');
 assert.equal(document.querySelector('.crypto-receive code').textContent,'public-'+sol.address_id);assert.equal(document.querySelector('[data-deposit-result]'),null);
 document.querySelector('dialog .close').click();await choose('[data-wallet-network]','ETHEREUM');assert.equal(document.querySelector('[data-wallet-group] dd').textContent,'124.456789012345677992');
});

test('first-time administrator approval refreshes authoritative verification and eligible networks without resetting Receive',async()=>{
 let catalogue=[usdcAsset([approved('ETHEREUM'),approved('SOLANA',{approved:false,verifiedAt:null})]),{asset_id:'dai',name:'Dai',currency_code:'DAI',networks:[approved('ETHEREUM',{approved:false,verifiedAt:null})]}],catalogueReads=0;
 const eth=usdcHolding('ETHEREUM'),views={cryptowallets:[eth],cryptonetworks:networkRows,customers:[{user_id:'1',full_name:'First holder'}]},calls=[];
 Object.defineProperty(views,'cryptocatalogue',{get(){catalogueReads++;return catalogue;}});
 await mount(views,()=>{},async(path,input)=>{
  calls.push({path,input});if(path==='crypto/wallet')return walletResponse(eth);
  assert.equal(path,'crypto/approve');catalogue=structuredClone(catalogue);const pair=catalogue.find(a=>a.asset_id===input.assetId).networks.find(n=>n.network===input.network);pair.approved=input.approved;pair.verifiedAt='2026-11-15T14:00:00Z';
  return {...input};
 },()=>({admin:true}));
 await document.querySelector('[data-add-asset]').onclick();assert.deepEqual(options(document.querySelector('[name=assetId]')),['','usd-coin']);document.querySelector('dialog .close').click();
 await document.querySelector('[data-receive]').onclick();const qr=document.querySelector('.crypto-qr').getAttribute('src'),hash='0x'+'e'.repeat(64);document.querySelector('[name=txHash]').value=hash;
 await document.querySelector('[data-approve="usd-coin"][data-network="SOLANA"]').onclick();
 assert.deepEqual(options(document.querySelector('[data-wallet-network]')),['ETHEREUM','SOLANA']);assert.deepEqual(options(document.querySelector('[data-receive-network]')),['ETHEREUM','SOLANA']);
 assert.equal(document.querySelector('[data-receive-network]').value,'ETHEREUM');assert.equal(document.querySelector('.crypto-qr').getAttribute('src'),qr);assert.equal(document.querySelector('[name=txHash]').value,hash);
 assert.equal(document.querySelector('[data-approve="usd-coin"][data-network="SOLANA"]').getAttribute('aria-checked'),'true');
 document.querySelector('dialog .close').click();await document.querySelector('[data-approve="dai"]').onclick();
 await document.querySelector('[data-add-asset]').onclick();const form=document.querySelector('dialog form');assert.deepEqual(options(form.elements.assetId),['','usd-coin','dai']);
 form.elements.assetId.value='dai';form.elements.assetId.onchange();assert.equal(form.querySelector('[data-included-networks]').textContent,'Ethereum');
 assert.equal(catalogueReads,3,'each approval must reload the verified catalogue rather than inventing a local verification timestamp');
 assert.equal(calls.filter(c=>c.path==='crypto/wallet').length,1,'updating available options must preserve the active receiving route');
 assert.equal(calls.filter(c=>c.path==='crypto/activate').length,0);
});


test('admin can remove and restore a single wallet card without touching its original address or account fields',async()=>{
 const ag=holding('AG',{account_id:'00000000-0000-4000-8000-000000000071',asset_id:'avis-green',address_id:'71',public_address:'original-ag',wallet_visible:true});
 const agi=holding('AGi',{account_id:'00000000-0000-4000-8000-000000000072',asset_id:'avis-green-investment',address_id:'72',public_address:'original-agi',wallet_visible:true});
 const views={cryptowallets:[ag,agi]};
 const originalAg={...ag};
 const originalAgi={...agi};
 const actions=[];
 await mount(views,()=>{},async(path,input)=>{
  actions.push({path,input});
  if(path==='crypto/wallet/visibility'){
   const row=views.cryptowallets.find(w=>w.account_id===input.accountId);
   row.wallet_visible=input.visible;
   return {accountId:row.account_id,visible:row.wallet_visible};
  }
  throw new Error('Unexpected action '+path);
 },()=>({admin:true,customerUserId:null}));
 const remove=document.querySelector('[data-wallet="00000000-0000-4000-8000-000000000071"] [data-archive-wallet]');
 assert.ok(remove);
 remove.click();await flush();await flush();
 assert.equal(document.querySelector('[data-wallet="00000000-0000-4000-8000-000000000071"]'),null);
 assert.ok(document.querySelector('[data-wallet="00000000-0000-4000-8000-000000000072"]'));
 const restore=document.querySelector('[data-restore-wallet="00000000-0000-4000-8000-000000000071"]');
 assert.ok(restore);
 restore.click();await flush();await flush();
 assert.ok(document.querySelector('[data-wallet="00000000-0000-4000-8000-000000000071"]'));
 assert.equal(views.cryptowallets[0].public_address,originalAg.public_address);
 assert.equal(views.cryptowallets[1].public_address,originalAgi.public_address);
 assert.equal(views.cryptowallets[0].available_balance,originalAg.available_balance);
 assert.deepEqual(actions.map(a=>a.input.visible),[false,true]);
});
test('the registered AVISPay PLC share converter is visible without asserting a completed chain issuance',async()=>{
 const share={card_id:'a0000000-0000-4000-8000-000000000001',name:'AVISPay PLC',symbol:'aAVISP',mode:'DEMO',state:'DRAFT',token_quantity:'0',dossier:{assetType:'STOCK',issuedVolume:'100000000',assetValue:'100000000',currency:'CHF',faceValue:'1',marginHaircutBps:1500,tradingFeeBps:10},actions:[]};
 await mount({cryptosecurities:[share],treasurypositions:[{asset_code:'AVISPAY-PLC-SHARES',quantity:'100000000',source_reference:'AVISPAY-PLC-EXISTING-SHARES'}]},()=>{},()=>{},()=>({admin:true,customerUserId:null}));
 assert.match(document.querySelector('.crypto-stock-register').textContent,/100,000,000 registered shares/);
 assert.equal(document.querySelector('[data-security="'+share.card_id+'"] strong').textContent,'AVISPay PLC');
 assert.ok(document.querySelector('[data-stock-convert]'));
});
