import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountTradingTesting,validateReplayDataset} from '../public/trading-testing.mjs';
import {mountTradingPanel} from '../public/trading-panel.mjs';

const ROBOT='10000000-0000-4000-8000-000000000001',PAUSED='10000000-0000-4000-8000-000000000002',RUN='20000000-0000-4000-8000-000000000001',HASH='a'.repeat(64),NOW='2026-11-15T20:00:00.000Z';
const copy=value=>structuredClone(value);
const dataset={ticks:[{tsMicros:1000000,bid:99,ask:100,bidSize:5,askSize:6,sellVolume:0},{tsMicros:2000000,bid:100,ask:101,bidSize:4,askSize:5,sellVolume:1}],indices:[{atMicros:1000000,index:{instrumentId:'BTC',score:10,confidence:.8,sourceCount:2,generatedAtMs:1000,validUntilMs:3000,sequence:'replay-1'}}]};
const profile={robotId:ROBOT,name:'Treasury W-effect',venue:'AVIS',symbol:'aAVISP',configurationHash:HASH,reviewedRunId:null,testReviewed:false};
const report={schemaVersion:1,engine:'NautilusTrader',engineVersion:'1.231.0',mode:'REPLAY',status:'PASSED',complete:true,checks:[{id:'flat',label:'Closed position',passed:true,detail:'Buy and sell fills are recorded.'}],metrics:{initialCash:'10000',finalCash:'10001.000000000000000001',finalEquity:'10001.000000000000000001',finalPosition:'0',costBasis:'0',realisedPnl:'1.000000000000000001',unrealisedPnl:'0',fees:'0.2',drawdown:'0.1',drawdownFraction:'0.00001',buyFills:1,sellFills:1,filledOrders:2,ticksProcessed:250,indexObservationsUsed:1,ordersGenerated:2,rejectedOrders:0,partialFills:0,openOrders:0,duplicateSignalsIgnored:0},orders:[{id:'virtual-order',signalId:'signal-1',tsMicros:1000000,side:'BUY',requestedQuantity:'1',limitPrice:'100',filledQuantity:'1',status:'FILLED',reason:null,type:'LIMIT',timeInForce:'IOC'}],fills:[{orderId:'virtual-order',tsMicros:1000000,side:'BUY',quantity:'1',price:'100',notional:'100',fee:'0.1',cashAfter:'9899.9',positionAfter:'1'}],assumptions:{referenceSettings:{initialCash:'10000',feeBps:10,slippageBps:5}}};
const run=overrides=>({runId:RUN,robotId:ROBOT,profileName:profile.name,mode:'REPLAY',status:'PASSED',configurationHash:HASH,engineFingerprint:HASH,datasetHash:HASH,createdAt:NOW,startedAt:NOW,completedAt:NOW,errorCode:null,report:copy(report),reviewEligible:true,reviewedAt:null,...overrides});
const metadata=overrides=>({engine:{name:'NautilusTrader',version:'1.231.0',fingerprint:HASH},profiles:[copy(profile)],runs:[],limits:{maxTicks:10000,maxIndices:10000,maxInputBytes:2097152,maxReportBytes:2097152},...overrides});
const deferred=()=>{let resolve,reject;return {promise:new Promise((yes,no)=>{resolve=yes;reject=no;}),resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<30;i++){if(predicate())return;await tick();}assert.ok(predicate(),'asynchronous UI update did not complete');}
const windows=[],controllers=[];
afterEach(()=>{for(const controller of controllers.splice(0))controller?.close();for(const dom of windows.splice(0))dom.window.close();});
function setup(){const dom=new JSDOM('<!doctype html><main><div id="host"></div></main>',{url:'https://bank.invalid'});windows.push(dom);return dom.window.document.querySelector('#host');}
async function mount(host,api,options={}){const controller=await mountTradingTesting({host,api,...options});controllers.push(controller);return controller;}
const formAt=host=>host.querySelector('[data-trading-test-form]');
const submit=host=>formAt(host).onsubmit({preventDefault(){}});
function mode(host,value){formAt(host).elements.mode.value=value;formAt(host).elements.mode.onchange();}
async function upload(host,value=dataset,options={}){const input=formAt(host).elements.replay,source=typeof value==='string'?value:JSON.stringify(value);Object.defineProperty(input,'files',{configurable:true,value:[{name:'replay.json',size:Buffer.byteLength(source),text:async()=>source,...options}]});return input.onchange();}
function panelApi(state,calls,custom=async()=>undefined){return async(path,input,key)=>{
 calls.push({path,input,key});const response=await custom(path,input,key);if(response!==undefined)return response;
 if(path==='crypto/trading/testing')return copy(state.value);
 if(path==='crypto/trading/index-policy')return {policyVersion:1,instructions:'Use exact evidence.',taxonomy:[]};
 if(path==='views/tradingengine')return {rows:[{ready:true,startedAt:NOW}]};
 if(path==='views/tradingrobots')return {rows:[{robot_id:ROBOT,name:'Treasury W-effect',venue:'AVIS',symbol:'aAVISP',enabled:false},{robot_id:PAUSED,name:'Existing active robot',venue:'AVIS',symbol:'AG',enabled:true}]};
 return {rows:[]};
};}

