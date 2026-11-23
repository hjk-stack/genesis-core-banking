const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money=value=>String(value??'0').replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1');
const intermediaryValue=value=>{
 const text=String(value??'').trim();
 return /^(?:n\/?a|tba|tbd|none|not applicable|not available|not provided|not recorded|unknown|[-—–]+)$/i.test(text)?'':text;
};
const intermediaryKeys=['bankName','bankAddress','accountName','aba','reference','bic','accountNumber'];
const intermediaryNames=['intermediaryBankName','intermediaryBankAddress','intermediaryAccountName','intermediaryAba','intermediaryReference','intermediaryBic','intermediaryAccountNumber'];
const hasIntermediaryDetails=row=>intermediaryKeys.some(key=>intermediaryValue(row[key]));
const intermediarySelections=new WeakMap();
const intermediaryLines=row=>{
 const value=Object.fromEntries(intermediaryKeys.map(key=>[key,intermediaryValue(row[key])]));
 const lines=[[value.bankName,value.bankAddress].filter(Boolean).join(' · '),
  [value.accountName&&'Account: '+value.accountName,value.aba&&'ABA: '+value.aba].filter(Boolean).join(' · '),
  [value.reference&&'Reference: '+value.reference,value.bic&&'BIC: '+value.bic,value.accountNumber&&'Account: '+value.accountNumber].filter(Boolean).join(' · ')];
 return lines.filter(Boolean).map(line=>'<small>'+esc(line)+'</small>').join('');
};

export function intermediaryFields(editing=false){
 const labels=['Intermediary bank name','Intermediary bank address','Intermediary account name','Intermediary ABA (US banks)','Intermediary reference','Intermediary BIC','Intermediary account number'];
 const lengths=[100,300,140,9,140,11,128];
 return '<fieldset class="incoming-intermediary-fields"><legend>Incoming intermediary bank · optional</legend>'+
  (editing?'<label>Incoming intermediary selection<select name="intermediarySelector" aria-label="Incoming intermediary selection"><option value="">No intermediary changes</option><option value="NEW">Add new incoming intermediary</option></select></label>':'')+
  intermediaryNames.map((name,index)=>'<label>'+labels[index]+'<input name="'+name+'" aria-label="'+labels[index]+'" maxlength="'+lengths[index]+'"'+(name==='intermediaryAba'?' pattern="[0-9]{9}" inputmode="numeric"':'')+(editing?' disabled':'')+'></label>').join('')+'</fieldset>';
}

export function bindIntermediaryFields(form,rows=[]){
 const selector=form.elements.namedItem('intermediarySelector');
 if(!selector)return;
 const records=rows;
 selector.innerHTML='<option value="">No intermediary changes</option><option value="NEW">Add new incoming intermediary</option>'+
  records.map(row=>'<option value="'+esc(row.intermediaryId)+'">'+esc([row.bankName,row.reference,row.bic,row.accountNumber,row.accountName,row.bankAddress,row.aba].map(intermediaryValue).filter(Boolean).join(' · ')||row.intermediaryId)+'</option>').join('');
 const populate=()=>{
  const row=records.find(record=>record.intermediaryId===selector.value);
  const original=Object.fromEntries(intermediaryKeys.map(key=>[key,String(row?.[key]??'')]));
  const displayed=Object.fromEntries(intermediaryKeys.map(key=>[key,intermediaryValue(original[key])]));
  intermediaryNames.forEach((name,index)=>{const field=form.elements.namedItem(name);field.value=displayed[intermediaryKeys[index]];field.disabled=!selector.value;});
  intermediarySelections.set(form,{id:row?.intermediaryId||null,original,displayed});
 };
 selector.value='';selector.onchange=populate;populate();
}

export function combinedNostroInput(data,form){
 const input=Object.fromEntries(data),selection=input.intermediarySelector;
 const details=Object.fromEntries(intermediaryKeys.map((key,index)=>[key,String(input[intermediaryNames[index]]??'').trim()]));
 for(const name of ['intermediarySelector',...intermediaryNames])delete input[name];
 if(selection==='')return input;
 if(selection&&selection!=='NEW'){
  const saved=intermediarySelections.get(form);
  if(!saved||saved.id!==selection)return input;
  if(intermediaryKeys.every(key=>details[key]===saved.displayed[key]))return input;
  return {...input,intermediary:{intermediaryId:selection,...Object.fromEntries(intermediaryKeys.map(key=>[key,details[key]===saved.displayed[key]?saved.original[key]:details[key]]))}};
 }
 return intermediaryKeys.some(key=>details[key])?{...input,intermediary:details}:input;
}

