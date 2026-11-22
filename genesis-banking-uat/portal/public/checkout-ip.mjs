
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():'—';
export const ipState=row=>row.status==='REQUESTED'&&Date.parse(row.expiresAt)<=Date.now()?'CLOSED':row.status;
export function checkoutIpRegister(rows=[],accounts=[],nostros=[]){
 const waiting=rows.filter(r=>ipState(r)==='REQUESTED').length;
 return '<section class="panel" data-checkout-ip-register>'+
 '<div class="panel-header"><h2>Checkout IP-to-IP requests · Payment Server</h2><span data-ip-pending>'+waiting+' awaiting activation</span></div>'+
 '<div class="table-wrap"><table class="checkout-ip-table"><thead><tr><th>Checkout / Request</th><th>Sender / Bank</th>'+
 '<th>Payment</th><th>Receiving ABIQ</th><th>NOSTRO network / Intermediary</th><th>Liquid Glass access</th><th>Server window</th></tr></thead><tbody>'+
 rows.map(r=>{
  const state=ipState(r),id=esc(r.requestId),eligible=accounts.filter(a=>a.currency_code===r.currency);
  const banks=nostros.filter(n=>n.currency_code===r.currency&&n.is_active);
  const deadline=Number.isFinite(Date.parse(r.expiresAt))?Date.parse(r.expiresAt):0;
  const recipientOptions=eligible.map(a=>'<option value="'+esc(a.account_id)+'" '+(a.account_id===r.receivingAccountId?'selected':'')+'>'+
   esc(a.owner_type.startsWith('COMMON')?'Common':'Suspense')+' · '+esc(a.abiq_iban)+' · '+esc(a.currency_code)+'</option>').join('');
  const bankOptions=banks.map(n=>'<option value="'+esc(n.cash_account_id)+'" '+(n.cash_account_id===r.nostroCashAccountId?'selected':'')+'>'+
   esc(n.institution_name)+' · '+esc(n.iban_or_account_no)+'</option>').join('');
  const selectedBank=banks.find(b=>b.cash_account_id===r.nostroCashAccountId);
  const intermediateRows=Array.isArray(selectedBank?.intermediaries)?selectedBank.intermediaries:[];
  const intermediateOptions=intermediateRows.map(i=>'<option value="'+esc(i.intermediaryId)+'" '+(i.intermediaryId===r.intermediaryId?'selected':'')+'>'+esc(i.bankName)+' · '+esc(i.reference)+'</option>').join('');
  return '<tr data-checkout-ip="'+id+'" data-ip-state="'+esc(state)+'">'+
   '<td><strong>'+esc(r.checkoutReference)+'</strong><small>'+esc(r.title)+'</small><small>Request '+id+
   '</small><small>Requested '+esc(date(r.requestedAt))+'</small><small>Expires '+esc(date(r.expiresAt))+'</small></td>'+
   '<td>'+esc(r.senderBankName)+'<small>IP '+esc(r.senderIp)+'</small><small>'+esc(r.authorizedPerson)+'</small>'+
   '<small>'+esc(r.senderAccountName)+' · '+esc(r.senderAccount)+'</small></td>'+
   '<td>'+esc(r.amount)+' '+esc(r.currency)+'<small>'+esc(r.source)+'</small></td>'+
   '<td><label class="ip-row-label">ABIQ Common / Suspense<select data-ip-account '+(state!=='REQUESTED'?'disabled':'')+'>'+
   '<option value="">Select receiving account</option>'+recipientOptions+'</select></label></td>'+
   '<td><label class="ip-row-label">Registered network<select data-ip-nostro '+(state!=='REQUESTED'?'disabled':'')+'>'+
   '<option value="">No NOSTRO specified</option>'+bankOptions+'</select></label>'+
   '<label class="ip-row-label">Incoming intermediary<select data-ip-intermediary '+(state!=='REQUESTED'?'disabled':'')+'>'+
   '<option value="">No intermediary</option>'+intermediateOptions+'</select></label></td>'+
   '<td><button type="button" role="switch" aria-checked="'+(state==='ACTIVE')+'" aria-label="IP-to-IP '+esc(state)+' '+id+
   '" class="pos-liquid-switch" data-ip-toggle data-state="'+esc(state)+'" '+(state==='REQUESTED'?'data-ip-deadline="'+deadline+'"':'')+'>'+
   '<span class="pos-liquid-knob" aria-hidden="true"></span></button>'+
   '<span class="pos-activation-label" data-state="'+esc(state)+'">'+esc(state==='REQUESTED'?'Activation requested':state==='ACTIVE'?'Open':'Closed')+'</span>'+
   '<small>Approved '+esc(date(r.approvedAt))+'</small></td>'+
   '<td><button type="button" data-ip-handler>Open IP-to-IP handler</button></td></tr>';
 }).join('')+'</tbody></table></div>'+
 (!rows.length?'<p class="panel-empty">Checkout IP-to-IP registrations will appear here when customers request activation.</p>':'')+
 '</section>';
}
export function bindCheckoutIp({root=document,requests=[],nostros=[],activate,onChange,openHandler}){
 const panel=root.querySelector('[data-checkout-ip-register]');if(!panel)return;
 for(const row of panel.querySelectorAll('[data-checkout-ip]')){
  const record=requests.find(r=>r.requestId===row.dataset.checkoutIp),bank=row.querySelector('[data-ip-nostro]');
  const intermediary=row.querySelector('[data-ip-intermediary]');
  bank.onchange=()=>{
   const n=nostros.find(x=>x.cash_account_id===bank.value);
   intermediary.replaceChildren(new Option('No intermediary',''),...(n?.intermediaries||[]).map(i=>new Option(i.bankName+' · '+i.reference,i.intermediaryId)));
  };
  row.querySelector('[data-ip-toggle]').onclick=async e=>{
   const button=e.currentTarget,active=ipState(record)==='REQUESTED';
   if(!active&&ipState(record)==='CLOSED')return;
   const receivingAccountId=row.querySelector('[data-ip-account]').value;
   if(active&&!receivingAccountId){row.querySelector('[data-ip-account]').focus();return;}
   button.disabled=true;
   try{
    const result=await activate({requestId:record.requestId,active,receivingAccountId,
     nostroCashAccountId:bank.value||null,intermediaryId:intermediary.value||null});
    onChange(result);
   }catch(error){const p=row.querySelector('[data-ip-error]')||document.createElement('small');p.dataset.ipError='';p.textContent=error.message;row.lastElementChild.append(p)}
   finally{button.disabled=false}
  };
  row.querySelector('[data-ip-handler]').onclick=()=>openHandler(record);
 }
}
