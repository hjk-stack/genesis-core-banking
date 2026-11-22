const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money=value=>String(value??'0').replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1');

export function nostroRegisterTable(rows=[]){
 return '<section class="panel" data-nostro-register>'+
  '<div class="panel-header"><h2>NOSTRO Clearing · Settlement network</h2><span>'+rows.length+' registered accounts</span></div>'+
  '<div class="table-wrap"><table><thead><tr><th>Bank / account details</th><th>External settlement account</th><th>Currency</th><th>Booked balance</th><th>Reserved</th><th>Bank network</th><th>Card settlement</th><th>Manage</th></tr></thead><tbody>'+
  rows.map(row=>{
   const intermediaries=Array.isArray(row.intermediaries)?row.intermediaries:[];
   return '<tr data-nostro-row="'+esc(row.cash_account_id)+'"><td><strong>'+esc(row.institution_name)+'</strong><small>'+esc(row.institution_type?.replaceAll('_',' '))+'</small>'+
    '<small>'+esc(row.bank_address||'Address not recorded')+'</small>'+
    '<small>Account name: '+esc(row.account_name||'—')+'</small>'+
    '<small>ABA: '+esc(row.aba||'—')+' · Reference: '+esc(row.bank_reference||'—')+'</small>'+
    '<div class="nostro-intermediary-details"><strong>Incoming intermediary bank</strong>'+
    (intermediaries.length?intermediaries.map(i=>'<div data-nostro-intermediary="'+esc(i.intermediaryId)+'"><small>'+esc(i.bankName)+' · '+esc(i.bankAddress)+'</small>'+
      '<small>Account: '+esc(i.accountName)+' · ABA: '+esc(i.aba||'—')+'</small>'+
      '<small>Reference: '+esc(i.reference)+' · BIC: '+esc(i.bic||'—')+' · Account: '+esc(i.accountNumber||'—')+'</small></div>').join(''):
      '<small>No incoming intermediary registered</small>')+'</div></td>'+
    '<td class="account-number">'+esc(row.iban_or_account_no)+'<small>BIC '+esc(row.bic_code||'—')+'</small></td>'+
    '<td>'+esc(row.currency_code)+'</td><td>'+esc(money(row.available_balance))+'</td><td>'+esc(money(row.locked_balance))+'</td>'+
    '<td>'+esc(row.bank_connectors||'—')+'</td><td>'+esc(row.card_gateways||'—')+'</td>'+
    '<td><button type="button" data-nostro-edit="'+esc(row.cash_account_id)+'">Edit NOSTRO &amp; intermediary</button> '+
    '<button type="button" data-nostro-mirror="'+esc(row.cash_account_id)+'">Mirror movement</button> '+
    '<button type="button" data-nostro-gateway="'+esc(row.cash_account_id)+'">Card gateway</button> '+
    '<button type="button" data-nostro-bank="'+esc(row.cash_account_id)+'">Bank API / ISO</button></td></tr>';
  }).join('')+
  '</tbody></table></div>'+(!rows.length?'<p class="panel-empty">Register a NOSTRO account together with its incoming intermediary bank.</p>':'')+
  '</section>';
}
export function nostroMovementsTable(rows=[]){
 return '<details class="panel" data-nostro-movements><summary class="panel-header"><h2>NOSTRO Clearing movements</h2><span>'+rows.length+' recent entries</span></summary>'+
  '<div class="table-wrap"><table><thead><tr><th>Date / time</th><th>Institution</th><th>Currency</th><th>Flow</th><th>Amount</th><th>Balance after</th><th>External reference</th><th>Rail</th><th>Source / event</th></tr></thead><tbody>'+
  rows.map(row=>'<tr><td>'+esc(row.created_at?new Date(row.created_at).toLocaleString():'')+'</td>'+
   '<td>'+esc(row.institution_name)+'</td><td>'+esc(row.currency_code)+'</td>'+
   '<td>'+esc(row.direction==='DEBIT'?'Incoming':'Outgoing')+'</td><td>'+esc(money(row.amount))+'</td>'+
   '<td>'+esc(money(row.running_balance))+'</td><td>'+esc(row.external_reference||'—')+'</td>'+
   '<td>'+esc(row.rail||'—')+'</td><td>'+esc(row.source)+' · '+esc(row.event_type)+'</td></tr>').join('')+
  '</tbody></table></div></details>';
}

export function intermediaryBankTable(rows=[]){
 return '<section class="panel" data-intermediary-register>'+
  '<div class="panel-header"><h2>Intermediary bank register</h2><span>'+rows.length+' linked intermediary banks</span></div>'+
  '<div class="table-wrap"><table><thead><tr><th>Related NOSTRO bank</th><th>Intermediary bank</th>'+
  '<th>Bank address</th><th>Account name</th><th>ABA</th><th>Reference</th><th>BIC / Account</th><th>Manage</th></tr></thead><tbody>'+
  rows.map(row=>'<tr><td>'+esc(row.parent_bank_name)+'<small>'+esc(row.parent_currency)+' · '+esc(row.parent_account)+'</small></td>'+
   '<td><strong>'+esc(row.bank_name)+'</strong></td><td>'+esc(row.bank_address)+'</td>'+
   '<td>'+esc(row.account_name)+'</td><td>'+esc(row.aba||'—')+'</td><td>'+esc(row.reference)+'</td>'+
   '<td>'+esc(row.bic_code||'—')+'<small>'+esc(row.account_number||'—')+'</small></td>'+
   '<td><button type="button" data-intermediary-edit="'+esc(row.intermediary_id)+'">Edit</button></td></tr>').join('')+
  '</tbody></table></div>'+(!rows.length?'<p class="panel-empty">Intermediary banks can be linked to an existing NOSTRO account.</p>':'')+'</section>';
}