test('customers do not mount or fetch the Trading tests back office',async()=>{
 const host=setup(),calls=[];await mountTradingPanel({host,isAdmin:false,api:async path=>{calls.push(path);throw Error('private read');}});
 assert.equal(host.innerHTML,'');assert.deepEqual(calls,[]);
 await mount(host,async()=>{throw Error('private read');},{isCurrent:()=>false});assert.equal(host.innerHTML,'');
});

test('general acceptance runs with fixed virtual funds and no robot or live API',async()=>{
 const host=setup(),calls=[];let value=metadata({profiles:[]});
 await mount(host,async(path,input,key)=>{calls.push({path,input,key});if(path==='views/tradingengine')return {rows:[{ready:false}]};if(path==='crypto/trading/tests'){value=metadata({profiles:[],runs:[run({robotId:null,profileName:null,mode:'ACCEPTANCE',reviewEligible:false,report:{...copy(report),mode:'ACCEPTANCE'}})]});return {runId:RUN,status:'QUEUED'};}return copy(value);});
 const form=formAt(host);assert.equal(form.elements.initialCash.disabled,true);assert.equal(form.elements.feeBps.disabled,true);assert.equal(form.elements.slippageBps.disabled,true);
 form.elements.initialCash.value='500';form.elements.feeBps.value='0';form.elements.slippageBps.value='0';await submit(host);
 const writes=calls.filter(call=>call.input);assert.equal(writes.length,1);assert.equal(writes[0].path,'crypto/trading/tests');assert.deepEqual(writes[0].input,{mode:'ACCEPTANCE',initialCash:'10000',feeBps:10,slippageBps:5});assert.match(writes[0].key,/^[a-f0-9-]{36}$/);
 assert.equal(host.querySelector('[data-test-result]').textContent,'Passed');assert.equal(host.querySelector('[data-review-test]'),null);assert.match(host.textContent,/10,001\.000000000000000001/);assert.match(host.textContent,/NautilusTrader 1\.231\.0/);assert.match(host.textContent,/Engine process readyNo/);assert.equal(form.elements.robotId.options.length,1);
 assert.deepEqual([...new Set(calls.map(call=>call.path))].sort(),['crypto/trading/testing','crypto/trading/tests','views/tradingengine']);
});