export function nostroRegisterTable(rows=[]){
 return '<section class="panel" data-nostro-register>'+
  '<div class="panel-header"><h2>NOSTRO Clearing · Settlement network</h2><span>'+rows.length+' registered accounts</span></div>'+
  '<div class="table-wrap"><table><thead><tr><th>Bank / account details</th><th>External settlement account</th><th>Currency</th><th>Manage</th></tr></thead><tbody>'+
  rows.map(row=>{
   const intermediaries=Array.isArray(row.intermediaries)?row.intermediaries.filter(hasIntermediaryDetails):[];
   return '<tr data-nostro-row="'+esc(row.cash_account_id)+'"><td><strong>'+esc(row.institution_name)+'</strong><small>'+esc(row.institution_type?.replaceAll('_',' '))+'</small>'+
    '<small>'+esc(row.bank_address||'Address not recorded')+'</small>'+
    '<small>Account name: '+esc(row.account_name||'—')+'</small>'+
    '<small>ABA: '+esc(row.aba||'—')+' · Reference: '+esc(row.bank_reference||'—')+'</small>'+
    (intermediaries.length?'<div class="nostro-intermediary-details"><strong>Incoming intermediary bank</strong>'+intermediaries.map(i=>'<div data-nostro-intermediary="'+esc(i.intermediaryId)+'">'+intermediaryLines(i)+'</div>').join('')+'</div>':'')+'</td>'+
    '<td class="account-number">'+esc(row.iban_or_account_no)+'<small>BIC '+esc(row.bic_code||'—')+'</small></td>'+
    '<td>'+esc(row.currency_code)+'</td>'+
    '<td><button type="button" data-nostro-statements="'+esc(row.cash_account_id)+'">External statements</button> '+
    '<button type="button" data-nostro-edit="'+esc(row.cash_account_id)+'">Edit NOSTRO &amp; intermediary</button> '+
    '<button type="button" data-nostro-mirror="'+esc(row.cash_account_id)+'">Mirror movement</button> '+
    '<button type="button" data-nostro-gateway="'+esc(row.cash_account_id)+'">Card gateway</button> '+
    '<button type="button" data-nostro-bank="'+esc(row.cash_account_id)+'">Bank API / ISO</button></td></tr>';
  }).join('')+
  '</tbody></table></div>'+(!rows.length?'<p class="panel-empty">Register a NOSTRO account.</p>':'')+
  '</section>';
}
export function nostroMovementsTable(rows=[]){
 return '<details class="panel" data-nostro-movements><summary class="panel-header"><h2>Internal clearing ledger</h2><span>'+rows.length+' recent entries</span></summary>'+
  '<div class="table-wrap"><table><thead><tr><th>Date / time</th><th>Institution</th><th>Currency</th><th>Flow</th><th>Amount</th><th>Balance after</th><th>External reference</th><th>Rail</th><th>Source / event</th></tr></thead><tbody>'+
  rows.map(row=>'<tr><td>'+esc(row.created_at?new Date(row.created_at).toLocaleString():'')+'</td>'+
   '<td>'+esc(row.institution_name)+'</td><td>'+esc(row.currency_code)+'</td>'+
   '<td>'+esc(row.direction==='DEBIT'?'Incoming':'Outgoing')+'</td><td>'+esc(money(row.amount))+'</td>'+
   '<td>'+esc(money(row.running_balance))+'</td><td>'+esc(row.external_reference||'—')+'</td>'+
   '<td>'+esc(row.rail||'—')+'</td><td>'+esc(row.source)+' · '+esc(row.event_type)+'</td></tr>').join('')+
  '</tbody></table></div></details>';
}

