const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():'—';
const value=text=>esc(text??'—');
export const ipState=row=>row.status==='REQUESTED'&&Date.parse(row.expiresAt)<=Date.now()?'CLOSED':row.status;
export const checkoutIpFingerprint=rows=>JSON.stringify(rows);
export const checkoutIpHandlerUrl=record=>'https://avis.land/admin/bank/quantum/direct-transfer'+(record?.requestId?'?checkoutRequest='+encodeURIComponent(record.requestId):'');
const routeSelectors=['[data-ip-account]','[data-ip-nostro]','[data-ip-intermediary]'];
const controlSelectors=[...routeSelectors,'[data-ip-toggle]','[data-ip-handler]','[data-ip-proof]','[data-ip-completion-report]'];
const intermediaryLabel=record=>{
 const fields=[record.bankName,record.reference,record.bic,record.accountName,record.accountNumber,record.bankAddress,record.aba]
  .map(field=>String(field??'').trim()).filter(field=>field&&!/^(?:n\/?a|tba|tbd|none|not applicable|not available|not provided|not recorded|unknown|[-—–]+)$/i.test(field));
 return [...new Set(fields)].join(' · ')||String(record.intermediaryId);
};

export function expireCheckoutIpControls(root=document,now=Date.now()){
 const panel=root.querySelector('[data-checkout-ip-register]');if(!panel)return;
 for(const button of panel.querySelectorAll('[data-ip-deadline]')){
  if(Number(button.dataset.ipDeadline)>now)continue;
  const row=button.closest('[data-checkout-ip]');row.dataset.ipState='CLOSED';
  button.dataset.state='CLOSED';button.setAttribute('aria-checked','false');button.setAttribute('aria-disabled','true');
  button.setAttribute('aria-label','IP-to-IP CLOSED '+row.dataset.checkoutIp);button.removeAttribute('data-ip-deadline');
  const label=row.querySelector('.pos-activation-label');label.dataset.state='CLOSED';label.textContent='Closed';
  for(const selector of routeSelectors)row.querySelector(selector).disabled=true;
 }
 panel.querySelector('[data-ip-pending]').textContent=panel.querySelectorAll('[data-ip-state="REQUESTED"]').length+' awaiting activation';
}

