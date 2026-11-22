export async function openAccountCleanup(api,refresh) {
 const dialog=document.createElement('dialog');
 dialog.className='abiq-generator';dialog.setAttribute('aria-label','Review legacy accounts');
 dialog.innerHTML='<header class="dialog-heading"><h2>Review legacy accounts</h2><button type="button" aria-label="Close">×</button></header><p role="status">Loading accounts…</p><div class="table-wrap"><table><thead><tr><th>Holder</th><th>Currency</th><th>Scope</th><th>Current ABIQ</th><th>Action</th></tr></thead><tbody></tbody></table></div><div class="dialog-actions"><button type="button" class="primary" disabled>Apply listed changes</button></div>';
 document.body.append(dialog);dialog.showModal();
 const close=()=>{dialog.close();dialog.remove();};
 dialog.querySelector('header button').onclick=close;dialog.oncancel=e=>{e.preventDefault();close();};
 const status=dialog.querySelector('[role=status]'),apply=dialog.querySelector('.primary');
 try{
  const {rows}=await api('abiq/cleanup');
  if(!dialog.isConnected)return;
  const batch=rows.slice(0,500);
  for(const item of batch){
   const row=dialog.querySelector('tbody').insertRow();
   for(const value of [item.full_name,item.currency_code,item.wallet_scope,item.former_identifier,item.action==='DELETE'?'Delete empty account':'Assign correct ABIQ']){
    row.insertCell().textContent=value;
   }
  }
  const count=batch.filter(x=>x.action==='DELETE').length;
  status.textContent=batch.length?`Delete ${count} empty accounts and assign correct numbers to ${batch.length-count} accounts.`:'No legacy accounts require cleanup.';
  apply.disabled=!batch.length;const key=crypto.randomUUID();
  apply.onclick=async()=>{
   apply.disabled=true;
   try{
    const result=await api('abiq/cleanup',{rows:batch.map(({account_id,action})=>({account_id,action}))},key);
    status.textContent=`Deleted ${result.removed} empty accounts. Assigned ${result.renumbered} account numbers.`;
    dialog.querySelector('.table-wrap').hidden=true;await refresh();
   }catch(e){status.textContent=e.code==='ACCOUNT_REVIEW_CHANGED'?'Account data changed. Reopen the review to see the current accounts.':e.message;apply.disabled=e.code==='ACCOUNT_REVIEW_CHANGED';}
  };
 }catch(e){status.textContent=e.message;}
}