export function intermediaryBankTable(rows=[]){
 rows=rows.filter(row=>hasIntermediaryDetails({bankName:row.bank_name,bankAddress:row.bank_address,accountName:row.account_name,aba:row.aba,reference:row.reference,bic:row.bic_code,accountNumber:row.account_number}));
 return '<section class="panel" data-intermediary-register>'+
  '<div class="panel-header"><h2>Intermediary bank register</h2><span>'+rows.length+' linked intermediary banks</span></div>'+
  '<div class="table-wrap"><table><thead><tr><th>Related NOSTRO bank</th><th>Intermediary bank</th>'+
  '<th>Bank address</th><th>Account name</th><th>ABA</th><th>Reference</th><th>BIC / Account</th><th>Manage</th></tr></thead><tbody>'+
  rows.map(row=>'<tr><td>'+esc(row.parent_bank_name)+'<small>'+esc(row.parent_currency)+' · '+esc(row.parent_account)+'</small></td>'+
   '<td><strong>'+esc(intermediaryValue(row.bank_name))+'</strong></td><td>'+esc(intermediaryValue(row.bank_address))+'</td>'+
   '<td>'+esc(intermediaryValue(row.account_name))+'</td><td>'+esc(intermediaryValue(row.aba))+'</td><td>'+esc(intermediaryValue(row.reference))+'</td>'+
   '<td>'+esc(intermediaryValue(row.bic_code))+'<small>'+esc(intermediaryValue(row.account_number))+'</small></td>'+
   '<td><button type="button" data-intermediary-edit="'+esc(row.intermediary_id)+'">Edit</button></td></tr>').join('')+
  '</tbody></table></div>'+(!rows.length?'<p class="panel-empty">Intermediary banks can be linked to an existing NOSTRO account.</p>':'')+'</section>';
}

const importedDate=value=>value?new Date(value).toLocaleString():'';
const accountDetails=account=>'<dl class="account-detail-fields">'+[
 ['Bank',account.institutionName],['External account',account.accountNumber],['BIC',account.bic],['Currency',account.currency]
].filter(([,value])=>value).map(([label,value])=>'<dt>'+label+'</dt><dd>'+esc(value)+'</dd>').join('')+'</dl>';
const statementRows=rows=>rows.map(row=>'<tr data-nostro-statement-row="'+esc(row.statementId)+'"><td>'+esc(row.reference)+'</td><td>'+esc(importedDate(row.importedAt))+'</td><td>'+esc(row.currency)+'</td><td>'+esc(money(row.openingBalance))+'</td><td>'+esc(money(row.closingBalance))+'</td><td>'+esc(row.entryCount)+'</td><td><button type="button" data-nostro-statement="'+esc(row.statementId)+'">View statement</button></td></tr>').join('');

