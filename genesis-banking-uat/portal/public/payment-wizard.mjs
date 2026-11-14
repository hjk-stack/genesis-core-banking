const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=s=>{const [whole,fraction='']=String(s).split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+fraction.replace(/0+$/,'').padEnd(2,'0');};
const names=['Account & amount','Receiving account','Receiver details','Reference','Review & transfer'];
const field=(name,title,attrs='')=>`<label>${title}<input name="${name}" ${attrs}><span class="field-error" data-error="${name}"></span></label>`;
const resultLabel=r=>r.current_status==='COMPLETED'?'Transfer completed':r.current_status==='REJECTED'?'Bank rejected the transfer':r.current_status==='CANCELLED'?'Transfer request cancelled':r.delivery_mode==='MANUAL'?'Recorded in Administration · Transfer requests':r.delivery==='UNCERTAIN'?'Delivery requires reconciliation · see Administration':r.delivery==='QUEUED'?'Transfer queued for delivery':'Transfer submitted · awaiting bank settlement';

export function createPaymentWizard({api,accounts,refresh,notice}){
 const dialog=document.createElement('dialog');dialog.id='payment-dialog';dialog.className='payment-dialog';
 dialog.setAttribute('aria-labelledby','payment-title');document.body.append(dialog);
 let step=0,busy=false,review=null,reviewKey='',transferKey='',lookupSeq=0,lookupTimer,receiverKey='',opened=false;
 const q=s=>dialog.querySelector(s),els=()=>q('form')?.elements;
 function clearErrors(){dialog.querySelectorAll('.field-error,.payment-error').forEach(e=>e.textContent='');dialog.querySelectorAll('[aria-invalid]').forEach(e=>e.removeAttribute('aria-invalid'));}
 function show(index){
  step=index;q('.payment-track').className='payment-track step-'+step;
  dialog.querySelectorAll('.payment-slide').forEach((panel,i)=>{panel.inert=i!==step;panel.setAttribute('aria-hidden',String(i!==step));});
  dialog.querySelectorAll('.payment-progress li').forEach((p,i)=>{p.classList.toggle('current',i===step);p.classList.toggle('complete',i<step);if(i===step)p.setAttribute('aria-current','step');else p.removeAttribute('aria-current');});
  q('.step-caption').textContent=`Step ${step+1} of 5 · ${names[step]}`;
  q('[data-back]').hidden=step===0;q('[data-next]').textContent=step===3?'OK · Build message':step===4?'Transfer':'Next';
  q('.payment-slide:nth-child('+(step+1)+')').querySelector('input,select,h3')?.focus();
 }
 function setBusy(value){busy=value;dialog.querySelectorAll('.payment-slide').forEach((p,i)=>p.inert=value||i!==step);dialog.querySelectorAll('.payment-footer button,.payment-close').forEach(b=>b.disabled=value);q('form').setAttribute('aria-busy',String(value));}
 function error(e){
  clearErrors();const input=els()?.namedItem(e.field),slot=dialog.querySelector(`[data-error="${String(e.field).replace(/[^a-zA-Z]/g,'')}"]`);
  if(input){const index=[...dialog.querySelectorAll('.payment-slide')].findIndex(p=>p.contains(input));if(index>=0)show(index);input.setAttribute('aria-invalid','true');input.focus();}
  (slot||q('.payment-error')).textContent=e.message;
 }
 const values=()=>Object.fromEntries(new FormData(q('form')));
 function source(){const a=accounts().find(a=>a.abiq_iban===els().from.value);q('[data-balance]').textContent=a?`Available balance: ${amount(a.available_balance)} ${a.currency_code}`:'Select the account to display its balance.';q('[data-currency]').textContent=a?.currency_code||'';return a;}
 function resetReceiver(){lookupSeq++;receiverKey='';for(const n of ['receiverName','street','city','postalCode','country']){els()[n].value='';els()[n].readOnly=false;}els().receiverName.readOnly=false;q('[data-receiver-note]').textContent='';}
 async function lookup({quiet=false}={}){
  clearTimeout(lookupTimer);
  const a=source(),v=values(),seq=++lookupSeq;
  if(!a||!v.receiverAccount)return null;
  try{
   const r=await api('payments/check-receiver',{currency:a.currency_code,receiverAccount:v.receiverAccount,receiverBic:v.receiverBic});
   if(seq!==lookupSeq||!opened)return null;
   els().receiverAccount.value=r.account;els().receiverBic.value=r.bic;
   const key=r.account+'|'+r.bic;
   if(receiverKey!==key){
    els().receiverName.value=r.receiverName||'';
    for(const n of ['street','city','postalCode','country'])els()[n].value=r.address?.[n]||'';
   }
   receiverKey=key;els().receiverName.readOnly=Boolean(r.receiverBridgeId);
   for(const n of ['street','city','postalCode','country'])els()[n].readOnly=Boolean(r.receiverBridgeId&&r.addressSource==='REGISTERED');
   q('[data-receiver-note]').textContent=r.receiverBridgeId?'Internal AVISPay account · receiver details loaded':r.receiverName?'Saved receiver details loaded':'';
   return r;
  }catch(e){if(seq===lookupSeq&&!quiet)throw e;return null;}
 }
 function reviewDisplay(r){
  const v=r.instruction;
  q('[data-summary]').innerHTML=`<dl class="payment-summary"><dt>From</dt><dd>${escape(v.from)}</dd><dt>Amount</dt><dd>${escape(v.amount)} ${escape(v.currency)}</dd><dt>Receiver</dt><dd>${escape(v.receiverName)}<br>${escape(v.address.street)}<br>${escape([v.address.postalCode,v.address.city,v.address.country].filter(Boolean).join(' '))}</dd><dt>To</dt><dd>${escape(v.receiverAccount)}<br>${escape(v.receiverBic)}</dd><dt>Reference</dt><dd>${escape(v.reference)}</dd><dt>Delivery</dt><dd>${r.mode==='INTERNAL'?'Internal AVISPay transfer':r.mode==='MANUAL'?'Administration · Transfer requests':'Bank connection'}</dd></dl>`;
  q('[data-message-label]').textContent=r.format==='FIN_MT103'?'FIN MT103 transfer message':'ISO 20022 transfer message';q('[data-message]').textContent=r.message;
 }
 async function next(e){
  e.preventDefault();if(busy)return;clearErrors();
  const panel=q('.payment-slide:nth-child('+(step+1)+')');
  for(const input of panel.querySelectorAll('input,select'))if(!input.reportValidity())return;
  setBusy(true);
  try{
   if(step===1){if(!await lookup())return;}
   if(step===3){
    const v=values(),a=source();reviewKey ||= crypto.randomUUID();
    review=await api('payments/review',{from:v.from,currency:a.currency_code,amount:v.amount,
     receiverAccount:v.receiverAccount,receiverBic:v.receiverBic,receiverName:v.receiverName,
     address:{street:v.street,city:v.city,postalCode:v.postalCode,country:v.country},reference:v.reference},reviewKey);
    transferKey=crypto.randomUUID();reviewDisplay(review);
   }
   if(step===4){
    const r=await api('payments/transfer',{requestId:review.id,messageHash:review.messageHash},transferKey);
    close();notice(resultLabel(r));await refresh();return;
   }
   show(step+1);
  }catch(e){error(e);}finally{setBusy(false);}
 }
 function close(){opened=false;lookupSeq++;clearTimeout(lookupTimer);dialog.close();}
 function open(){
  opened=true;step=0;review=null;reviewKey='';transferKey='';receiverKey='';busy=false;
  dialog.innerHTML=`<div class="payment-heading"><div><p class="eyebrow">PAYMENTS</p><h2 id="payment-title">Register a payment</h2></div><button type="button" class="payment-close" aria-label="Close payment">×</button></div>
   <ol class="payment-progress">${names.map((name,i)=>`<li><span>${i+1}</span><small>${name}</small></li>`).join('')}</ol><p class="step-caption" aria-live="polite"></p>
   <form novalidate><div class="payment-viewport"><div class="payment-track">
    <section class="payment-slide"><h3 tabindex="-1">Account and amount</h3><label>Sender account<select name="from" required><option value="">Select account…</option>${accounts().map(a=>`<option value="${escape(a.abiq_iban)}">${escape(a.full_name)} · ${escape(a.currency_code)} · ${escape(a.abiq_iban)} · Available ${escape(amount(a.available_balance))}</option>`).join('')}</select><span class="field-error" data-error="from"></span></label><p class="account-balance" data-balance></p><div class="amount-field">${field('amount','Amount','required inputmode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" maxlength="21"')}<span data-currency></span></div></section>
    <section class="payment-slide"><h3 tabindex="-1">Receiving account</h3>${field('receiverAccount','Receiver IBAN or account number','required autocomplete="off" maxlength="40"')}${field('receiverBic','Receiver BIC','autocomplete="off" maxlength="11"')}<p class="field-help">Internal AVISPay account numbers fill the BIC and receiver details automatically.</p></section>
    <section class="payment-slide"><h3 tabindex="-1">Receiver details</h3><p data-receiver-note></p>${field('receiverName','Name','required maxlength="140"')}${field('street','Street and building','required maxlength="70"')}<div class="payment-grid">${field('postalCode','Postal code','maxlength="16"')}${field('city','City','required maxlength="35"')}</div>${field('country','Country code','required minlength="2" maxlength="2" placeholder="AT" pattern="[A-Za-z]{2}"')}</section>
    <section class="payment-slide"><h3 tabindex="-1">Payment reference</h3>${field('reference','Reference','required maxlength="128"')}<p>The reference will accompany the transfer.</p></section>
    <section class="payment-slide"><h3 tabindex="-1">Please check your transfer</h3><div data-summary></div><details open><summary data-message-label></summary><pre data-message></pre></details></section>
   </div></div><p class="payment-error" role="alert"></p><div class="payment-footer"><button type="button" data-back>Back</button><button type="submit" class="primary" data-next>Next</button></div></form>`;
  q('form').onsubmit=next;q('.payment-close').onclick=()=>{if(!busy)close();};
  dialog.oncancel=e=>{if(busy)e.preventDefault();else close();};
  q('[data-back]').onclick=()=>{if(busy)return;review=null;reviewKey='';clearErrors();show(step-1);};
  q('form').oninput=e=>{
   review=null;reviewKey='';clearErrors();
   if(['receiverAccount','receiverBic','from'].includes(e.target.name)){
    if(e.target.name==='from'){resetReceiver();source();}
    else{if(e.target.name==='receiverAccount')els().receiverBic.value='';resetReceiver();}
    clearTimeout(lookupTimer);lookupTimer=setTimeout(()=>void lookup({quiet:true}),400);
   }
  };
  source();dialog.showModal();show(0);
 }
 async function view(id){
  const r=await api('payment-requests/'+id);open();reviewDisplay({instruction:r.instruction,mode:r.delivery_mode,format:r.message_format,message:r.message_content});show(4);
  q('#payment-title').textContent='Transfer request';q('.step-caption').textContent=resultLabel(r);q('.payment-progress').hidden=true;
  q('[data-back]').hidden=true;q('[data-next]').hidden=true;
  const download=document.createElement('button');download.type='button';download.textContent='Download message';q('.payment-footer').append(download);
  download.onclick=()=>{const url=URL.createObjectURL(new Blob([r.message_content],{type:r.message_format==='FIN_MT103'?'text/plain':'application/xml'}));const a=document.createElement('a');a.href=url;a.download='AVISPay-'+r.request_id+(r.message_format==='FIN_MT103'?'.fin':'.xml');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  if(r.delivery_mode==='MANUAL'&&r.status==='OUTGOING'){
   const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel request and release funds';q('.payment-footer').append(cancel);
   const key=crypto.randomUUID();cancel.onclick=async()=>{if(busy)return;setBusy(true);try{await api('payments/cancel',{requestId:id},key);close();notice('Transfer request cancelled · funds released');await refresh();}catch(e){error(e);}finally{setBusy(false);}};
  }
  // Viewing an existing instruction is read-only; Enter cannot submit it again.
  q('form').onsubmit=e=>e.preventDefault();
 }
 return {open,view,close};
}