export function checkoutIpRegister(rows=[],accounts=[],nostros=[]){
 const waiting=rows.filter(r=>ipState(r)==='REQUESTED').length;
 return '<section class="panel" data-checkout-ip-register>'+
 '<div class="panel-header ip-register-heading"><h2>Checkout IP-to-IP requests · Payment Server</h2><div class="ip-register-actions"><span data-ip-pending>'+waiting+' awaiting activation</span>'+
 '<button type="button" data-ip-handler-open>Open IP-to-IP handler</button></div></div>'+
 '<div class="table-wrap" tabindex="0" role="region" aria-label="IP-to-IP payment processing register"><table class="checkout-ip-table"><thead><tr>'+
 ['Checkout / Request','Sender / Bank','Sender Account','Payment','Currency','NOSTRO','Amount Cleared','Beneficiary name','Beneficiary Account','Franchise Payment','Operation Completed','Proof of Payment'].map(label=>'<th scope="col">'+label+'</th>').join('')+
 '</tr></thead><tbody>'+rows.map(r=>{
  const state=ipState(r),id=esc(r.requestId),processing=r.processing||{},eligible=accounts.filter(a=>a.currency_code===r.currency);
  const banks=nostros.filter(n=>n.currency_code===r.currency&&n.is_active);
  const deadline=Number.isFinite(Date.parse(r.expiresAt))?Date.parse(r.expiresAt):0;
  const recipientOptions=eligible.map(a=>'<option value="'+esc(a.account_id)+'" '+(a.account_id===r.receivingAccountId?'selected':'')+'>'+
   esc(a.owner_type?.startsWith('COMMON')?'Common':'Suspense')+' · '+esc(a.abiq_iban)+' · '+esc(a.currency_code)+'</option>').join('');
  const bankOptions=banks.map(n=>'<option value="'+esc(n.cash_account_id)+'" '+(n.cash_account_id===r.nostroCashAccountId?'selected':'')+'>'+
   esc(n.institution_name)+' · '+esc(n.iban_or_account_no)+'</option>').join('');
  const selectedBank=banks.find(b=>b.cash_account_id===r.nostroCashAccountId);
  const intermediateRows=Array.isArray(selectedBank?.intermediaries)?selectedBank.intermediaries:[];
  const intermediateOptions=intermediateRows.map(i=>'<option value="'+esc(i.intermediaryId)+'" '+(i.intermediaryId===r.intermediaryId?'selected':'')+'>'+esc(intermediaryLabel(i))+'</option>').join('');
  return '<tr data-checkout-ip="'+id+'" data-ip-state="'+esc(state)+'">'+
   '<td class="ip-request-cell"><strong>'+esc(r.checkoutReference)+'</strong><small>'+esc(r.title)+'</small><small>Request '+id+
   '</small><div class="ip-request-controls"><button type="button" role="switch" aria-checked="'+(state==='ACTIVE')+'" aria-label="IP-to-IP '+esc(state)+' '+id+
   '" class="pos-liquid-switch" data-ip-toggle data-state="'+esc(state)+'" '+(state==='CLOSED'?'aria-disabled="true" ':'')+(state==='REQUESTED'?'data-ip-deadline="'+deadline+'"':'')+'>'+
   '<span class="pos-liquid-knob" aria-hidden="true"></span></button><span class="pos-activation-label" data-state="'+esc(state)+'">'+
   esc(state==='REQUESTED'?'Activation requested':state==='ACTIVE'?'Open':'Closed')+'</span></div>'+
   '<button type="button" data-ip-handler>Open handler</button><small>Requested '+esc(date(r.requestedAt))+'</small><small>Expires '+esc(date(r.expiresAt))+'</small>'+
   '<small>Approved '+esc(date(r.approvedAt))+'</small><small class="form-error" data-ip-error role="alert"></small></td>'+
   '<td>'+value(processing.bankName||r.senderBankName)+'<small>IP '+esc(r.senderIp)+'</small><small>'+esc(r.authorizedPerson)+'</small></td>'+
   '<td class="account-number">'+value(r.senderAccount)+'<small>'+esc(r.senderAccountName)+'</small></td>'+
   '<td data-ip-payment>'+value(processing.bankServerSentAmount)+'<small>Amount Server Sent</small><small>Requested '+esc(r.amount)+'</small><small>'+esc(r.source)+'</small></td>'+
   '<td>'+esc(r.currency)+'</td>'+
   '<td><label class="ip-row-label">Registered network<select data-ip-nostro '+(state!=='REQUESTED'?'disabled':'')+'>'+
   '<option value="">No NOSTRO specified</option>'+bankOptions+'</select></label>'+
   '<label class="ip-row-label">Incoming intermediary<select data-ip-intermediary '+(state!=='REQUESTED'?'disabled':'')+'>'+
   '<option value="">No intermediary</option>'+intermediateOptions+'</select></label><small>IBAN '+value(processing.nostroIban||selectedBank?.iban_or_account_no)+'</small></td>'+
   '<td>'+value(processing.amountCleared)+'<small>IBAN '+value(processing.receivingAbiqIban||eligible.find(a=>a.account_id===r.receivingAccountId)?.abiq_iban)+'</small>'+
   '<label class="ip-row-label">ABIQ Common / Suspense<select data-ip-account '+(state!=='REQUESTED'?'disabled':'')+'>'+
   '<option value="">Select receiving account</option>'+recipientOptions+'</select></label></td>'+
   '<td>'+value(processing.beneficiaryName)+'</td><td class="account-number">'+value(processing.beneficiaryAccount)+'</td>'+
   '<td>'+value(processing.franchiseAllocatedPercent)+(processing.franchiseAllocatedPercent!=null?' %':'')+'<small>Allocated amount %</small></td>'+
   '<td class="ip-operation-cell">'+(processing.operationCompleted?'Completed':'—')+(processing.manualReport100Digits?
   '<label class="ip-row-label">Manual report · 100 digits<textarea data-ip-completion-report readonly rows="4">'+esc(processing.manualReport100Digits)+'</textarea></label>':'')+
   (processing.transactionReference?'<small>Reference '+esc(processing.transactionReference)+'</small>':'')+'</td>'+
   '<td>'+(processing.proof?.available?'<button type="button" data-ip-proof>View proof PDF</button><small>'+esc(processing.proof.fileName)+'</small>':'—')+'</td></tr>';
 }).join('')+'</tbody></table></div>'+
 (!rows.length?'<p class="panel-empty">Checkout IP-to-IP registrations will appear here when customers request activation.</p>':'')+'</section>';
}

