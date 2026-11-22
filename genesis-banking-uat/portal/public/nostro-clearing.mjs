const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money=value=>String(value??'0').replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1');

export function nostroRegisterTable(rows=[]){
 return '<section class="panel" data-nostro-register>'+
  '<div class="panel-header"><h2>NOSTRO Clearing · Settlement network</h2><span>'+rows.length+' registered accounts</span></div>'+
  '<div class="table-wrap"><table><thead><tr><th>Institution / type</th><th>External settlement account</th><th>Currency</th><th>Booked balance</th><th>Reserved</th><th>Bank network</th><th>Card settlement</th><th>Manage</th></tr></thead><tbody>'+
  rows.map(row=>'<tr><td><strong>'+esc(row.institution_name)+'</strong><small>'+esc(row.institution_type?.replaceAll('_',' '))+'</small></td>'+
   '<td class="account-number">'+esc(row.iban_or_account_no)+'<small>BIC '+esc(row.bic_code||'—')+'</small></td>'+
   '<td>'+esc(row.currency_code)+'</td><td>'+esc(money(row.available_balance))+'</td><td>'+esc(money(row.locked_balance))+'</td>'+
   '<td>'+esc(row.bank_connectors||'—')+'</td><td>'+esc(row.card_gateways||'—')+'</td>'+
   '<td><button type="button" data-nostro-mirror="'+esc(row.cash_account_id)+'">Mirror movement</button> '+
   '<button type="button" data-nostro-gateway="'+esc(row.cash_account_id)+'">Card gateway</button> '+
   '<button type="button" data-nostro-bank="'+esc(row.cash_account_id)+'">Bank API / ISO</button></td></tr>').join('')+
  '</tbody></table></div>'+(!rows.length?'<p class="panel-empty">Register the first clearing account to configure settlement routes.</p>':'')+
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
