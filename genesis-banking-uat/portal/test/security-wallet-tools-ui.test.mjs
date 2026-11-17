import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createCryptoWorkspace} from '../public/crypto-workspace.mjs';

const descriptors=new Map(['document','FormData','navigator'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
const sessions=[];
afterEach(()=>{for(const {workspace,dom} of sessions.splice(0)){workspace.close();dom.window.close();}for(const [name,descriptor]of descriptors)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;return {promise:new Promise((yes,no)=>{resolve=yes;reject=no;}),resolve,reject};};
const address='0x'+'1'.repeat(40),otherAddress='0x'+'2'.repeat(40),bookingId='b0000000-0000-4000-8000-000000000001';
const cards=()=>Array.from({length:10},(_,i)=>({card_id:'a0000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),sort_order:i+1,name:i?'Demo security '+String(i+1).padStart(2,'0'):'AVISPay PLC',symbol:i?'DEMO'+String(i+1).padStart(2,'0'):'aAVISP',mode:'DEMO',state:'DRAFT',token_quantity:'99999999',dossier:{assetType:'STOCK',currency:'CHF',assetValue:'99999999',issuedVolume:'99999999',faceValue:'1',source:'Example dossier'},actions:[]}));
const booked=()=>({...cards()[0],mode:'REAL',state:'BOOKED',user_id:'1',network:'ETHEREUM',wallet_address_id:'address-1',wallet_public_address:address,token_quantity:'123',name:'Registered shares'});
const custody=extra=>({account_id:'custody-account',user_id:'1',full_name:'AVISPay PLC',account_role:'INSTITUTION',network:'ETHEREUM',address_id:'address-1',public_address:address,currency_code:'aAVISP',name:'Registered shares',wallet_scope:'CUSTODY',available_balance:'10.123456789012345678',locked_balance:'0.100000000000000001',...extra});
async function setup({cardRows=cards(),wallets=[],action}={}){
 const dom=new JSDOM('<!doctype html><body><main><div id="view"></div></main></body>',{url:'https://bank.invalid'});
 globalThis.document=dom.window.document;globalThis.FormData=dom.window.FormData;Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 const copied=[],shared=[];Object.defineProperty(dom.window.navigator,'clipboard',{value:{writeText:async value=>copied.push(value)},configurable:true});Object.defineProperty(dom.window.navigator,'share',{value:async value=>shared.push(value),configurable:true});
 const views={cryptosecurities:cardRows,cryptowallets:wallets,customers:[{user_id:'1',full_name:'AVISPay PLC',account_role:'INSTITUTION'},{user_id:'2',full_name:'Second institution',account_role:'INSTITUTION'},{user_id:'3',full_name:'Private customer',account_role:'CUSTOMER'}],cryptonetworks:[{code:'ETHEREUM',name:'Ethereum',kind:'EVM'},{code:'POLYGON',name:'Polygon',kind:'EVM'},{code:'SOLANA',name:'Solana',kind:'SOLANA'}],treasurypositions:[{booking_id:bookingId,asset_class:'SECURITY',asset_code:'AVISPAY-PLC-SHARES',owner_user_id:'1',asset_name:'AVISPay PLC shares',quantity:'30000000000',source_reference:'Original Treasury shares'}]};
 const calls=[],sent=[];
 const api=async(path,input,key)=>{
  calls.push({path,input:input?structuredClone(input):input,key});
  if(action){const value=await action(path,input,key,views);if(value!==undefined)return value;}
  if(path.startsWith('views/'))return {rows:views[path.slice(6)]||[]};
  if(path==='crypto/trading/index-policy')return {policyVersion:1,instructions:'Use sources.',taxonomy:[]};
  if(path==='crypto/trading/testing')return {profiles:[],runs:[],limits:{},engine:{}};
  if(path.startsWith('crypto/trading/live'))return {profiles:[],selectedRobotId:null,market:null,audit:null,liquidity:null};
  if(path.startsWith('crypto/securities/'))return views.cryptosecurities.find(row=>row.card_id===path.slice('crypto/securities/'.length));
  throw Error('Unexpected API '+path);
 };
 const workspace=createCryptoWorkspace({api,identity:()=>({admin:true,customerUserId:null}),purchase(){},sell(){},send:row=>sent.push(row),notice(){}});
 sessions.push({dom,workspace});await workspace.mount(document.querySelector('#view'));await flush();
 return {dom,workspace,views,calls,sent,copied,shared,card:id=>document.querySelector('[data-security="'+id+'"]'),remount:()=>workspace.mount(document.querySelector('#view'))};
}

test('all stored security slots are standard wallet cards and only the highlighted Treasury strip is removed',async()=>{
 const ui=await setup(),securityDesk=document.querySelector('#crypto-security-desk');
 assert.equal(document.querySelector('.crypto-stock-register'),null);assert.equal(document.querySelector('[data-stock-convert]'),null);
 assert.equal(securityDesk.querySelectorAll('article[data-security]').length,10);assert.equal(securityDesk.querySelectorAll('[data-security-details]').length,10);assert.equal(securityDesk.querySelectorAll('[data-security-create]').length,10);
 assert.equal(ui.card(ui.views.cryptosecurities[1].card_id).querySelector('strong').textContent,'Security wallet 02');
 assert.doesNotMatch(securityDesk.textContent,/Demo security|DEMO0|Demo wallet|99,999,999/);
 assert.match(ui.card(ui.views.cryptosecurities[0].card_id).textContent,/Source holding30,000,000,000 units/);
 assert.equal(ui.card(ui.views.cryptosecurities[1].card_id).querySelector('dd').textContent,'—');
 assert.ok(document.querySelector('.security-conversion'));assert.equal(document.querySelectorAll('[data-security-send]').length,0);
 assert.equal(ui.calls.some(call=>call.input),false,'opening the scroller cannot create wallets or holdings');
});

test('booked security balance and Send use one exact custody account while Receive shows its real address and QR',async()=>{
 const card=booked(),wallet=custody(),qr='data:image/png;base64,cmVhbC1yZXNwb25zZQ==';
 const ui=await setup({cardRows:[card],wallets:[wallet],action:async(path,input)=>path==='crypto/wallet'?{address_id:'address-1',user_id:1,network:'ETHEREUM',public_address:address,qr}:undefined});
 const element=ui.card(card.card_id);assert.match(element.textContent,/Available10\.023456789012345677/);assert.match(element.textContent,/Reserved0\.100000000000000001/);
 assert.equal(element.querySelector('.security-wallet-address').textContent,address);element.querySelector('[data-security-send]').click();assert.equal(ui.sent[0],wallet);
 await element.querySelector('[data-security-receive]').onclick();const dialog=document.querySelector('dialog');assert.equal(dialog.parentElement,document.body);assert.equal(dialog.querySelectorAll('[aria-label=Close]').length,1);assert.equal(dialog.querySelector('img').src,qr);
 await dialog.querySelector('[data-security-copy]').onclick();await dialog.querySelector('[data-security-share]').onclick();assert.deepEqual(ui.copied,[address]);assert.match(ui.shared[0].text,new RegExp(address));
 assert.deepEqual(ui.calls.filter(c=>c.path==='crypto/wallet').map(c=>c.input),[{addressId:'address-1'}]);assert.equal(ui.calls.some(c=>/securities\/wallet|securities\/prepare|actions\/submit/.test(c.path)),false);
 dialog.querySelector('[aria-label=Close]').click();assert.equal(document.querySelector('dialog'),null);
});

test('wrong holder, chain, token, address or account scope never exposes a security Send button',async()=>{
 const card=booked(),ui=await setup({cardRows:[card]});
 const mismatches=[{user_id:'2'},{network:'POLYGON'},{currency_code:'AG'},{address_id:'other-id'},{public_address:otherAddress},{wallet_scope:'FUNDING'}];
 for(const changed of mismatches){ui.views.cryptowallets=[custody(changed)];await ui.remount();assert.equal(ui.card(card.card_id).querySelector('[data-security-send]'),null,JSON.stringify(changed));assert.equal(ui.card(card.card_id).querySelector('dd').textContent,'—');}
 ui.views.cryptowallets=[custody({}),custody({account_id:'ambiguous-second'})];await ui.remount();assert.equal(ui.card(card.card_id).querySelector('[data-security-send]'),null,'ambiguous duplicate mappings must not select an account');
});

test('Create receiving wallet requires the chosen institution and EVM chain and retries the same request identity',async()=>{
 let attempts=0;const ui=await setup({action:async(path,input,key,views)=>{
  if(path!=='crypto/securities/wallet')return undefined;
  if(++attempts===1)throw Error('Retry this wallet request.');
  const card=views.cryptosecurities.find(c=>c.card_id===input.cardId);Object.assign(card,{user_id:input.userId,network:input.network,wallet_address_id:'created-address',wallet_public_address:otherAddress});
  return {address_id:'created-address',user_id:input.userId,network:input.network,public_address:otherAddress};
 }}),id=ui.views.cryptosecurities[1].card_id;
 await ui.card(id).querySelector('[data-security-create]').onclick();let dialog=document.querySelector('dialog'),form=dialog.querySelector('form');
 assert.equal(dialog.parentElement,document.body);assert.equal(form.elements.userId.value,'');assert.equal(form.elements.network.value,'');assert.deepEqual([...form.elements.userId.options].map(o=>o.value),['','1','2']);assert.deepEqual([...form.elements.network.options].map(o=>o.value),['','ETHEREUM','POLYGON']);
 form.elements.userId.value='2';form.elements.network.value='POLYGON';await form.onsubmit({preventDefault(){}});assert.equal(form.querySelector('.form-error').textContent,'Retry this wallet request.');assert.equal(document.querySelector('[data-crypto-error]').textContent,'');
 await form.onsubmit({preventDefault(){}});const requests=ui.calls.filter(c=>c.path==='crypto/securities/wallet');assert.equal(requests.length,2);assert.equal(requests[0].key,requests[1].key);assert.deepEqual(requests[0].input,{userId:'2',network:'POLYGON',cardId:id});
 assert.equal(document.querySelector('dialog'),null);assert.equal(ui.card(id).querySelector('.security-wallet-address').textContent,otherAddress);assert.ok(ui.card(id).querySelector('[data-security-receive]'));assert.equal(ui.card(id).querySelector('[data-security-send]'),null);assert.equal(ui.views.cryptosecurities[1].token_quantity,'99999999','wallet creation cannot change saved holdings');
});

test('wallet creation cancellation has no API mutation and a delayed response cannot reopen a closed window',async()=>{
 const pending=deferred(),ui=await setup({action:async path=>path==='crypto/securities/wallet'?pending.promise:undefined}),id=ui.views.cryptosecurities[2].card_id;
 await ui.card(id).querySelector('[data-security-create]').onclick();document.querySelector('[data-cancel]').click();assert.equal(ui.calls.some(c=>c.path==='crypto/securities/wallet'),false);
 await ui.card(id).querySelector('[data-security-create]').onclick();const dialog=document.querySelector('dialog'),form=dialog.querySelector('form');form.elements.userId.value='1';form.elements.network.value='ETHEREUM';const saving=form.onsubmit({preventDefault(){}});await form.onsubmit({preventDefault(){}});dialog.querySelector('[aria-label=Close]').click();pending.resolve({address_id:'late',user_id:'1',network:'ETHEREUM',public_address:address});await saving;
 assert.equal(document.querySelector('dialog'),null);assert.equal(ui.calls.filter(c=>c.path==='crypto/securities/wallet').length,1);
});

test('receiving identity mismatch remains in its popup and late reads cannot replace another window',async()=>{
 const pending=deferred(),card=booked();let mode='mismatch';const ui=await setup({cardRows:[card],action:async path=>path==='crypto/wallet'?(mode==='mismatch'?{address_id:'address-1',user_id:'2',network:'ETHEREUM',public_address:address,qr:'data:image/png;base64,eA=='}:pending.promise):undefined});
 await ui.card(card.card_id).querySelector('[data-security-receive]').onclick();assert.match(document.querySelector('[data-security-receive-error]').textContent,/does not match/);assert.equal(document.querySelector('.crypto-qr'),null);assert.equal(document.querySelector('[data-crypto-error]').textContent,'');document.querySelector('[aria-label=Close]').click();
 mode='delayed';const reading=ui.card(card.card_id).querySelector('[data-security-receive]').onclick();document.querySelector('[aria-label=Close]').click();pending.resolve({address_id:'address-1',user_id:'1',network:'ETHEREUM',public_address:address,qr:'data:image/png;base64,eA=='});await reading;assert.equal(document.querySelector('dialog'),null);
});

test('neutral slots require a real token symbol when preparing an existing Portfolio holding',async()=>{
 const ui=await setup({wallets:[custody({account_id:'funding',wallet_scope:'FUNDING'})],action:async(path,input)=>path==='crypto/securities/prepare'?{id:input.cardId,symbol:input.tokenSymbol}:undefined}),id=ui.views.cryptosecurities[1].card_id;
 ui.views.securitypositions=[{position_id:'position-1',user_id:'1',account_role:'INSTITUTION',name:'Registered company shares',quantity:'200',available_quantity:'175',reference:'Recorded source'}];await ui.remount();await ui.card(id).querySelector('[data-security-details]').onclick();assert.equal(document.querySelector('[data-demo-convert]'),null);
 await document.querySelector('[data-real-prepare]').onclick();const form=document.querySelector('dialog form');assert.equal(form.elements.tokenSymbol.required,true);assert.equal(form.elements.tokenSymbol.value,'');
 const symbolPattern=new RegExp('^(?:'+form.elements.tokenSymbol.pattern+')$','v');assert.equal(symbolPattern.test('q-SHARE_1.0'),true);assert.equal(symbolPattern.test('q:SHARE'),false);
 form.elements.positionId.value='position-1';form.elements.positionId.onchange();assert.equal(form.elements.quantity.value,'175');assert.equal(form.elements.tokenQuantity.value,'175');
 form.elements.tokenSymbol.value='qSHARE';form.elements.addressId.value='address-1';form.elements.custodyReference.value='Recorded source';form.elements.greenHighTechVerified.checked=true;await form.onsubmit({preventDefault(){}});
 const request=ui.calls.find(c=>c.path==='crypto/securities/prepare');assert.equal(request.input.tokenSymbol,'qSHARE');assert.equal(request.input.cardId,id);assert.equal(request.input.network,'ETHEREUM');assert.equal(request.input.positionId,'position-1');assert.equal(ui.calls.some(c=>c.path==='crypto/securities/demo-convert'),false);
});

test('selecting another security cancels a delayed Treasury-source registration window',async()=>{
 const pending=deferred();let delay=false;const cardRows=cards();cardRows[0].sourceHolding={bookingId,positionId:null,userId:'1',quantity:'30000000000',name:'AVISPay PLC shares',assetType:'STOCK',source:'Treasury register'};
 const ui=await setup({cardRows,action:async path=>delay&&path==='views/treasurypositions'?pending.promise:undefined});delay=true;
 const opening=document.querySelector('[data-real-prepare]').onclick();await ui.card(cardRows[1].card_id).querySelector('[data-security-details]').onclick();pending.resolve({rows:ui.views.treasurypositions});await opening;
 assert.equal(document.querySelector('dialog'),null);assert.match(document.querySelector('[data-security-detail] h3').textContent,/Security wallet 02/);
});

test('preparing a configured receiving wallet preserves its exact institution, blockchain and address',async()=>{
 const cardRows=cards();Object.assign(cardRows[1],{user_id:'1',network:'POLYGON',wallet_address_id:'fixed-wallet',wallet_public_address:otherAddress});
 const ui=await setup({cardRows,wallets:[custody({wallet_scope:'FUNDING'}),custody({account_id:'other-chain',network:'POLYGON',address_id:'other-wallet',public_address:address,wallet_scope:'FUNDING'})]});
 ui.views.securitypositions=[{position_id:'same-owner',user_id:'1',account_role:'INSTITUTION',name:'Own security',quantity:'10'},{position_id:'another-owner',user_id:'2',account_role:'INSTITUTION',name:'Another security',quantity:'20'}];
 await ui.remount();await ui.card(cardRows[1].card_id).querySelector('[data-security-details]').onclick();await document.querySelector('[data-real-prepare]').onclick();const form=document.querySelector('dialog form');
 assert.deepEqual([...form.elements.positionId.options].map(o=>o.value),['','same-owner']);form.elements.positionId.value='same-owner';form.elements.positionId.onchange();
 assert.deepEqual([...form.elements.addressId.options].map(o=>o.value),['','fixed-wallet']);assert.equal(form.elements.addressId.value,'fixed-wallet');
 assert.match(form.elements.addressId.selectedOptions[0].textContent,/POLYGON/);assert.match(form.elements.addressId.selectedOptions[0].textContent,new RegExp(otherAddress));
 assert.equal(ui.calls.some(c=>c.path==='crypto/securities/prepare'),false);
});
