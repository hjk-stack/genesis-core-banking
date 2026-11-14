import {encryptCardMessage,downloadMessage} from './card-message.mjs';
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=s=>{const [whole,fraction='']=String(s).split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+fraction.replace(/0+$/,'').padEnd(2,'0');};
const names=['Account & amount','Receiving account','Receiver details','Reference','Review & transfer'];
const field=(name,title,attrs='')=>`<label>${title}<input name="${name}" aria-label="${title}" ${attrs}><span class="field-error" data-error="${name}"></span></label>`;
const resultLabel=r=>r.current_status==='COMPLETED'?'Transfer completed':r.current_status==='REJECTED'?'Bank rejected the transfer':r.current_status==='CANCELLED'?'Transfer request cancelled':r.delivery_mode==='MANUAL'?'Recorded in Administration · Transfer requests':r.delivery==='UNCERTAIN'?'Delivery requires reconciliation · see Administration':r.delivery==='QUEUED'?'Transfer queued for delivery':'Transfer submitted · awaiting bank settlement';

export function createPaymentWizard({api,accounts,refresh,notice,data=()=>[],purchase=()=>{},settle=()=>{}}){
 const dialog=document.createElement('dialog');dialog.id='payment-dialog';dialog.className='payment-dialog';
 dialog.setAttribute('aria-labelledby','payment-title');document.body.append(dialog);
 let step=0,busy=false,review=null,reviewKey='',externalKey='',transferKey='',lookupSeq=0,lookupTimer,receiverKey='',opened=false;
 const q=s=>dialog.querySelector(s),els=()=>q('form')?.elements;
 function clearErrors(){dialog.querySelectorAll('.field-error,.payment-error').forEach(e=>e.textContent='');dialog.querySelectorAll('[aria-invalid]').forEach(e=>e.removeAttribute('aria-invalid'));}
 function show(index){
  step=index;q('.payment-track').className='payment-track step-'+step;
  dialog.querySelectorAll('.payment-slide').forEach((panel,i)=>{panel.inert=i!==step;panel.setAttribute('aria-hidden',String(i!==step));});
  dialog.querySelectorAll('.payment-progress li').forEach((p,i)=>{p.classList.toggle('current',i===step);p.classList.toggle('complete',i<step);if(i===step)p.setAttribute('aria-current','step');else p.removeAttribute('aria-current');});
  q('.step-caption').textContent=`Step ${step+1} of 5 · ${names[step]}`;
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
 const bankSource=()=>accounts().find(a=>a.abiq_iban===els().from.value);
 const option=(v,t)=>`<option value="${escape(v)}">${escape(t)}</option>`;
 function fillOptions(name,rows){const current=els()[name].value;els()[name].innerHTML=option('','Select…')+rows.map(r=>option(...r)).join('');if(rows.some(r=>String(r[0])===current))els()[name].value=current;}
 function syncOptions(){
  const a=bankSource(),owned=r=>a&&String(r.user_id)===String(a.user_id);
  fillOptions('cryptoAccount',data('cryptoholdings').filter(owned).map(r=>[r.account_id,`${r.currency_code} · ${r.network} · Available ${amount(r.available_balance)}`]));
  fillOptions('receiverUserId',data('customers').filter(r=>a&&String(r.user_id)!==String(a.user_id)).map(r=>[r.user_id,r.full_name+' · User '+r.user_id]));
  fillOptions('cardId',data('transfercards').filter(r=>owned(r)&&r.currency_code===a.currency_code&&r.card_rail_mode!=='GLOBAL_SCHEME_ONLY').map(r=>[r.card_id,`Card ending ${r.last_four_digits} · Available ${amount(r.available_balance)} ${r.currency_code}`]));
  fillOptions('externalCardId',[...data('externalcards').filter(owned).map(r=>[r.card_id,r.holder_name+' · '+r.last_four]),['NEW','Register external card…']]);
 }
 function syncMode(){
  const m=method();if(m==='CODED_CARD'&&els().cardDestination.value==='EXTERNAL')els().cardDestination.value='NEW';const cd=els().cardDestination.value,xd=els().cryptoDestination.value;
  dialog.querySelectorAll('[data-method]').forEach(el=>el.hidden=!el.dataset.method.split(' ').includes(m));
  dialog.querySelectorAll('[data-card]').forEach(el=>el.hidden=el.dataset.card!==cd);
  dialog.querySelectorAll('[data-crypto]').forEach(el=>el.hidden=el.dataset.crypto!==xd);
  q('[data-external-new]').hidden=els().externalCardId.value!=='NEW';
  q('[data-address]').hidden=m!=='BANK';
  if(m==='CODED_CARD'){els().offlineDebit.checked=true;if(cd==='EXTERNAL')els().cardDestination.value='NEW';}
  q('[data-offline]').hidden=els().cardDestination.value==='EXTERNAL';
  dialog.querySelectorAll('input,select').forEach(el=>el.disabled=Boolean(el.closest('[hidden]')));
  if(m==='CODED_CARD')els().offlineDebit.disabled=true;
  els().amount.pattern=m==='CRYPTO'?'[0-9]+([.][0-9]{1,18})?':'[0-9]+([.][0-9]{1,2})?';els().amount.maxLength=m==='CRYPTO'?37:21;
  source();
 }
 function source(){
  const bank=bankSource(),a=method()==='CRYPTO'?data('cryptoholdings').find(r=>r.account_id===els().cryptoAccount.value&&String(r.user_id)===String(bank?.user_id)):bank;
  q('[data-balance]').textContent=a?`Available balance: ${amount(a.available_balance)} ${a.currency_code}${a.network?' · '+a.network:''}`:method()==='CRYPTO'?'Select a crypto holding, or purchase AG first.':'Select the account to display its balance.';
  q('[data-currency]').textContent=a?.currency_code||'';return a;
 }
 function nonBankReceiver(){
  const v=values(),a=bankSource();let name='';
  if(method()==='CRYPTO'&&v.cryptoDestination==='INTERNAL')name=data('customers').find(r=>String(r.user_id)===v.receiverUserId)?.full_name||'';
  if(['CARD','CODED_CARD'].includes(method()))name=v.cardDestination==='EXTERNAL'?(data('externalcards').find(r=>r.card_id===v.externalCardId)?.holder_name||v.holderName||''):a?.full_name||'';
  els().receiverName.readOnly=Boolean(name);if(name)els().receiverName.value=name;
  q('[data-receiver-note]').textContent=name?'Receiver details loaded':'';
 }
 async function showDelivery(r){
  const payload=await api('payments/card-delivery',{requestId:r.request_id});
  q('[data-summary]').innerHTML=`<h3>${payload.code?'Offline card debit':'Card issued'}</h3><p>${escape(payload.holder)} · ${escape(amount(payload.amount))} ${escape(payload.currency)}</p>${payload.code?`<p class="card-code">${escape(payload.code)}</p><p>Code valid until ${escape(new Date(payload.expiresAt).toLocaleString())}</p>`:''}<label>Delivery password<input type="password" name="deliveryPassword" aria-label="Delivery password" autocomplete="new-password" minlength="12" maxlength="256"></label><p class="field-help">The recipient opens the encrypted message with this password. Share the password separately.</p><button type="button" data-encrypt>Download encrypted message</button>`;
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
    if(method()==='BANK'){if(!await lookup())return;}
    else{
     const v=values(),a=bankSource();
     if(v.cardDestination==='EXTERNAL'&&v.externalCardId==='NEW'){
      const card=await api('cards/external',{from:v.from,currency:a.currency_code,cardNumber:v.cardNumber,expiry:v.expiry,holderName:v.holderName},externalKey ||= crypto.randomUUID());
      data('externalcards').push({card_id:card.id,user_id:a.user_id,holder_name:v.holderName,last_four:card.lastFour});syncOptions();els().externalCardId.value=card.id;els().cardNumber.value='';els().expiry.value='';syncMode();
     }
     nonBankReceiver();
    }
   }
   if(step===3){
    const v=values(),a=bankSource();reviewKey ||= crypto.randomUUID();
    review=await api('payments/review',{method:method(),cryptoAccount:v.cryptoAccount,cryptoDestination:v.cryptoDestination,receiverUserId:v.receiverUserId,cryptoAddress:v.cryptoAddress,destinationTag:v.destinationTag,cardDestination:v.cardDestination,cardId:v.cardId,externalCardId:v.externalCardId,offlineDebit:els().offlineDebit.checked,from:v.from,currency:a.currency_code,amount:v.amount,
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
  dialog.innerHTML=`<div class="payment-heading"><div><p class="eyebrow">PAYMENTS</p><h2 id="payment-title">Register a payment</h2></div><button type="button" class="payment-close" aria-label="Close payment">×</button></div>
   <ol class="payment-progress">${names.map((name,i)=>`<li><span>${i+1}</span><small>${name}</small></li>`).join('')}</ol><p class="step-caption" aria-live="polite"></p>
   <form novalidate><div class="payment-viewport"><div class="payment-track">
    <section class="payment-slide"><h3 tabindex="-1">Account and amount</h3><label>Transfer by<select name="method" aria-label="Transfer by"><option value="BANK">Bank account</option><option value="CRYPTO">Crypto</option><option value="CARD">Card</option><option value="CODED_CARD">Coded card</option></select></label><label>Sender account<select name="from" aria-label="Sender account" required><option value="">Select account…</option>${accounts().map(a=>`<option value="${escape(a.abiq_iban)}">${escape(a.full_name)} · ${escape(a.currency_code)} · ${escape(a.abiq_iban)} · Available ${escape(amount(a.available_balance))}</option>`).join('')}</select><span class="field-error" data-error="from"></span></label><div data-method="CRYPTO"><label>Crypto holding<select name="cryptoAccount" aria-label="Crypto holding" required></select><span class="field-error" data-error="cryptoAccount"></span></label><button type="button" data-purchase>Purchase AG / crypto</button></div><p class="account-balance" data-balance></p><div class="amount-field">${field('amount','Amount','required inputmode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" maxlength="21"')}<span data-currency></span></div></section>
    <section class="payment-slide"><h3 tabindex="-1">Receiving account</h3><div data-method="BANK">${field('receiverAccount','Receiver IBAN or account number','required autocomplete="off" maxlength="40"')}${field('receiverBic','Receiver BIC','autocomplete="off" maxlength="11"')}<p class="field-help">Internal AVISPay account numbers fill the BIC and receiver details automatically.</p></div>
     <div data-method="CRYPTO"><label>Crypto destination<select name="cryptoDestination" aria-label="Crypto destination"><option value="INTERNAL">AVISPay user</option><option value="EXTERNAL">Blockchain address</option></select></label><div data-crypto="INTERNAL"><label>Receiving user<select name="receiverUserId" aria-label="Receiving user" required></select><span class="field-error" data-error="receiverUserId"></span></label></div><div data-crypto="EXTERNAL">${field('cryptoAddress','Receiving blockchain address','required maxlength="256"')}${field('destinationTag','Destination tag / memo','maxlength="10"')}</div></div>
     <div data-method="CARD CODED_CARD"><label>Load into<select name="cardDestination" aria-label="Load into"><option value="EXISTING">My existing AVIS card</option><option value="NEW">Issue a new AVIS card</option><option value="EXTERNAL">External card</option></select></label><div data-card="EXISTING"><label>My card<select name="cardId" aria-label="My card" required></select><span class="field-error" data-error="cardId"></span></label></div><div data-card="NEW"><p>The new card is issued in the account holder’s name. Its delivery message can be encrypted after the transfer.</p></div><div data-card="EXTERNAL"><label>External card<select name="externalCardId" aria-label="External card" required></select><span class="field-error" data-error="externalCardId"></span></label><div data-external-new>${field('cardNumber','Card number','required inputmode="numeric" autocomplete="off" maxlength="23"')}${field('expiry','Expiry (MM/YYYY)','required placeholder="MM/YYYY" maxlength="7"')}${field('holderName','Name on card','required maxlength="140"')}</div></div><label class="offline-option" data-offline><input type="checkbox" name="offlineDebit">Offline card debit · issue a six-digit code</label><span class="field-error" data-error="offlineDebit"></span></div>
    </section>
    <section class="payment-slide"><h3 tabindex="-1">Receiver details</h3><p data-receiver-note></p>${field('receiverName','Name','required maxlength="140"')}<div data-address>${field('street','Street and building','required maxlength="70"')}<div class="payment-grid">${field('postalCode','Postal code','maxlength="16"')}${field('city','City','required maxlength="35"')}</div>${field('country','Country code','required minlength="2" maxlength="2" placeholder="AT" pattern="[A-Za-z]{2}"')}</div></section>
    <section class="payment-slide"><h3 tabindex="-1">Payment reference</h3>${field('reference','Reference','required maxlength="128"')}<p>The reference will accompany the transfer.</p></section>
    <section class="payment-slide"><h3 tabindex="-1">Please check your transfer</h3><div data-summary></div><details open><summary data-message-label></summary><pre data-message></pre></details></section>
   </div></div><p class="payment-error" role="alert"></p><div class="payment-footer"><button type="button" data-back>Back</button><button type="submit" class="primary" data-next>Next</button></div></form>`;
  q('form').onsubmit=next;q('.payment-close').onclick=()=>{if(!busy)close();};
  dialog.oncancel=e=>{if(busy)e.preventDefault();else close();};
  q('[data-back]').onclick=()=>{if(busy)return;review=null;reviewKey='';clearErrors();show(step-1);};
  q('[data-purchase]').onclick=()=>{close();purchase();};
  q('form').oninput=e=>{
   review=null;reviewKey='';clearErrors();
   if(['cardNumber','expiry','holderName'].includes(e.target.name))externalKey='';
   if(e.target.name==='from')syncOptions();
   if(['method','from','cryptoAccount','cryptoDestination','cardDestination','externalCardId'].includes(e.target.name))syncMode();
   if(method()!=='BANK'){nonBankReceiver();return;}
   if(['receiverAccount','receiverBic','from'].includes(e.target.name)){
    if(e.target.name==='from'){resetReceiver();source();}
    else{if(e.target.name==='receiverAccount')els().receiverBic.value='';resetReceiver();}
    clearTimeout(lookupTimer);lookupTimer=setTimeout(()=>void lookup({quiet:true}),400);
   }
  };
  syncOptions();syncMode();source();dialog.showModal();show(0);
 }
 async function view(id){
  const r=await api('payment-requests/'+id);open();reviewDisplay({instruction:r.instruction,mode:r.delivery_mode,format:r.message_format,message:r.message_content});show(4);
  q('#payment-title').textContent='Transfer request';q('.step-caption').textContent=resultLabel(r);q('.payment-progress').hidden=true;
  q('[data-back]').hidden=true;q('[data-next]').hidden=true;
  const download=document.createElement('button');download.type='button';download.textContent='Download message';q('.payment-footer').append(download);
  download.onclick=()=>{const url=URL.createObjectURL(new Blob([r.message_content],{type:r.message_format==='FIN_MT103'?'text/plain':'application/xml'}));const a=document.createElement('a');a.href=url;a.download='AVISPay-'+r.request_id+(r.message_format==='AVIS_TRANSFER_V1'?'.json':r.message_format==='FIN_MT103'?'.fin':'.xml');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  if(r.hasDelivery){const showCard=document.createElement('button');showCard.type='button';showCard.textContent='Card delivery & code';q('.payment-footer').append(showCard);showCard.onclick=()=>showDelivery(r).catch(error);}
  if(r.status==='OUTGOING'||r.current_status==='PROCESSING'){
   const pick=document.createElement('button');pick.type='button';pick.textContent='Pick up request';q('.payment-footer').append(pick);pick.onclick=async()=>{setBusy(true);try{await api('payments/pickup',{requestId:id},crypto.randomUUID());pick.textContent='Picked up';await refresh();}catch(e){error(e);}finally{setBusy(false);}};
  }
  if(r.delivery_mode==='MANUAL'&&r.status==='OUTGOING'){
   const complete=document.createElement('button');complete.type='button';complete.textContent='Record completed transfer';q('.payment-footer').append(complete);complete.onclick=()=>{close();settle(r);};
   if(r.external_card_id){const details=document.createElement('button');details.type='button';details.textContent='Card processing details';q('.payment-footer').append(details);details.onclick=async()=>{try{const c=await api('cards/pickup-details',{requestId:id},crypto.randomUUID());q('[data-message]').textContent=c.holder+'\n'+c.pan+'\n'+c.expiry;}catch(e){error(e);}};}

   const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel request and release funds';q('.payment-footer').append(cancel);
   const key=crypto.randomUUID();cancel.onclick=async()=>{if(busy)return;setBusy(true);try{await api('payments/cancel',{requestId:id},key);close();notice('Transfer request cancelled · funds released');await refresh();}catch(e){error(e);}finally{setBusy(false);}};
  }
  // Viewing an existing instruction is read-only; Enter cannot submit it again.
  q('form').onsubmit=e=>e.preventDefault();
 }
 return {open,view,close};
}