// Refresh handler reports without losing a pending routing selection or keyboard focus.
export function replaceCheckoutIpRegister(panel,rows,accounts=[],nostros=[]){
 const selectors=routeSelectors,doc=panel.ownerDocument;
 const selections=new Map([...panel.querySelectorAll('[data-checkout-ip][data-ip-state="REQUESTED"]')].map(row=>[
  row.dataset.checkoutIp,selectors.map(selector=>row.querySelector(selector)?.value)]));
 const focused=doc.activeElement,focusRequest=focused?.closest('[data-checkout-ip]')?.dataset.checkoutIp;
 const focusSelector=controlSelectors.find(selector=>focused?.matches(selector));
 const scroll=panel.querySelector('.table-wrap').scrollLeft;
 const displayRows=rows.map(row=>{
  const selection=selections.get(row.requestId);if(!selection||ipState(row)!=='REQUESTED')return row;
  return {...row,receivingAccountId:selection[0],nostroCashAccountId:selection[1],intermediaryId:selection[2]};
 });
 const holder=doc.createElement('div');holder.innerHTML=checkoutIpRegister(displayRows,accounts,nostros);
 const replacement=holder.firstElementChild;panel.replaceWith(replacement);
 replacement.querySelector('.table-wrap').scrollLeft=scroll;
 if(focusSelector){const row=[...replacement.querySelectorAll('[data-checkout-ip]')].find(row=>row.dataset.checkoutIp===focusRequest),field=row?.querySelector(focusSelector);if(field&&!field.disabled)field.focus({preventScroll:true});}
 return replacement;
}

export function bindCheckoutIp({root=document,requests=[],nostros=[],activate,onChange,openHandler,openProof}){
 const panel=root.querySelector('[data-checkout-ip-register]');if(!panel)return;
 panel.querySelector('[data-ip-handler-open]').onclick=()=>openHandler(null);
 for(const row of panel.querySelectorAll('[data-checkout-ip]')){
  const record=requests.find(r=>r.requestId===row.dataset.checkoutIp),bank=row.querySelector('[data-ip-nostro]');
  if(!record)continue;
  const intermediary=row.querySelector('[data-ip-intermediary]'),Option=row.ownerDocument.defaultView.Option;
  bank.onchange=()=>{
   const n=nostros.find(x=>x.cash_account_id===bank.value);
   intermediary.replaceChildren(new Option('No intermediary',''),...(n?.intermediaries||[]).map(i=>new Option(intermediaryLabel(i),i.intermediaryId)));
  };
  row.querySelector('[data-ip-toggle]').onclick=async e=>{
   const button=e.currentTarget,active=ipState(record)==='REQUESTED';
   if(button.disabled||(!active&&ipState(record)==='CLOSED'))return;
   const receiving=row.querySelector('[data-ip-account]'),error=row.querySelector('[data-ip-error]');
   error.textContent='';
   if(active&&!receiving.value){receiving.focus();return;}
   button.disabled=true;
   try{
    const result=await activate({requestId:record.requestId,active,receivingAccountId:receiving.value,
     nostroCashAccountId:bank.value||null,intermediaryId:intermediary.value||null});
    onChange(result);
   }catch(e){error.textContent=e.message;}
   finally{button.disabled=false;}
  };
  row.querySelector('[data-ip-handler]').onclick=()=>openHandler(record);
  const proof=row.querySelector('[data-ip-proof]');if(proof)proof.onclick=()=>openProof?.(record);
 }
}

