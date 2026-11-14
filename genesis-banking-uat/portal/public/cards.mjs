import {encryptCardMessage,downloadMessage} from './card-message.mjs';
export const cardProducts=[['VIRTUAL','Virtual'],['STANDARD_BUSINESS','Standard - Business'],['GOLD_STANDARD','Gold Card Standard'],['BLACK_VIP','Black VIP Card'],['GOLD_METAL','Gold Card Metal'],['GOLD_DIAMOND','Gold Diamond']];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=s=>{const[w,f='']=String(s).split('.');return w.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+f.replace(/0+$/,'').padEnd(2,'0');};
const date=s=>s?new Date(s).toLocaleString():'—';
export function cardAccountTable(rows){
 return `<section class="panel"><div class="panel-header"><h2>Card accounts</h2><span>${rows.length} accounts</span></div><div class="table-wrap"><table><thead><tr><th>Account holder</th><th>Card number</th><th>Currency</th><th>Balance</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr data-card-row="${esc(r.account_id)}" tabindex="0"><td>${esc(r.full_name)}</td><td><select aria-label="Cards for ${esc(r.full_name)} ${esc(r.currency_code)}" data-account-card="${esc(r.account_id)}">${r.cards.map(c=>`<option value="${esc(c.card_id)}">${esc(c.card_number)} · ${esc(cardProducts.find(p=>p[0]===c.card_product)?.[1]||c.card_type)} · ${esc(c.status)}</option>`).join('')}</select></td><td>${esc(r.currency_code)}</td><td>${esc(number(r.available_balance))}</td><td><button type="button" data-card-account="${esc(r.account_id)}">View account</button></td></tr>`).join('')}</tbody></table></div></section>`;
}
export function createCardManager({api,refresh,notice}){
 const dialog=document.createElement('dialog');dialog.className='managed-card-dialog';document.body.append(dialog);
 let generation=0,busy=false;
 const close=(force=false)=>{if(busy&&force!==true)return;generation++;dialog.close();dialog.replaceChildren();};
 dialog.oncancel=e=>{e.preventDefault();close();};
 async function open(cardId){
  const serial=++generation,r=await api('cards/'+cardId);if(serial!==generation)return;const c=r.card;
  dialog.innerHTML=`<div class="dialog-heading"><div><h2>Card account · ${esc(c.full_name)}</h2><p>${esc(c.currency_code)} · Available ${esc(number(c.available_balance))}</p></div><button type="button" class="close" aria-label="Close card account">×</button></div><div class="card-account-content">
   <label>Card number<select data-card-selector aria-label="Card number">${r.cards.map(x=>`<option value="${esc(x.card_id)}" ${x.card_id===cardId?'selected':''}>${esc(x.card_number)}</option>`).join('')}</select></label>
   <dl class="payment-summary"><dt>Card type</dt><dd>${esc(cardProducts.find(p=>p[0]===c.card_product)?.[1]||c.card_type)}</dd><dt>Status</dt><dd>${esc(c.status)}</dd><dt>Issue date</dt><dd>${esc(date(c.issued_at))}</dd><dt>Expiry date</dt><dd>${esc(date(c.expires_at))}</dd></dl>
   <div class="actions"><button type="button" data-block>${c.status==='BLOCKED'?'Unblock card':'Block card'}</button><button type="button" data-reset>Reset PIN</button><button type="button" data-delivery>Encrypted card message</button></div>
   <form data-pin hidden><label>New PIN<input name="pin" aria-label="New PIN" type="password" autocomplete="new-password" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" required></label><label>Repeat PIN<input name="confirmation" aria-label="Repeat PIN" type="password" autocomplete="new-password" inputmode="numeric" pattern="[0-9]{4,6}" required></label><button class="primary">Save PIN</button></form>
   <form data-encrypted hidden><label>Delivery password<input name="password" aria-label="Delivery password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><p>Share the password separately from the encrypted message.</p><button class="primary">Download encrypted message</button></form><p class="form-error" role="alert"></p>
   <div class="metrics"><div class="metric"><p>Incoming</p><strong>${esc(number(r.totals.incoming))}</strong></div><div class="metric"><p>Outgoing</p><strong>${esc(number(r.totals.outgoing))}</strong></div><div class="metric"><p>Balance</p><strong>${esc(number(c.available_balance))} ${esc(c.currency_code)}</strong></div></div>
   <div class="table-wrap"><table><thead><tr><th>Date and time</th><th>Reference</th><th>Incoming</th><th>Outgoing</th><th>Balance</th></tr></thead><tbody>${r.entries.map(e=>`<tr><td>${esc(date(e.created_at))}</td><td>${esc(e.reference_id)}</td><td>${e.direction==='CREDIT'?esc(number(e.amount)):''}</td><td>${e.direction==='DEBIT'?esc(number(e.amount)):''}</td><td>${esc(number(e.running_balance))}</td></tr>`).join('')}</tbody></table></div></div>`;
  const q=s=>dialog.querySelector(s);q('.close').onclick=()=>close();q('[data-card-selector]').onchange=e=>open(e.target.value).catch(e=>notice(e.message));
  const action=async task=>{if(busy)return;busy=true;dialog.querySelectorAll('button,select').forEach(b=>b.disabled=true);q('.form-error').textContent='';try{await task();}catch(e){if(q('.form-error'))q('.form-error').textContent=e.message;}finally{busy=false;dialog.querySelectorAll('button,select').forEach(b=>b.disabled=false);}};
  q('[data-block]').onclick=()=>action(async()=>{await api('cards/status',{cardId,status:c.status==='BLOCKED'?'ACTIVE':'BLOCKED'},crypto.randomUUID());await refresh();await open(cardId);});
  q('[data-reset]').onclick=()=>{q('[data-pin]').hidden=false;q('[data-encrypted]').hidden=true;q('[data-pin] input').focus();};
  q('[data-pin]').onsubmit=e=>{e.preventDefault();const form=e.currentTarget;void action(async()=>{if(form.elements.pin.value!==form.elements.confirmation.value)throw Error('The PIN entries must match.');await api('cards/pin',{cardId,pin:form.elements.pin.value},crypto.randomUUID());form.reset();form.hidden=true;notice('PIN updated');});};
  q('[data-delivery]').onclick=()=>{q('[data-encrypted]').hidden=false;q('[data-pin]').hidden=true;q('[data-encrypted] input').focus();};
  q('[data-encrypted]').onsubmit=e=>{e.preventDefault();const form=e.currentTarget;void action(async()=>{const payload=await api('cards/delivery',{cardId},crypto.randomUUID()),envelope=await encryptCardMessage(payload,form.elements.password.value);envelope.openWith=new URL('/card-message',location.href).href;downloadMessage(envelope,'AVISPay-card-'+cardId+'.json');form.reset();});};
  if(!dialog.open)dialog.showModal();
 }
 return {open,close:()=>close(true)};
}
