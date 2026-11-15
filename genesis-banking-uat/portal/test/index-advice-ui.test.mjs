import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountIndexAdvice} from '../public/index-advice.mjs';
import {mountTradingPanel} from '../public/trading-panel.mjs';
let dom;
afterEach(()=>dom?.window.close());
const setup=()=>{dom=new JSDOM('<!doctype html><main><section id="index"></section></main>',{url:'https://bank.invalid'});return dom.window.document.querySelector('#index');};
const policy={policyVersion:3,instructions:'Read issuer notices.\nKeep unknowns null. </textarea><script>bad()</script>',taxonomy:[{id:'EQ01',label:'Major contracts'}]};
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};

test('INDEX editing is confined to the current crypto back office and sends a versioned save',async()=>{
 const host=setup(),calls=[];await mountTradingPanel({api:async()=>{throw Error('Customer must not fetch private data');},host,isAdmin:false});assert.equal(host.innerHTML,'');
 await mountIndexAdvice({host,api:async(path,input,key)=>{calls.push({path,input,key});if(path==='crypto/trading/index-policy')return input?{...policy,policyVersion:4,instructions:input.instructions}:policy;return {rows:[]};}});
 assert.equal(host.querySelector('script'),null);assert.equal(host.querySelector('textarea').value,policy.instructions);assert.match(host.textContent,/INDEX AI instructions/);assert.match(host.textContent,/No event candidates received yet/);
 const form=host.querySelector('form');form.elements.instructions.value='Use official earnings releases.';await form.onsubmit({preventDefault(){}});const save=calls.at(-1);assert.equal(save.path,'crypto/trading/index-policy');assert.deepEqual(save.input,{expectedVersion:3,instructions:'Use official earnings releases.'});assert.match(save.key,/^[a-f0-9-]{36}$/);assert.match(host.querySelector('[data-index-version]').textContent,/Version 4/);assert.match(host.querySelector('[data-index-saved]').textContent,/next analysis uses version 4/);
});

test('late private reads and saves cannot render into a changed workspace',async()=>{
 const host=setup(),pending=deferred();let current=true;const work=mountIndexAdvice({host,isCurrent:()=>current&&host.isConnected,api:async path=>path==='crypto/trading/index-policy'?pending.promise:{rows:[]}});current=false;host.textContent='Customer accounts';pending.resolve(policy);await work;assert.equal(host.textContent,'Customer accounts');assert.equal(host.querySelector('textarea'),null);
 current=true;const save=deferred();await mountIndexAdvice({host,isCurrent:()=>current,api:async(path,input)=>path==='crypto/trading/index-policy'?(input?save.promise:policy):{rows:[]}});const submitted=host.querySelector('form').onsubmit({preventDefault(){}});current=false;host.textContent='Customer accounts';save.resolve({...policy,policyVersion:4,instructions:'Private next version'});await submitted;assert.equal(host.textContent,'Customer accounts');
});

test('a newer draft survives a delayed save and the next save uses the new server version',async()=>{
 const host=setup(),pending=deferred(),writes=[];await mountIndexAdvice({host,api:async(path,input)=>{if(path!=='crypto/trading/index-policy')return {rows:[]};if(!input)return policy;writes.push(input);return writes.length===1?pending.promise:{...policy,policyVersion:5,instructions:input.instructions};}});
 const form=host.querySelector('form');form.elements.instructions.value='First submitted draft';const saving=form.onsubmit({preventDefault(){}});form.elements.instructions.value='Newer draft typed while saving';pending.resolve({...policy,policyVersion:4,instructions:'First submitted draft'});await saving;
 assert.equal(form.elements.instructions.value,'Newer draft typed while saving');assert.match(host.querySelector('[data-index-saved]').textContent,/new edits await Save/);assert.equal(host.querySelector('[data-index-version]').textContent,'Version 4');await form.onsubmit({preventDefault(){}});assert.deepEqual(writes[1],{expectedVersion:4,instructions:'Newer draft typed while saving'});
});

test('candidate evidence is escaped, source links are HTTPS, and save failures stay in the instruction field',async()=>{
 const host=setup(),keys=[];await mountIndexAdvice({host,api:async(path,input,key)=>{if(path==='crypto/trading/index-policy'){if(input){keys.push(key);throw Error('Reload the current instruction version.');}return policy;}return {rows:[{signal_id:'signal-1',state:'ACTIVE',display_state:'ACTIVE',policy_version:3,resolution:{status:'UNRESOLVED',robots:[]},payload:{proposed_action:'WATCH',issuer_or_asset_name:'<img src=x onerror=bad()>',event_category:'EQ01',event_status:'PENDING',event_version:1,evidence_summary:'<script>bad()</script>',source_urls:['javascript:bad()','https://issuer.example/article'],analysed_at:'2026-11-15T12:00:00Z',expires_at:'2026-11-15T12:10:00Z'}}]};}});
 assert.equal(host.querySelector('img,script'),null);assert.equal(host.querySelectorAll('a').length,1);assert.equal(host.querySelector('a').href,'https://issuer.example/article');assert.match(host.textContent,/Awaiting exact instrument/);
 const form=host.querySelector('form');await form.onsubmit({preventDefault(){}});await form.onsubmit({preventDefault(){}});assert.equal(keys[0],keys[1],'same save retry retains its idempotency key');assert.equal(host.querySelector('[data-index-error]').textContent,'Reload the current instruction version.');assert.equal(form.querySelector('button').disabled,false);
});