test('saved-profile replay review unlocks only a separate live-start action',async()=>{
 const host=setup(),calls=[],state={value:metadata()};let refreshes=0;
 const api=panelApi(state,calls,async(path,input)=>{
  if(path==='crypto/trading/tests'){state.value.runs=[run()];return {runId:RUN,status:'QUEUED'};}
  if(path==='crypto/trading/tests/review'){state.value.profiles[0]={...profile,reviewedRunId:RUN,testReviewed:true};state.value.runs[0].reviewedAt=NOW;return {runId:RUN,robotId:ROBOT,testReviewed:true,reviewedAt:NOW};}
  if(path==='crypto/trading/toggle')return {robotId:input.robotId,enabled:input.enabled};
 });
 await mountTradingPanel({host,api,isAdmin:true,refresh:async()=>{refreshes++;}});await until(()=>host.querySelector('[data-run-test]')?.disabled===false);
 const start=host.querySelector('[data-toggle="'+ROBOT+'"]'),pause=host.querySelector('[data-toggle="'+PAUSED+'"]'),lab=host.querySelector('[data-trading-testing]');
 assert.equal(start.textContent,'Start live trading');assert.equal(start.disabled,true);assert.equal(pause.disabled,false);assert.equal(pause.textContent,'Pause new entries');
 mode(lab,'REPLAY');const form=formAt(lab);form.elements.robotId.value=ROBOT;form.elements.initialCash.value='25000.123';form.elements.feeBps.value='12';form.elements.slippageBps.value='7';assert.equal(form.elements.initialCash.disabled,false);await upload(lab);await submit(lab);
 const request=calls.find(call=>call.path==='crypto/trading/tests');assert.deepEqual(request.input,{robotId:ROBOT,mode:'REPLAY',initialCash:'25000.123',feeBps:12,slippageBps:7,dataset});assert.equal(start.disabled,true);
 lab.querySelector('[data-review-test]').click();await until(()=>start.disabled===false);
 assert.equal(calls.filter(call=>call.path==='crypto/trading/tests/review').length,1);assert.deepEqual(calls.find(call=>call.path==='crypto/trading/tests/review').input,{runId:RUN});assert.equal(calls.filter(call=>call.path==='crypto/trading/toggle').length,0,'review must not call live activation');assert.equal(refreshes,1,'review refreshes the robot cards to reflect paused entries');assert.match(lab.textContent,/Use the separate Start live trading/);
 await start.onclick();assert.deepEqual(calls.find(call=>call.path==='crypto/trading/toggle').input,{robotId:ROBOT,enabled:true});assert.equal(refreshes,2,'live start needs its own user action');
 assert.equal(calls.some(call=>/order|validate-providers/.test(call.path)&&call.input),false);
});

test('missing, failed and refreshed configuration metadata close Start while Pause remains available',async()=>{
 const host=setup(),calls=[],state={value:metadata({profiles:[{...profile,reviewedRunId:RUN,testReviewed:true}]})};let readFailure=false,pending=null;
 const api=panelApi(state,calls,async path=>{if(path==='crypto/trading/testing'){if(readFailure)throw Error('Test review could not be read.');if(pending)return pending.promise;}});
 await mountTradingPanel({host,api,isAdmin:true,refresh:async()=>{}});await until(()=>host.querySelector('[data-toggle="'+ROBOT+'"]')?.disabled===false);
 const start=host.querySelector('[data-toggle="'+ROBOT+'"]'),pause=host.querySelector('[data-toggle="'+PAUSED+'"]'),refresh=host.querySelector('[data-test-refresh]');
 pending=deferred();refresh.click();assert.equal(start.disabled,true);assert.equal(pause.disabled,false);pending.resolve(metadata({profiles:[{...profile,configurationHash:'b'.repeat(64)}]}));pending=null;await until(()=>refresh.disabled===false);assert.equal(start.disabled,true);
 readFailure=true;refresh.click();await until(()=>host.querySelector('[data-test-error]').textContent==='Test review could not be read.');assert.equal(start.disabled,true);assert.equal(pause.disabled,false);await start.onclick();assert.equal(calls.some(call=>call.path==='crypto/trading/toggle'),false);assert.equal(host.querySelectorAll('[role=alert]').length>0,true);
});

