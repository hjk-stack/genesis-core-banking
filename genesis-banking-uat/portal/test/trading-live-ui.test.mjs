import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createExecutionActivity,mountRobotInstructions,mountTradingLive} from '../public/trading-live.mjs';
import {mountIndexAdvice} from '../public/index-advice.mjs';

const first={robotId:'10000000-0000-4000-8000-000000000001',name:'Treasury W',venue:'AVIS',symbol:'aAVISP',baseAsset:'aAVISP',quoteAsset:'CHF'},second={robotId:'10000000-0000-4000-8000-000000000002',name:'Spot W',venue:'BINANCE',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT'};
const instructions=JSON.stringify({maxNotional:'1000',dailyNotional:'10000',maxLoss:'1000',minimumIndex:0,trailingBps:50,notes:'Use the recorded strategy.'},null,2);
const policy=(profile=first,extra={})=>({robotId:profile.robotId,version:2,instructionVersion:1,instructions,updatedAt:'2026-11-15T20:00:00Z',...extra});
const windows=[],controllers=[];
afterEach(()=>{controllers.splice(0).forEach(controller=>controller?.close());windows.splice(0).forEach(dom=>dom.window.close());});
function setup(){const dom=new JSDOM('<!doctype html><main><div id="host"></div><div id="evidence"></div></main>',{url:'https://bank.invalid'});windows.push(dom);return dom.window.document.querySelector('#host');}
const deferred=()=>{let resolve,reject;return {promise:new Promise((yes,no)=>{resolve=yes;reject=no;}),resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const mount=(host,api,options={})=>{const controller=mountRobotInstructions({host,api,...options});controllers.push(controller);return controller;};
const submit=host=>host.querySelector('form').onsubmit({preventDefault(){}});
const fill=(id,side='BUY',extra={})=>({id,orderId:'order-'+id,side,quantity:'0.123456789012345678',price:'100.25',quoteValue:'12.3765431984876542195',fees:[{asset:'BNB',amount:'0.000000000000000001'}],executedAt:null,recordedAt:new Date().toISOString(),evidence:'VENUE_FILL',...extra});
const liveData=(profile=first,extra={})=>({schemaVersion:1,observedAt:new Date().toISOString(),profiles:[{...first,enabled:false,testReviewed:false},{...second,enabled:false,testReviewed:false}],selectedRobotId:profile.robotId,market:{provider:'CoinAPI',symbolId:profile.symbol,baseAsset:profile.baseAsset,quoteAsset:profile.quoteAsset,quote:{bid:'100.123456789012345678',ask:'101.123456789012345678',bidSize:'5.123456789012345678',askSize:'6',exchangeTime:new Date().toISOString(),providerTime:new Date().toISOString(),receivedAt:new Date().toISOString(),ageMs:0,sourceDelayMs:0,stale:false},trades:[],connection:{state:'OPEN',lastMessageAt:new Date().toISOString(),errorCode:null}},audit:{coverage:{scope:'ALL_RECORDED_ORDERS',complete:true,totalOrders:2,ordersIncluded:2},orders:[{id:'order-1',side:'BUY',status:'SETTLED',requestedQuantity:'1',executedQuantity:'0.123456789012345678',quoteValue:'12.3765431984876542195',averagePrice:'100.25',createdAt:new Date().toISOString(),recordedAt:new Date().toISOString(),executedAt:null}],fills:[fill('fill-1')],totals:{baseVolume:'1234.123456789012345678',quoteVolume:'120001.123456789012345678',buyQuantity:'1234',sellQuantity:'0.123456789012345678',executedOrders:2,fees:[{asset:'BNB',amount:'0.000000000000000001'},{asset:'CHF',amount:'1.2'}],recordedRealisedPnl:'12.123456789012345678',knownFeeAdjustedPnl:'12.123456789012345678',grossRealisedPnl:null,netRealisedPnl:null,netPnlComplete:false,unpricedFeeAssets:['BNB'],positionQuantity:'1233.876543210987654322',costBasis:'100000.123',unrealisedPnl:null},reconciliation:{positionMatches:true,costBasisMatches:true,realisedPnlMatches:true},issues:[]},liquidity:null,...extra});
async function liveMount(host,api,options={}){const controller=await mountTradingLive({host,api,pollMs:0,...options});controllers.push(controller);return controller;}

test('robot activity only follows new recent actual fills and never restarts on duplicate polls',()=>{
 const now=Date.parse('2026-11-15T20:00:00Z'),activity=createExecutionActivity(),fill=(id,side='BUY',extra={})=>({id,side,quantity:'0.000000000000000001',recordedAt:new Date(now).toISOString(),executedAt:null,...extra});
 assert.equal(activity.observe(first.robotId,[fill('existing')],now),null);
 assert.equal(activity.observe(first.robotId,[fill('existing')],now+1000),null);
 assert.equal(activity.observe(first.robotId,[fill('new-buy'),fill('existing')],now+1000)?.side,'BUY');
 assert.equal(activity.observe(first.robotId,[fill('new-buy'),fill('existing')],now+2000),null);
 assert.equal(activity.observe(first.robotId,[fill('new-sell','SELL'),fill('new-buy')],now+2000)?.side,'SELL');
 assert.equal(activity.observe(first.robotId,[fill('zero','SELL',{quantity:'0'}),fill('old','BUY',{executedAt:new Date(now-60000).toISOString()}),fill('future','BUY',{executedAt:new Date(now+60000).toISOString()})],now),null);
 assert.equal(activity.observe(second.robotId,[fill('new-buy')],now),null,'selecting another robot establishes its own baseline');
 assert.equal(activity.observe(first.robotId,[fill('new-buy')],now),null,'switching back cannot replay an already observed execution');
});

test('bounded activity history keeps still-visible fills without replaying them after pruning',()=>{
 const now=Date.now(),activity=createExecutionActivity({maxSeen:2}),fills=Array.from({length:5},(_,index)=>({id:'fill-'+index,side:'BUY',quantity:'1',recordedAt:new Date(now).toISOString()}));
 activity.observe(first.robotId,[],now);assert.ok(activity.observe(first.robotId,fills,now));assert.equal(activity.observe(first.robotId,fills,now+1000),null);
});

test('robot instructions require a selected saved profile and persist exact versioned execution settings',async()=>{
 const host=setup(),calls=[],saved=[];const controller=mount(host,async(path,input,key)=>{calls.push({path,input,key});return input?policy(first,{version:3,instructionVersion:2,instructions:input.instructions,enabled:false}):policy();},{onSaved:async result=>saved.push(result)});
 assert.equal(host.querySelector('textarea').disabled,true);assert.equal(calls.length,0);await controller.select(first);
 assert.equal(host.querySelector('textarea').value,instructions);assert.equal(host.querySelector('[data-robot-instruction-version]').textContent,'Saved instructions v1 · configuration v2');
 const edited=JSON.parse(instructions);edited.maxNotional='250.123456789012345678';edited.notes='<script>bad()</script>';host.querySelector('textarea').value=JSON.stringify(edited,null,2);await submit(host);
 assert.deepEqual(calls[0],{path:'crypto/trading/robot-instructions?robotId='+first.robotId,input:undefined,key:undefined});
 const write=calls[1];assert.equal(write.path,'crypto/trading/robot-instructions');assert.equal(write.input.robotId,first.robotId);assert.equal(write.input.expectedVersion,2);assert.equal(JSON.parse(write.input.instructions).maxNotional,'250.123456789012345678');assert.match(write.key,/^[a-f0-9-]{36}$/);
 assert.equal(saved.length,1);assert.equal(saved[0].enabled,false);assert.equal(host.querySelector('script'),null);assert.match(host.textContent,/entries paused/);assert.equal(calls.some(call=>/toggle|order/.test(call.path)),false);
});

test('first robot instruction save reports unsaved state and persists existing controls without creating trading orders',async()=>{
 const host=setup(),calls=[];
 const controller=mount(host,async(path,input,key)=>{
  calls.push({path,input,key});
  return input?policy(first,{version:3,instructionVersion:1,instructions:input.instructions,enabled:false}):policy(first,{instructionVersion:0,updatedAt:null});
 });
 await controller.select(first);
 assert.equal(host.querySelector('[data-robot-instruction-version]').textContent,'Not saved · configuration v2');
 assert.equal(host.querySelector('[type=submit]').textContent,'Save first instruction version');
 assert.match(host.querySelector('[data-robot-instruction-saved]').textContent,/Current execution settings loaded/);
 assert.equal(host.querySelector('textarea').value,instructions);
 await submit(host);
 assert.equal(calls.filter(c=>c.path==='crypto/trading/robot-instructions').length,1);
 assert.equal(calls.find(c=>c.input)?.input.instructions,instructions);
 assert.equal(host.querySelector('[data-robot-instruction-version]').textContent,'Saved instructions v1 · configuration v3');
 assert.equal(host.querySelector('[type=submit]').textContent,'Save robot instructions');
 assert.match(host.querySelector('[data-robot-instruction-saved]').textContent,/Saved instruction version 1/);
 assert.equal(calls.some(c=>/toggle|order/.test(c.path)),false);
});

test('instruction failures remain beside the editor and identical retries keep their key',async()=>{
 const host=setup(),keys=[];const controller=mount(host,async(path,input,key)=>{if(input){keys.push(key);throw Error('The current instruction version changed.');}return policy();});await controller.select(first);
 host.querySelector('textarea').value='Buy every asset';await submit(host);assert.equal(keys.length,0);assert.match(host.querySelector('[data-robot-instruction-error]').textContent,/JSON execution settings/);
 host.querySelector('textarea').value=instructions;await submit(host);await submit(host);assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(host.querySelector('[data-robot-instruction-error]').textContent,'The current instruction version changed.');assert.equal(host.querySelector('textarea').value,instructions);assert.equal(host.querySelector('button').disabled,false);
});

test('instruction profile switches clear old values and reject out-of-order private reads and saves',async()=>{
 const host=setup(),slow=deferred(),save=deferred();let current=true,saved=0;
 const controller=mount(host,async(path,input)=>input?save.promise:path.endsWith(first.robotId)?slow.promise:policy(second),{isCurrent:()=>current,onSaved:async()=>saved++});
 const old=controller.select(first);assert.equal(host.querySelector('textarea').value,'');assert.equal(host.querySelector('textarea').disabled,true);await controller.select(second);slow.resolve(policy());await old;
 assert.match(host.querySelector('[data-robot-instruction-profile]').textContent,/Spot W/);const submitting=submit(host);assert.equal(host.querySelector('textarea').disabled,true);current=false;host.textContent='Customer accounts';save.resolve(policy(second,{version:3,enabled:false}));await submitting;assert.equal(host.textContent,'Customer accounts');assert.equal(saved,0);
});

test('INDEX instruction field can share a two-column row while escaped event evidence stays full width',async()=>{
 const host=setup(),detailsHost=host.ownerDocument.querySelector('#evidence');await mountIndexAdvice({host,detailsHost,api:async path=>path==='crypto/trading/index-policy'?{policyVersion:1,instructions:'Use official sources.',taxonomy:[{id:'EQ01',label:'Major contracts'}]}:{rows:[{state:'ACTIVE',signal_id:'event-1',payload:{issuer_or_asset_name:'<script>bad()</script>',event_category:'EQ01',proposed_action:'WATCH',evidence_summary:'Recorded source evidence.',source_urls:['https://issuer.example/report']}}]}});
 assert.equal(host.querySelectorAll('textarea').length,1);assert.equal(host.querySelector('.index-candidates'),null);assert.equal(detailsHost.querySelectorAll('.index-candidates article').length,1);assert.equal(detailsHost.querySelector('script'),null);assert.match(detailsHost.textContent,/Recorded source evidence/);assert.equal(host.querySelectorAll('form').length,1);
});

test('live view renders actual quote precision and separately denominated fees without inventing net profit',async()=>{
 const host=setup(),calls=[];await liveMount(host,async(path,input)=>{calls.push({path,input});return liveData();});
 assert.match(host.querySelector('[data-live-quote]').textContent,/100\.123456789012345678 CHF/);assert.match(host.querySelector('[data-live-quote]').textContent,/5\.123456789012345678 aAVISP/);
 assert.match(host.querySelector('[data-live-audit]').textContent,/1,234\.123456789012345678 aAVISP/);assert.match(host.querySelector('[data-live-audit]').textContent,/0\.000000000000000001 BNB · 1\.2 CHF/);assert.match(host.querySelector('[data-live-audit]').textContent,/Net realised profit—/);assert.match(host.querySelector('[data-live-audit]').textContent,/Fees awaiting quote-currency valuation: BNB/);
 assert.equal(host.querySelector('[data-robot-activity]').dataset.robotActivity,'','initial historical fills do not animate');assert.equal(host.querySelector('[data-live-samples]').textContent,'1 recorded quote in this view');assert.equal(host.querySelectorAll('.trading-robot-art').length,1);assert.deepEqual(calls,[{path:'crypto/trading/live',input:undefined}]);
});

test('percentage-quoted securities retain percent prices and currency-denominated execution values',async()=>{
 const host=setup(),data=liveData();data.market.quote.bid='98.123456789012345678';data.market.quote.ask='99.123456789012345678';data.liquidity={kind:'AVIS_ORDER_BOOK',quoteBasis:'PERCENT',denomination:'1000',securityId:'bond-1',baseAsset:first.baseAsset,quoteAsset:first.quoteAsset,totalOrders:0,lots:[],securityTokens:[]};await liveMount(host,async()=>data);
 assert.match(host.querySelector('[data-live-quote]').textContent,/98\.123456789012345678 %/);assert.match(host.querySelector('[data-live-quote]').textContent,/99\.123456789012345678 %/);assert.doesNotMatch(host.querySelector('[data-live-quote]').textContent,/98\.123456789012345678 CHF/);assert.match(host.querySelector('[data-live-audit]').textContent,/120,001\.123456789012345678 CHF/);assert.match(host.querySelector('[data-live-audit]').textContent,/Recorded realised P&L12\.123456789012345678 CHF/);
});

test('rapid live profile switches clear prior account data and cannot install out-of-order markets',async()=>{
 const host=setup(),slow=deferred(),fast=deferred(),calls=[];let count=0;
 await liveMount(host,async path=>{calls.push(path);return ++count===1?liveData():path.endsWith(second.robotId)?slow.promise:fast.promise;});const selector=host.querySelector('[data-live-profile]');
 selector.value=second.robotId;const older=selector.onchange();assert.equal(host.querySelector('[data-live-quote]').textContent,'Bid—Ask—Bid size—Ask size—');assert.equal(host.querySelector('[data-focus-execution]').disabled,true);assert.equal(host.querySelectorAll('[data-live-executions] tbody tr').length,0);
 selector.value=first.robotId;const newer=selector.onchange();const latest=liveData();latest.market.quote.bid='102.5';fast.resolve(latest);await newer;slow.resolve(liveData(second));await older;
 assert.equal(selector.value,first.robotId);assert.match(host.querySelector('[data-live-symbol]').textContent,/aAVISP · AVIS/);assert.match(host.querySelector('[data-live-quote]').textContent,/102\.5 CHF/);assert.doesNotMatch(host.querySelector('[data-live-quote]').textContent,/USDT/);assert.deepEqual(calls,['crypto/trading/live','crypto/trading/live?robotId='+second.robotId,'crypto/trading/live?robotId='+first.robotId]);
});

test('robot buy/sell filters and focus inspect actual executions without any order or toggle request',async()=>{
 const host=setup(),calls=[],data=liveData();data.audit.fills=[fill('sell-2','SELL'),fill('buy-1','BUY')];await liveMount(host,async(path,input)=>{calls.push({path,input});return data;});
 host.querySelector('[data-live-side=BUY]').click();assert.equal(host.querySelectorAll('[data-live-executions] tbody tr').length,1);assert.match(host.querySelector('[data-live-executions] tbody').textContent,/BUY/);assert.equal(host.querySelector('[data-live-side=BUY]').getAttribute('aria-pressed'),'true');
 host.querySelector('[data-live-side=SELL]').click();assert.equal(host.querySelectorAll('[data-live-executions] tbody tr').length,1);assert.match(host.querySelector('[data-live-executions] tbody').textContent,/SELL/);
 host.querySelector('[data-focus-execution]').click();assert.equal(host.querySelectorAll('[data-live-executions] tbody tr').length,2);assert.equal(host.ownerDocument.activeElement.dataset.executionId,'sell-2');assert.equal(calls.length,1);assert.equal(calls.some(call=>call.input||/order|toggle/.test(call.path)),false);
});

test('a new execution lights its actual arm briefly and duplicate reads do not extend the signal',async()=>{
 const host=setup();let value=liveData();const controller=await liveMount(host,async()=>structuredClone(value));value.audit.fills.unshift(fill('new-sell','SELL'));await controller.refresh();assert.equal(host.querySelector('[data-robot-activity]').dataset.robotActivity,'SELL');
 await new Promise(resolve=>setTimeout(resolve,1000));await controller.refresh();assert.equal(host.querySelector('[data-robot-activity]').dataset.robotActivity,'SELL');await new Promise(resolve=>setTimeout(resolve,950));assert.equal(host.querySelector('[data-robot-activity]').dataset.robotActivity,'');
});

test('empty market and changed owner never fabricate quote, trade activity or private late output',async()=>{
 const host=setup();await liveMount(host,async()=>liveData(first,{market:null,audit:null}));assert.equal(host.querySelector('[data-live-quote]').textContent,'Bid—Ask—Bid size—Ask size—');assert.match(host.querySelector('[data-live-chart]').textContent,/Market observations will appear here/);assert.equal(host.querySelector('[data-focus-execution]').disabled,true);assert.equal(host.querySelector('[data-robot-activity]').dataset.robotActivity,'');
 const other=setup(),waiting=deferred();let current=true;const mounting=liveMount(other,async()=>waiting.promise,{isCurrent:()=>current});current=false;other.textContent='Customer accounts';waiting.resolve(liveData());await mounting;assert.equal(other.textContent,'Customer accounts');
});

test('an actual reference market can be observed without a robot or fabricated execution state',async()=>{
 const host=setup(),data=liveData(second,{profiles:[],selectedRobotId:null,audit:null});data.market.reference=true;data.market.baseAsset='BTC';data.market.quoteAsset='USDT';await liveMount(host,async()=>data);
 assert.equal(host.querySelector('[data-live-symbol]').textContent,'BTC/USDT · Reference market');assert.match(host.querySelector('[data-live-quote]').textContent,/100\.123456789012345678 USDT/);assert.equal(host.querySelector('[data-live-profile]').disabled,true);assert.equal(host.querySelector('[data-focus-execution]').disabled,true);assert.equal(host.querySelector('[data-live-robot-state]').textContent,'—');assert.equal(host.querySelector('[data-robot-activity]').dataset.robotActivity,'');
});

test('entry indication follows both enabled configuration and current reviewed evidence',async()=>{
 const host=setup(),data=liveData();data.profiles[0].enabled=true;const controller=await liveMount(host,async()=>structuredClone(data));assert.equal(host.querySelector('[data-live-robot-state]').textContent,'Entries paused');data.profiles[0].testReviewed=true;await controller.refresh();assert.equal(host.querySelector('[data-live-robot-state]').textContent,'Entries enabled');
});

test('security backing is a separate guarded read with finalized proof and per-asset escrow',async()=>{
 const host=setup(),calls=[],pending=deferred(),data=liveData();data.liquidity={kind:'AVIS_ORDER_BOOK',securityId:'security-1',baseAsset:'aAVISP',quoteAsset:'CHF',totalOrders:1,complete:true,wholeLotsOnly:true,bids:[{price:'100',quantity:'2',quoteValue:'200',orders:1}],asks:[],lots:[{orderId:'lot-1',side:'BUY',price:'100',quantity:'2',quoteValue:'200',reservationConsistent:true,submittedAt:new Date().toISOString()}],reservationBasis:'Cash hold; aggregate reserved securities consistency.',securityTokens:[{cardId:'card-1',name:'AVISPay PLC',network:'ETHEREUM',state:'BOOKED',contractAddress:'0x1111111111111111111111111111111111111111',hubAddress:'0x2222222222222222222222222222222222222222',registeredTokenQuantity:'1000',reservedSourceQuantity:'1000',registeredAt:'2026-11-15T20:00:00Z'}]};
 const controller=await liveMount(host,async path=>{calls.push(path);return path.startsWith('crypto/trading/live/liquidity')?pending.promise:structuredClone(data);});await controller.refresh();assert.equal(calls.some(path=>path.includes('/liquidity')),false,'market polling must not make chain reads');
 const button=host.querySelector('[data-read-backing]'),reading=button.onclick();await button.onclick();assert.equal(calls.filter(path=>path.includes('/liquidity')).length,1,'duplicate security audit clicks are suppressed');
 const proof={schemaVersion:1,robotId:first.robotId,observedAt:'2026-11-15T20:00:50Z',cards:[{cardId:'card-1',name:'AVISPay PLC',symbol:'aAVISP',network:'ETHEREUM',chain:{observedAt:'2026-11-15T20:00:05Z',proof:{finalized:true,canonicalRechecked:true,blockNumber:100,blockHash:'0x'+'a'.repeat(64),blockTime:'2026-11-15T20:00:00Z'},identity:{contractAddress:'0x1111111111111111111111111111111111111111',isin:'CH0000000001'},security:{totalSupply:'1000',custodyCap:'2000',availableTradingPower:'100.123456789012345678',capacityCurrency:'CHF',capacityBasis:'CONFIGURED_COLLATERAL_VALUATION'},settlement:[{asset:'AG',escrow:'1.123456789012345678',accumulatedFees:'0.01',contractBalance:'2',operatorBalance:'3',operatorAllowance:'4',escrowCovered:true},{asset:'AGi',escrow:'5.123456789012345678',accumulatedFees:'0.02',contractBalance:'6',operatorBalance:'7',operatorAllowance:'8',escrowCovered:true}]}}]};pending.resolve(proof);await reading;
 const backing=host.querySelector('[data-live-backing]');assert.ok(backing.querySelector(':scope>p').textContent.includes('Audit response at '+new Date(proof.observedAt).toLocaleString()));assert.equal([...backing.querySelectorAll('dt')].find(element=>element.textContent==='Proof observed').nextElementSibling.textContent,new Date(proof.cards[0].chain.observedAt).toLocaleString());
 assert.match(host.querySelector('[data-live-backing]').textContent,/Finalized checkpointYes/);assert.match(host.querySelector('[data-live-backing]').textContent,/Configured collateral valuation/);assert.match(host.querySelector('[data-live-backing]').textContent,/1\.123456789012345678/);assert.match(host.querySelector('[data-live-backing]').textContent,/5\.123456789012345678/);assert.equal(host.querySelectorAll('[data-live-backing] tbody tr').length,2);
 await controller.refresh();assert.equal(calls.filter(path=>path.includes('/liquidity')).length,1);assert.match(host.querySelector('[data-live-backing]').textContent,/Finalized checkpointYes/);data.liquidity.securityTokens[0].contractAddress='0x3333333333333333333333333333333333333333';await controller.refresh();assert.equal(host.querySelector('[data-live-backing]').textContent,'','changed contract binding clears the old proof without making another chain call');
});

test('a delayed security audit cannot populate a different selected robot',async()=>{
 const host=setup(),pending=deferred(),data=liveData();data.liquidity={kind:'AVIS_ORDER_BOOK',securityId:'security-1',totalOrders:0,lots:[],securityTokens:[{cardId:'card-1',contractAddress:'token',hubAddress:'hub'}]};let switched=false;
 await liveMount(host,async path=>path.startsWith('crypto/trading/live/liquidity')?pending.promise:switched?liveData(second):structuredClone(data));const reading=host.querySelector('[data-read-backing]').onclick();switched=true;const selector=host.querySelector('[data-live-profile]');selector.value=second.robotId;await selector.onchange();pending.resolve({schemaVersion:1,robotId:first.robotId,cards:[{name:'Old private security',network:'ETHEREUM',chain:null,errorCode:'old-error'}]});await reading;assert.equal(host.querySelector('[data-live-backing]').textContent,'');assert.doesNotMatch(host.textContent,/Old private security/);
});