export function createNostroStatements({api,root=document}){
 let dialog=null,generation=0,returnFocus=null;
 const close=()=>{
  generation++;const own=dialog;dialog=null;
  if(own){if(own.open)own.close();own.remove();}
  if(returnFocus?.isConnected)returnFocus.focus();returnFocus=null;
 };
 function show(){
  if(dialog)return dialog;
  const own=root.createElement('dialog');own.className='account-statement-dialog';own.dataset.nostroStatementDialog='';own.setAttribute('aria-label','External bank statements');
  own.innerHTML='<div class="dialog-heading account-window-handle"><h2>External bank statements</h2><button class="close" type="button" aria-label="Close external bank statements">×</button></div><div class="account-statement-content"><div data-nostro-statement-content></div><p class="form-error" role="alert" data-nostro-statement-error></p></div>';
  own.querySelector('[data-nostro-statement-content]').style.minWidth='0';
  dialog=own;root.body.append(own);own.querySelector('.close').onclick=close;own.oncancel=event=>{event.preventDefault();close();};own.showModal();
  const handle=own.querySelector('.account-window-handle'),view=root.defaultView;
  handle.onpointerdown=event=>{
   if(event.button!==0||event.target.closest('button'))return;
   const box=own.getBoundingClientRect(),x=event.clientX,y=event.clientY;handle.setPointerCapture(event.pointerId);
   handle.onpointermove=move=>{
    if(!handle.hasPointerCapture(move.pointerId))return;
    own.style.margin='0';own.style.left=Math.max(0,Math.min(view.innerWidth-box.width,box.left+move.clientX-x))+'px';own.style.top=Math.max(0,Math.min(view.innerHeight-box.height,box.top+move.clientY-y))+'px';
   };
   const release=move=>{if(handle.hasPointerCapture(move.pointerId))handle.releasePointerCapture(move.pointerId);handle.onpointermove=null;};
   handle.onpointerup=release;handle.onpointercancel=release;
  };
  return own;
 }
 const endpoint=id=>'nostro/'+encodeURIComponent(id)+'/statements';
 const valid=(own,serial)=>dialog===own&&own.isConnected&&generation===serial;
 const fail=(own,error)=>{own.querySelector('[data-nostro-statement-error]').textContent=error.message;};
 function bindStatementRows(own,id){
  own.querySelectorAll('[data-nostro-statement]').forEach(button=>button.onclick=()=>detail(id,button.dataset.nostroStatement));
 }
 async function list(id){
  const own=show(),serial=++generation,content=own.querySelector('[data-nostro-statement-content]');
  content.innerHTML='<p role="status">Loading statements…</p>';own.querySelector('[data-nostro-statement-error]').textContent='';
  try{
   const result=await api(endpoint(id));if(!valid(own,serial))return;
   const rows=result.statements;
   content.innerHTML=accountDetails(result.account)+'<div class="table-wrap"><table><thead><tr><th>Statement reference</th><th>Imported</th><th>Currency</th><th>Opening balance</th><th>Closing balance</th><th>Entries</th><th></th></tr></thead><tbody>'+statementRows(rows)+'</tbody></table></div>'+
    (!rows.length?'<p>No external statements have been imported for this account.</p>':'')+'<button type="button" data-nostro-older>Load older statements</button>';
   let next=result.nextCursor;const older=own.querySelector('[data-nostro-older]');older.hidden=!next;
   older.onclick=async()=>{
    if(!next||older.disabled)return;older.disabled=true;own.querySelector('[data-nostro-statement-error]').textContent='';
    try{
     const page=await api(endpoint(id)+'?before='+encodeURIComponent(next));if(!valid(own,serial))return;
     content.querySelector('tbody').insertAdjacentHTML('beforeend',statementRows(page.statements));next=page.nextCursor;older.hidden=!next;bindStatementRows(own,id);
    }catch(error){if(valid(own,serial))fail(own,error);}finally{if(valid(own,serial))older.disabled=false;}
   };
   bindStatementRows(own,id);
  }catch(error){if(valid(own,serial)){content.replaceChildren();fail(own,error);}}
 }
 async function detail(id,statementId){
  const own=show(),serial=++generation,content=own.querySelector('[data-nostro-statement-content]');
  content.innerHTML='<p role="status">Loading statement…</p>';own.querySelector('[data-nostro-statement-error]').textContent='';
  try{
   const result=await api(endpoint(id)+'/'+encodeURIComponent(statementId));if(!valid(own,serial))return;
   const statement=result.statement;
   content.innerHTML=accountDetails(result.account)+'<dl class="account-detail-fields"><dt>Statement reference</dt><dd>'+esc(statement.reference)+'</dd><dt>Imported</dt><dd>'+esc(importedDate(statement.importedAt))+'</dd></dl>'+
    '<dl class="account-detail-fields"><dt>Opening balance</dt><dd>'+esc(money(statement.openingBalance))+' '+esc(statement.currency)+'</dd><dt>Closing balance</dt><dd>'+esc(money(statement.closingBalance))+' '+esc(statement.currency)+'</dd></dl>'+
    '<div class="table-wrap"><table><thead><tr><th>Bank reference</th><th>Direction</th><th>Amount</th><th>Currency</th></tr></thead><tbody>'+result.entries.map(entry=>'<tr><td>'+esc(entry.bankReference)+'</td><td>'+esc(entry.direction==='CREDIT'?'Incoming (credit)':entry.direction==='DEBIT'?'Outgoing (debit)':entry.direction)+'</td><td>'+esc(money(entry.amount))+'</td><td>'+esc(statement.currency)+'</td></tr>').join('')+'</tbody></table></div><button type="button" data-nostro-back>Back to statements</button>';
   own.querySelector('[data-nostro-back]').onclick=()=>list(id);
  }catch(error){if(valid(own,serial)){content.innerHTML='<button type="button" data-nostro-back>Back to statements</button>';own.querySelector('[data-nostro-back]').onclick=()=>list(id);fail(own,error);}}
 }
 async function open(id,trigger){close();returnFocus=trigger||root.activeElement;return list(id);}
 function bind(container){container.querySelectorAll('[data-nostro-statements]').forEach(button=>button.onclick=()=>open(button.dataset.nostroStatements,button));}
 return {open,close,bind};
}
