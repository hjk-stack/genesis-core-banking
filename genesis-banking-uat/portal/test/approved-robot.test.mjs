import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {tradeCandles,observedDepth,reviewedExchangeIntent,installApprovedRobot,CANDLE_INTERVALS,formatted} from '../public/approved-robot.mjs';
import {mountTradingLive} from '../public/trading-live.mjs';
const windows=[],controllers=[];
afterEach(()=>{controllers.splice(0).forEach(c=>c?.close());windows.splice(0).forEach(w=>w.close());});
const trade=(id,second,price,quantity='1')=>({id,exchangeTime:'2026-11-17T14:16:'+String(second).padStart(2,'0')+'.000Z',price:String(price),quantity});
const profile={robotId:'10000000-0000-4000-8000-000000000001',name:'AVIS treasury',venue:'AVIS',symbol:'aAVISP',baseAsset:'aAVISP',quoteAsset:'CHF',enabled:false,testReviewed:true};
const snapshot=()=>({schemaVersion:1,observedAt:new Date().toISOString(),selectedRobotId:profile.robotId,profiles:[profile],market:{provider:'AVIS',symbolId:'aAVISP',baseAsset:'aAVISP',quoteAsset:'CHF',connection:{state:'OPEN'},quote:{bid:'100',ask:'101',bidSize:'5',askSize:'6',stale:false,receivedAt:new Date().toISOString()},trades:[trade('a',1,100),trade('b',2,102)]},audit:{orders:[],fills:[],totals:{baseVolume:'0',netRealisedPnl:null,executedOrders:0,fees:[]},reconciliation:{},issues:[]},liquidity:null});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('owner robot artwork is exactly the uploaded JPEG',async()=>{
 const bytes=await readFile(new URL('../public/crypto-icons/robot-approved.jpg',import.meta.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'085f7dee99acb6ee9b15f34f42642bc53f269b5aad03a8b09d854cf2af0b9fa1');
});
test('observed trades produce OHLC and volume, not invented historical bars',()=>{
 const a=trade('a',1,100,'2'),b=trade('b',30,103,'3'),c=trade('c',40,99,'1');
 assert.deepEqual(tradeCandles([c,b,a,a],'1m'),[{stamp:Date.parse('2026-11-17T14:16:00Z'),open:100,high:103,low:99,close:99,volume:6,count:3}]);
 assert.deepEqual(tradeCandles([], '1m'),[]);assert.deepEqual(tradeCandles([{price:'100',quantity:'1'},trade('x',1,-1),trade('y',2,2,'0')]),[]);
 assert.throws(()=>tradeCandles([], '3m'),/Unsupported/);assert.equal(Object.keys(CANDLE_INTERVALS).length,6);
});
test('identical anonymous trades remain distinct and interval buttons change aggregation',()=>{
 const a=trade(undefined,1,100);assert.equal(tradeCandles([a,{...a}],'1m')[0].count,2);
 const rows=[trade('a',1,100),{...trade('b',1,101),exchangeTime:'2026-11-17T14:17:01Z'}];
 assert.equal(tradeCandles(rows,'1m').length,2);assert.equal(tradeCandles(rows,'5m').length,1);
});
test('depth contains only published levels and no synthetic liquidity',()=>{
 assert.deepEqual(observedDepth({market:{quote:{bid:'100',ask:'101',bidSize:'2',askSize:'3'}}}),{bids:[{price:100,quantity:2}],asks:[{price:101,quantity:3}],basis:'Published top of book'});
 assert.deepEqual(observedDepth({market:{quote:{bid:'100',ask:'101',bidSize:'0',askSize:null}}}).bids,[]);
 const book=observedDepth({liquidity:{kind:'AVIS_ORDER_BOOK',bids:[{price:'98',quantity:'1'},{price:'99',quantity:'2'}],asks:[{price:'102',quantity:'1'},{price:'101',quantity:'1'}]}});
 assert.deepEqual(book.bids.map(x=>x.price),[99,98]);assert.deepEqual(book.asks.map(x=>x.price),[101,102]);
});
test('buy and sell prepare exact registered instrument intents without transmitting an order',()=>{
 assert.equal(reviewedExchangeIntent(profile,'BUY'),'#exchange?side=BUY&symbol=AAVISP');
 assert.equal(reviewedExchangeIntent(profile,'SELL'),'#exchange?side=SELL&symbol=AAVISP');
 assert.equal(reviewedExchangeIntent({...profile,venue:'BINANCE'},'BUY'),null);
 assert.equal(reviewedExchangeIntent({...profile,symbol:'<script>'},'BUY'),null);
 assert.equal(reviewedExchangeIntent(profile,'TRANSFER'),null);
});
test('approved terminal moves existing trading controls without modifying wallet controls, funds or order APIs',async()=>{
 const dom=new JSDOM('<main><div data-wallets><button id="receive">Receive AG</button></div><section class="crypto-trading-desk"><div data-trading-panel><div id="host"></div></div></section></main>',{url:'https://bank.invalid'});windows.push(dom.window);
 const host=dom.window.document.querySelector('#host'),wallet=dom.window.document.querySelector('#receive'),data=snapshot(),calls=[],intents=[];
 let receives=0,configure=0;wallet.onclick=()=>receives++;
 const markets=['BTC','ETH','SOL','XRP','AG','AGi'].map(code=>({currency_code:code,market_data:{usd:'100',change24h:1,observedAt:new Date().toISOString()}}));
 const api=async(path,body)=>{calls.push({path,body});if(path==='views/cryptomarkets')return {rows:markets};if(path.startsWith('crypto/trading/live'))return data;if(path==='crypto/trading/toggle'){data.profiles=[{...profile,enabled:body.enabled}];return {enabled:body.enabled};}throw Error('Unexpected API: '+path);};
 const skin=installApprovedRobot({host,api,onConfigure:()=>configure++,onOrder:x=>intents.push(x)});controllers.push(skin);
 const pending=mountTradingLive({host,api,pollMs:0,onSnapshot:x=>skin.update(x)});skin.mount();controllers.push(await pending);await tick();
 assert.equal(host.querySelector('.ar-robot-image').getAttribute('src'),'/crypto-icons/robot-approved.jpg');
 assert.equal(host.querySelectorAll('.ar-robot-image').length,1);skin.mount();assert.equal(host.querySelectorAll('.ar-robot-image').length,1);
 assert.equal(dom.window.document.querySelector('#receive'),wallet);wallet.click();assert.equal(receives,1);
 assert.equal(host.querySelector('[data-trading-buy]').closest('.terminal-price-screen')!==null,true);
 for(const name of ['Depth','Trades','Info','Chart']){host.querySelector('[data-ar-tab="'+name+'"]').click();assert.equal(host.querySelector('[data-ar-tab="'+name+'"]').getAttribute('aria-selected'),'true');}
 host.querySelector('[data-ar-period="1m"]').click();assert.match(host.querySelector('[data-ar-candles] svg').getAttribute('aria-label'),/^1m/);
 host.querySelector('[data-trading-buy]').click();host.querySelector('[data-trading-sell]').click();assert.deepEqual(intents.map(x=>x.side),['BUY','SELL']);
 assert.equal(calls.some(x=>x.body&&/order|transfer|activate/.test(x.path)),false);
 const toggle=host.querySelector('[data-trading-auto]');toggle.checked=true;await toggle.onchange({target:toggle});assert.equal(calls.find(x=>x.path==='crypto/trading/toggle').body.robotId,profile.robotId);
 assert.equal(host.querySelectorAll('.ar-ticker-copy:first-child .ar-market').length,7);assert.match(host.querySelector('[data-active-market-quote]').textContent,/aAVISP \/ CHF/);
 host.querySelector('[data-ar-expand]').click();assert.ok(host.querySelector('.ar-expanded'));host.querySelector('[data-ar-collapse]').click();assert.equal(host.querySelector('.ar-expanded'),null);
 controllers.at(-1).close();skin.close();data.profiles=[];data.selectedRobotId=null;const fresh=installApprovedRobot({host,api,onConfigure:()=>configure++});controllers.push(fresh);const opening=mountTradingLive({host,api,pollMs:0,onSnapshot:x=>fresh.update(x)});fresh.mount();controllers.push(await opening);host.querySelector('[data-trading-buy]').click();assert.equal(configure,1);
 assert.equal(host.querySelector('[data-trading-auto]').disabled,true);
});
test('layout is isolated to the trading terminal and preserves a usable horizontal tablet board',async()=>{
 const css=await readFile(new URL('../public/approved-robot.css',import.meta.url),'utf8');
 assert.equal(formatted('10000000000.123456789012345678'),'10,000,000,000.123456789012345678');assert.equal(formatted('0.000000000000000001'),'0.000000000000000001');
 assert.match(css,/min-width:1010px/);assert.match(css,/overflow-x:auto/);assert.match(css,/prefers-reduced-motion/);assert.doesNotMatch(css,/\.crypto-wallet\s*\{/);
});