test('bounded JSON replay validation rejects unsupported code, URLs, ordering and invalid values',()=>{
 assert.equal(validateReplayDataset(copy(dataset)).ticks.length,2);assert.equal(validateReplayDataset({...copy(dataset),indices:[]}).indices.length,0);
 const cases=[
  {...copy(dataset),url:'https://example.invalid/replay'},
  {...copy(dataset),script:'throw new Error()'},
  {...copy(dataset),indices:undefined},
  {...copy(dataset),ticks:[]},
  {...copy(dataset),ticks:Array.from({length:10001},()=>copy(dataset.ticks[0]))},
  {...copy(dataset),ticks:[{...dataset.ticks[0],bid:true}]},
  {...copy(dataset),ticks:[{...dataset.ticks[0],bid:Infinity}]},
  {...copy(dataset),ticks:[{...dataset.ticks[0],ask:98}]},
  {...copy(dataset),ticks:[{...dataset.ticks[0],receivedAtMicros:null}]},
  {...copy(dataset),ticks:[{...dataset.ticks[0],receivedAtMicros:999999}]},
  {...copy(dataset),ticks:[dataset.ticks[1],dataset.ticks[0]]},
  {...copy(dataset),ticks:[{...dataset.ticks[0],receivedAtMicros:4000000},dataset.ticks[1]]},
  {...copy(dataset),indices:[{atMicros:1000000,index:null}]},
  {...copy(dataset),indices:[{atMicros:1000000,index:{...dataset.indices[0].index,generatedAtMs:1001}}]},
  {...copy(dataset),indices:[{atMicros:1000000,index:{...dataset.indices[0].index,sourceCount:1.5}}]},
  {...copy(dataset),indices:[{atMicros:1000000,index:{...dataset.indices[0].index,sequence:' '}}]}
 ];for(const invalid of cases)assert.throws(()=>validateReplayDataset(invalid),Error);
});

test('invalid and oversized files remain scoped to the lab and never submit a run',async()=>{
 const host=setup(),calls=[];await mount(host,async(path,input)=>{calls.push({path,input});return path==='views/tradingengine'?{rows:[]}:metadata();});mode(host,'REPLAY');
 for(const [source,options,expected]of [['{',{},/valid JSON/],[dataset,{size:2097153},/2 MiB/],[dataset,{name:'run.mjs'},/local JSON/],[{...dataset,url:'https://example.invalid'}, {},/ticks and indices/]]){
  await upload(host,source,options);assert.match(host.querySelector('[data-test-error]').textContent,expected);await submit(host);assert.match(host.querySelector('[data-test-error]').textContent,/Choose a valid local JSON/);
 }
 assert.equal(calls.some(call=>call.input),false);assert.equal(host.querySelectorAll('dialog').length,0);
});

test('newer upload wins over a delayed file read and duplicate submit retains its retry identity',async()=>{
 const host=setup(),calls=[],slowFile=deferred(),slowWrite=deferred();let count=0;
 await mount(host,async(path,input,key)=>{calls.push({path,input,key});if(path==='views/tradingengine')return {rows:[]};if(input){count++;if(count===1)return slowWrite.promise;throw Error('Temporary test submission failure.');}return metadata();});mode(host,'REPLAY');
 const reading=upload(host,dataset,{text:()=>slowFile.promise}),newDataset={...copy(dataset),indices:[]};await upload(host,newDataset);slowFile.resolve(JSON.stringify(dataset));await reading;
 const submitting=submit(host);await submit(host);assert.equal(count,1,'a second click cannot create another run');slowWrite.reject(Error('Temporary test submission failure.'));await submitting;await submit(host);
 const writes=calls.filter(call=>call.input);assert.equal(writes.length,2);assert.equal(writes[0].key,writes[1].key);assert.deepEqual(writes[0].input.dataset,newDataset);assert.deepEqual(writes[1].input.dataset,newDataset);
});

