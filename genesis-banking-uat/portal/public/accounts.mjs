const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=s=>{const[w,f='']=String(s??0).split('.');return w.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+f.replace(/0+$/,'').padEnd(2,'0');};
const date=s=>s?new Date(s).toLocaleString():'—';
const abiq=s=>/^TN\d{2}AVIP000\d{15}$/.test(s||'')?s.slice(0,14)+' '+s.slice(14):s;
export const accountTypes=[['PERSONAL','Personal'],['BUSINESS','Business'],['COMMON','Common Account'],['SUSPENSE','Suspense Account']];
const name=type=>accountTypes.find(t=>t[0]===type)?.[1]||type;
const backoffice=a=>['COMMON','SUSPENSE'].includes(a.account_type);
function accountRows(rows){
 return rows.map(r=>`<tr data-account-row="${esc(r.account_id)}" data-backoffice="${backoffice(r)}" tabindex="0"><td>${backoffice(r)?'<span>'+esc(r.display_name)+'</span><br>':''}<span class="account-number">${esc(abiq(r.account_reference))}</span></td><td>${esc(name(r.account_type))}</td><td>${esc(r.currency_code)}${r.network?' · '+esc(r.network):''}</td><td>${esc(number(r.credit))}</td><td>${esc(number(r.debit))}</td><td>${esc(r.reference_id||'—')}</td><td>${esc(number(r.available_balance))}</td><td>${esc(number(r.locked_balance))}</td><td class="account-row-actions"><button type="button" data-movements-toggle aria-expanded="false" aria-label="Show movements for ${esc(r.account_reference)}">Movements</button><button type="button" data-open-account>${backoffice(r)?'View statement':'View details'}</button></td></tr><tr data-movements-for="${esc(r.account_id)}" hidden><td colspan="9"></td></tr>`).join('');
}
function groups(rows,isBackoffice){
 const grouped=new Map();for(const a of rows){const key=isBackoffice?a.account_type:String(a.user_id);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(a);}
 return [...grouped.values()].map((accounts,i)=>{const a=accounts[0],title=isBackoffice?name(a.account_type):a.full_name;return `<details class="account-group" ${i===0?'open':''}><summary><span>${esc(title)}${isBackoffice?'':` · User ${esc(a.user_id)}`}</span><span>${accounts.length} accounts</span></summary><div class="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th>Currency / asset</th><th>Credit</th><th>Debit</th><th>Reference</th><th>Available</th><th>Reserved</th><th></th></tr></thead><tbody>${accountRows(accounts)}</tbody></table></div></details>`;}).join('');
}
export function accountSummaryTable(rows,title='Account summary'){return `<section class="panel account-summary"><div class="panel-header"><h2>${esc(title)}</h2><span>${rows.length} accounts</span></div>${groups(rows,false)}</section>`;}
export function backofficeAccountTable(rows){return `<section class="panel account-summary"><div class="panel-header"><h2>Backoffice accounts</h2><span>${rows.length} accounts</span></div>${groups(rows,true)}${rows.length?'':'<p class="panel-empty">No accounts of this type yet.</p>'}</section>`;}
const entryRows=(accountId,rows)=>rows.map(e=>`<tr data-movement="${esc(e.entry_id)}" data-account="${esc(accountId)}" tabindex="0"><td>${esc(date(e.created_at))}</td><td>${esc(e.reference_id||'—')}</td><td>${e.direction==='CREDIT'?esc(number(e.amount)):''}</td><td>${e.direction==='DEBIT'?esc(number(e.amount)):''}</td><td>${esc(number(e.running_balance))}</td><td><button type="button">View movement</button></td></tr>`).join('');
const movementTable=(accountId,entries)=>`<div class="table-wrap"><table class="account-movements"><thead><tr><th>Date and time</th><th>Reference</th><th>Credit</th><th>Debit</th><th>Balance</th><th></th></tr></thead><tbody>${entryRows(accountId,entries)}</tbody></table></div>`;
const fields=values=>`<dl class="account-detail-fields">${values.filter(([,v])=>v!==null&&v!==undefined&&v!=='').map(([label,v])=>`<dt>${esc(label)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
const accountFields=a=>fields([['Account holder / name',a.display_name],['User',a.user_id],['Account type',name(a.account_type)],['Account',abiq(a.account_reference)],['BIC',a.abiq_bic],['Currency / asset',a.currency_code],['Blockchain',a.network],['Status',a.status],['Address',a.postal_address?Object.values(a.postal_address).filter(Boolean).join(', '):null],['Available',number(a.available_balance)],['Reserved',number(a.locked_balance)]]);
export function createAccountStatements({api}){
 const dialog=document.createElement('dialog');dialog.className='account-statement-dialog';document.body.append(dialog);
 let generation=0;
 const close=()=>{generation++;dialog.close();dialog.replaceChildren();dialog.removeAttribute('style');};
 dialog.oncancel=e=>{e.preventDefault();close();};
 function heading(title,subtitle){return `<div class="dialog-heading account-window-handle"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="close" type="button" aria-label="Close account statement">×</button></div>`;}
 function show(){
  dialog.querySelector('.close').onclick=close;if(!dialog.open)dialog.showModal();
  const handle=dialog.querySelector('.account-window-handle');handle.onpointerdown=e=>{
   if(e.button!==0||e.target.closest('button'))return;const r=dialog.getBoundingClientRect(),x=e.clientX,y=e.clientY;handle.setPointerCapture(e.pointerId);
   handle.onpointermove=m=>{if(!handle.hasPointerCapture(m.pointerId))return;dialog.style.margin='0';dialog.style.left=Math.max(0,Math.min(innerWidth-r.width,r.left+m.clientX-x))+'px';dialog.style.top=Math.max(0,Math.min(innerHeight-50,r.top+m.clientY-y))+'px';};
   handle.onpointerup=m=>{handle.releasePointerCapture(m.pointerId);handle.onpointermove=null;};
  };
 }
 function bindMovements(container){container.querySelectorAll('[data-movement]').forEach(row=>{
  const open=()=>movement(row.dataset.account,row.dataset.movement).catch(e=>showError(container,e));row.onclick=()=>void open();row.onkeydown=e=>{if(e.target===row&&e.key==='Enter'){e.preventDefault();void open();}};
 });}
 function showError(container,error){const el=container.querySelector('.form-error')||document.querySelector('#account-page-error');if(el)el.textContent=error.message;}
 function older(container,id,next,valid){
  const button=container.querySelector('[data-older]');button.hidden=!next;
  button.onclick=async()=>{if(!next||button.disabled)return;button.disabled=true;
   try{const page=await api('accounts/'+id+'?before='+encodeURIComponent(next));if(!valid())return;container.querySelector('.account-movements tbody').insertAdjacentHTML('beforeend',entryRows(id,page.entries));next=page.nextCursor;button.hidden=!next;bindMovements(container);}
   catch(e){if(valid())showError(container,e);}finally{button.disabled=false;}
  };
 }
 async function open(id,isBackoffice=false){
  const serial=++generation,r=await api(isBackoffice?'backoffice-accounts/'+id+'/statement':'accounts/'+id);if(serial!==generation)return;const a=r.account;
  dialog.innerHTML=heading(backoffice(a)?name(a.account_type)+' statement':'Account details',a.display_name+' · '+a.currency_code)+`<div class="account-statement-content">${accountFields(a)}<div class="metrics"><div class="metric"><p>Total credit</p><strong>${esc(number(r.totals.incoming))}</strong></div><div class="metric"><p>Total debit</p><strong>${esc(number(r.totals.outgoing))}</strong></div><div class="metric"><p>Balance</p><strong>${esc(number(a.available_balance))} ${esc(a.currency_code)}</strong></div></div>${movementTable(id,r.entries)}${r.entries.length?'':'<p>No movements recorded for this account.</p>'}<button type="button" data-older>Load older entries</button><p class="form-error" role="alert"></p></div>`;
  older(dialog,id,r.nextCursor,()=>serial===generation);bindMovements(dialog);show();
 }
 async function movement(id,entryId){
  const serial=++generation,r=await api('accounts/'+id+'/movements/'+entryId);if(serial!==generation)return;const e=r.entry,a=r.account;
  dialog.innerHTML=heading('Movement details',e.reference_id||'Account movement')+`<div class="account-statement-content">${fields([['Date and time',date(e.created_at)],['Reference',e.reference_id],['Operation',e.event_type],['Credit',e.direction==='CREDIT'?number(e.amount)+' '+a.currency_code:'—'],['Debit',e.direction==='DEBIT'?number(e.amount)+' '+a.currency_code:'—'],['Balance after movement',number(e.running_balance)+' '+a.currency_code],['Movement ID',e.entry_id],['Journal reference',e.journal_id],['Reverses journal',e.reverses_journal_id]])}${accountFields(a)}<button type="button" data-back-account>Back to account</button><p class="form-error" role="alert"></p></div>`;
  dialog.querySelector('[data-back-account]').onclick=()=>open(id,backoffice(a)).catch(e=>showError(dialog,e));show();
 }
 function bind(container){container.querySelectorAll('[data-account-row]').forEach(row=>{
  const id=row.dataset.accountRow,isBackoffice=row.dataset.backoffice==='true';
  const view=()=>open(id,isBackoffice).catch(e=>showError(container,e));
  row.onclick=e=>{if(!e.target.closest('[data-movements-toggle]'))void view();};row.onkeydown=e=>{if(e.target===row&&e.key==='Enter'){e.preventDefault();void view();}};
  const toggle=row.querySelector('[data-movements-toggle]'),detail=row.nextElementSibling;
  toggle.onclick=async()=>{
   detail.hidden=!detail.hidden;toggle.setAttribute('aria-expanded',String(!detail.hidden));if(detail.hidden||detail.dataset.loaded)return;
   const box=detail.firstElementChild;box.innerHTML='<p>Loading movements…</p>';
   try{const r=await api('accounts/'+id);if(!detail.isConnected)return;box.innerHTML=movementTable(id,r.entries)+(r.entries.length?'':'<p>No movements recorded for this account.</p>')+'<button type="button" data-older>Load older entries</button><p class="form-error" role="alert"></p>';detail.dataset.loaded='true';older(box,id,r.nextCursor,()=>detail.isConnected);bindMovements(box);}
   catch(e){if(detail.isConnected)box.innerHTML=`<p class="form-error" role="alert">${esc(e.message)}</p>`;}
  };
 });}
 return {open,close,bind};
}