// One original PDF at a time; closing or changing workspace destroys its bytes and preview.
export function createCheckoutIpProof({root=document,fetcher=(...args)=>fetch(...args),urlApi=URL,onUnauthorized=()=>{}}={}){
 let dialog=null,objectUrl=null,controller=null,generation=0,returnFocus=null,returnRequest=null,returnSelector=null;
 const close=()=>{
  generation++;controller?.abort();controller=null;
  if(dialog){dialog.close();dialog.remove();dialog=null;}
  if(objectUrl){urlApi.revokeObjectURL(objectUrl);objectUrl=null;}
  const replacement=returnRequest&&returnSelector?[...root.querySelectorAll('[data-checkout-ip]')].find(row=>row.dataset.checkoutIp===returnRequest)?.querySelector(returnSelector):null;
  const target=returnFocus?.isConnected?returnFocus:replacement;target?.focus({preventScroll:true});
  returnFocus=null;returnRequest=null;returnSelector=null;
 };
 async function open(record){
  close();if(!record?.processing?.proof?.available)return;
  const serial=++generation;returnFocus=root.activeElement;returnRequest=returnFocus?.closest('[data-checkout-ip]')?.dataset.checkoutIp;
  returnSelector=controlSelectors.find(selector=>returnFocus?.matches(selector));controller=new AbortController();
  const own=root.createElement('dialog');dialog=own;own.className='ip-proof-dialog';own.setAttribute('aria-labelledby','ip-proof-title');own.dataset.ipProofDialog='';
  own.innerHTML='<div class="dialog-heading ip-proof-handle"><div><h2 id="ip-proof-title">Proof of Payment</h2><p>'+esc(record.checkoutReference)+' · '+esc(record.processing.transactionReference)+'</p></div>'+
   '<button type="button" class="close" aria-label="Close proof of payment">×</button></div><div class="ip-proof-toolbar">'+
   '<button type="button" data-ip-print disabled>Print</button><a data-ip-download hidden>Download PDF</a></div>'+
   '<p data-ip-proof-loading>Loading payment proof…</p><p class="form-error" data-ip-proof-error role="alert"></p><iframe title="Original proof of payment PDF" hidden></iframe>';
  root.body.append(own);own.oncancel=e=>{e.preventDefault();close();};own.querySelector('.close').onclick=close;own.showModal();
  const handle=own.querySelector('.ip-proof-handle'),win=root.defaultView;
  handle.onpointerdown=e=>{
   if(e.button!==0||e.target.closest('button'))return;
   const box=own.getBoundingClientRect(),x=e.clientX,y=e.clientY;handle.setPointerCapture(e.pointerId);
   handle.onpointermove=m=>{if(!handle.hasPointerCapture(m.pointerId))return;own.style.margin='0';own.style.left=Math.max(0,Math.min(win.innerWidth-box.width,box.left+m.clientX-x))+'px';own.style.top=Math.max(0,Math.min(win.innerHeight-box.height,box.top+m.clientY-y))+'px';};
   const release=m=>{if(handle.hasPointerCapture(m.pointerId))handle.releasePointerCapture(m.pointerId);handle.onpointermove=null;};
   handle.onpointerup=release;handle.onpointercancel=release;
  };
  const frame=own.querySelector('iframe'),print=own.querySelector('[data-ip-print]'),error=own.querySelector('[data-ip-proof-error]');
  print.onclick=()=>{try{frame.contentWindow.focus();frame.contentWindow.print();}catch{error.textContent='Download the PDF to print it with your PDF reader.';}};
  try{
   const response=await fetcher('/api/checkout-ip/'+encodeURIComponent(record.requestId)+'/proof.pdf',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
   if(serial!==generation)return;
   if(response.status===401){onUnauthorized();throw Error('Sign in to view this payment proof.');}
   if(!response.ok){let detail;try{detail=await response.json();}catch{}throw Error(detail?.message||'Could not load this payment proof. Try opening it again.');}
   if(response.headers.get('content-type')?.split(';')[0].trim()!=='application/pdf')throw Error('The payment proof response is not a PDF.');
   const blob=await response.blob();if(serial!==generation)return;
   objectUrl=urlApi.createObjectURL(blob);
   const download=own.querySelector('[data-ip-download]');download.href=objectUrl;download.download=record.processing.proof.fileName||'payment-proof.pdf';download.hidden=false;
   frame.onload=()=>{if(serial===generation)print.disabled=false;};frame.src=objectUrl;frame.hidden=false;
   own.querySelector('[data-ip-proof-loading]').hidden=true;
  }catch(e){if(serial===generation&&e.name!=='AbortError'){own.querySelector('[data-ip-proof-loading]').hidden=true;error.textContent=e.message;}}
 }
 return {open,close};
}