test('out-of-order refresh and changed owner cannot restore stale reports or private eligibility',async()=>{
 const host=setup(),readOne=deferred(),readTwo=deferred(),changes=[];let reads=0,current=true;
 const controller=await mount(host,async path=>{if(path==='views/tradingengine')return {rows:[]};reads++;return reads===1?metadata():reads===2?readOne.promise:readTwo.promise;},{isCurrent:()=>current,onMetadata:value=>changes.push(value)});
 const first=controller.refresh(),second=controller.refresh();readTwo.resolve(metadata({runs:[run({profileName:'Latest result'})]}));await second;readOne.resolve(metadata({runs:[run({profileName:'Old result'})]}));await first;assert.match(host.textContent,/Latest result/);assert.doesNotMatch(host.textContent,/Old result/);assert.equal(changes.at(-1).runs[0].profileName,'Latest result');
 const waiting=deferred();const other=setup();const mounting=mount(other,async path=>path==='views/tradingengine'?{rows:[]}:waiting.promise,{isCurrent:()=>current});current=false;other.textContent='Customer accounts';waiting.resolve(metadata({runs:[run()]}));await mounting;assert.equal(other.textContent,'Customer accounts');
});

test('queued test refresh shows immutable terminal results, scoped failure and escaped report data',async()=>{
 const host=setup();let value=metadata({runs:[run({status:'RUNNING',report:null,reviewEligible:false,completedAt:null})]});const controller=await mount(host,async path=>path==='views/tradingengine'?{rows:[]}:copy(value));assert.equal(host.querySelector('[data-test-result]').textContent,'Running');
 const malicious=copy(report);malicious.checks[0].detail='<img src=x onerror=bad()>\nExact source detail';malicious.orders[0].reason='<script>bad()</script>';value.runs=[run({report:malicious})];await controller.refresh();assert.equal(host.querySelector('[data-test-result]').textContent,'Passed');assert.equal(host.querySelector('script,img'),null);assert.match(host.textContent,/<img src=x onerror=bad\(\)>/);assert.equal(host.querySelectorAll('.trading-test-table tbody tr').length,2);assert.match(host.textContent,/1\.000000000000000001/);
 value.runs=[run({status:'FAILED',report:null,errorCode:'TRADING_TEST_PROCESS_EXIT',reviewEligible:false})];await controller.refresh();assert.equal(host.querySelector('[data-test-result]').textContent,'Failed');assert.equal(host.querySelector('[data-test-report] .form-error').textContent,'TRADING_TEST_PROCESS_EXIT');assert.equal(host.querySelector('[data-review-test]'),null);
});

test('past results are bounded to twenty and review failures retry without starting live trading',async()=>{
 const host=setup(),calls=[];let value=metadata({runs:Array.from({length:23},(_,index)=>run({runId:index===0?RUN:'past-'+index,profileName:'Profile '+index}))});
 await mount(host,async(path,input,key)=>{calls.push({path,input,key});if(path==='views/tradingengine')return {rows:[]};if(input)throw Error('Review result could not be saved.');return copy(value);});assert.equal(host.querySelector('[data-test-history-count]').textContent,'20');assert.equal(host.querySelectorAll('[data-open-test-run]').length,20);
 host.querySelector('[data-review-test]').click();await until(()=>host.querySelector('[data-test-error]').textContent==='Review result could not be saved.');await tick();host.querySelector('[data-review-test]').click();await until(()=>calls.filter(call=>call.input).length===2);
 const writes=calls.filter(call=>call.input);assert.equal(writes[0].key,writes[1].key);assert.equal(writes.every(call=>call.path==='crypto/trading/tests/review'),true);assert.equal(host.querySelector('[data-review-test]').disabled,false);
});
