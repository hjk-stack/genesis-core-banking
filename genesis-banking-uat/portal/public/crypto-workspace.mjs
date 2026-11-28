import {mountRollingConverterAdmin,isRollingConverterHost} from './rolling-converter-admin.mjs';
import {mountTradingPanel} from './trading-panel.mjs';
import {mountWalletTradingScroller} from './wallet-trading-scroller.mjs';
import {openTreasurySource} from './treasury-source.mjs';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>{if(v===null||v===undefined)return '—';const value=String(v),decimal=/^([+-]?\d+)(?:\.(\d*))?$/.exec(value);if(!decimal)return value;const whole=decimal[1].replace(/\B(?=(\d{3})+(?!\d))/g,','),fraction=(decimal[2]||'').replace(/0+$/,'');return whole+(fraction?'.'+fraction:'');};
const marketChange=v=>{if(!['number','string'].includes(typeof v)||String(v).trim()==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const canSend=w=>w.wallet_scope==='FUNDING'||w.wallet_scope==='CUSTODY'&&w.network==='ETHEREUM';
const field=(name,title,type='text',extra='')=>`<label>${esc(title)}<input name="${name}" type="${type}" aria-label="${esc(title)}" ${extra}></label>`;
const select=(name,title,rows,extra='')=>`<label>${esc(title)}<select name="${name}" aria-label="${esc(title)}" ${extra}><option value="">Select…</option>${rows.map(([v,t])=>`<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select></label>`;
const brandIcons=Object.freeze({AG:'/crypto-icons/ag.png',AGI:'/crypto-icons/agi.png'});
const icon=a=>{const symbol=String(a.currency_code||a.symbol||'').toUpperCase(),src=brandIcons[symbol]||(a.icon_url&&/^https:\/\/(assets|coin-images)\.coingecko\.com\//.test(a.icon_url)?a.icon_url:'');return src?`<img class="coin-icon" src="${esc(src)}" alt="${esc(a.name||a.currency_code||a.symbol)}" loading="lazy">`:`<span class="coin-icon coin-monogram">${esc(a.currency_code||a.symbol||'AVIS')}</span>`;};
const details=rows=>`<dl class="crypto-details">${rows.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v??'—')}</dd>`).join('')}</dl>`;
import {basketPolicyFields,mountBasketPolicy} from './crypto-basket.mjs';
export function createCryptoWorkspace({api,identity,purchase,registerOffer,sell,send,notice}){
 let allowanceScroller=null,rollingConverter=null;
 const legacyInactive=()=>isRollingConverterHost(root?.ownerDocument);
 let root,epoch=0,data={},selected=null,dialog=null,delegation=null,advancedExpanded=false,receiveState=null,lifecycle=0,actorKey=null,walletRead=0,walletApplied=0,catalogueRead=0,catalogueApplied=0;
 let walletListFailed=false,assetOptionError=null;
 const selectedNetworks=new Map(),activationJobs=new Map(),walletIssues=new Map(),selectionVersions=new Map();
 const q=s=>root?.querySelector(s),isAdmin=()=>identity().admin;
 const actor=()=>JSON.stringify([!!identity().admin,String(identity().customerUserId??'')]);
 const currentContext=(version,key)=>!!root&&version===lifecycle&&key===actorKey&&key===actor();
 // Card display, Receive and Send must all resolve the same booked account.
 const holdingAt=(group,network)=>{const rows=group.rows.filter(w=>w.network===network);return rows.find(w=>/[1-9]/.test(String(w.available_balance)+String(w.locked_balance)))||rows[0];};
 // Stored converter slots remain available until the owner selects a real source.
 const securityCards=()=>data.cryptosecurities.filter(s=>s.mode==='REAL'||s.symbol==='aAVISP'||isAdmin()&&s.mode==='DEMO');
 const securitySlot=s=>s.mode==='DEMO'&&/^DEMO\d+$/i.test(s.symbol)&&!s.position_id&&!s.security_id;
 const securityTitle=s=>securitySlot(s)?'Security wallet '+String(s.sort_order||Math.max(1,securityCards().findIndex(row=>row.card_id===s.card_id)+1)).padStart(2,'0'):s.name;
 const securitySource=s=>{
  if(s.sourceHolding)return s.sourceHolding;
  const positions=(data.securitypositions||[]).filter(p=>p.position_id===s.position_id&&(!s.user_id||String(p.user_id)===String(s.user_id)));
  if(positions.length===1)return {quantity:positions[0].quantity,userId:positions[0].user_id,name:positions[0].name};
  if(s.symbol==='aAVISP'){
   const sources=(data.treasurypositions||[]).filter(p=>p.asset_code==='AVISPAY-PLC-SHARES'&&(!s.user_id||String(p.owner_user_id)===String(s.user_id)));
   if(sources.length===1)return {quantity:sources[0].quantity,userId:sources[0].owner_user_id,name:sources[0].asset_name};
  }
  return null;
 };
 const securityAccount=s=>{
  if(s.mode!=='REAL'||s.state!=='BOOKED'||!s.user_id||!s.network||!s.wallet_address_id||!s.wallet_public_address)return null;
  const matches=(data.cryptowallets||[]).filter(w=>w.account_id&&w.wallet_scope==='CUSTODY'&&String(w.user_id)===String(s.user_id)&&w.network===s.network&&
   String(w.currency_code).toUpperCase()===String(s.symbol).toUpperCase()&&String(w.address_id)===String(s.wallet_address_id)&&
   String(w.public_address).toLowerCase()===String(s.wallet_public_address).toLowerCase());
  return matches.length===1?matches[0]:null;
 };
 function renderSecurityWallets(){
  const host=q('[data-security-wallets]');if(!host)return;
  host.innerHTML=securityCards().map(s=>{
   const title=securityTitle(s),slot=securitySlot(s),account=securityAccount(s),source=securitySource(s),available=allocationUnits(account?.available_balance),reserved=allocationUnits(account?.locked_balance);
   const holder=(data.customers||[]).find(u=>String(u.user_id)===String(s.user_id||source?.userId));
   return `<article class="crypto-wallet security-wallet ${selected===s.card_id?'selected':''}" role="listitem" tabindex="0" data-security="${esc(s.card_id)}" aria-label="${esc(title)} wallet" ${selected===s.card_id?'aria-current="true"':''}>
    <div class="security-wallet-top">${s.symbol==='aAVISP'?'<img class="security-brand-logo" src="/crypto-icons/avispay.webp" alt="AVISPay">':'<span class="security-symbol" aria-hidden="true">◈</span>'}<span class="crypto-badge">${esc(s.network||'')}</span></div>
    <strong>${esc(title)}</strong><span>${slot?'Security wallet':esc(s.symbol)+' · '+esc(s.dossier?.assetType||'Security')}</span>${holder?`<p class="crypto-holder">${esc(holder.full_name)}</p>`:''}
    <dl><dt>Available</dt><dd>${available!==null&&reserved!==null?fmt(unitsText(available-reserved)):'—'}</dd><dt>Reserved</dt><dd>${reserved===null?'—':fmt(unitsText(reserved))}</dd>${source?.quantity!=null?`<dt>Source holding</dt><dd>${fmt(source.quantity)} units</dd>`:''}</dl>
    <div class="security-wallet-receiving"><span>Receiving wallet</span><code class="security-wallet-address">${esc(s.wallet_public_address||'—')}</code></div>
    <div class="security-wallet-tools"><button type="button" data-security-details aria-label="Details for ${esc(title)}" aria-pressed="${selected===s.card_id}">Details</button>${s.wallet_address_id?`<button type="button" data-security-receive aria-label="Receive ${esc(title)}">Receive</button>`:isAdmin()&&!legacyInactive()?'<button type="button" data-security-create>Create receiving wallet</button>':''}${account&&canSend(account)?`<button type="button" data-security-send aria-label="Send ${esc(s.symbol)}">Send</button>`:''}</div>
    <p class="form-error" role="alert" data-security-wallet-error></p></article>`;
  }).join('');
  host.querySelectorAll('[data-security]').forEach(card=>{
   const get=()=>securityCards().find(s=>s.card_id===card.dataset.security);
   card.onclick=e=>{if(!e.target.closest('button,a,select,input'))void showSecurity(card.dataset.security);};
   card.onkeydown=e=>{if(e.target===card&&['Enter',' '].includes(e.key)){e.preventDefault();void showSecurity(card.dataset.security);}};
   card.querySelector('[data-security-details]').onclick=()=>showSecurity(card.dataset.security);
   const receive=card.querySelector('[data-security-receive]');if(receive)receive.onclick=()=>receiveSecurityWallet(get());
   const create=card.querySelector('[data-security-create]');if(create)create.onclick=()=>createSecurityReceivingWallet(get());
   const sendButton=card.querySelector('[data-security-send]');if(sendButton)sendButton.onclick=()=>{const account=securityAccount(get());if(account&&canSend(account))send(account);};
  });
 }
 async function receiveSecurityWallet(s){
  if(!s?.wallet_address_id)return;
  const context=lifecycle,who=actorKey,title=securityTitle(s),el=modal('Receive '+title,'<div class="crypto-receive"><div class="crypto-receive-content" data-security-receive-content><p role="status">Loading receiving address…</p></div></div>');
  const current=()=>currentContext(context,who)&&dialog===el&&el.isConnected,content=el.querySelector('[data-security-receive-content]');
  try{
   const wallet=await api('crypto/wallet',{addressId:s.wallet_address_id});if(!current())return;
   if(String(wallet.address_id)!==String(s.wallet_address_id)||String(wallet.user_id)!==String(s.user_id)||wallet.network!==s.network||
    !wallet.public_address||s.wallet_public_address&&wallet.public_address.toLowerCase()!==s.wallet_public_address.toLowerCase()||!wallet.qr?.startsWith('data:image/png;base64,'))
    throw new Error('The receiving address does not match this security wallet.');
   content.innerHTML=`<p>${esc(title)} · ${esc(networkName(wallet.network))}</p><img class="crypto-qr" src="${esc(wallet.qr)}" alt="Receiving address QR code"><code>${esc(wallet.public_address)}</code>${wallet.destination_tag!=null?`<p>Destination tag: ${esc(wallet.destination_tag)}</p>`:''}<div class="crypto-inline-actions"><button type="button" data-security-copy>Copy address</button><button type="button" data-security-share>Share</button></div><p role="status" data-security-receive-status></p><p class="form-error" role="alert" data-security-receive-error></p>`;
   const issue=content.querySelector('[data-security-receive-error]'),status=content.querySelector('[data-security-receive-status]');
   content.querySelector('[data-security-copy]').onclick=async()=>{if(!current())return;try{await navigator.clipboard.writeText(wallet.public_address);if(current())status.textContent='Address copied.';}catch(e){if(current())error(e,issue);}};
   content.querySelector('[data-security-share]').onclick=async()=>{if(!current())return;try{const text=title+' · '+wallet.network+'\n'+wallet.public_address+(wallet.destination_tag!=null?'\nTag: '+wallet.destination_tag:'');if(navigator.share)await navigator.share({title:'AVISPay security receiving wallet',text});else{await navigator.clipboard.writeText(text);if(current())status.textContent='Wallet details copied for sharing.';}}catch(e){if(current()&&e.name!=='AbortError')error(e,issue);}};
  }catch(e){if(current()){content.innerHTML='<p class="form-error" role="alert" data-security-receive-error></p>';error(e,content.querySelector('[data-security-receive-error]'));}}
 }
 async function createSecurityReceivingWallet(s){
  if(!s||!isAdmin()||legacyInactive())return;if(s.wallet_address_id)return receiveSecurityWallet(s);
  const context=lifecycle,who=actorKey,source=securitySource(s),owner=s.user_id||source?.userId;
  const users=(data.customers||[]).filter(u=>u.account_role==='INSTITUTION'&&(!owner||String(u.user_id)===String(owner)));
  const networks=data.cryptonetworks.filter(n=>n.kind==='EVM'&&(!s.network||n.code===s.network));
  const el=modal('Create receiving wallet · '+securityTitle(s),`<form><div class="crypto-form-grid">${select('userId','Portfolio holder',users.map(u=>[u.user_id,u.full_name]),'required')}${select('network','Blockchain',networks.map(n=>[n.code,n.name]),'required')}</div><p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" data-cancel>Cancel</button><button class="primary" type="submit">Create receiving wallet</button></div></form>`),f=el.querySelector('form');
  if(owner)f.elements.userId.value=String(owner);if(s.network)f.elements.network.value=s.network;
  const current=()=>currentContext(context,who)&&dialog===el&&el.isConnected;let busy=false,lastInput='',lastKey='';
  el.querySelector('[data-cancel]').onclick=()=>el.close();
  f.onsubmit=async event=>{
   event.preventDefault();if(!current()||busy||!f.reportValidity())return;
   const input={...Object.fromEntries(new FormData(f)),cardId:s.card_id},serialized=JSON.stringify(input);if(serialized!==lastInput){lastInput=serialized;lastKey=crypto.randomUUID();}
   const button=f.querySelector('[type=submit]');busy=true;button.disabled=true;f.querySelector('.form-error').textContent='';
   try{
    const wallet=await api('crypto/securities/wallet',input,lastKey);if(!current())return;
    if(!wallet.address_id||!wallet.public_address||String(wallet.user_id)!==input.userId||wallet.network!==input.network)throw new Error('The created wallet did not match the selected institution and blockchain.');
    el.close();if(currentContext(context,who))await mount(root);
   }catch(e){if(current())error(e,f.querySelector('.form-error'));}finally{busy=false;if(current())button.disabled=false;}
  };
 }
 function close(){rollingConverter?.close();rollingConverter=null;allowanceScroller?.close();allowanceScroller=null;epoch++;lifecycle++;receiveState=null;delegation?.remove();delegation=null;dialog?.close();dialog?.remove();dialog=null;root=null;actorKey=null;selectedNetworks.clear();activationJobs.clear();walletIssues.clear();selectionVersions.clear();}
 function error(e,element){if(element)element.textContent=e.message||'Please retry this action.';}
 function modal(title,body){receiveState=null;dialog?.remove();dialog=document.createElement('dialog');dialog.className='crypto-dialog';dialog.innerHTML=`<div class="dialog-heading"><h2>${esc(title)}</h2><button type="button" class="close" aria-label="Close">×</button></div>${body}`;document.body.append(dialog);const ownDialog=dialog;ownDialog.querySelector('.close').onclick=()=>ownDialog.close();ownDialog.addEventListener('close',()=>{ownDialog.remove();if(dialog===ownDialog){dialog=null;receiveState=null;renderWallets();}},{once:true});dialog.showModal();renderWallets();return dialog;}
 function eligibleNetworks(asset){const supported=new Set((data.cryptonetworks||[]).map(n=>n.code));return (asset?.networks||[]).filter(n=>n.approved&&n.verifiedAt&&supported.has(n.network));}
 const networkName=code=>(data.cryptonetworks||[]).find(n=>n.code===code)?.name||code;
 function walletGroups(){
  const groups=new Map(),who=identity();
  for(const w of data.cryptowallets||[]){
   if(w.wallet_visible===false)continue;
   if(!who.admin&&String(w.user_id)!==String(who.customerUserId))continue;
   const asset=(data.cryptocatalogue||[]).find(a=>w.asset_id?a.asset_id===w.asset_id:a.currency_code===w.currency_code),assetId=w.asset_id||asset?.asset_id||w.currency_code,scope=w.wallet_scope||'FUNDING',key=JSON.stringify([String(w.user_id),assetId,scope]);
   if(!groups.has(key))groups.set(key,{key,userId:String(w.user_id),assetId,scope,asset,rows:[],currency:w.currency_code,name:w.name||asset?.name||w.currency_code,icon:w,holder:w.full_name});
   groups.get(key).rows.push(w);
  }
  return [...groups.values()].map(group=>{
   group.networks=[...new Set([...group.rows.map(w=>w.network),...(group.scope==='FUNDING'?eligibleNetworks(group.asset).map(n=>n.network):[])])];
   if(!group.networks.includes(selectedNetworks.get(group.key)))selectedNetworks.set(group.key,group.rows[0].network);
   group.network=selectedNetworks.get(group.key);group.holding=holdingAt(group,group.network);return group;
  });
 }
 const walletGroup=key=>walletGroups().find(group=>group.key===key);
 const networkOptions=group=>group.networks.map(network=>`<option value="${esc(network)}">${esc(networkName(network))}</option>`).join('');
 const receivingBusy=group=>receiveState?.key===group.key&&receiveState.network===group.network&&receiveState.loading;
 function syncReceiveOptions(){const state=receiveState,group=state&&walletGroup(state.key);if(!group||dialog!==state.el||!state.el.isConnected)return;if(state.network!==group.network){void loadReceive(state);return;}const chooser=state.el.querySelector('[data-receive-network]');chooser.innerHTML=networkOptions(group);chooser.value=group.network;}
 const allocationUnits=value=>{const text=String(value??'').trim();if(!/^\d{1,36}(?:\.\d{1,18})?$/.test(text))return null;const [whole,fraction='']=text.split('.');return BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,'0'));};
 const unitsText=n=>{const str=String(n/10n**18n),f=(n%10n**18n).toString().padStart(18,'0').replace(/0+$/,'');return str+(f?'.'+f:'');};
 function openTradingDelegation(card,key){
  delegation?.remove();delegation=null;const group=walletGroup(key),wallet=group?.holding;if(!wallet?.account_id||group.scope!=='FUNDING')return;
  const whole=allocationUnits(wallet.available_balance),locked=allocationUnits(wallet.locked_balance),free=whole!==null&&locked!==null?whole-locked:0n;
  const popup=document.createElement('section');popup.className='wallet-trading-popup';popup.setAttribute('role','dialog');popup.setAttribute('aria-label','Allocate '+group.currency+' to algorithmic trading');
  const activeAllocations=(data.walletdelegations||[]).filter(d=>d.account_id===wallet.account_id&&d.state==='ACTIVE');
  const releaseList=activeAllocations.length?'<details class="wallet-delegation-active" open><summary>Frozen allocations · '+activeAllocations.length+'</summary>'+activeAllocations.map(d=>'<div><span>'+esc(fmt(d.quantity))+' '+esc(group.currency)+'</span><button type="button" data-release-delegation="'+esc(d.delegation_id)+'">Release</button></div>').join('')+'</details>':'';
  popup.innerHTML='<header><strong>Robot trading · '+esc(group.currency)+'</strong><button type="button" data-close aria-label="Close trading allocation">×</button></header>'+releaseList+'<p class="wallet-trading-disclosure">'+esc('By confirming below, I expressly instruct and authorize automated algorithmic trading using the designated portion of assets from this wallet. I acknowledge that cryptocurrency markets are volatile and that algorithmic trading carries a substantial risk of loss, up to and including the total loss of the allocated funds.')+'</p><label class="wallet-trading-amount">Designated amount <input type="text" data-allocate-quantity inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="Designated trading quantity"></label><div class="wallet-trading-line"><small>Available: '+esc(unitsText(free))+' '+esc(group.currency)+'</small><button type="button" data-max>Max</button></div><label class="wallet-trading-approval"><input type="checkbox" data-consent disabled><span>I accept the risk disclosure and freeze this portion for robot trading.</span></label><p class="form-error" role="alert" data-allocation-error></p><footer><button type="button" data-close>Cancel</button><button type="button" class="primary" data-confirm disabled>Freeze &amp; Authorize Robot</button></footer>';
  document.body.append(popup);delegation=popup;
  const place=()=>{if(!popup.isConnected)return;const rect=card.getBoundingClientRect(),width=Math.min(392,innerWidth-24);popup.style.width=width+'px';popup.style.left=Math.max(12,Math.min(innerWidth-width-12,rect.right-width))+'px';popup.style.top=Math.max(10,rect.top-popup.offsetHeight-10)+'px';if(rect.top-popup.offsetHeight<10)popup.style.top=Math.min(innerHeight-popup.offsetHeight-10,rect.bottom+10)+'px';};
  place();popup.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{popup.remove();if(delegation===popup)delegation=null;});
  popup.querySelectorAll('[data-release-delegation]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await api('crypto/trading/revoke-wallet',{delegationId:button.dataset.releaseDelegation},crypto.randomUUID());popup.remove();if(delegation===popup)delegation=null;if(root)await mount(root);}catch(e){popup.querySelector('[data-allocation-error]').textContent=e.message;button.disabled=false;}});
  const input=popup.querySelector('[data-allocate-quantity]'),consent=popup.querySelector('[data-consent]'),confirm=popup.querySelector('[data-confirm]');
  const valid=()=>{const value=allocationUnits(input.value);return /^\d{1,18}(?:\.\d{1,18})?$/.test(input.value.trim())&&value!==null&&value>0n&&value<=free;};
  const sync=()=>{consent.disabled=!valid();if(!valid())consent.checked=false;input.readOnly=consent.checked;confirm.disabled=!valid()||!consent.checked;};
  input.addEventListener('input',sync);popup.querySelector('[data-max]').onclick=()=>{if(!input.readOnly){input.value=unitsText(free);sync();}};consent.onchange=sync;
  confirm.onclick=async()=>{if(!valid()||!consent.checked)return;confirm.disabled=true;try{await api('crypto/trading/delegate-wallet',{accountId:wallet.account_id,amount:input.value.trim(),consent:true},crypto.randomUUID());popup.remove();if(delegation===popup)delegation=null;if(root)await mount(root);}catch(e){popup.querySelector('[data-allocation-error]').textContent=e.message;sync();}};
  input.focus();setTimeout(place,0);
 }
 async function changeWalletVisibility(accountId,visible,button){
  if(!isAdmin()||!accountId)return;
  try{
   await api('crypto/wallet/visibility',{accountId,visible},crypto.randomUUID());
   if(button.isConnected&&root)await mount(root);
  }catch(e){if(button.isConnected)error(e,button.closest('[data-wallet-group]').querySelector('[data-wallet-error]'));}
 }
 function renderWallets(){
  const host=q('[data-wallets]');if(!host)return;
  host.innerHTML=walletGroups().map(group=>{const w=group.holding,busy=receivingBusy(group),issue=walletIssues.get(group.key),delegated=(data.walletdelegations||[]).filter(d=>d.account_id===w?.account_id&&d.state==='ACTIVE').reduce((sum,d)=>sum+(allocationUnits(d.quantity)||0n),0n),spendable=allocationUnits(w?.available_balance)!==null&&allocationUnits(w?.locked_balance)!==null?allocationUnits(w.available_balance)-allocationUnits(w.locked_balance):0n;return `<article class="crypto-wallet" data-wallet-group="${esc(group.key)}" data-wallet="${esc(w?.account_id||'')}" data-holder="${esc(group.userId)}" data-wallet-scope="${esc(group.scope)}"><div class="crypto-wallet-title">${icon(group.icon)}<div><strong>${esc(group.name)}</strong><span>${esc(group.currency)} · ${group.scope==='CUSTODY'?'Security':'Funding'}</span></div></div>${isAdmin()?`<p class="crypto-holder">${esc(group.holder)}</p>`:''}<label class="crypto-wallet-network">Blockchain<select data-wallet-network aria-label="Blockchain for ${esc(group.name)}">${networkOptions(group)}</select></label><dl><dt>Available</dt><dd>${w?.available_balance==null?'—':fmt(unitsText(spendable))}</dd><dt>Reserved</dt><dd>${w?.locked_balance==null?'—':fmt(w.locked_balance)}</dd></dl><p class="wallet-robot-frozen">Trade allowance: ${w?.locked_balance==null?'—':fmt(unitsText(delegated))} ${esc(group.currency)}</p><div class="crypto-wallet-actions"><button type="button" data-delegate aria-label="Allocate ${esc(group.currency)} for robot trading" title="Allocate to trading robot">◈</button><button data-buy="${esc(w?.account_id||'')}" aria-label="Buy ${esc(group.currency)}">⇄</button><button data-receive="${esc(w?.account_id||'')}" aria-label="Receive ${esc(group.currency)}">▦</button>${isAdmin()&&w?.account_id?`<button type="button" data-archive-wallet="${esc(w.account_id)}" aria-label="Remove ${esc(group.currency)} from wallet scroller" title="Remove wallet card">×</button>`:'' }${w&&canSend(w)?`<button data-send="${esc(w.account_id)}" aria-label="Send ${esc(group.currency)}" ${busy?'disabled':''}>↗</button>`:''}</div><p class="form-error" role="alert" data-wallet-error>${issue?.network===group.network?esc(issue.message):''}</p></article>`;}).join('')||(walletListFailed?'':'<button class="crypto-add-card" data-add-asset>＋ Select your first accepted currency</button>');
  host.querySelectorAll('[data-wallet-group]').forEach(card=>{
   const group=walletGroup(card.dataset.walletGroup),chooser=card.querySelector('[data-wallet-network]');chooser.value=group.network;chooser.onchange=()=>chooseNetwork(group.key,chooser.value);
   card.oncontextmenu=e=>{if(e.target.closest('select,input,button'))return;e.preventDefault();openTradingDelegation(card,group.key);};card.querySelector('[data-delegate]').onclick=()=>openTradingDelegation(card,group.key);card.querySelector('[data-buy]').onclick=()=>{const w=walletGroup(group.key);purchase(w.currency,w.network);};card.querySelector('[data-receive]').onclick=()=>receive(group.key);
   const button=card.querySelector('[data-send]');if(button)button.onclick=()=>{const active=walletGroup(group.key);if(!button.disabled&&active?.holding?.account_id===button.dataset.send&&!receivingBusy(active))send(active.holding);};
  });
  host.querySelectorAll('[data-archive-wallet]').forEach(b=>b.onclick=()=>changeWalletVisibility(b.dataset.archiveWallet,false,b));
  host.querySelectorAll('[data-add-asset]').forEach(button=>button.onclick=addAsset);
 }
 async function ensureWallet(key,network){
  const group=walletGroup(key);if(!group)return null;const existing=holdingAt(group,network);if(existing?.address_id||group.scope!=='FUNDING')return existing;
  const jobKey=JSON.stringify([group.userId,group.assetId]),version=lifecycle,who=actorKey;let job=activationJobs.get(jobKey);
  if(!job){job=(async()=>{await api('crypto/activate',{userId:group.userId,assetId:group.assetId},crypto.randomUUID());if(!currentContext(version,who))return;const serial=++walletRead,received=await api('views/cryptowallets');if(currentContext(version,who)&&serial>=walletApplied){data.cryptowallets=received.rows||[];walletApplied=serial;renderWallets();}})();activationJobs.set(jobKey,job);}
  try{await job;}finally{if(activationJobs.get(jobKey)===job)activationJobs.delete(jobKey);}
  if(!currentContext(version,who))return null;
  const active=walletGroup(key),holding=active&&holdingAt(active,network);if(!holding?.address_id)throw new Error('Could not load the selected blockchain wallet.');return holding;
 }
 async function chooseNetwork(key,network){
  const group=walletGroup(key);if(!group?.networks.includes(network))return;
  const version=(selectionVersions.get(key)||0)+1,context=lifecycle,who=actorKey;selectionVersions.set(key,version);selectedNetworks.set(key,network);walletIssues.delete(key);renderWallets();
  if(receiveState?.key===key)return loadReceive(receiveState);
  try{await ensureWallet(key,network);}catch(e){if(currentContext(context,who)&&selectionVersions.get(key)===version&&selectedNetworks.get(key)===network)walletIssues.set(key,{network,message:e.message});}
  if(currentContext(context,who)&&selectionVersions.get(key)===version)renderWallets();
 }
 async function form(title,html,submit,label='Save'){
  const el=modal(title,`<form><div class="crypto-form-grid">${html}</div><p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" data-cancel>Cancel</button><button class="primary" type="submit">${esc(label)}</button></div></form>`),f=el.querySelector('form');el.querySelector('[data-cancel]').onclick=()=>el.close();let busy=false;f.onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;const b=f.querySelector('[type=submit]');b.disabled=true;const key=crypto.randomUUID();try{await submit(Object.fromEntries(new FormData(f)),key);el.close();if(root)await mount(root);}catch(e){error(e,f.querySelector('.form-error'));}finally{busy=false;b.disabled=false;}};return f;
 }
 async function mount(target){rollingConverter?.close();rollingConverter=null;allowanceScroller?.close();allowanceScroller=null;delegation?.remove();delegation=null;const who=actor();if(actorKey!==who||root&&root!==target){lifecycle++;receiveState=null;delegation?.remove();delegation=null;dialog?.close();dialog=null;selectedNetworks.clear();activationJobs.clear();walletIssues.clear();selectionVersions.clear();data={};}actorKey=who;root=target;const serial=++epoch,context=lifecycle,walletSerial=++walletRead,catalogueSerial=++catalogueRead;const names=['cryptocatalogue','cryptowallets','walletdelegations','cryptosecurities','cryptonetworks',...(isAdmin()?['cryptorobots','customers','securitypositions','treasurypositions']:[])];
  target.innerHTML='<div class="crypto-loading" role="status">Loading your wallets…</div>';
  // Market data can arrive independently while the operator uses the wallets.
  const marketRead=api('views/cryptomarkets').then(({rows})=>({rows}),error=>({error}));
  const reads=await Promise.allSettled(names.map(name=>api('views/'+name)));
  if(serial!==epoch||root!==target||!currentContext(context,who))return;
  const previous=data;
  const failures=new Map();
  data={cryptomarkets:[]};
  reads.forEach((result,index)=>{
   const view=names[index];
   if(result.status==='fulfilled'){data[view]=result.value.rows;return;}
   data[view]=[];
   failures.set(view,result.reason);
   console.error('CRYPTO_VIEW_READ_FAILED',view,result.reason.code||result.reason.name,result.reason.requestId||'');
  });
  if(walletSerial<walletApplied){data.cryptowallets=previous.cryptowallets||[];failures.delete('cryptowallets');}
  else walletApplied=walletSerial;
  if(catalogueSerial<catalogueApplied){data.cryptocatalogue=previous.cryptocatalogue||[];failures.delete('cryptocatalogue');}
  else catalogueApplied=catalogueSerial;
  walletListFailed=failures.has('cryptowallets');
  assetOptionError=failures.get('cryptocatalogue')||failures.get('cryptonetworks')||failures.get('customers');
  const firstError=(...views)=>esc(views.map(view=>failures.get(view)).find(Boolean)?.message||'');
  target.innerHTML=`
   <section class="crypto-section" id="crypto-wallet-desk"><div class="crypto-section-heading"><div><span class="crypto-section-number">I</span><h2>Payment & exchange wallets</h2></div><div class="crypto-inline-actions"><button type="button" data-refresh>Refresh</button><button class="primary" data-add-asset aria-label="Add accepted currency">＋ Add currency</button></div></div><p class="form-error" role="alert" data-crypto-error>${firstError('cryptowallets')}</p><div class="crypto-scroller" aria-label="Currency wallets" data-wallets></div><div class="crypto-inline-actions"><button data-purchase>Purchase crypto</button>${isAdmin()?basketPolicyFields:''}<button data-sell>Convert to FIAT</button></div></section>

   <section class="crypto-section crypto-trading-desk" id="crypto-trading-desk" aria-label="AVISPay high-speed trading platform">
    <p class="form-error" role="alert" data-trading-read-error>${firstError('cryptorobots','walletdelegations')}</p><div data-trading-allowances></div><div class="crypto-trading-console" data-trading-panel></div>
    ${isAdmin()?'<details class="crypto-connectors"><summary>Registered rolling settlement channels</summary><div class="crypto-inline-actions"><button data-channel>＋ Trading channel</button></div><div class="crypto-robot-channels">'+data.cryptorobots.filter(r=>r.mode==='REAL').map(r=>'<article><strong>'+esc(r.name)+'</strong><p>'+esc(r.chain_channel)+' · '+esc(r.settlement_asset)+'</p>'+details([['Security quantity',fmt(r.security_amount)],['Gross settlement',fmt(r.gross_value)],['State',r.state]])+'<div class="crypto-inline-actions">'+[['LOCK','Lock margin'],['APPROVE','Approve settlement'],['ROLL','Review next trade'],['BATCH','Review parallel batch'],['CLOSE','Close channel'],['RELEASE','Release margin']].map(([a,t])=>'<button data-chain-action="'+a+'" data-card="'+esc(r.card_id)+'" data-channel-id="'+esc(r.channel_id)+'">'+t+'</button>').join('')+'</div></article>').join('')+'</div></details>':''}
   </section>
   ${legacyInactive()&&isAdmin()?`<section class="crypto-section" id="crypto-rolling-desk"><div class="crypto-section-heading"><div><span class="crypto-section-number">III</span><h2>Rolling-token converter</h2></div></div><div data-rolling-converter></div></section>`:''}
   ${legacyInactive()?`<details class="crypto-section crypto-spare-converter" id="crypto-security-desk"><summary class="crypto-section-heading"><span>Stock → Blockchain asset converter</span><span>Spare technology</span></summary>`:`<section class="crypto-section" id="crypto-security-desk"><div class="crypto-section-heading"><div><span class="crypto-section-number">III</span><h2>Stock → Blockchain asset converter</h2></div><span>Security register · tokenisation · custody</span></div>`}
    <p class="form-error" role="alert" data-securities-read-error>${firstError('cryptosecurities','securitypositions','treasurypositions')}</p><div class="crypto-scroller" role="list" aria-label="Security wallets" data-security-wallets></div><div data-security-detail></div>${legacyInactive()?'</details>':'</section>'}
   <section class="crypto-section" id="crypto-market-desk"><div class="crypto-section-heading"><div><span class="crypto-section-number">IV</span><h2>Market performance</h2></div><select aria-label="Market selection" data-market-filter><option value="top">Top 100 currencies</option><option value="performance">Top 10 performers</option></select></div><p class="form-error" role="alert" data-market-read-error></p><div class="crypto-scroller" data-markets></div><p class="crypto-source">Market data: CoinGecko · observation time shown per currency</p></section>
   ${isAdmin()?`<section class="crypto-section"><div class="crypto-section-heading"><div><span class="crypto-section-number">V</span><h2>Accepted currencies & blockchains</h2></div><button data-market-refresh>Refresh market prices</button></div><p class="form-error" role="alert" data-catalogue-error>${firstError('cryptocatalogue','cryptonetworks')}</p><div class="crypto-admin-filter"><input type="search" data-catalogue-search aria-label="Search accepted currencies" placeholder="Search ${data.cryptocatalogue.length} currencies"><span>Green switches enable customer selection on that blockchain.</span></div><div class="crypto-catalogue" data-catalogue></div><details class="crypto-connectors"><summary>Blockchain API connections</summary><div>${data.cryptonetworks.map(n=>`<p><strong>${esc(n.name)}</strong> · ${esc(n.kind)} <button data-probe="${esc(n.code)}">Check API</button><span data-probe-result="${esc(n.code)}"></span></p>`).join('')}</div></details></section>`:''}`;
  q('[data-refresh]').onclick=()=>mount(target);target.querySelectorAll('[data-add-asset]').forEach(b=>b.onclick=addAsset);q('[data-purchase]').onclick=()=>purchase();if(isAdmin())void mountBasketPolicy(target,api,registerOffer);q('[data-sell]').onclick=sell;
  renderWallets();syncReceiveOptions();renderSecurityWallets();
  if(legacyInactive()&&isAdmin())rollingConverter=mountRollingConverterAdmin({host:q('[data-rolling-converter]'),api,isCurrent:()=>isAdmin()&&serial===epoch&&currentContext(context,who)});
  q('[data-market-filter]').onchange=markets;markets();if(isAdmin()){q('[data-channel]').onclick=channel;q('[data-catalogue-search]').oninput=catalogue;catalogue();q('[data-market-refresh]').onclick=async e=>{
   const button=e.currentTarget,issue=q('[data-market-read-error]');
   button.disabled=true;issue.textContent='';
   try{await api('crypto/markets/refresh',{});if(button.isConnected&&currentContext(context,who))await mount(target);}
   catch(e){if(button.isConnected)error(e,issue);}
   finally{button.disabled=false;}
  };target.querySelectorAll('[data-probe]').forEach(b=>b.onclick=async()=>{b.disabled=true;const el=target.querySelector(`[data-probe-result="${b.dataset.probe}"]`);try{const r=await api('crypto/check-network',{network:b.dataset.probe});el.textContent=' · Connected · '+new Date(r.checkedAt).toLocaleTimeString();}catch(e){el.textContent=' · '+e.message;}finally{b.disabled=false;}});}
  allowanceScroller=mountWalletTradingScroller({api,host:q('[data-trading-allowances]'),isCurrent:()=>serial===epoch&&currentContext(context,who)});
  if(isAdmin())void mountTradingPanel({api,host:q('[data-trading-panel]'),form,refresh:()=>mount(target),isAdmin:()=>isAdmin()&&serial===epoch&&currentContext(context,who)}).then(()=>{if(serial!==epoch||!currentContext(context,who))return;const panel=q('.trading-advanced');if(panel){panel.open=advancedExpanded;panel.addEventListener('toggle',()=>{if(panel.isConnected&&serial===epoch)advancedExpanded=panel.open;});}}).catch(e=>{if(serial===epoch&&currentContext(context,who))error(e,q('[data-trading-read-error]'));});
  const marketPaint=marketRead.then(result=>{
   if(serial!==epoch||!currentContext(context,who))return;
   if(result.error){
    console.error('CRYPTO_VIEW_READ_FAILED','cryptomarkets',result.error.code||result.error.name,result.error.requestId||'');
    error(result.error,q('[data-market-read-error]'));
    return;
   }
   data.cryptomarkets=result.rows;markets();
  });
  bindChain(target);if(selected&&securityCards().some(s=>s.card_id===selected))await showSecurity(selected);else if(data.cryptosecurities.some(s=>s.symbol==='aAVISP'))await showSecurity(data.cryptosecurities.find(s=>s.symbol==='aAVISP').card_id);else if(data.cryptosecurities.find(s=>s.mode==='REAL'))await showSecurity(data.cryptosecurities.find(s=>s.mode==='REAL').card_id);
  await marketPaint;
 }
 async function addAsset(){const accepted=data.cryptocatalogue.filter(a=>eligibleNetworks(a).length);const holder=isAdmin()?select('userId','Account holder',data.customers.map(u=>[u.user_id,u.full_name]),'required'):'';
  const f=await form('Add accepted currency',holder+select('assetId','Currency',accepted.map(a=>[a.asset_id,a.name+' · '+a.currency_code]),'required')+'<div class="crypto-included-networks"><span>Included blockchains</span><p data-included-networks>Select a currency.</p></div>',(v,k)=>api('crypto/activate',{assetId:v.assetId,userId:isAdmin()?v.userId:identity().customerUserId},k),'Activate currency');
  if(assetOptionError)error(assetOptionError,f.querySelector('.form-error'));
  f.elements.assetId.onchange=()=>{const a=accepted.find(a=>a.asset_id===f.elements.assetId.value);f.querySelector('[data-included-networks]').textContent=a?eligibleNetworks(a).map(n=>networkName(n.network)).join(' · '):'Select a currency.';};
  const native=f.elements.assetId,label=native.closest('label');label.classList.add('currency-native-control');
  const picker=document.createElement('details');picker.className='currency-icon-picker';picker.innerHTML='<summary aria-label="Select currency"><span data-currency-choice>Select currency</span></summary><div class="currency-icon-options"><input type="search" aria-label="Search currencies" placeholder="Search currency name or code"><div role="listbox" aria-label="Currencies with icons">'+accepted.map(a=>'<button type="button" role="option" aria-selected="false" data-currency-option="'+esc(a.asset_id)+'">'+icon(a)+'<span><strong>'+esc(a.name)+'</strong><small>'+esc(a.currency_code)+'</small></span></button>').join('')+'</div></div>';label.after(picker);
  const sync=native.onchange;native.onchange=()=>{sync();const a=accepted.find(a=>a.asset_id===native.value);picker.querySelector('[data-currency-choice]').innerHTML=a?icon(a)+'<span>'+esc(a.name)+' · '+esc(a.currency_code)+'</span>':'Select currency';picker.querySelectorAll('[data-currency-option]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.currencyOption===native.value)));};
  picker.querySelectorAll('[data-currency-option]').forEach(b=>b.onclick=()=>{native.value=b.dataset.currencyOption;native.onchange();picker.open=false;});
  picker.querySelector('input').oninput=e=>{const term=e.target.value.trim().toLowerCase();picker.querySelectorAll('[data-currency-option]').forEach(b=>b.hidden=!b.textContent.toLowerCase().includes(term));};
 }
 function receive(key,mode='receive'){
  const group=walletGroup(key);if(!group)return;
  if(receiveState?.key===key&&receiveState.mode===mode&&dialog===receiveState.el&&dialog.isConnected)return receiveState.network===group.network&&(receiveState.loading||receiveState.ready)?receiveState.pending:loadReceive(receiveState);
  const el=modal((mode==='activity'?'Wallet activity · ':'Receive ')+group.currency,`<div class="crypto-receive"><label>Blockchain<select name="network" data-receive-network aria-label="Blockchain">${networkOptions(group)}</select></label><div class="crypto-receive-content" data-receive-details></div>${mode==='receive'?'<div class="crypto-inline-actions"><button type="button" data-receive-details-open>Transaction details</button></div>':''}</div>`),state={key,el,mode,request:0,network:null,loading:false,ready:false};receiveState=state;
  const chooser=el.querySelector('[data-receive-network]');chooser.onchange=()=>chooseNetwork(key,chooser.value);const details=el.querySelector('[data-receive-details-open]');if(details)details.onclick=()=>receive(key,'activity');return loadReceive(state);
 }
 function loadReceive(state){
  const group=walletGroup(state.key);if(!group)return;
  const network=group.network,request=++state.request,context=lifecycle,who=actorKey,el=state.el,content=el.querySelector('[data-receive-details]'),chooser=el.querySelector('[data-receive-network]');
  state.network=network;state.loading=true;state.ready=false;chooser.innerHTML=networkOptions(group);chooser.value=network;content.innerHTML=state.mode==='activity'?'':'<p role="status">Loading receiving address…</p>';renderWallets();
  const current=()=>currentContext(context,who)&&receiveState===state&&dialog===el&&el.isConnected&&state.request===request&&selectedNetworks.get(state.key)===network;
  state.pending=(async()=>{try{
   const activity=state.mode==='activity';
   const holding=activity?holdingAt(group,network):await ensureWallet(state.key,network);
   if(!current())return;
   if(!holding?.address_id)throw new Error('Could not load the selected blockchain wallet.');
   if(!activity){
    const w=await api('crypto/wallet',{addressId:holding.address_id});
    if(!current())return;
    if(String(w.address_id)!==String(holding.address_id)||w.network!==network)throw new Error('The receiving address does not match the selected blockchain wallet.');
    content.innerHTML=`<img class="crypto-qr" src="${esc(w.qr)}" alt="Receiving address QR code"><code>${esc(w.public_address)}</code>${w.destination_tag!=null?`<p>Destination tag: ${esc(w.destination_tag)}</p>`:''}<div class="crypto-inline-actions"><button data-copy>Copy address</button><button data-share aria-label="Share" title="Share receiving address">↗</button></div><p role="status" data-copy-status></p><p class="form-error" role="alert" data-receive-error></p>`;
    const issue=content.querySelector('[data-receive-error]');
   content.querySelector('[data-copy]').onclick=async()=>{if(!current())return;try{await navigator.clipboard.writeText(w.public_address);if(current())content.querySelector('[data-copy-status]').textContent='Address copied.';}catch(e){if(current())error(e,issue);}};
   content.querySelector('[data-share]').onclick=async()=>{if(!current())return;try{const text=holding.currency_code+' · '+w.network+'\n'+w.public_address+(w.destination_tag!=null?'\nTag: '+w.destination_tag:'');if(navigator.share)await navigator.share({title:'AVISPay receiving wallet',text});else{await navigator.clipboard.writeText(text);if(current())content.querySelector('[data-copy-status]').textContent='Wallet details copied for sharing.';}}catch(e){if(current()&&e.name!=='AbortError')error(e,issue);}};
    state.ready=true;
    return;
   }
   const allowDeposit=network==='ETHEREUM'&&['FUNDING','CUSTODY'].includes(holding.wallet_scope);
   content.innerHTML=`<button type="button" data-chain-balance>Read blockchain balance</button><p role="status" data-balance-result></p><p class="form-error" role="alert" data-activity-error></p>${allowDeposit?`<form data-deposit-form><h3>Confirm an incoming transfer</h3>${field('txHash','Transaction hash','text','required pattern="0x[a-fA-F0-9]{64}" minlength="66" maxlength="66" autocomplete="off" spellcheck="false"')}<p class="form-error" role="alert" data-deposit-error></p><button class="primary" type="submit">Check incoming transfer</button><p role="status" data-deposit-result></p></form>`:''}`;
   state.ready=true;
   const issue=content.querySelector('[data-activity-error]');
   const balanceButton=content.querySelector('[data-chain-balance]');balanceButton.onclick=async()=>{if(!current()||balanceButton.disabled)return;balanceButton.disabled=true;try{const r=await api('crypto/balance',{addressId:holding.address_id,assetId:holding.asset_id});if(current())content.querySelector('[data-balance-result]').textContent='Blockchain: '+fmt(r.balance)+' '+holding.currency_code+' · '+new Date(r.observedAt).toLocaleString();}catch(e){if(current())error(e,issue);}finally{if(current())balanceButton.disabled=false;}};
   const deposit=content.querySelector('[data-deposit-form]');if(deposit){let busy=false,lastHash,lastKey;deposit.onsubmit=async e=>{e.preventDefault();if(!current()||busy)return;const txHash=deposit.elements.txHash.value.trim(),button=deposit.querySelector('[type=submit]'),message=deposit.querySelector('[data-deposit-result]'),depositIssue=deposit.querySelector('[data-deposit-error]');if(txHash!==lastHash){lastHash=txHash;lastKey=crypto.randomUUID();}busy=true;button.disabled=true;depositIssue.textContent='';message.textContent='Checking the transaction receipt…';try{const r=await api('crypto/deposits/reconcile',{accountId:holding.account_id,addressId:holding.address_id,txHash},lastKey);if(current()){if(r.status==='CONFIRMED')message.textContent='Received '+fmt(r.amount)+' '+r.currency+' · '+r.txHash;else if(r.status==='MANAGED')message.textContent='This transfer is tracked by its AVISPay payment receipt.';else message.textContent='Confirmations: '+(r.confirmations||0)+' / 12'+(r.finalized?'':' · Awaiting blockchain finalization');}if(r.status==='CONFIRMED'&&currentContext(context,who))await mount(root);}catch(e){if(current()){message.textContent='';error(e,depositIssue);}}finally{busy=false;if(current())button.disabled=false;}};}
  }catch(e){if(current()){content.innerHTML='<p class="form-error" role="alert" data-receive-error></p>';error(e,content.querySelector('[data-receive-error]'));}}
  finally{if(current()){state.loading=false;renderWallets();}}
  })();return state.pending;
 }
 async function showSecurity(id){
  if(!root)return;selected=id;const serial=epoch,context=lifecycle,who=actorKey;
  renderSecurityWallets();q('[data-security-detail]').innerHTML='<article class="security-detail"><p role="status">Loading security wallet…</p><p class="form-error" role="alert" data-security-error></p></article>';
  const current=()=>serial===epoch&&selected===id&&currentContext(context,who);
  try{
   const s=await api('crypto/securities/'+id);if(!current())return;
   if(!s||s.card_id!==id)throw new Error('Could not load the selected security wallet.');
   const row=data.cryptosecurities.find(c=>c.card_id===id);if(row)Object.assign(row,s);
   renderSecurityWallets();
   const source=s.sourceHolding,slot=securitySlot(s),title=securityTitle(s);
   const d=source?{...s.dossier,assetType:source.assetType,isin:source.isin,cusip:source.cusip,currency:source.currency,assetValue:source.assetValue,issuedVolume:source.quantity,faceValue:source.price,collateralHouseRef:source.reference,source:source.source}:
    s.mode==='DEMO'?{assetType:slot?null:s.dossier?.assetType}:s.dossier||{};
   const percent=value=>value==null?'—':value/100+'%';
   q('[data-security-detail]').innerHTML=`<article class="security-detail"><div class="crypto-section-heading"><h3>${esc(title)} · Asset contents & conversion</h3><span class="crypto-badge">${s.symbol==='aAVISP'?'Portfolio-linked security':slot?'Security wallet':esc(s.network||'Security')}</span></div><div class="security-conversion"><div><p class="eyebrow">SOURCE ASSET</p>${details([['Asset name',source?.name||(slot?'—':s.name)],['Security',d.assetType],['ISIN',d.isin],['CUSIP',d.cusip],['Asset value',d.assetValue==null?'—':fmt(d.assetValue)+' '+(d.currency||'')],['Issued volume',fmt(d.issuedVolume)],['Value per token',d.faceValue==null?'—':fmt(d.faceValue)+' '+(d.currency||'')],['Custody reference',d.collateralHouseRef],['Source',d.source]])}</div><div class="conversion-code-column"><strong>CONVERTER CODE</strong><span class="conversion-arrow" aria-hidden="true">⇄</span><code>${esc(s.conversion_code||'—')}</code></div><div><p class="eyebrow">ROLLING TRADE-LOOP SECURITY</p>${details([['Token',slot?'—':s.symbol],[s.state==='BOOKED'?'Token volume':'Tokens to issue',s.mode==='REAL'?fmt(s.token_quantity):'—'],['Receiving wallet',s.wallet_public_address],['Margin haircut',percent(d.marginHaircutBps)],['Trading fee',percent(d.tradingFeeBps)],['Blockchain',s.network],['Contract address',s.contract_address],['Conversion code',s.conversion_code],['Wallet booking',s.journal_id]])}</div></div><div class="crypto-inline-actions">${isAdmin()&&!legacyInactive()&&s.mode==='DEMO'?'<button class="primary" data-real-prepare>'+((source?.bookingId&&!source.positionId)?'Register source holding':s.symbol==='aAVISP'?'Convert Portfolio security':'Select Portfolio security')+'</button>':''}${s.wallet_address_id?'<button type="button" data-security-receive-detail>Receive security</button>':isAdmin()&&!legacyInactive()?'<button type="button" data-security-wallet>Create security receiving wallet</button>':''}${isAdmin()&&!legacyInactive()&&s.mode==='REAL'&&s.state!=='BOOKED'?`<button class="primary" data-chain-action="${!s.hub_address?'HUB':!s.contract_address?'DEPLOY':!s.dossier?.capConfirmed?'CAP':'MINT'}" data-card="${s.card_id}">${!s.hub_address?'Review hub deployment':!s.contract_address?'Review security deployment':!s.dossier?.capConfirmed?'Review custody cap':'Review treasury wallet booking'}</button>`:''}${isAdmin()&&!slot?'<button data-contract-package>Download contract & dossier</button>':''}</div><p class="form-error" role="alert" data-security-error></p>${s.actions?.length?`<div class="crypto-action-history"><h4>Contract transactions</h4>${s.actions.map(a=>`<p><strong>${esc(a.action_type)}</strong> · ${esc(a.status)} ${a.tx_hash?`<code>${esc(a.tx_hash)}</code>`:''}${['SIGNED','SUBMITTED'].includes(a.status)?` <button data-confirm-action="${a.action_id}">Check receipt</button>`:''}</p>`).join('')}</div>`:''}${s.sourceSpecification?`<p class="crypto-source">Contract source: ${esc(s.sourceSpecification)}</p>`:''}</article>`;
   if(q('[data-real-prepare]'))q('[data-real-prepare]').onclick=()=>prepareReal(s);
   if(q('[data-security-wallet]'))q('[data-security-wallet]').onclick=()=>createSecurityReceivingWallet(s);
   if(q('[data-security-receive-detail]'))q('[data-security-receive-detail]').onclick=()=>receiveSecurityWallet(s);
   if(q('[data-contract-package]'))q('[data-contract-package]').onclick=async()=>{try{const p=await api('crypto/securities/package',{cardId:id});if(!current())return;const blob=new Blob([JSON.stringify(p,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=s.symbol+'-rolling-contract.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){if(current())error(e,q('[data-security-error]'));}};
   bindChain(q('[data-security-detail]'));q('[data-security-detail]').querySelectorAll('[data-confirm-action]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const r=await api('crypto/actions/confirm',{actionId:b.dataset.confirmAction});if(!current())return;if(r.status!=='CONFIRMED'&&r.status!=='FAILED')notice('Confirmations: '+r.confirmations+' / 12');await mount(root);}catch(e){if(current())error(e,q('[data-security-error]'));}finally{if(b.isConnected)b.disabled=false;}});
  }catch(e){if(current())error(e,q('[data-security-error]'));}
 }
 async function registerSource(s){
  if(legacyInactive())return;
  const context=lifecycle,who=actorKey,current=()=>currentContext(context,who)&&selected===s.card_id;
  try{await openTreasurySource({api,modal,bookingId:s.sourceHolding.bookingId,isCurrent:current,onRegistered:async()=>{if(current()){await mount(root);if(current())await showSecurity(s.card_id);}}});}
  catch(e){if(current())error(e,q('[data-security-error]'));}
 }
 async function prepareReal(s){
  if(legacyInactive())return;
  if(s.sourceHolding?.bookingId&&!s.sourceHolding.positionId)return registerSource(s);
  const cardWallet=s.wallet_address_id&&s.wallet_public_address?[{address_id:s.wallet_address_id,public_address:s.wallet_public_address,user_id:s.user_id,full_name:s.name,account_role:'INSTITUTION',network:s.network}]:[];
  const conversionWallets=[...data.cryptowallets,...cardWallet].filter(w=>w.account_role==='INSTITUTION'&&w.address_id&&data.cryptonetworks.some(n=>n.code===w.network&&n.kind==='EVM'))
   .filter(w=>(!s.user_id||String(w.user_id)===String(s.user_id))&&(!s.network||w.network===s.network)&&(!s.wallet_address_id||String(w.address_id)===String(s.wallet_address_id)))
   .filter((w,i,a)=>a.findIndex(v=>v.address_id===w.address_id)===i);
  const positions=data.securitypositions.filter(p=>(p.account_role==='INSTITUTION'||data.customers.some(u=>String(u.user_id)===String(p.user_id)&&u.account_role==='INSTITUTION'))&&(!s.user_id||String(p.user_id)===String(s.user_id)));
  const available=p=>p.available_quantity??p.quantity;
  const f=await form('Prepare '+securityTitle(s)+' conversion',
   select('positionId','Registered security holding',positions.map(p=>[p.position_id,p.name+' · '+fmt(available(p))+' available units']),'required')+
   (securitySlot(s)?field('tokenSymbol','Token symbol','text','required maxlength="25" pattern="[A-Za-z][A-Za-z0-9._\\-]{0,24}" autocapitalize="off"'):'' )+
   field('quantity','Source security quantity','text','required inputmode="decimal"')+
   field('tokenQuantity','Tokens to issue','text','required inputmode="decimal"')+
   field('custodyReference','Collateral House custody reference','text','required maxlength="128"')+
   select('addressId','Institution blockchain wallet',[],'required')+
   field('marginHaircutBps','Margin haircut (basis points)','number','required min="0" max="9999" value="1500"')+
   field('tradingFeeBps','Trading fee (basis points)','number','required min="0" max="10000" value="10"')+
   '<label class="crypto-check"><input name="greenHighTechVerified" type="checkbox" required> Green High-Tech asset verified in the registered dossier</label>',
   (v,k)=>{
    const p=positions.find(p=>p.position_id===v.positionId),w=conversionWallets.find(w=>String(w.address_id)===v.addressId&&String(w.user_id)===String(p?.user_id));
    if(!w)throw Object.assign(new Error('Select a blockchain wallet for this institution.'),{field:'addressId'});
    return api('crypto/securities/prepare',{...v,cardId:s.card_id,network:w.network,marginHaircutBps:Number(v.marginHaircutBps),tradingFeeBps:Number(v.tradingFeeBps),greenHighTechVerified:v.greenHighTechVerified==='on'},k);
   },'Prepare conversion');
  const sync=()=>{
   const p=positions.find(p=>p.position_id===f.elements.positionId.value),previous=f.elements.addressId.value;
   const wallets=conversionWallets.filter(w=>String(w.user_id)===String(p?.user_id));
   f.elements.addressId.innerHTML='<option value="">Select…</option>'+wallets.map(w=>`<option value="${esc(w.address_id)}">${esc(w.full_name+' · '+w.network+' · '+w.public_address)}</option>`).join('');
   if(wallets.some(w=>String(w.address_id)===previous))f.elements.addressId.value=previous;
   else if(wallets.some(w=>String(w.address_id)===String(s.wallet_address_id)))f.elements.addressId.value=String(s.wallet_address_id);
   f.elements.quantity.value=p?available(p):'';f.elements.tokenQuantity.value=p?available(p):'';
  };
  f.elements.positionId.onchange=sync;
  if(positions.some(p=>p.position_id===s.sourceHolding?.positionId))f.elements.positionId.value=s.sourceHolding.positionId;
  sync();
 }

 async function channel(){await form('Configure rolling trade channel',select('cardId','Security wallet',data.cryptosecurities.map(s=>[s.card_id,s.name+(s.mode==='DEMO'?' · Demo':'')]),'required')+field('channel','Channel number','number','min="1" required')+select('settlementAsset','Settlement currency',[['AG','AG'],['AGi','AGi']],'required')+field('securityAmount','Security quantity per channel','text','required inputmode="decimal"')+field('grossValue','Gross settlement per trade','text','required inputmode="decimal"'),(v,k)=>api('crypto/robot/channels',v,k));}
 function bindChain(target){target?.querySelectorAll('[data-chain-action]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{if(legacyInactive()&&['HUB','DEPLOY','CAP','MINT'].includes(b.dataset.chainAction))return;const r=await api('crypto/actions/review',{cardId:b.dataset.card,action:b.dataset.chainAction,channelId:b.dataset.channelId,cycles:1});const el=modal('Review '+r.action.toLowerCase()+' transaction',details([['Blockchain',r.instruction.chainId],['From wallet',r.instruction.from],['Contract',r.instruction.to||'New contract'],['Maximum network fee',r.instruction.feeMaximum+' '+r.instruction.nativeCurrency]])+'<p class="form-error" role="alert"></p><div class="dialog-actions"><button data-cancel>Close</button><button class="primary" data-submit>Sign & submit</button></div>');let submitted=false,signing=false;el.addEventListener('close',()=>{if(!submitted&&!signing)void api('crypto/actions/cancel',{actionId:r.id}).catch(()=>{});},{once:true});el.querySelector('[data-cancel]').onclick=()=>el.close();el.querySelector('[data-submit]').onclick=async e=>{e.currentTarget.disabled=true;signing=true;try{await api('crypto/actions/submit',{actionId:r.id,reviewHash:r.reviewHash});submitted=true;el.close();await mount(root);}catch(e){error(e,el.querySelector('.form-error'));el.querySelector('[data-submit]').disabled=false;}finally{signing=false;}};}catch(e){if(b.isConnected)error(e,b.closest('#crypto-trading-desk')?q('[data-trading-read-error]'):q('[data-security-error]'));}finally{b.disabled=false;}});}
 function markets(){
  const mode=q('[data-market-filter]').value;
  let rows=data.cryptomarkets.filter(a=>a.market_rank&&a.market_data.usd!==null&&a.market_data.usd!==undefined);
  rows=mode==='performance'?rows.filter(a=>marketChange(a.market_data.change24h)!==null).sort((a,b)=>marketChange(b.market_data.change24h)-marketChange(a.market_data.change24h)).slice(0,10):rows.sort((a,b)=>a.market_rank-b.market_rank).slice(0,100);
  q('[data-markets]').innerHTML=rows.map(a=>{
   const m=a.market_data,c=marketChange(m.change24h),direction=c===null?'unknown':c>0?'up':c<0?'down':'flat';
   return `<article class="crypto-market"><div>${icon(a)}<strong>${esc(a.currency_code)}</strong><span class="market-arrow ${direction}" aria-label="${c===null?'24-hour change not reported':direction}">${c===null?'—':direction==='up'?'↑':direction==='down'?'↓':'→'}</span></div>${details([['USD',fmt(m.usd)],['EUR',fmt(m.eur)],['CHF',fmt(m.chf)]])}<span class="market-change ${direction}">${c===null?'—':(c>0?'+':'')+c.toFixed(2)+'%'}</span><small>${m.observedAt?esc(new Date(m.observedAt).toLocaleString()):''}</small></article>`;
  }).join('');
 }
 function catalogue(){const query=q('[data-catalogue-search]').value.toLowerCase(),rows=data.cryptocatalogue.filter(a=>(a.name+' '+a.currency_code).toLowerCase().includes(query));q('[data-catalogue]').innerHTML=rows.map(a=>`<article class="crypto-currency-row"><div>${icon(a)}<strong>${esc(a.name)}</strong><span>${esc(a.currency_code)}</span></div><div class="crypto-network-switches">${a.networks.map(n=>`<button role="switch" aria-checked="${n.approved}" class="crypto-switch ${n.approved?'enabled':''}" data-approve="${esc(a.asset_id)}" data-network="${esc(n.network)}" title="${esc(n.contractAddress||'Native currency')}"><span></span>${esc(n.network)}</button>`).join('')||'<span class="crypto-source">No mapped blockchain in this catalogue record</span>'}</div><p class="form-error" role="alert"></p></article>`).join('');q('[data-catalogue]').querySelectorAll('[data-approve]').forEach(b=>b.onclick=async()=>{
  if(b.disabled)return;b.disabled=true;const el=b.closest('article').querySelector('.form-error'),context=lifecycle,who=actorKey;
  try{const approved=b.getAttribute('aria-checked')!=='true';await api('crypto/approve',{assetId:b.dataset.approve,network:b.dataset.network,approved});if(!currentContext(context,who))return;
   const serial=++catalogueRead,result=await api('views/cryptocatalogue');if(!currentContext(context,who)||serial<catalogueApplied)return;data.cryptocatalogue=result.rows||[];catalogueApplied=serial;
   q('[data-catalogue]')?.querySelectorAll('[data-approve]').forEach(button=>{const pair=data.cryptocatalogue.find(a=>a.asset_id===button.dataset.approve)?.networks.find(n=>n.network===button.dataset.network);button.classList.toggle('enabled',!!pair?.approved);button.setAttribute('aria-checked',String(!!pair?.approved));});
   renderWallets();syncReceiveOptions();el.textContent='';
  }catch(e){if(currentContext(context,who))error(e,el);}finally{b.disabled=false;}
 });}
 return {mount,close};
}
