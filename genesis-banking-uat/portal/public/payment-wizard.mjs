import {encryptCardMessage,downloadMessage} from './card-message.mjs';
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=s=>{const [whole,fraction='']=String(s).split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+fraction.replace(/0+$/,'').padEnd(2,'0');};
const names=['Payment','Receiving account','Receiver details','Reference','Review & transfer'];
const field=(name,title,attrs='')=>`<label>${title}<input name="${name}" aria-label="${title}" ${attrs}><span class="field-error" data-error="${name}"></span></label>`;
const resultLabel=r=>r.current_status==='COMPLETED'?'Transfer completed':r.current_status==='REJECTED'?'Bank rejected the transfer':r.current_status==='CANCELLED'?'Transfer request cancelled':r.delivery_mode==='MANUAL'?'Recorded in Administration · Transfer requests':r.delivery==='UNCERTAIN'?'Delivery requires reconciliation · see Administration':r.delivery==='QUEUED'?'Transfer queued for delivery':'Transfer submitted · awaiting bank settlement';

export function createPaymentWizard({api,accounts,refresh,notice,data=()=>[],purchase=()=>{},sell=()=>{},settle=()=>{},isAdmin=()=>true,userId=()=>null}){
 const dialog=document.createElement('dialog');dialog.id='payment-dialog';dialog.className='payment-dialog';
 dialog.setAttribute('aria-labelledby','payment-title');document.body.append(dialog);
 let step=0,busy=false,review=null,reviewKey='',externalKey='',transferKey='',lookupSeq=0,lookupTimer,receiverKey='',opened=false;
 const q=s=>dialog.querySelector(s),els=()=>q('form')?.elements;
 function clearErrors(){dialog.querySelectorAll('.field-error,.payment-error').forEach(e=>e.textContent='');dialog.querySelectorAll('[aria-invalid]').forEach(e=>e.removeAttribute('aria-invalid'));}
 function show(index){
  step=index;q('.payment-track').className='payment-track step-'+step;
  dialog.querySelectorAll('.payment-slide').forEach((panel,i)=>{panel.inert=i!==step;panel.setAttribute('aria-hidden',String(i!==step));});
  dialog.querySelectorAll('.payment-progress li').forEach((p,i)=>{p.classList.toggle('current',i===step);p.classList.toggle('complete',i<step);if(i===step)p.setAttribute('aria-current','step');else p.removeAttribute('aria-current');});
  q('.step-caption').textContent=`Step ${step+1} of 5`;
  q('[data-back]').hidden=step===0;q('[data-next]').textContent=step===3?'OK · Build message':step===4?'Transfer':'Next';
  q('.payment-slide:nth-child('+(step+1)+')').querySelector('input,select,h3')?.focus({preventScroll:true});
 }
 function setBusy(value){busy=value;dialog.querySelectorAll('.payment-slide').forEach((p,i)=>p.inert=value||i!==step);dialog.querySelectorAll('.payment-footer button,.payment-close').forEach(b=>b.disabled=value);q('form')?.setAttribute('aria-busy',String(value));}
 function error(e){
  if(!opened||!q('form')){notice(e.message);return;}
  clearErrors();const input=els()?.namedItem(e.field),slot=dialog.querySelector(`[data-error="${String(e.field).replace(/[^a-zA-Z]/g,'')}"]`);
  if(input){const index=[...dialog.querySelectorAll('.payment-slide')].findIndex(p=>p.contains(input));if(index>=0)show(index);input.setAttribute('aria-invalid','true');input.focus({preventScroll:true});}
  (slot||q('.payment-error')).textContent=e.message;
 }
 const values=()=>Object.fromEntries(new FormData(q('form')));
 const method=()=>els().method.value;
 const secured=()=>method()==='CODED_CARD'&&els().offlineDebit.checked;
 const own=rows=>isAdmin()?rows:rows.filter(r=>String(r.user_id)===String(userId()));
 const bankSource=()=>own(accounts()).find(a=>a.abiq_iban===els().from.value);
 const option=(v,t)=>`<option value="${escape(v)}">${escape(t)}</option>`;
 function fillOptions(name,rows){const current=els()[name].value;els()[name].innerHTML=option('','Select…')+rows.map(r=>option(...r)).join('');if(rows.some(r=>String(r[0])===current))els()[name].value=current;}
 function syncOptions(){
  fillOptions('cryptoAccount',own(data('cryptoholdings')).map(r=>[r.account_id,`${isAdmin()?r.full_name+' · ':''}${r.currency_code} · ${r.network} · Available ${amount(r.available_balance)}`]));
  fillOptions('sourceCardId',own(data('transfercards')).filter(r=>r.card_rail_mode!=='GLOBAL_SCHEME_ONLY').map(r=>[r.card_id,`${isAdmin()?r.full_name+' · ':''}${r.card_number||'Card ending '+r.last_four_digits} · ${amount(r.available_balance)} ${r.currency_code}`]));
  for(const n of ['cryptoAccount','sourceCardId'])if(!els()[n].value&&els()[n].options.length===2)els()[n].selectedIndex=1;
  if(isAdmin())fillOptions('receiverUserId',data('customers').map(r=>[r.user_id,r.full_name+' · User '+r.user_id]));
 }
 function syncMode(){
  const m=method();if(m!=='CODED_CARD')els().offlineDebit.checked=false;
  dialog.querySelectorAll('[data-method]').forEach(el=>el.hidden=!el.dataset.method.split(' ').includes(m));
  dialog.querySelectorAll('[data-crypto]').forEach(el=>el.hidden=el.dataset.crypto!==els().cryptoDestination.value);
  const receiving=m==='BANK'||(['CARD','CODED_CARD'].includes(m)&&!secured());
  q('[data-receiving]').hidden=!receiving;q('[data-address]').hidden=!receiving;
  q('[data-code-delivery]').hidden=!secured();q('[data-code-window]').hidden=!secured()||!els().amount.value;
  dialog.querySelectorAll('input,select').forEach(el=>el.disabled=Boolean(el.closest('[hidden]')));
  els().amount.pattern=m==='CRYPTO'?'[0-9]+([.][0-9]{1,18})?':'[0-9]+([.][0-9]{1,2})?';els().amount.maxLength=m==='CRYPTO'?37:21;
  source();
 }
 function source(){
  const m=method(),a=m==='BANK'?bankSource():m==='CRYPTO'?own(data('cryptoholdings')).find(r=>r.account_id===els().cryptoAccount.value):own(data('transfercards')).find(r=>r.card_id===els().sourceCardId.value);
  q('[data-balance]').textContent=a?`Available balance: ${amount(a.available_balance)} ${a.currency_code}${a.network?' · '+a.network:''}`:'';
  q('[data-currency]').textContent=a?.currency_code||'';return a;
 }
 function nonBankReceiver(){
  let name='';
  if(secured())name=source()?.full_name||'';
  else if(method()==='CRYPTO'&&els().cryptoDestination.value==='INTERNAL'&&isAdmin())name=data('customers').find(r=>String(r.user_id)===els().receiverUserId.value)?.full_name||'';
  els().receiverName.readOnly=Boolean(name);if(name)els().receiverName.value=name;
  q('[data-receiver-note]').textContent=name?'Receiver details loaded':'';
 }
 async function showDelivery(r){
  const payload=await api('payments/card-delivery',{requestId:r.request_id});
  q('[data-summary]').innerHTML=`<h3>${payload.code?'Offline card debit':'Card issued'}</h3><p>${escape(payload.holder)} · ${escape(amount(payload.amount))} ${escape(payload.currency)}</p>${payload.code?`<p class="card-code">${escape(payload.code)}</p><p>Valid from ${escape(new Date(payload.validFrom||Date.now()).toLocaleString())}<br>Until ${escape(new Date(payload.expiresAt).toLocaleString())}</p>`:''}<label>Delivery password<input type="password" name="deliveryPassword" aria-label="Delivery password" autocomplete="new-password" minlength="12" maxlength="256"></label><p class="field-help">The recipient opens the encrypted message with this password. Share the password separately.</p><button type="button" data-encrypt>Download encrypted message</button>`;
  q('[data-message]').textContent='';q('details').hidden=true;q('[data-back]').hidden=true;q('[data-next]').hidden=true;q('.step-caption').textContent='Transfer completed';
  q('form').onsubmit=e=>e.preventDefault();q('[data-encrypt]').onclick=async()=>{try{const envelope=await encryptCardMessage(payload,els().deliveryPassword.value);envelope.openWith=new URL('/card-message',location.href).href;downloadMessage(envelope,'AVISPay-card-'+r.request_id+'.json');els().deliveryPassword.value='';}catch(e){q('.payment-error').textContent=e.message;}};
 }

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
  const addr=v.address||{};
  q('[data-summary]').innerHTML=`<dl class="payment-summary"><dt>From</dt><dd>${escape(v.from)}</dd><dt>Amount</dt><dd>${escape(v.amount)} ${escape(v.currency)}</dd><dt>Receiver</dt><dd>${escape(v.receiverName)}<br>${escape(addr.street||'')}<br>${escape([addr.postalCode,addr.city,addr.country].filter(Boolean).join(' '))}</dd><dt>To</dt><dd>${escape(v.receiverAccount||v.destinationLabel)}<br>${escape(v.receiverBic||v.network||'')}</dd><dt>Reference</dt><dd>${escape(v.reference)}</dd><dt>Delivery</dt><dd>${r.mode==='INTERNAL'?'Internal AVISPay transfer':r.mode==='MANUAL'?'Administration · Transfer requests':'Bank connection'}</dd></dl>`;
  q('[data-message-label]').textContent=r.format==='AVIS_TRANSFER_V1'?'Transfer instruction':r.format==='FIN_MT103'?'FIN MT103 transfer message':'ISO 20022 transfer message';q('[data-message]').textContent=r.message;
 }
 async function next(e){
  e.preventDefault();if(busy)return;clearErrors();
  const panel=q('.payment-slide:nth-child('+(step+1)+')');
  for(const input of panel.querySelectorAll('input,select'))if(!input.reportValidity())return;
  setBusy(true);
  try{
   if(step===1){
    if(method()==='BANK'||(['CARD','CODED_CARD'].includes(method())&&!secured())){if(!await lookup())return;}
    else if(method()==='CRYPTO'&&els().cryptoDestination.value==='INTERNAL'){
     const r=await api('payments/crypto-receiver',{receiverUserId:els().receiverUserId.value});els().receiverName.value=r.receiverName;els().receiverName.readOnly=true;
    }else nonBankReceiver();
   }
   if(step===3){
    const v=values(),a=source();reviewKey ||= crypto.randomUUID();
    review=await api('payments/review',{method:method(),cryptoAccount:v.cryptoAccount,cryptoDestination:v.cryptoDestination,receiverUserId:v.receiverUserId,cryptoAddress:v.cryptoAddress,destinationTag:v.destinationTag,sourceCardId:v.sourceCardId,
     offlineDebit:secured(),...(secured()?{codeStart:new Date(v.codeStart).toISOString(),codeEnd:new Date(v.codeEnd).toISOString()}:{}),from:method()==='BANK'?v.from:undefined,currency:a.currency_code,amount:v.amount,
     receiverAccount:v.receiverAccount,receiverBic:v.receiverBic,receiverName:v.receiverName,
     address:{street:v.street,city:v.city,postalCode:v.postalCode,country:v.country},reference:v.reference},reviewKey);
    transferKey=crypto.randomUUID();reviewDisplay(review);
   }
   if(step===4){
    const r=await api('payments/transfer',{requestId:review.id,messageHash:review.messageHash},transferKey);
    if(r.hasDelivery){await showDelivery(r);await refresh();return;}close();notice(resultLabel(r));await refresh();return;
   }
   show(step+1);
  }catch(e){error(e);}finally{setBusy(false);}
 }
 function close(){opened=false;lookupSeq++;clearTimeout(lookupTimer);dialog.close();dialog.replaceChildren();}
 function open(){
  opened=true;step=0;review=null;reviewKey='';externalKey='';transferKey=crypto.randomUUID();receiverKey='';busy=false;
  dialog.innerHTML=`<div class="payment-heading"><div><h2 id="payment-title">Register a payment</h2></div><button type="button" class="payment-close" aria-label="Close payment">×</button></div>
   <ol class="payment-progress">${names.map((name,i)=>`<li><span>${i+1}</span><small>${name}</small></li>`).join('')}</ol><p class="step-caption" aria-live="polite"></p>
   <form novalidate><div class="payment-viewport"><div class="payment-track">
    <section class="payment-slide"><label>Transfer by<select name="method" aria-label="Transfer by"><option value="BANK">Bank account</option><option value="CRYPTO">Crypto</option><option value="CARD">Card</option><option value="CODED_CARD">Make a force payment</option></select></label>
     <label data-method="BANK">${isAdmin()?'Account':'My currency account'}<select name="from" aria-label="Account" required><option value="">Select account…</option>${own(accounts()).map(a=>`<option value="${escape(a.abiq_iban)}">${escape(isAdmin()?a.full_name+' · ':'')}${escape(a.currency_code)} · ${escape(a.abiq_iban)} · ${escape(amount(a.available_balance))}</option>`).join('')}</select><span class="field-error" data-error="from"></span></label>
     <div data-method="CRYPTO"><label>Wallet holdings<select name="cryptoAccount" aria-label="Wallet holdings" required></select><span class="field-error" data-error="cryptoAccount"></span></label><p class="field-help">For cross-border volume transfers, we offer AG and AGi as payment media. At any time, our exchange offers conversion of AG or AGi back to FIAT.</p><p>If you don’t have enough holdings, purchase now.</p><div class="actions"><button type="button" data-purchase>Purchase now</button><button type="button" data-sell>Convert to FIAT</button></div></div>
     <div data-method="CARD CODED_CARD"><label>My cards<select name="sourceCardId" aria-label="My cards" required></select><span class="field-error" data-error="sourceCardId"></span></label></div>
     <p class="account-balance" data-balance></p><div class="amount-field">${field('amount','Amount','required inputmode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" maxlength="21"')}<span data-currency></span></div>
     <label class="offline-option" data-method="CODED_CARD"><input type="checkbox" name="offlineDebit">Card debit secured by code</label>
     <div data-code-window><div class="payment-grid">${field('codeStart','Code start time','type="datetime-local" required')}${field('codeEnd','Code end time','type="datetime-local" required')}</div><p class="field-help">Choose a validity period of up to 48 hours.</p></div>
    </section>
    <section class="payment-slide"><div data-receiving><h3 tabindex="-1">Receiving account</h3>${field('receiverAccount','Receiver IBAN or account number','required autocomplete="off" maxlength="40"')}${field('receiverBic','Receiver BIC','autocomplete="off" maxlength="11"')}<p class="field-help">Internal AVISPay account numbers fill the BIC and receiver details automatically.</p></div>
     <div data-method="CRYPTO"><label>Crypto destination<select name="cryptoDestination" aria-label="Crypto destination"><option value="INTERNAL">AVISPay user</option><option value="EXTERNAL">Blockchain address</option></select></label><div data-crypto="INTERNAL">${isAdmin()?'<label>Receiving user<select name="receiverUserId" aria-label="Receiving user" required></select><span class="field-error" data-error="receiverUserId"></span></label>':field('receiverUserId','Receiving user number','required inputmode="numeric" pattern="[0-9]+"')}</div><div data-crypto="EXTERNAL">${field('cryptoAddress','Receiving blockchain address','required maxlength="256"')}${field('destinationTag','Destination tag / memo','maxlength="10"')}</div></div>
     <div data-code-delivery><h3 tabindex="-1">Code delivery</h3><p>The selected amount is reserved from the card balance when you confirm. The six-digit code and encrypted delivery message are then created for the selected validity period.</p></div>
    </section>
    <section class="payment-slide"><h3 tabindex="-1">Receiver details</h3><p data-receiver-note></p>${field('receiverName','Name','required maxlength="140"')}<div data-address>${field('street','Street and building','required maxlength="70"')}<div class="payment-grid">${field('postalCode','Postal code','maxlength="16"')}${field('city','City','required maxlength="35"')}</div>${field('country','Country code','required minlength="2" maxlength="2" placeholder="AT" pattern="[A-Za-z]{2}"')}</div></section>
    <section class="payment-slide"><h3 tabindex="-1">Payment reference</h3>${field('reference','Reference','required maxlength="128"')}<p>The reference will accompany the transfer.</p></section>
    <section class="payment-slide"><h3 tabindex="-1">Please check your transfer</h3><div data-summary></div><details open><summary data-message-label></summary><pre data-message></pre></details></section>
   </div></div><p class="payment-error" role="alert"></p><div class="payment-footer"><button type="button" data-back>Back</button><button type="submit" class="primary" data-next>Next</button></div></form>`;
  q('form').onsubmit=next;q('.payment-close').onclick=()=>{if(!busy)close();};
  dialog.oncancel=e=>{if(busy)e.preventDefault();else close();};
  q('[data-back]').onclick=()=>{if(busy)return;review=null;reviewKey='';clearErrors();show(step-1);};
  q('[data-purchase]').onclick=()=>{close();purchase();};q('[data-sell]').onclick=()=>{close();sell();};
  q('form').oninput=e=>{
   review=null;reviewKey='';clearErrors();
   if(['method','from','cryptoAccount','sourceCardId','cryptoDestination','offlineDebit','amount'].includes(e.target.name))syncMode();
   if(secured()||method()==='CRYPTO'){nonBankReceiver();return;}
   if(['receiverAccount','receiverBic','from','sourceCardId'].includes(e.target.name)){
    if(e.target.name==='receiverAccount')els().receiverBic.value='';resetReceiver();
    clearTimeout(lookupTimer);lookupTimer=setTimeout(()=>void lookup({quiet:true}),400);
   }
  };
  const localTime=date=>{const d=new Date(date.getTime()-date.getTimezoneOffset()*60000);return d.toISOString().slice(0,16);};
  els().codeStart.value=localTime(new Date());els().codeEnd.value=localTime(new Date(Date.now()+48*3600000));
  syncOptions();syncMode();source();dialog.showModal();show(0);
 }
 async function view(id){
  const r=await api('payment-requests/'+id);open();reviewDisplay({instruction:r.instruction,mode:r.delivery_mode,format:r.message_format,message:r.message_content});show(4);
  q('#payment-title').textContent='Transfer request';q('.step-caption').textContent=resultLabel(r);q('.payment-progress').hidden=true;
  q('[data-back]').hidden=true;q('[data-next]').hidden=true;
  const download=document.createElement('button');download.type='button';download.textContent='Download message';q('.payment-footer').append(download);
  download.onclick=()=>{const url=URL.createObjectURL(new Blob([r.message_content],{type:r.message_format==='FIN_MT103'?'text/plain':'application/xml'}));const a=document.createElement('a');a.href=url;a.download='AVISPay-'+r.request_id+(r.message_format==='AVIS_TRANSFER_V1'?'.json':r.message_format==='FIN_MT103'?'.fin':'.xml');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  if(r.hasDelivery){const showCard=document.createElement('button');showCard.type='button';showCard.textContent='Card delivery & code';q('.payment-footer').append(showCard);showCard.onclick=()=>showDelivery(r).catch(error);}
  if(isAdmin()&&(r.status==='OUTGOING'||r.current_status==='PROCESSING')){
   const pick=document.createElement('button');pick.type='button';pick.textContent='Pick up request';q('.payment-footer').append(pick);pick.onclick=async()=>{setBusy(true);try{await api('payments/pickup',{requestId:id},crypto.randomUUID());pick.textContent='Picked up';await refresh();}catch(e){error(e);}finally{setBusy(false);}};
  }
  if(isAdmin()&&r.delivery_mode==='MANUAL'&&r.status==='OUTGOING'){
   const complete=document.createElement('button');complete.type='button';complete.textContent='Record completed transfer';q('.payment-footer').append(complete);complete.onclick=()=>{close();settle(r);};
   if(r.external_card_id){const details=document.createElement('button');details.type='button';details.textContent='Card processing details';q('.payment-footer').append(details);details.onclick=async()=>{try{const c=await api('cards/pickup-details',{requestId:id},crypto.randomUUID());q('[data-message]').textContent=c.holder+'\n'+c.pan+'\n'+c.expiry;}catch(e){error(e);}};}

   const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel request and release funds';q('.payment-footer').append(cancel);
   const key=crypto.randomUUID();cancel.onclick=async()=>{if(busy)return;setBusy(true);try{await api('payments/cancel',{requestId:id},key);close();notice('Transfer request cancelled · funds released');await refresh();}catch(e){error(e);}finally{setBusy(false);}};
  }
  // Viewing an existing instruction is read-only; Enter cannot submit it again.
  q('form').onsubmit=e=>e.preventDefault();
 }
 function reviewPrepared(r){open();review=r;transferKey=crypto.randomUUID();reviewDisplay(r);show(4);q('[data-back]').hidden=true;}
 return {open,view,close,reviewPrepared};
}
