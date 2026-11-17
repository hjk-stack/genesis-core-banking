const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function allowanceText(value) {
 const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value ?? ''));
 if (!match) return '—';
 const fraction = (match[2] || '').replace(/0+$/, '');
 return match[1].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
}
export function allowanceIcon(row) {
 const code = String(row.currency_code || '').toUpperCase();
 if (code === 'AG') return '/crypto-icons/ag.png';
 if (code === 'AGI') return '/crypto-icons/agi.png';
 return /^https:\/\/(?:assets|coin-images)\.coingecko\.com\//.test(row.icon_url || '') ? row.icon_url : null;
}
export function eligibleAllowanceRows(input) {
 const seen = new Set();
 return (Array.isArray(input) ? input : []).filter(row => {
  if (!row || typeof row.account_id !== 'string' || seen.has(row.account_id) ||
      !row.currency_code || !row.network || typeof row.enabled !== 'boolean' ||
      !Number.isSafeInteger(row.version) || row.version < 0 ||
      !/^\d+(?:\.\d+)?$/.test(String(row.quantity)) || !/[1-9]/.test(String(row.quantity))) return false;
  seen.add(row.account_id);return true;
 });
}

// Selection is persisted by wallet account. This row is not a price ticker and
// does not substitute a public quote for an account's authorised trading amount.
export function mountWalletTradingScroller({api,host,isCurrent=()=>true,pollMs=15000}) {
 if (!host) return null;
 const doc=host.ownerDocument,win=doc.defaultView;
 let closed=false,timer=null,serial=0,mutation=0,rows=[],loading=true;
 const pending=new Set(),errors=new Map();
 const alive=()=>!closed&&host.isConnected&&isCurrent();
 host.classList.add('wallet-trading-strip');
 host.setAttribute('aria-label','Authorised coins for robot trading');
 if (!doc.querySelector('link[data-wallet-trading-style]')) {
  const link=doc.createElement('link');link.rel='stylesheet';link.href='/wallet-trading-scroller.css';
  link.dataset.walletTradingStyle='';doc.head.append(link);
 }
 host.innerHTML='<div class="wallet-trading-strip-heading"><strong>Trade allowances</strong><div><button type="button" data-wallet-scroll="-1" aria-label="Previous authorised coins">‹</button><button type="button" data-wallet-scroll="1" aria-label="Next authorised coins">›</button></div></div><div class="wallet-trading-coins" data-trading-allowance-coins role="list" aria-label="Select multiple coins for the robot" tabindex="0"></div><p class="form-error" role="alert" data-allowance-error></p>';
 const track=host.querySelector('[data-trading-allowance-coins]');
 function render() {
  if (!alive()) return;
  const scroll=track.scrollLeft,focus=doc.activeElement?.dataset?.selectTradingWallet;
  track.innerHTML=rows.length?rows.map(row=>{
   const src=allowanceIcon(row),id=esc(row.account_id),code=esc(row.currency_code);
   return `<article role="listitem" class="wallet-trading-coin${row.enabled?' is-selected':''}" data-trading-wallet="${id}"><div class="wallet-trading-coin-title">${src?`<img src="${esc(src)}" width="28" height="28" alt="">`:`<span class="wallet-trading-monogram">${code}</span>`}<div><strong>${code}</strong><small>${esc(row.name||row.currency_code)}</small></div></div><small class="wallet-trading-holder">${esc(row.full_name||'')} · ${esc(row.network)}</small><span class="wallet-trading-quantity">${esc(allowanceText(row.quantity))} ${code}</span><div class="wallet-trading-choice"><span>${row.enabled?'Selected':'Authorised'}</span><button type="button" role="switch" aria-checked="${row.enabled}" aria-label="Activate ${code} on ${esc(row.network)} for robot" data-select-trading-wallet="${id}" ${pending.has(row.account_id)?'disabled aria-busy="true"':''}>${row.enabled?'Pause':'Activate'}</button></div><p role="alert" class="form-error" data-wallet-selection-error>${esc(errors.get(row.account_id)||'')}</p></article>`;
  }).join(''):`<p class="wallet-trading-empty">${loading?'Loading trade allowances…':'Authorize a wallet trade allowance to add a coin.'}</p>`;
  track.scrollLeft=scroll;
  if(focus) [...track.querySelectorAll('[data-select-trading-wallet]')].find(b=>b.dataset.selectTradingWallet===focus)?.focus({preventScroll:true});
 }
 async function refresh() {
  clearTimeout(timer);
  if (!alive()) {close();return;}
  const request=++serial,epoch=mutation;
  try {
   const result=await api('views/tradingallowances');
   if(!alive()||request!==serial||epoch!==mutation)return;
   if(!Array.isArray(result?.rows))throw new Error('Trade allowances could not be read. Retry this row.');
   rows=eligibleAllowanceRows(result.rows);loading=false;
   host.querySelector('[data-allowance-error]').textContent='';render();
  } catch(error) {
   if(alive()&&request===serial){loading=false;host.querySelector('[data-allowance-error]').textContent=error.message;render();}
  } finally {
   if(alive()&&request===serial&&pollMs>0){timer=setTimeout(refresh,pollMs);timer.unref?.();}
  }
 }
 async function toggle(accountId) {
  const row=rows.find(item=>item.account_id===accountId);
  if(!alive()||!row||pending.has(accountId))return;
  pending.add(accountId);errors.delete(accountId);mutation++;render();
  const enabled=!row.enabled;
  try {
   const result=await api('crypto/trading/select-wallet',{accountId,enabled,expectedVersion:row.version},crypto.randomUUID());
   if(!alive())return;
   if(result.account_id!==accountId||result.enabled!==enabled||!Number.isSafeInteger(result.version))
    throw new Error('The wallet selection receipt did not match. Refresh this coin.');
   const current=rows.find(item=>item.account_id===accountId);
   if(current)Object.assign(current,{enabled:result.enabled,version:result.version,quantity:result.quantity??current.quantity});
  } catch(error) {
   if(alive())errors.set(accountId,error.message);
  } finally {
   pending.delete(accountId);mutation++;
   if(alive()){render();void refresh();}
  }
 }
 function clicked(event) {
  const toggleButton=event.target.closest('[data-select-trading-wallet]');
  if(toggleButton&&host.contains(toggleButton)){void toggle(toggleButton.dataset.selectTradingWallet);return;}
  const arrow=event.target.closest('[data-wallet-scroll]');
  if(arrow&&host.contains(arrow))track.scrollBy?.({left:Number(arrow.dataset.walletScroll)*Math.max(220,track.clientWidth*.75),behavior:'smooth'});
 }
 function keydown(event) {
  if(event.target!==track||!['ArrowLeft','ArrowRight'].includes(event.key))return;
  event.preventDefault();track.scrollBy?.({left:event.key==='ArrowRight'?240:-240,behavior:'smooth'});
 }
 const changed=()=>{void refresh();};
 function close(){if(closed)return;closed=true;serial++;clearTimeout(timer);host.removeEventListener('click',clicked);track.removeEventListener('keydown',keydown);win?.removeEventListener('avispay:trade-allowance-changed',changed);}
 host.addEventListener('click',clicked);track.addEventListener('keydown',keydown);
 win?.addEventListener('avispay:trade-allowance-changed',changed);
 render();const ready=refresh();
 return {ready,refresh,toggle,close};
}
