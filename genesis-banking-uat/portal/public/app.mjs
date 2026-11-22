import {createAbiqGenerator} from './abiq-generator.mjs';
import {createCryptoWorkspace} from './crypto-workspace.mjs';
import {readExchangeIntent} from './exchange-intent.mjs';
import {createPortfolio,securitiesTable,stockRegisterTable,securityOrdersTable,securityBookTable} from './portfolio.mjs';
import {accountTypes,accountSummaryTable,backofficeAccountTable,createAccountStatements} from './accounts.mjs';
import {createCardManager,cardAccountTable,cardProducts} from './cards.mjs';
import {openCardMessage} from './card-message.mjs';
import {createPaymentWizard} from './payment-wizard.mjs';
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
import {openCryptoBasket,resumeBasketAuthorization,openCheckoutManagement} from './crypto-basket.mjs';
let identity={admin:true,canSwitchWorkspace:false},sessionEpoch=0,accountTypeFilter='',csrf='',activeForm=null,requestKey='',loading=0;const cache={};
let exchangeIntent=null;try{exchangeIntent=readExchangeIntent(location.hash);}catch(e){$('#login-form .form-error').textContent=e.message;}
if(exchangeIntent)$('#login-form h2').textContent=exchangeIntent.side?'Sign in to '+exchangeIntent.side.toLowerCase()+' '+exchangeIntent.symbol:'Sign in to your portfolio';
if(new URLSearchParams(location.search).get('own')==='1'){$('#close-workspace').hidden=false;$('#close-workspace').onclick=()=>{if(window.avisDesktop?.windowControl)window.avisDesktop.windowControl('close');else{window.close();setTimeout(()=>{if(!window.closed)location.assign('https://avis.land/exchange');},300);}};}
const currencies=['EUR','USD','GBP','CHF','SEK','NOK','DKK','PLN','CZK','HUF','RON','AED','SGD','JPY'];
async function api(path,body,key){
 const epoch=sessionEpoch,write=body!==undefined;
 let response;
 try{
  response=await fetch('/api/'+path,{
   method:write?'POST':'GET',
   headers:write?{'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':key||crypto.randomUUID()}:{},
   ...(write?{body:JSON.stringify(body)}:{})
  });
 }catch{
  throw Object.assign(new Error('Could not reach the banking service.'),{code:'NETWORK_REQUEST_FAILED'});
 }
 if(response.status===401&&path!=='login'&&epoch===sessionEpoch){
  exchangeIntent=portfolioManager.pendingIntent()||exchangeIntent;signedOut();
 }
 let data;
 try{data=await response.json();}
 catch{
  throw Object.assign(new Error('Could not read the banking response.'),{
   code:'INVALID_RESPONSE',status:response.status,requestId:response.headers.get('x-request-id')
  });
 }
 if(!response.ok)throw Object.assign(new Error(data.message||'Please try this action again.'),data);
 return data;
}
let formGeneration=0,noticeTimer;
function clearNotice(){clearTimeout(noticeTimer);$('#notice').textContent='';$('#notice').hidden=true;}
function clearForm(){abiqGenerator.close();formGeneration++;activeForm=null;if($('#form-dialog').open)$('#form-dialog').close();$('#action-form').reset();$('#form-fields').replaceChildren();}
function signedOut(){document.querySelector('[data-basket-authorize]')?.remove();document.querySelector('[data-checkout-management]')?.remove();sessionEpoch++;loading++;clearNotice();$('#workspace-selector').replaceChildren();$('#workspace-error').textContent='';clearForm();paymentWizard.close();cardManager.close();accountStatements.close();portfolioManager.close();cryptoManager.close();accountTypeFilter='';$('#workspace-selector').hidden=true;$('#workspace').hidden=true;$('#signin').hidden=false;$('#signout').hidden=true;$('#operator-name').textContent='';csrf='';for(const k of Object.keys(cache))delete cache[k];if($('#form-dialog').open)$('#form-dialog').close();}
function signedIn(session){document.querySelector('[data-basket-authorize]')?.remove();document.querySelector('[data-checkout-management]')?.remove();sessionEpoch++;clearNotice();$('#workspace-selector').replaceChildren();$('#workspace-error').textContent='';clearForm();paymentWizard.close();cardManager.close();accountStatements.close();portfolioManager.close();cryptoManager.close();accountTypeFilter='';for(const k of Object.keys(cache))delete cache[k];identity={...session,admin:session.admin!==false};csrf=session.csrf;document.querySelectorAll('nav a').forEach(a=>a.hidden=!identity.admin&&!['#accounts','#portfolio','#payments','#cards','#wallets'].includes(a.hash));void refreshWorkspaces();void refreshPickupAlerts();$('#workspace').hidden=false;$('#signin').hidden=true;$('#signout').hidden=false;$('#operator-name').textContent=session.username;void resumeExchange();void showStripeReturn();if(new URLSearchParams(location.search).get('crypto_basket')==='1'){const purpose=new URLSearchParams(location.search).get('purpose');history.replaceState(null,'','#wallets');void openCryptoBasket(api,null,null,purpose).catch(pageError);}else if(identity.admin&&new URLSearchParams(location.search).get('checkout_management')==='1'){history.replaceState(null,'','#pos');void openCheckoutManagement(api);}else void resumeBasketAuthorization(api,document.body);}
async function showStripeReturn(){
 const params=new URLSearchParams(location.search),kind=params.get('stripe_pos');if(!['return','cancel'].includes(kind))return;
 const sessionId=params.get('session_id');
 if(kind==='cancel'){notice('Stripe checkout closed. The payment register retains its original reference.');return;}
 if(!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId||''))return;
 try{const result=await api('stripe/webpos/status?sessionId='+encodeURIComponent(sessionId));
  notice(result.status==='PAID'?'Stripe card payment confirmed · '+result.reference:'Stripe checkout returned · confirm the payment in Stripe card payments');
  history.replaceState(null,'',location.pathname+location.hash);
 }catch(error){pageError(error);}
}
async function resumeExchange(){
 const serial=sessionEpoch,intent=exchangeIntent;
 if(intent)history.replaceState(null,'','#portfolio');
 await render();if(serial!==sessionEpoch||!intent)return;
 try{if(intent.side)await portfolioManager.fromExchange(intent);if(serial===sessionEpoch)exchangeIntent=null;}catch(e){if(serial===sessionEpoch&&location.hash==='#portfolio')pageError(e);}
}
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');button.disabled=true;form.querySelector('.form-error').textContent='';try{signedIn(await api('login',Object.fromEntries(new FormData(form))));form.reset();}catch(err){form.querySelector('.form-error').textContent=err.message;}finally{button.disabled=false;}});
$('#signout').onclick=async()=>{
 const epoch=sessionEpoch;
 try{await api('logout',{});if(epoch===sessionEpoch)signedOut();}
 catch(e){if(epoch===sessionEpoch)$('#workspace-error').textContent=e.message;}
};
const number=s=>{const[a,b]=String(s).split('.');return a.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(b?'.'+b.replace(/0+$/,'').padEnd(2,'0'):'');};
const displayAbiq=s=>typeof s==='string'&&/^TN\d{2}AVIP000\d{15}$/.test(s)?s.slice(0,14)+' '+s.slice(14):s;
const label=s=>s.toLowerCase().replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
const columns={accounts:[['user_id','User'],['full_name','Account holder'],['account_type','Type'],['abiq_iban','ABIQ-IBAN'],['currency_code','Currency'],['available_balance','Available'],['locked_balance','Reserved']],customers:[['user_id','User'],['customer_number','Customer number'],['full_name','Name'],['account_type','Account type'],['account_role','Role']],ledger:[['owner_class','Owner'],['account_holder','Account holder'],['account_reference','ABIQ / Ledger account'],['currency_code','Asset'],['wallet_scope','Scope'],['account_category','Category'],['available_balance','Available'],['locked_balance','Reserved']],transactions:[['created_at','Date & time'],['reference_id','Reference'],['event_type','Operation'],['direction','Entry'],['amount','Amount'],['currency_code','Currency'],['abiq_iban','ABIQ account']],shops:[['shop_name','Shop'],['merchant_id','Merchant ID'],['full_name','Business owner'],['commission_rate_bps','Commission (bps)'],['status','Status']],checkouts:[['marketplace_order_ref','Order'],['buyer_user_id','Buyer'],['payment_rail','Payment rail'],['total_amount_eur','EUR'],['status','Status'],['checkout_id','Checkout reference']],cards:[['user_id','Customer'],['last_four_digits','Card ending'],['card_type','Type'],['card_rail_mode','Card programme'],['status','Status']],terminals:[['terminal_id','Terminal'],['merchant_id','Merchant'],['terminal_type','Type'],['status','Status']],authorizations:[['created_at','Date & time'],['terminal_id','Terminal'],['network_reference','Network reference'],['amount','Amount'],['currency_code','Currency'],['status','Status'],['authorization_id','Authorization']],gateways:[['display_name','Gateway'],['gateway_category','Route'],['settlement_cycle','Settlement cycle']],stripepayments:[['created_at','Created'],['merchant_id','Merchant'],['terminal_id','Web POS'],['reference','Reference'],['amount','Amount'],['currency_code','Currency'],['status','Stripe status'],['payment_intent_id','Payment reference']],correspondents:[['institution_name','Institution'],['institution_type','Account class'],['bic_code','BIC'],['iban_or_account_no','Account'],['currency_code','Currency']],wallets:[['user_id','Customer'],['network','Blockchain'],['public_address','Receiving address'],['destination_tag','Destination tag']],connectors:[['display_name','Connector'],['connector_code','Code'],['is_enabled','Enabled'],['auto_provision','Automatic provisioning']],audit:[['created_at','Date & time'],['actor_id','Operator'],['operation','Action'],['resource_id','Reference']]};
let posTerminalsExpanded=true,posTerminalActionBusy=false,posTerminalPolling=false,posTerminalActionEpoch=0;
const terminalDeadline=row=>row.expires_at?Date.parse(row.expires_at):row.requested_at?Date.parse(row.requested_at)+3600000:NaN;
const terminalState=row=>{
 if(row.terminal_type!=='WEB_POS')return '';
 const state=['CLOSED','REQUESTED','ACTIVE'].includes(row.activation_state)?row.activation_state:'CLOSED';
 return state==='REQUESTED'&&Number.isFinite(terminalDeadline(row))&&terminalDeadline(row)<=Date.now()?'CLOSED':state;
};
const posTime=value=>{
 if(!value)return '—';
 const date=new Date(value);
 return Number.isNaN(date.getTime())?'—':date.toLocaleString(undefined,{dateStyle:'short',timeStyle:'medium'});
};
function posTerminalsTable(rows){
 const pending=rows.filter(r=>terminalState(r)==='REQUESTED');
 const opened=posTerminalsExpanded||pending.length>0;
 return `<details class="panel pos-terminal-register" data-pos-register ${opened?'open':''}>
  <summary class="panel-header pos-terminal-summary"><h2>POS terminals</h2><span class="pos-register-count">${rows.length} terminals</span><span class="pos-pending-count" data-pending-count="${pending.length}">${pending.length} pending activation${pending.length===1?'':'s'}</span></summary>
  <div class="table-wrap"><table class="pos-terminal-table"><thead><tr><th>Terminal ID</th><th>Merchant</th><th>Type</th><th>Registration</th><th>Checkout / origin</th><th>Request &amp; expiry (local time)</th><th>Liquid Glass POS switch</th></tr></thead><tbody>
  ${rows.map(r=>{
   const state=terminalState(r),id=esc(r.terminal_id),requestAt=posTime(r.requested_at),
    expiryAt=posTime(r.expires_at||(r.requested_at&&new Date(Date.parse(r.requested_at)+3600000).toISOString())),
    lastExpiredAt=posTime(r.expired_at);
   const isPending=state==='REQUESTED',wasExpired=state==='CLOSED'&&Boolean(r.expired_at);
   const source=`<strong>${esc(r.checkout_title||r.checkout_reference||'Registered terminal')}</strong><small>${esc(r.checkout_reference||r.terminal_id)} · ${esc(r.checkout_kind||'REGISTERED')}</small>`;
   const history=isPending?`<span class="pos-time-line">Requested: <time>${esc(requestAt)}</time></span><span class="pos-time-line">Expires: <time>${esc(expiryAt)}</time></span>`
    :wasExpired?`<span class="pos-time-line">Requested: <time>${esc(requestAt)}</time></span><span class="pos-time-line">Expired: <time>${esc(lastExpiredAt)}</time></span>`
    :state==='ACTIVE'?`<span class="pos-time-line">${r.requested_at?'Requested: '+esc(requestAt):'Manual activation'}</span><span class="pos-time-line">Activated: <time>${esc(posTime(r.approved_at))}</time></span>`:'—';
   const expiryMs=isPending?terminalDeadline(r):null;
   return `<tr data-pos-terminal="${id}" data-pos-request-state="${state}" ${isPending?'class="pos-terminal-awaiting"':''}><td class="account-number">${id}</td><td>${esc(r.merchant_id)}</td><td>${esc(r.terminal_type)}</td><td><span class="status">${esc(r.status)}</span></td><td class="pos-checkout-source">${source}</td><td class="pos-request-time">${history}</td><td class="pos-activation-cell">${state?`<button type="button" class="pos-liquid-switch" role="switch" data-state="${state}" aria-checked="${state==='ACTIVE'}" aria-label="${state==='ACTIVE'?'Close':'Activate'} POS ${id}" data-terminal-toggle="${id}" data-terminal-active="${state!=='ACTIVE'}" ${expiryMs?`data-pos-deadline="${expiryMs}"`:''}><span class="pos-liquid-knob" aria-hidden="true"></span></button><span class="pos-activation-label" data-state="${state}">${isPending?'Request waiting':state==='ACTIVE'?'Open':wasExpired?'Request expired':'Closed'}</span>`:''}</td></tr>`;
  }).join('')}
  </tbody></table></div></details>`;
}
function bindTerminalControls(){
 const panel=document.querySelector('[data-pos-register]');if(!panel)return;
 panel.addEventListener('toggle',()=>{posTerminalsExpanded=panel.open});
 panel.querySelectorAll('[data-terminal-toggle]').forEach(button=>button.onclick=async()=>{
  if(button.disabled||posTerminalActionBusy)return;
  posTerminalActionBusy=true;posTerminalActionEpoch++;button.disabled=true;
  try{
   const rows=await api('terminals/activation',{terminalId:button.dataset.terminalToggle,active:button.dataset.terminalActive==='true'});
   const index=(cache.terminals||[]).findIndex(t=>t.terminal_id===rows.terminalId);
   if(index>=0)cache.terminals[index]={...cache.terminals[index],activation_state:rows.state,requested_at:rows.requestedAt,approved_at:rows.approvedAt,expired_at:rows.expiredAt,expires_at:rows.expiresAt};
   const current=document.querySelector('[data-pos-register]');if(!current||location.hash!=='#pos')return;
   posTerminalsExpanded=current.open;current.outerHTML=posTerminalsTable(cache.terminals||[]);bindTerminalControls();
  }catch(err){pageError(err,button)}finally{posTerminalActionBusy=false;if(button.isConnected)button.disabled=false}
 });
}
setInterval(()=>{
 if(!csrf||!identity.admin||location.hash!=='#pos')return;
 let expiredCount=0;
 for(const switchButton of document.querySelectorAll('[data-pos-deadline]')){
  if(Number(switchButton.dataset.posDeadline)>Date.now())continue;
  // Stop the blue flash immediately at sixty minutes, even when a network
  // poll is delayed; the server independently closes and audits the request.
  switchButton.dataset.state='CLOSED';
  switchButton.setAttribute('aria-checked','false');
  switchButton.removeAttribute('data-pos-deadline');
  const row=switchButton.closest('tr');row?.classList.remove('pos-terminal-awaiting');if(row)row.dataset.posRequestState='CLOSED';
  expiredCount++;
  const status=switchButton.parentElement.querySelector('.pos-activation-label');
  if(status){status.dataset.state='CLOSED';status.textContent='Request expired';}
 }
 if(expiredCount){
  const pending=document.querySelector('[data-pending-count]');
  if(pending){
   const remaining=document.querySelectorAll('.pos-liquid-switch[data-state="REQUESTED"]').length;
   pending.dataset.pendingCount=String(remaining);
   pending.textContent=remaining+' pending activation'+(remaining===1?'':'s');
  }
 }
},1000);
setInterval(async()=>{
 if(!csrf||!identity.admin||posTerminalActionBusy||posTerminalPolling||location.hash!=='#pos'||!document.querySelector('[data-pos-register]'))return;
 posTerminalPolling=true;
 const currentEpoch=sessionEpoch,actionEpoch=posTerminalActionEpoch;
 try{
  const before=JSON.stringify((cache.terminals||[]).map(r=>[r.terminal_id,r.activation_state,r.requested_at,r.approved_at,r.expired_at,r.expires_at,r.checkout_title]));
  const response=await api('views/terminals');
  if(currentEpoch!==sessionEpoch||actionEpoch!==posTerminalActionEpoch||posTerminalActionBusy||location.hash!=='#pos')return;
  const rows=response.rows;cache.terminals=rows;
  const after=JSON.stringify(rows.map(r=>[r.terminal_id,r.activation_state,r.requested_at,r.approved_at,r.expired_at,r.expires_at,r.checkout_title]));
  if(before===after)return;
  const panel=document.querySelector('[data-pos-register]');if(!panel)return;
  posTerminalsExpanded=panel.open||rows.some(r=>terminalState(r)==='REQUESTED');
  panel.outerHTML=posTerminalsTable(rows);bindTerminalControls();
 }catch(error){console.error('POS_TERMINAL_REFRESH',error.code||error.name)}finally{posTerminalPolling=false}
},7000);
function table(name,title,rows){return `<section class="panel"><div class="panel-header"><h2>${esc(title)}</h2><span>${rows.length} records${rows.length===300?' · latest 300':''}</span></div><div class="table-wrap"><table><thead><tr>${columns[name].map(([,h])=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${columns[name].map(([k])=>`<td${k.includes('iban')||k==='account_reference'?' class="account-number"':''}>${name==='portfolio'&&['smart_contract','historical_wallet_address'].includes(k)?(r.historical_proof||[]).map(p=>`<a class="portfolio-chain-proof" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(k==='smart_contract'?p.contractAddress:p.walletAddress)}</a>`).join('<br>')||'—':k==='request_id'?`<button type="button" data-request="${esc(r[k])}">View transfer</button>`:k==='status'?`<span class="status">${esc(label(r[k]))}</span>`:esc(k.includes('balance')||['amount','total_amount_eur'].includes(k)?number(r[k]):k==='created_at'?new Date(r[k]).toLocaleString():['abiq_iban','account_reference'].includes(k)?displayAbiq(r[k]):['owner_class','wallet_scope','account_category'].includes(k)&&r[k]?label(r[k]):typeof r[k]==='boolean'?(r[k]?'Yes':'No'):r[k]??'—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;}
Object.assign(columns,{
 treasurypositions:[['asset_name','Registered asset'],['portfolio_abiq_iban','Portfolio ABIQ IBAN'],['asset_code','Asset identifier'],['isin','ISIN'],['asset_class','Asset class'],['quantity','Units'],['destination','Treasury account'],['booking_reference','Booking reference'],['booked_at','Booked at']],
 portfolio:[['currency_code','Asset'],['network','Blockchain'],['available_balance','Available holdings'],['locked_balance','Reserved holdings'],['smart_contract','Historical smart contract'],['historical_wallet_address','Historical wallet address']],
 cryptoholdings:[['user_id','User'],['full_name','Holder'],['currency_code','Asset'],['network','Blockchain'],['available_balance','Available']],
 cryptooffers:[['asset','Asset'],['network','Blockchain'],['unit_price','Unit price'],['fiat','Pay currency'],['available_balance','Available stock']],
 transfercards:[['user_id','User'],['full_name','Cardholder'],['last_four_digits','Card ending'],['card_type','Type'],['currency_code','Currency'],['available_balance','Card balance'],['offline_reserved','Offline reserved']],
 codedcards:[['valid_from','Valid from'],['request_id','Details'],['last_four_digits','Card ending'],['amount','Amount'],['currency_code','Currency'],['expires_at','Expires'],['status','Status']],
 transferalerts:[['created_at','Submitted'],['payment_method','Method'],['beneficiary_name','Receiver'],['amount','Amount'],['currency_code','Currency'],['status','Status'],['pickup','Picked up by'],['request_id','Details']],

 paymentregister:[['created_at','Date & time'],['payment_method','Method'],['beneficiary_name','Receiver'],['beneficiary_account','Receiving account'],['amount','Amount'],['currency_code','Currency'],['payment_reference','Reference'],['delivery_mode','Route'],['status','Status'],['request_id','Details']],
 transferrequests:[['created_at','Date & time'],['payment_method','Method'],['pickup','Picked up by'],['beneficiary_name','Receiver'],['beneficiary_account','Receiving account'],['amount','Amount'],['currency_code','Currency'],['payment_reference','Reference'],['delivery_mode','Route'],['status','Status'],['delivery','Delivery'],['request_id','Details']],
fxrates:[['currency_code','Currency'],['units_per_eur','Units per EUR'],['source','Source'],['source_date','Publication date'],['observed_at','Retrieved']],
fxquotes:[['quote_id','Quote'],['from_currency','Pay currency'],['from_amount','You pay'],['fee_amount','Fee'],['to_currency','Receive currency'],['to_amount','You receive'],['rate','Quoted rate'],['rate_source','Reference source'],['rate_date','Reference date'],['expires_at','Valid until'],['status','Status']],
offlinegrants:[['grant_id','Allowance reference'],['last_four_digits','Card ending'],['allowance','Reserved EUR'],['spent','Spent EUR'],['used_transactions','Transactions'],['max_transactions','Transaction limit'],['expires_at','Spend until'],['settle_by','Upload by'],['status','Status']],
bankprofiles:[['profile_id','Connector'],['display_name','Bank / network'],['protocol','Protocol'],['local_bic','Our BIC'],['peer_bic','Bank BIC'],['currency_code','Currency'],['endpoint_url','Endpoint']],
bankroutes:[['abiq_iban','ABIQ account'],['account_number','Bank account'],['bank_bic','BIC'],['currency_code','Currency'],['connector_code','Connector']],
bankpayments:[['created_at','Created'],['direction','Direction'],['profile_id','Connector'],['debtor_iban','From'],['creditor_iban','To'],['amount','Amount'],['currency_code','Currency'],['status','Bank status'],['delivery','Delivery'],['uetr','Tracking reference']],
clearing:[['provider_reference','Statement'],['currency_code','Currency'],['opening_balance','Opening balance'],['closing_balance','Closing balance'],['entries','Entries'],['matched','Matched payments']]
});
const pages={
fx:{title:'Fiat converter',subtitle:'AVISPay treasury quotes, commission and settlement between your currency accounts.',actions:[['fxquote','Get quote'],['fxexecute','Execute conversion'],['fxcancel','Cancel quote'],['fxrefresh','Refresh reference rates']],views:[['fxquotes','Conversion quotes & settlements'],['fxrates','Published reference rates']]},
accounts:{title:'Accounts & ABIQ',subtitle:'Account summaries, currency accounts and backoffice account management.',actions:[['customer','Open account'],['currency','Add currencies'],['abiqgenerator','Generate ABIQ number'],['accountcleanup','Review legacy accounts'],['customerprofile','Account holder details'],['suspense','Move to suspense']],views:[['accountsummaries','Account summary'],['backofficeaccounts','Backoffice accounts']]},
portfolio:{title:'Portfolio management',subtitle:'Securities, investment values and exchange orders.',actions:[['recordsecurity','Record holding'],['buysecurity','Buy'],['sellsecurity','Sell'],['syncsecurities','Refresh Green Bond catalogue']],views:[['treasurypositions','AVISPay PLC Treasury opening positions'],['securitypositions','Securities portfolio'],['securityorders','Exchange orders'],['exchangebook','AVISPay Exchange'],['portfolio','Portfolio holdings']]},
payments:{title:'Payments',subtitle:'Register, review and transfer payments from your accounts.',actions:[['newpayment','New payment']],views:[['paymentregister','Payment register'],['bankpayments','Bank payments & settlement'],['bankroutes','IBAN to ABIQ routing'],['transactions','Account activity']]},
marketplace:{title:'Marketplace City',subtitle:'Business shops, multi-shop checkout and escrow settlement.',actions:[['shop','Register shop'],['checkout','Create checkout'],['release','Release escrow'],['refund','Refund checkout']],views:[['shops','Merchant shops'],['checkouts','Checkout & settlement']]},
cards:{title:'Cards',subtitle:'Card accounts, balances and payment activity.',actions:[['issuecard','Activate card account'],['loadcard','Load card'],['externalcard','Register external card'],['loadexternal','Load external card'],['card','Register existing card'],['redeemcode','Redeem card code'],['cancelcode','Release coded debit'],['opencardmessage','Open encrypted card'],['offlinekeys','Offline keys'],['allowance','Offline allowance'],['offlineclose','Release allowance']],views:[['cardaccounts','Card accounts'],['codedcards','Code-secured card debits'],['offlinegrants','Offline allowances']]},
pos:{title:'POS',subtitle:'Terminals, authorizations and merchant settlement.',actions:[['checkoutmanagement','Checkout management'],['terminal','Register terminal'],['stripecard','Stripe card payment'],['authorize','Authorize'],['capture','Capture'],['reverse','Reverse'],['offlinesync','Upload signed batch']],views:[['stripepayments','Stripe card payments'],['terminals','POS terminals'],['authorizations','Authorizations & captures'],['gateways','Payment gateways']]},
wallets:{title:'Crypto & tokenisation',subtitle:'Receiving addresses and asset balances by customer and blockchain.',actions:[['buycrypto','Purchase AG / AGi / crypto'],['sellcrypto','Convert to FIAT'],['cryptooffer','Register sale offer']],views:[['cryptoholdings','Crypto holdings'],['cryptooffers','Purchase offers'],['wallets','Blockchain addresses']]},
administration:{title:'Administration',subtitle:'Transfer requests, operator audit and bank connections.',actions:[['bindlogin','Link customer login'],['dispatch','Submit queued bank payment'],['cashaccount','Add clearing account'],['bankprofile','Add bank connector'],['bankroute','Link IBAN to ABIQ']],views:[['transferalerts','Transfers awaiting administrator pickup'],['transferrequests','Transfer requests · Outgoing transfer requests'],['correspondents','Clearing & correspondent accounts'],['bankprofiles','Bank connectors'],['connectors','Quantum connectors'],['clearing','Clearing records'],['audit','Operations audit']]}
};
async function refreshWorkspaces(){
 const field=$('#workspace-selector'),epoch=sessionEpoch;
 field.hidden=!identity.canSwitchWorkspace;
 if(!identity.canSwitchWorkspace)return;
 try{
  const result=await api('workspaces');
  if(epoch!==sessionEpoch)return;
  field.innerHTML='<option value="">Administration</option>'+result.rows.map(r=>`<option value="${esc(r.user_id)}">${esc(r.full_name)} · User ${esc(r.user_id)}</option>`).join('');
  field.value=identity.customerUserId||'';
 }catch(e){
  if(epoch===sessionEpoch)console.error('WORKSPACE_LIST_READ_FAILED',e.code||e.name,e.requestId||'');
 }
}
$('#workspace-selector').onfocus=()=>{if(!$('#workspace-selector').options.length)void refreshWorkspaces();};
$('#workspace-selector').onchange=async e=>{
 const field=e.currentTarget,epoch=sessionEpoch;
 field.disabled=true;$('#workspace-error').textContent='';
 try{
  const session=await api('workspace',{userId:field.value||null});
  if(epoch===sessionEpoch){location.hash='#accounts';signedIn(session);}
 }catch(err){
  if(epoch===sessionEpoch){field.value=identity.customerUserId||'';$('#workspace-error').textContent=err.message;}
 }finally{field.disabled=false;}
};
function visiblePage(key){
 if(identity.admin)return pages[key]||pages.accounts;
 const allowed={accounts:{...pages.accounts,subtitle:'Your accounts and available balances.',actions:[['currency','Add currencies'],...(identity.canSwitchWorkspace?[['abiqgenerator','Generate ABIQ number']]:[]),['customerprofile','My details']],views:[['accountsummaries','My accounts']]},portfolio:{...pages.portfolio,subtitle:'Your securities, investment values and exchange orders.',actions:[['buysecurity','Buy'],['sellsecurity','Sell'],['buycrypto','Purchase assets'],['sellcrypto','Convert to FIAT']]},payments:{...pages.payments,views:[['paymentregister','My payments'],['transactions','Account activity']]},cards:{...pages.cards,actions:pages.cards.actions.filter(([id])=>!['card','offlinekeys','allowance','offlineclose'].includes(id)),views:[['cardaccounts','My card accounts'],['codedcards','Code-secured card debits']]},wallets:{...pages.wallets,actions:pages.wallets.actions.filter(([id])=>id!=='cryptooffer')}};
 return allowed[key]||allowed.accounts;
}
async function refreshPickupAlerts(){if(!csrf||!identity.admin)return;try{const rows=await getRows('transferalerts'),link=document.querySelector('nav a[href="#administration"]');if(link){link.textContent=rows.length?'Administration · '+rows.length:'Administration';link.setAttribute('aria-label',rows.length?'Administration · '+rows.length+' transfers awaiting processing':'Administration');}}catch{}}
setInterval(()=>void refreshPickupAlerts(),30000);
async function getRows(view){const epoch=sessionEpoch,result=await api('views/'+view);if(epoch!==sessionEpoch)throw Error('Workspace changed. Repeat the action.');cache[view]=result.rows;return result.rows;}
async function render(){if(!csrf)return;void refreshPickupAlerts();if(location.hash==='#ledger')history.replaceState(null,'','#portfolio');const serial=++loading,key=location.hash.slice(1)||'accounts',page=visiblePage(key);document.querySelectorAll('nav a').forEach(a=>a.classList.toggle('active',a.hash==='#'+key));if(key==='wallets')return cryptoManager.mount($('#view'));cryptoManager.close();$('#view').innerHTML=`<div class="view-header"><div><h1>${esc(page.title)}</h1><p>${esc(page.subtitle)}</p></div><div class="actions">${key==='portfolio'?'<a class="button" href="https://avis.land/exchange?banking=1">AVIS Exchange</a>':''}${page.actions.map(([id,name],i)=>`<button data-form="${id}" class="${i===0?'primary':''}">${esc(name)}</button>`).join('')}</div></div>${key==='accounts'&&identity.admin?`<div class="account-filter"><label>Account type<select id="account-type-filter" aria-label="Account type"><option value="">All accounts</option>${accountTypes.map(([v,t])=>`<option value="${v}" ${accountTypeFilter===v?'selected':''}>${t}</option>`).join('')}</select></label></div>`:''}<p class="form-error" role="alert" id="account-page-error"></p><div id="panels" aria-busy="true"></div>`;if($('#account-type-filter'))$('#account-type-filter').onchange=e=>{accountTypeFilter=e.target.value;void render();};document.querySelectorAll('[data-form]').forEach(b=>b.onclick=()=>openForm(b.dataset.form));
const results=await Promise.allSettled(page.views.map(([v])=>getRows(v)));if(serial!==loading)return;let html='';
if(key==='accounts'&&identity.admin&&!accountTypeFilter&&results.every(r=>r.status==='fulfilled'))html=`<div class="metrics"><div class="metric"><p>Account holders</p><strong>${new Set(results[0].value.map(a=>String(a.user_id))).size}</strong></div><div class="metric"><p>ABIQ currency accounts</p><strong>${results[0].value.length}</strong></div><div class="metric"><p>Backoffice accounts</p><strong>${results[1].value.length}</strong></div></div>`;
if(key==='pos')html+=`<div class="rail-grid"><div class="rail"><p class="eyebrow">AVIS PROPRIETARY</p><h2>Own-network processing</h2><p>Authorization · capture · reversal · merchant settlement</p></div><div class="rail"><p class="eyebrow">GLOBAL CARD SCHEMES</p><h2>Scheme gateway bridge</h2><p>Separate issuing, acquiring and clearing routes</p></div><div class="rail"><p class="eyebrow">POS & INDUSTRIAL</p><h2>Terminal network</h2><p>Merchant ownership and terminal registration</p></div></div>`;
html+=results.map((r,i)=>{
 const view=page.views[i][0],type=key==='accounts'&&identity.admin?accountTypeFilter:'';
 if(type&&(['COMMON','SUSPENSE'].includes(type)?view!=='backofficeaccounts':view==='backofficeaccounts'))return '';
 if(r.status!=='fulfilled')return `<section class="panel"><div class="panel-header"><h2>${esc(page.views[i][1])}</h2></div><p class="panel-error">${esc(r.reason.message)}</p></section>`;
 const rows=type?r.value.filter(x=>x.account_type===type):r.value;
 if(view==='accountsummaries')return accountSummaryTable(rows,page.views[i][1]);
 if(view==='backofficeaccounts')return backofficeAccountTable(rows);
 if(view==='terminals')return posTerminalsTable(rows);
 if(view==='cardaccounts')return cardAccountTable(rows);
 if(view==='securitypositions')return (identity.admin?stockRegisterTable(cache.treasurypositions,rows):'')+securitiesTable(rows,identity.admin);
 if(view==='securityorders')return securityOrdersTable(rows);
 if(view==='exchangebook')return securityBookTable(rows);
 return table(view,page.views[i][1],rows)+(view==='portfolio'&&!rows.length?'<p class="panel-empty">No investment holdings recorded yet.</p>':'');
}).join('');$('#panels').innerHTML=html;$('#panels').setAttribute('aria-busy','false');accountStatements.bind($('#panels'));portfolioManager.bind($('#panels'));if(key==='pos')bindTerminalControls();document.querySelectorAll('[data-request]').forEach(b=>b.onclick=()=>paymentWizard.view(b.dataset.request).catch(e=>pageError(e,b)));document.querySelectorAll('[data-card-row]').forEach(row=>{const show=()=>cardManager.open(row.querySelector('select').value).catch(e=>pageError(e,row));row.onclick=e=>{if(e.target.closest('select'))return;void show();};row.onkeydown=e=>{if(e.target===row&&e.key==='Enter'){e.preventDefault();void show();}};});}
window.addEventListener('hashchange',()=>{
 clearNotice();clearForm();paymentWizard.close();accountStatements.close();cardManager.close();portfolioManager.close();

 try{const intent=readExchangeIntent(location.hash);if(intent){exchangeIntent=intent;if(csrf)void resumeExchange();else $('#login-form h2').textContent=intent.side?'Sign in to '+intent.side.toLowerCase()+' '+intent.symbol:'Sign in to your portfolio';return;}}catch(e){pageError(e);return;}
 void render();
});
const input=(name,title,type='text',extra='')=>`<label>${esc(title)}<input name="${name}" aria-label="${esc(title)}" type="${type}" ${extra} required></label>`;
const select=(name,title,options)=>`<label>${esc(title)}<select name="${name}" aria-label="${esc(title)}" required><option value="">Select…</option>${options.map(([v,t])=>`<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select></label>`;
const accountOptions=()=> (cache.accounts||[]).map(a=>[a.abiq_iban,`${a.full_name} · ${a.currency_code} · ${displayAbiq(a.abiq_iban)}`]);
const shopOptions=()=> (cache.shops||[]).map(a=>[a.merchant_id,`${a.shop_name} · ${a.merchant_id}`]);
const checkoutOptions=()=> (cache.checkouts||[]).filter(a=>['ESCROW_HELD','PARTIALLY_SETTLED'].includes(a.status)).map(a=>[a.checkout_id,a.marketplace_order_ref]);
const authOptions=()=> (cache.authorizations||[]).filter(a=>a.status==='AUTHORIZED').map(a=>[a.authorization_id,`${a.network_reference} · ${number(a.amount)} ${a.currency_code}`]);
const currencySelect=()=>select('currency','Currency',currencies.map(c=>[c,c]));
const checkboxCurrencies=()=>`<fieldset><legend>Account currencies</legend><div class="currency-grid">${currencies.map(c=>`<label><input type="checkbox" name="currencies" value="${c}" ${c==='EUR'?'checked':''}>${c}</label>`).join('')}</div></fieldset>`;
const profiles=()=>select('profileId','Bank connector',(cache.bankprofiles||[]).map(p=>[p.profile_id,`${p.display_name} · ${p.currency_code}`]));
const forms={
 issuecard:{title:'Activate card account',path:'cards/issue',button:'Issue card',fields:()=>select('product','Card / account type',cardProducts)+select('from','My currency account',accountOptions()),build:f=>({...Object.fromEntries(f),currency:cache.accounts.find(a=>a.abiq_iban===f.get('from'))?.currency_code})},
 loadcard:{title:'Load card account',path:'cards/load',button:'Load card',fields:()=>select('from','Pay from currency account',accountOptions())+select('cardId','Card',(cache.transfercards||[]).map(c=>[c.card_id,`${c.full_name} · ${c.card_number} · ${c.currency_code}`]))+input('amount','Amount','text','inputmode="decimal"')+input('reference','Reference'),build:f=>({...Object.fromEntries(f),currency:cache.accounts.find(a=>a.abiq_iban===f.get('from'))?.currency_code})},
 externalcard:{title:'Register external card',path:'cards/external',button:'Register card',fields:()=>select('from','My currency account',accountOptions())+input('cardNumber','Card number','text','inputmode="numeric" autocomplete="off" maxlength="23"')+input('expiry','Expiry (MM/YYYY)','text','placeholder="MM/YYYY" maxlength="7"')+input('holderName','Name on card'),build:f=>({...Object.fromEntries(f),currency:cache.accounts.find(a=>a.abiq_iban===f.get('from'))?.currency_code})},
 loadexternal:{title:'Load external card',path:'payments/review',button:'Review transfer',fields:()=>select('from','Pay from currency account',accountOptions())+select('externalCardId','External card',(cache.externalcards||[]).map(c=>[c.card_id,c.holder_name+' · '+c.last_four]))+input('amount','Amount','text','inputmode="decimal"')+input('reference','Reference'),build:f=>({...Object.fromEntries(f),method:'CARD',cardDestination:'EXTERNAL',currency:cache.accounts.find(a=>a.abiq_iban===f.get('from'))?.currency_code})},
 suspense:{title:'Move funds to suspense',path:'accounts/suspense',button:'Move to suspense',fields:()=>select('from','Account',accountOptions())+input('amount','Amount','text','inputmode="decimal"')+input('reference','Reason / reference'),build:f=>({...Object.fromEntries(f),currency:cache.accounts.find(a=>a.abiq_iban===f.get('from'))?.currency_code})},
 bindlogin:{title:'Link customer login',path:'access/customer',button:'Link login',fields:()=>select('userId','Account holder',(cache.customers||[]).filter(c=>c.customer_workspace??(c.account_role==='CUSTOMER')).map(c=>[c.user_id,c.full_name]))+input('fineractUserId','Existing Fineract user ID','text','inputmode="numeric" pattern="[0-9]+"')},
 sellcrypto:{title:'Convert AG / AGi / crypto to FIAT',path:'crypto/sell',button:'Convert to FIAT',fields:()=>select('cryptoAccount','Wallet holding',(cache.cryptoholdings||[]).map(c=>[c.account_id,`${c.full_name} · ${c.currency_code} · ${c.network} · Available ${number(c.available_balance)}`]))+select('to','Receive into currency account',accountOptions())+select('offerId','Exchange offer',(cache.cryptooffers||[]).map(o=>[o.offer_id,`${o.asset} · ${o.network} · ${number(o.unit_price)} ${o.fiat} per unit`]))+input('quantity','Quantity','text','inputmode="decimal"')+input('unitPrice','Unit price','text','readonly')+input('total','Total to receive','text','readonly')+input('reference','Reference')},

 settletransfer:{title:'Record completed external transfer',path:'payments/settle-manual',button:'Record settlement',fields:()=>input('requestId','Transfer request')+select('settlementAccountId','Settlement account used',(cache.ledger||[]).filter(a=>['CORRESPONDENT_NOSTRO','HOT_WALLET','TREASURY'].includes(a.owner_type)&&a.account_category==='ASSET'&&!a.sub_account_code.startsWith('UAT_OPENING')).map(a=>[a.account_id,`${a.account_reference} · ${a.currency_code} ${a.network||''} · Available ${number(a.available_balance)}`]))+input('settlementReference','Bank / processor receipt or blockchain transaction reference')},
 redeemcode:{title:'Redeem coded card debit',path:'cards/redeem-code',button:'Redeem once',fields:()=>input('token','Card redemption token')+input('code','Six-digit code','text','inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off"')+select('to','Receiving account',accountOptions())+input('reference','Reference'),build:f=>({...Object.fromEntries(f),currency:cache.accounts.find(a=>a.abiq_iban===f.get('to'))?.currency_code})},
 cancelcode:{title:'Release unused coded card debit',path:'cards/cancel-code',button:'Return funds to sender',fields:()=>select('requestId','Coded debit',(cache.codedcards||[]).filter(r=>['ACTIVE','LOCKED'].includes(r.status)).map(r=>[r.request_id,`${r.last_four_digits} · ${number(r.amount)} ${r.currency_code} · ${r.request_id}`]))},
 cryptooffer:{title:'Register crypto purchase offer',path:'crypto/offers',button:'Register offer',fields:()=>select('stockAccountId','Institution crypto stock',(cache.cryptoholdings||[]).filter(a=>a.account_role==='INSTITUTION').map(a=>[a.account_id,`${a.currency_code} · ${a.network} · Available ${number(a.available_balance)}`]))+select('proceedsAccount','Sale proceeds account',accountOptions().filter(([id])=>cache.accounts.find(a=>a.abiq_iban===id)?.account_role==='INSTITUTION'))+input('unitPrice','Price per asset unit','text','inputmode="decimal"'),build:f=>({...Object.fromEntries(f),fiatCurrency:cache.accounts.find(a=>a.abiq_iban===f.get('proceedsAccount'))?.currency_code})},
 buycrypto:{title:'Purchase AG / crypto',path:'crypto/purchase',button:'Purchase',fields:()=>select('from','Pay from account',accountOptions())+select('offerId','Purchase offer',(cache.cryptooffers||[]).filter(o=>Number(o.available_balance)>0).map(o=>[o.offer_id,`${o.asset} · ${o.network} · ${number(o.unit_price)} ${o.fiat} per unit`]))+input('quantity','Quantity','text','inputmode="decimal"')+input('unitPrice','Unit price','text','readonly')+input('total','Total to pay','text','readonly')+input('reference','Reference')},

fxquote:{title:'Quote currency conversion',path:'fx/quote',button:'Reserve quote',fields:()=>select('from','Pay from',accountOptions())+select('to','Receive into',accountOptions())+input('amount','You pay','text','inputmode="decimal"')+input('commissionBps','Commission in basis points','number','min="0" max="9999" value="0"'),build:f=>({...Object.fromEntries(f),fromCurrency:cache.accounts.find(a=>a.abiq_iban===f.get('from'))?.currency_code,toCurrency:cache.accounts.find(a=>a.abiq_iban===f.get('to'))?.currency_code,commissionBps:Number(f.get('commissionBps'))})},
fxexecute:{title:'Execute currency conversion',path:'fx/execute',button:'Execute conversion',fields:()=>select('quoteId','Reserved quote',(cache.fxquotes||[]).filter(q=>q.status==='OPEN').map(q=>[q.quote_id,number(q.from_amount)+' '+q.from_currency+' → '+number(q.to_amount)+' '+q.to_currency+' · fee '+number(q.fee_amount)+' '+q.from_currency+' · until '+new Date(q.expires_at).toLocaleTimeString()]))},
fxcancel:{title:'Cancel reserved quote',path:'fx/cancel',button:'Release quote',fields:()=>select('quoteId','Quote',(cache.fxquotes||[]).filter(q=>q.status==='OPEN').map(q=>[q.quote_id,q.from_currency+' → '+q.to_currency+' · '+q.quote_id]))},
fxrefresh:{title:'Refresh published reference rates',path:'fx/rates/refresh',button:'Refresh rates',fields:()=>'<p>Retrieve the latest ECB publication. Its source date is retained with every conversion quote.</p>'},

offlinekeys:{title:'Configure offline public key',path:'offline/keys',button:'Save public key',fields:()=>select('kind','Key belongs to',[['CARD','AVIS card'],['TERMINAL','POS terminal']])+input('reference','Card token or terminal ID')+`<label>Public key (PEM)<textarea name="publicKey" rows="6" required></textarea></label>`+input('floorLimit','Terminal transaction limit (EUR)','text','value="50"')+input('batchCap','Terminal batch limit (EUR)','text','value="10000"')},
allowance:{title:'Reserve offline card allowance',path:'offline/allowances',button:'Issue signed allowance',fields:()=>input('cardReference','AVIS card token')+input('amount','Allowance (EUR)','text','inputmode="decimal"')+input('maxTransactions','Maximum transactions','number','min="1" max="5000" value="5"')+input('expiresAt','Valid until','datetime-local'),build:f=>({...Object.fromEntries(f),maxTransactions:Number(f.get('maxTransactions')),expiresAt:new Date(f.get('expiresAt')).toISOString()})},
offlinesync:{title:'Settle signed offline batch',path:'offline/sync',button:'Verify and settle batch',fields:()=>`<label>Signed terminal batch (JSON)<textarea name="batch" rows="12" required></textarea></label>`,build:f=>JSON.parse(f.get('batch'))},
offlineclose:{title:'Release remaining offline allowance',path:'offline/close',button:'Release remaining balance',fields:()=>select('grantId','Allowance',(cache.offlinegrants||[]).filter(g=>g.status==='ACTIVE'&&new Date(g.settle_by).getTime()<Date.now()).map(g=>[g.grant_id,`${g.last_four_digits} · ${g.grant_id}`]))},

cashaccount:{title:'Register clearing account',path:'correspondents',button:'Register account',fields:()=>input('institutionName','Institution name')+select('institutionType','Account class',['CENTRAL_BANK','CORRESPONDENT_BANK','CORE_BANK_OMNIBUS','CARD_SCHEME_SETTLEMENT'].map(x=>[x,label(x)]))+input('bic','Bank BIC')+input('accountNumber','External account number')+currencySelect()},
bankprofile:{title:'Configure bank connector',path:'bankprofiles',button:'Save connector',fields:()=>input('profileId','Connector code','text','pattern="[A-Z0-9_]{1,35}"')+input('name','Bank / network name')+select('cashAccountId','Clearing account',(cache.correspondents||[]).map(c=>[c.cash_account_id,`${c.institution_name} · ${c.currency_code} · ${c.iban_or_account_no}`]))+select('protocol','Protocol',['IP_TO_IP','SWIFT_ISO20022','BANK_API'].map(x=>[x,label(x)]))+input('localBic','Our BIC')+input('peerBic','Peer bank BIC')+input('endpoint','Bank endpoint','url')+input('credentialReference','Application credential reference','text','pattern="AVIS_CONNECTOR_[A-Z0-9_]+"')},
bankroute:{title:'Link bank IBAN to ABIQ',path:'bankroutes',button:'Link account',fields:()=>select('abiqIban','ABIQ account',accountOptions())+currencySelect()+profiles()+input('accountNumber','Bank-issued IBAN')+input('country','IBAN country code','text','pattern="[A-Z]{2}" maxlength="2"')+input('bic','Bank BIC')+input('providerAccountId','Provider account ID')+input('providerReference','Provider confirmation reference'),build:f=>({abiqIban:f.get('abiqIban'),currency:f.get('currency'),bankRoute:{accountType:'IBAN',accountNumber:f.get('accountNumber'),country:f.get('country'),bic:f.get('bic'),connectorCode:f.get('profileId'),providerAccountId:f.get('providerAccountId'),providerReference:f.get('providerReference')}})},
bankpayment:{title:'Prepare bank payment',path:'bankpayments',button:'Prepare payment',fields:()=>select('from','From ABIQ account',accountOptions())+profiles()+currencySelect()+input('creditorName','Receiver name')+input('creditorIban','Receiver IBAN')+input('amount','Amount','text','inputmode="decimal"')+input('reference','Payment reference','text','maxlength="35"')},
dispatch:{title:'Submit bank payment',path:'bankpayments/dispatch',button:'Submit to bank',fields:()=>select('transferId','Payment to submit',(cache.bankpayments||[]).filter(t=>t.delivery==='QUEUED').map(t=>[t.transfer_id,`${t.creditor_name||t.creditor_iban} · ${number(t.amount)} ${t.currency_code} · ${t.payment_reference||t.uetr} · ${t.creditor_iban}`]))},
statement:{title:'Reconcile bank statement',path:'clearing/reconcile',button:'Reconcile',fields:()=>profiles()+currencySelect()+input('reference','Statement reference')+input('openingBalance','Opening balance','text','inputmode="decimal"')+input('closingBalance','Closing balance','text','inputmode="decimal"')+`<label>Statement entries · JSON<textarea name="entries" rows="8" required aria-label="Statement entries"></textarea></label>`,build:f=>({...Object.fromEntries(f),entries:JSON.parse(f.get('entries'))})},

customerprofile:{title:'Account holder details',path:'customers/profile',button:'Save details',fields:()=>select('userId','Account holder',(cache.customers||[]).map(c=>[c.user_id,c.full_name]))+input('street','Street and building','text','maxlength="70"')+input('city','City','text','maxlength="35"')+input('postalCode','Postal code','text','maxlength="16"')+input('country','Country code','text','maxlength="2" pattern="[A-Za-z]{2}"'),build:f=>({userId:f.get('userId'),address:{street:f.get('street'),city:f.get('city'),postalCode:f.get('postalCode'),country:f.get('country')}})},
customer:{title:'Open account',path:'accounts/open',button:'Open account',fields:()=>select('accountType','Account type',accountTypes)+input('fullName','Account name / holder')+currencySelect(),build:f=>({fullName:f.get('fullName'),accountType:f.get('accountType'),currencies:[f.get('currency')]})},
currency:{title:'Add account currencies',path:'currencies',button:'Add currencies',fields:()=>select('userId','Account holder',(cache.customers||[]).map(c=>[c.user_id,`${c.user_id} · ${c.full_name}`]))+checkboxCurrencies(),build:f=>({...Object.fromEntries(f),currencies:f.getAll('currencies')})},
transfer:{title:'ABIQ transfer',path:'transfers',button:'Transfer',fields:()=>select('from','From account',accountOptions())+select('to','Receiving account',accountOptions())+currencySelect()+input('amount','Amount','text','inputmode="decimal"')+input('reference','Payment reference')},
shop:{title:'Register Marketplace City shop',path:'shops',button:'Register shop',fields:()=>input('merchantId','Merchant / shop ID')+input('shopName','Shop name')+select('ownerUserId','Business account',(cache.customers||[]).filter(c=>c.account_type==='BUSINESS').map(c=>[c.user_id,`${c.user_id} · ${c.full_name}`]))+input('commissionBps','Commission in basis points','number','min="0" max="10000" value="0"'),build:f=>({...Object.fromEntries(f),commissionBps:Number(f.get('commissionBps'))})},
checkout:{title:'Multi-shop checkout',path:'checkouts/capture',button:'Capture to escrow',fields:()=>input('orderReference','Order reference')+select('buyerAccount','Buyer account',accountOptions().filter(([v])=>cache.accounts.find(a=>a.abiq_iban===v)?.currency_code==='EUR'))+`<div id="split-fields"></div><button type="button" id="add-split">+ Add shop</button>`,build:f=>({orderReference:f.get('orderReference'),buyerAccount:f.get('buyerAccount'),paymentRail:'AVIS_BANK_EUR',splits:f.getAll('merchantId').map((m,i)=>({merchantId:m,amount:f.getAll('splitAmount')[i]}))})},
release:{title:'Release escrow to shops',path:'checkouts/release',button:'Release funds',fields:()=>select('checkoutId','Checkout',checkoutOptions())},
refund:{title:'Refund held checkout',path:'checkouts/refund',button:'Refund buyer',fields:()=>select('checkoutId','Checkout',(cache.checkouts||[]).filter(c=>c.status==='ESCROW_HELD').map(c=>[c.checkout_id,c.marketplace_order_ref]))},
card:{title:'Register AVIS card',path:'cards',button:'Register card',fields:()=>input('cardReference','Card token / issuing reference')+input('lastFour','Last four digits','text','pattern="[0-9]{4}" maxlength="4"')+select('fundingAccount','Funding account',accountOptions())+currencySelect()+select('railMode','Card programme',[['AVIS_PROPRIETARY_ONLY','AVIS proprietary'],['GLOBAL_SCHEME_ONLY','Global card scheme'],['DUAL_COBADGED','Dual / co-badged']])},
terminal:{title:'Register POS terminal',path:'terminals',button:'Register terminal',fields:()=>input('terminalId','Terminal ID')+select('merchantId','Merchant shop',shopOptions())+select('terminalType','Terminal type',['SMART_POS','SOFTPOS_NFC','TRANSIT_GATE','UNATTENDED_KIOSK','WEB_POS'].map(v=>[v,label(v)]))},
stripecard:{title:'Stripe card payment',path:'stripe/webpos/checkout',button:'Open secure card checkout',fields:()=>select('terminalId','WEB POS terminal',(cache.terminals||[]).filter(t=>t.terminal_type==='WEB_POS'&&t.status==='ACTIVE').map(t=>[t.terminal_id,t.terminal_id+' · '+t.merchant_id]))+select('currency','Card currency',['EUR','USD','GBP','CHF'].map(v=>[v,v]))+input('amount','Card amount','text','inputmode="decimal" placeholder="10.00"')+input('reference','Merchant payment reference','text','maxlength="100"')},
authorize:{title:'AVIS card authorization',path:'cards/authorize',button:'Authorize',fields:()=>input('cardReference','AVIS card token')+select('terminalId','Terminal',(cache.terminals||[]).map(t=>[t.terminal_id,t.terminal_id]))+input('networkReference','Transaction reference')+currencySelect()+input('amount','Amount','text','inputmode="decimal"')},
capture:{title:'Capture AVIS card payment',path:'cards/capture',button:'Capture payment',fields:()=>select('authorizationId','Authorization',authOptions())},
reverse:{title:'Reverse AVIS card authorization',path:'cards/reverse',button:'Reverse authorization',fields:()=>select('authorizationId','Authorization',authOptions())}
};
function addSplit(){$('#split-fields').insertAdjacentHTML('beforeend',`<fieldset><legend>Shop allocation</legend><div class="split">${select('merchantId','Shop',shopOptions())}${input('splitAmount','Amount (EUR)','text','inputmode="decimal"')}</div></fieldset>`);}
async function openForm(id){
 if(id==='accountcleanup'){try{const {openAccountCleanup}=await import('./account-cleanup.mjs');await openAccountCleanup(api,render);}catch(e){pageError(e);}return;}
 if(id==='abiqgenerator'){abiqGenerator.open();return;}
 if(id==='checkoutmanagement'){if(identity.admin)await openCheckoutManagement(api);return;}
 if(id==='buycrypto'){try{await openCryptoBasket(api);}catch(e){pageError(e);}return;}
 const epoch=sessionEpoch,hash=location.hash,generation=++formGeneration;
 const current=()=>epoch===sessionEpoch&&hash===location.hash&&generation===formGeneration;
 try{if(['recordsecurity','buysecurity','sellsecurity','syncsecurities'].includes(id)){await portfolioManager.open(id);return;}if(id==='opencardmessage'){openCardMessage();return;}if(id==='newpayment'){paymentWizard.open({loadRows:readPaymentRows});return;}const dependencies={issuecard:['accounts'],loadcard:['accounts','transfercards'],externalcard:['accounts'],loadexternal:['accounts','externalcards'],suspense:['accounts'],bindlogin:['customers'],sellcrypto:['accounts','cryptooffers','cryptoholdings'],settletransfer:['ledger'],redeemcode:['accounts'],cancelcode:['codedcards'],cryptooffer:['accounts','cryptoholdings'],buycrypto:['accounts','cryptooffers'],customerprofile:['customers'],fxquote:['accounts'],fxexecute:['fxquotes'],fxcancel:['fxquotes'],fxrefresh:[],offlinekeys:[],allowance:[],offlinesync:[],offlineclose:['offlinegrants'],cashaccount:[],bankprofile:['correspondents'],bankroute:['accounts','bankprofiles'],bankpayment:['accounts','bankprofiles'],dispatch:['bankpayments'],statement:['bankprofiles'],customer:[],currency:['customers'],transfer:['accounts'],shop:['customers'],checkout:['accounts','shops'],release:['checkouts'],refund:['checkouts'],card:['accounts'],terminal:['shops'],stripecard:['terminals'],authorize:['terminals'],capture:['authorizations'],reverse:['authorizations']}[id];await Promise.all(dependencies.map(getRows));if(!current())return false;activeForm=forms[id];requestKey=crypto.randomUUID();$('#dialog-title').textContent=activeForm.title;$('#form-fields').innerHTML=activeForm.fields();$('#submit-action').textContent=activeForm.button;$('#submit-action').disabled=false;$('#action-form .form-error').textContent='';if(id==='customer'&&accountTypeFilter)$('#action-form').elements.accountType.value=accountTypeFilter;if(id==='checkout'){addSplit();$('#add-split').onclick=addSplit;}if(id==='customerprofile')$('#action-form').elements.userId.onchange=e=>{const address=(cache.customers||[]).find(c=>String(c.user_id)===e.target.value)?.postal_address;for(const n of ['street','city','postalCode','country'])$('#action-form').elements[n].value=address?.[n]||'';};if(id==='buycrypto'||id==='sellcrypto'){
 const f=$('#action-form');f.oninput=()=>{const offer=cache.cryptooffers.find(o=>o.offer_id===f.elements.offerId.value);f.elements.unitPrice.value=offer?.unit_price||'';f.elements.total.value='';try{if(offer&&/^[0-9]{1,18}(\.[0-9]{1,18})?$/.test(f.elements.quantity.value)){const units=s=>{const[w,d='']=s.split('.');return BigInt(w)*10n**18n+BigInt(d.padEnd(18,'0'));};const quantum=offer.fiat==='JPY'?10n**18n:10n**16n,divisor=10n**18n*quantum,n=((units(f.elements.quantity.value)*units(offer.unit_price)+(id==='buycrypto'?divisor-1n:0n))/divisor)*quantum;const digits=n.toString().padStart(19,'0');f.elements.total.value=digits.slice(0,-18)+'.'+digits.slice(-18);}}catch{}};
 }else $('#action-form').oninput=null;
 $('#form-dialog').showModal();return true;
 }catch(err){
  if(current())pageError(err);
  return false;
 }
}
function pageError(err,origin){
 if(origin&&!origin.isConnected)return;
 const panel=origin?.closest('.panel');
 if(panel){
  let issue=panel.querySelector('[data-panel-action-error]');
  if(!issue){
   issue=document.createElement('p');issue.className='form-error';issue.dataset.panelActionError='';
   issue.setAttribute('role','alert');(panel.querySelector('.panel-header')||panel.firstElementChild)?.after(issue);
  }
  issue.textContent=err.message;return;
 }
 const target=$('#account-page-error')||$('#crypto-wallet-desk [data-crypto-error]')||$('#login-form .form-error');
 if(target)target.textContent=err.message;
}
async function readPaymentRows(view){
 try{return (await api('views/'+view)).rows;}
 catch(e){console.error('PAYMENT_OPTION_READ_FAILED',view,e.code||e.name,e.requestId||'');throw e;}
}
$('#close-dialog').onclick=$('#cancel-dialog').onclick=clearForm;
$('#form-dialog').oncancel=e=>{e.preventDefault();clearForm();};
function notice(message){clearNotice();$('#notice').textContent=message;$('#notice').hidden=false;noticeTimer=setTimeout(clearNotice,7000);}
function clearFieldError(form){
 const issue=form.querySelector('[data-action-field-error]');
 if(!issue)return;
 const field=form.elements.namedItem(issue.dataset.actionFieldError);
 if(field){field.removeAttribute('aria-invalid');field.removeAttribute('aria-describedby');}
 issue.remove();
}
$('#action-form').addEventListener('input',e=>{
 if(e.target.name&&e.target.getAttribute('aria-invalid')==='true')clearFieldError(e.currentTarget);
});
$('#action-form').addEventListener('submit',async e=>{
 e.preventDefault();
 const form=e.currentTarget,button=$('#submit-action'),generation=formGeneration;
 if(!activeForm||button.disabled)return;
 button.disabled=true;clearFieldError(form);
 const error=form.querySelector('.form-error');error.textContent='';try{const data=new FormData(e.currentTarget),body=activeForm.build?activeForm.build(data):Object.fromEntries(data);const result=await api(activeForm.path,body,requestKey);if(generation!==formGeneration)return;$('#form-dialog').close();form.reset();if(activeForm===forms.loadexternal){paymentWizard.reviewPrepared(result);return;}if(activeForm===forms.stripecard&&result.checkoutUrl){location.assign(result.checkoutUrl);return;}if(result.allowance){const url=URL.createObjectURL(new Blob([JSON.stringify(result.allowance,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='AVIS-offline-allowance-'+result.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}notice(result.accounts?`Account created · ${result.accounts.map(a=>a.currency+' '+displayAbiq(a.abiqIban)).join(' · ')}`:result.delivery?`Payment delivery · ${label(result.delivery)}`:result.journalId?`Recorded · journal ${result.journalId}`:'Saved successfully.');await render();}catch(err){
 if(generation!==formGeneration)return;
 const field=err.field&&form.elements.namedItem(err.field);
 if(field?.closest?.('label')){
  const slot=document.createElement('span');slot.className='field-error';slot.id='action-field-error';
  slot.dataset.actionFieldError=field.name;slot.setAttribute('role','alert');slot.textContent=err.message;
  field.after(slot);field.setAttribute('aria-invalid','true');field.setAttribute('aria-describedby',slot.id);field.focus();
 }else error.textContent=err.message;
 }finally{if(generation===formGeneration)button.disabled=false;}
});
const cryptoManager=createCryptoWorkspace({api,identity:()=>identity,purchase:(asset,network)=>openCryptoBasket(api,asset,network).catch(pageError),registerOffer:()=>openForm('cryptooffer'),sell:()=>openForm('sellcrypto'),send:holding=>paymentWizard.fromCrypto(holding.account_id,readPaymentRows),notice});
const paymentWizard=createPaymentWizard({api,accounts:()=>cache.accounts||[],refresh:render,notice,data:view=>cache[view]||[],purchase:()=>openForm('buycrypto'),sell:()=>openForm('sellcrypto'),isAdmin:()=>identity.admin,userId:()=>identity.customerUserId,settle:async r=>{if(!await openForm('settletransfer'))return;$('#action-form').elements.requestId.value=r.request_id;$('#action-form').elements.requestId.readOnly=true;}});
const cardManager=createCardManager({api,refresh:render,notice});
const abiqGenerator=createAbiqGenerator({api});
const accountStatements=createAccountStatements({api,assignNumber:abiqGenerator.assign,canAssign:()=>identity.admin||identity.canSwitchWorkspace});
const portfolioManager=createPortfolio({api,getRows,data:view=>cache[view]||[],refresh:render,notice,actionError:pageError,isAdmin:()=>identity.admin});
api('session').then(signedIn).catch(()=>signedOut());
