const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>{const[a,b='']=String(v??'0').split('.');return a.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+b.replace(/0+$/,'').padEnd(2,'0');};
const option=(v,t)=>`<option value="${esc(v)}">${esc(t)}</option>`;
const input=(n,t,attrs='')=>`<label>${esc(t)}<input name="${n}" aria-label="${esc(t)}" ${attrs}><span class="field-error" data-error="${n}"></span></label>`;
const select=(n,t,rows,attrs='')=>`<label>${esc(t)}<select name="${n}" aria-label="${esc(t)}" ${attrs}>${option('','Select…')+rows.map(r=>option(...r)).join('')}</select><span class="field-error" data-error="${n}"></span></label>`;
const units=s=>{if(!/^[0-9]{1,18}(\.[0-9]{1,18})?$/.test(s))throw Error('Enter an amount using digits and a decimal point.');const[w,f='']=s.split('.');return BigInt(w)*10n**18n+BigInt(f.padEnd(18,'0'));};
const decimal=n=>{const s=n.toString().padStart(19,'0');return s.slice(0,-18)+'.'+s.slice(-18).replace(/0+$/,'').padEnd(2,'0');};
export function portfolioValue(q,d,p,basis,currency){const scale=10n**18n,quantum=currency==='JPY'?scale:10n**16n,numerator=basis==='PERCENT'?units(q)*units(d)*units(p):units(q)*units(p),divisor=basis==='PERCENT'?scale*scale*100n:scale;return decimal(((numerator+divisor*quantum/2n)/(divisor*quantum))*quantum);}
const columns=[['name','Name of security'],['portfolio_abiq_iban','Portfolio ABIQ IBAN'],['currency_code','Currency'],['short_name','Short name'],['isin','ISIN'],['cusip','CUSIP'],['denomination','Denomination'],['quantity','Quantity'],['issuing_price','Issuing price'],['market_price','Market price'],['portfolio_value','Portfolio value']];
export function securitiesTable(rows,admin){
 return `<section class="panel"><div class="panel-header"><h2>Securities portfolio</h2><span>${rows.length} holdings</span></div><div class="table-wrap"><table><thead><tr>${admin?'<th>Portfolio holder</th>':''}${columns.map(([,t])=>`<th>${t}</th>`).join('')}<th>Actions</th></tr></thead><tbody>${rows.map(r=>`<tr>${admin?`<td>${esc(r.full_name)}</td>`:''}${columns.map(([k])=>`<td>${esc(['denomination','quantity','issuing_price','market_price','portfolio_value'].includes(k)?fmt(r[k]):r[k]||'—')}${['issuing_price','market_price'].includes(k)&&r.quote_basis==='PERCENT'?'%':''}${k==='quantity'&&Number(r.reserved_quantity)>0?`<small class="portfolio-reserved">${esc(fmt(r.reserved_quantity))} reserved</small>`:''}</td>`).join('')}<td><div class="actions"><button data-security-buy="${esc(r.security_id)}">Buy</button><button data-security-sell="${esc(r.security_id)}" data-holder="${esc(r.user_id)}">Sell</button>${admin?`<button data-position="${esc(r.position_id)}">Edit</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>${!rows.length?'<p class="panel-empty">No securities recorded yet.</p>':''}</section>`;
}
export function stockRegisterTable(sources,positions){
 const stocks=(sources||[]).filter(source=>source.asset_class==='SECURITY'&&source.asset_code==='AVISPAY-PLC-SHARES');
 if(!stocks.length)return '';
 return `<section class="panel" data-stock-register><div class="panel-header"><h2>AVISPay PLC stock register</h2></div><div class="table-wrap"><table><thead><tr><th>Security</th><th>Units</th><th>Unit price</th><th>Currency</th><th>Portfolio value</th><th>Source reference</th><th>Portfolio ABIQ IBAN</th><th>Details</th></tr></thead><tbody>${stocks.map(source=>{
  const position=(positions||[]).find(row=>row.position_id===source.position_id&&String(row.user_id)===String(source.owner_user_id));
  return `<tr><td>${esc(position?.name||source.asset_name)}</td><td>${esc(fmt(position?.quantity??source.quantity))}</td><td>${position?esc(fmt(position.market_price)):'—'}</td><td>${esc(position?.currency_code||'—')}</td><td>${position?esc(fmt(position.portfolio_value)):'—'}</td><td>${esc(source.source_reference)}</td><td>${esc(source.portfolio_abiq_iban||position?.portfolio_abiq_iban||'—')}</td><td><button type="button" ${position?'data-position="'+esc(position.position_id)+'"':'data-register-treasury="'+esc(source.booking_id)+'"'}>${position?'Edit stock details':'Register stock details'}</button></td></tr>`;
 }).join('')}</tbody></table></div><p class="form-error" role="alert" data-stock-register-error></p></section>`;
}
export function securityOrdersTable(rows){return `<section class="panel"><div class="panel-header"><h2>Exchange orders</h2><span>${rows.length} orders</span></div><div class="table-wrap"><table><thead><tr><th>Security</th><th>Side</th><th>Quantity</th><th>Price</th><th>Total</th><th>Payment</th><th>Reference</th><th>Status</th><th>Details</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.short_name)}</td><td>${esc(r.side)}</td><td>${esc(fmt(r.quantity))}</td><td>${esc(fmt(r.price))}</td><td>${esc(fmt(r.total))} ${esc(r.currency_code)}</td><td>${esc(r.payment_method)}</td><td>${esc(r.reference)}</td><td>${esc(r.status==='OPEN'?'Open':r.status==='FILLED'?'Executed':'Cancelled')}</td><td><button data-security-order="${esc(r.order_id)}">View order</button></td></tr>`).join('')}</tbody></table></div></section>`;}
export function securityBookTable(rows){return `<details class="panel"><summary class="panel-header">AVISPay Exchange · Open buy and sell offers</summary><div class="table-wrap"><table><thead><tr><th>Security</th><th>Side</th><th>Quantity per order</th><th>Price</th><th>Currency</th><th>Orders</th><th>Trade</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.short_name)}</td><td>${r.side==='BUY'?'Buying':'Selling'}</td><td>${esc(fmt(r.quantity))}</td><td>${esc(fmt(r.price))}${r.quote_basis==='PERCENT'?'%':''}</td><td>${esc(r.currency_code)}</td><td>${esc(r.orders)}</td><td><button data-book-security="${esc(r.security_id)}" data-side="${r.side==='BUY'?'SELL':'BUY'}" data-quantity="${esc(r.quantity)}" data-price="${esc(r.price)}">${r.side==='BUY'?'Sell':'Buy'}</button></td></tr>`).join('')}</tbody></table></div></details>`;}

export function createPortfolio({api,getRows,data,refresh,notice,actionError=err=>notice(err.message),isAdmin}){
 const dialog=document.createElement('dialog');dialog.className='payment-dialog portfolio-dialog';dialog.id='portfolio-dialog';dialog.setAttribute('aria-labelledby','portfolio-title');document.body.append(dialog);
 let epoch=0,step=0,busy=false,review=null,requestKey='',submitKey='',side='BUY',holder=null,mode='',draft={};
 const q=s=>dialog.querySelector(s),form=()=>q('form'),els=()=>form()?.elements,values=()=>Object.fromEntries(new FormData(form()));
 function close(){epoch++;dialog.close();dialog.replaceChildren();review=null;busy=false;}
 function setBusy(value){busy=value;dialog.querySelectorAll('button').forEach(b=>b.disabled=value);dialog.querySelectorAll('.payment-slide').forEach((p,i)=>p.inert=value||i!==step);form()?.setAttribute('aria-busy',String(value));}
 function error(e){if(!form())return;q('.payment-error').textContent=e.message;const el=els().namedItem(e.field);if(el){const panel=el.closest('.payment-slide');if(panel)show([...dialog.querySelectorAll('.payment-slide')].indexOf(panel));el.setAttribute('aria-invalid','true');el.focus();}}
 function shell(title,content){
  dialog.innerHTML=`<div class="payment-heading"><h2 id="portfolio-title">${esc(title)}</h2><button type="button" class="payment-close" aria-label="Close portfolio window">×</button></div>${content}`;
  q('.payment-close').onclick=()=>{if(!busy)close();};dialog.oncancel=e=>{if(busy)e.preventDefault();else close();};if(!dialog.open)dialog.showModal();
 }
 let catalogueSyncedAt=0;
 async function ensureBookingCatalogue(){
  if(!isAdmin()||Date.now()-catalogueSyncedAt<60000)return '';
  try{await api('portfolio/catalogue/sync',{},crypto.randomUUID());catalogueSyncedAt=Date.now();return '';}
  catch(e){return e.message||'Catalogue refresh failed';}
 }
 async function dependencies(){const serial=++epoch;await Promise.all(['securities','securitypositions','accountsummaries','transfercards','cryptoholdings','cryptooffers',...(isAdmin()?['customers']:[])].map(getRows));return serial===epoch;}
 const securities=()=>data('securities'),security=()=>securities().find(s=>s.security_id===els()?.securityId?.value);
 const selector=selected=>select('securityId','Security · Green Bond / registered securities',securities().map(s=>[s.security_id,`${s.short_name} · ${s.isin||s.currency_code}`]),'required')+(isAdmin()?'<button type="button" data-add-security>+ Add security</button>':'');
 const metadata=s=>s?`<dl class="payment-summary"><dt>Name</dt><dd>${esc(s.name)}</dd><dt>Currency</dt><dd>${esc(s.currency_code)}</dd><dt>Short name</dt><dd>${esc(s.short_name)}</dd><dt>ISIN</dt><dd>${esc(s.isin||'—')}</dd><dt>CUSIP</dt><dd>${esc(s.cusip||'—')}</dd><dt>Denomination</dt><dd>${esc(fmt(s.denomination))}</dd><dt>Price basis</dt><dd>${s.quote_basis==='PERCENT'?'% of denomination':'Price per unit'}</dd></dl>`:'';
 function show(index){step=index;dialog.querySelectorAll('.payment-slide').forEach((p,i)=>{p.inert=i!==step;p.setAttribute('aria-hidden',String(i!==step));});dialog.querySelectorAll('.payment-progress li').forEach((p,i)=>{p.classList.toggle('current',i===step);p.classList.toggle('complete',i<step);if(i===step)p.setAttribute('aria-current','step');else p.removeAttribute('aria-current');});q('.step-caption').textContent=`Step ${step+1} of 5`;q('[data-back]').hidden=step===0;q('[data-next]').textContent=step===4?(side==='BUY'?'Buy':'Sell'):step===3?'Review order':'Next';}
 function sourceRows(){const s=security(),method=els().paymentMethod.value;if(!s)return [];
  const rows=method==='ACCOUNT'?data('accountsummaries').filter(a=>a.wallet_scope==='FUNDING'&&a.status==='ACTIVE'&&!a.network&&a.currency_code===s.currency_code):method==='CARD'?data('transfercards').filter(a=>a.currency_code===s.currency_code&&a.card_rail_mode!=='GLOBAL_SCHEME_ONLY'):data('cryptoholdings').filter(a=>data('cryptooffers').some(o=>o.asset===a.currency_code&&o.network===a.network&&o.fiat===s.currency_code));
  return holder?rows.filter(r=>String(r.user_id)===String(holder)):rows;
 }
 function selectedSource(){const id=els().source.value,m=els().paymentMethod.value;return sourceRows().find(a=>(m==='CARD'?a.card_id:a.account_id)===id);}
 function syncSources(){const current=els().source.value,m=els().paymentMethod.value;els().source.innerHTML=option('','Select…')+sourceRows().map(a=>option(m==='CARD'?a.card_id:a.account_id,`${a.full_name} · ${m==='CARD'?a.card_number:a.abiq_iban||a.network} · ${fmt(a.available_balance)} ${a.currency_code}`)).join('');if([...els().source.options].some(o=>o.value===current))els().source.value=current;if(els().source.options.length===2)els().source.selectedIndex=1;syncBalance();}
 function syncBalance(){const a=selectedSource(),s=security(),crypto=els().paymentMethod.value==='CRYPTO';q('[data-balance]').textContent=a?`Available balance: ${fmt(a.available_balance)} ${a.currency_code}`:'';q('[data-offer]').hidden=!crypto;els().offerId.disabled=!crypto;els().offerId.required=crypto;
  const previous=els().offerId.value;els().offerId.innerHTML=option('','Select…')+data('cryptooffers').filter(o=>a&&s&&o.asset===a.currency_code&&o.network===a.network&&o.fiat===s.currency_code).map(o=>option(o.offer_id,`${fmt(o.unit_price)} ${o.fiat} / ${o.asset} · ${o.network}`)).join('');if([...els().offerId.options].some(o=>o.value===previous))els().offerId.value=previous;if(els().offerId.options.length===2)els().offerId.selectedIndex=1;
  const p=data('securitypositions').find(p=>s&&p.security_id===s.security_id&&String(p.user_id)===String(a?.user_id));q('[data-held]').textContent=side==='SELL'?`Available quantity: ${fmt(p?.available_quantity||'0')}`:'';calculate();
 }
 function calculate(){const s=security();if(!s)return;try{els().total.value=portfolioValue(els().quantity.value,s.denomination,els().price.value,s.quote_basis,s.currency_code);}catch{els().total.value='';}const offer=data('cryptooffers').find(o=>o.offer_id===els().offerId.value);let amount='';try{if(offer&&els().total.value){const value=units(els().total.value)*10n**18n,rate=units(offer.unit_price);amount=`${side==='BUY'?'Crypto to debit':'Crypto to receive'}: ${decimal((value+(side==='BUY'?rate-1n:0n))/rate)} ${offer.asset}`;}}catch{}q('[data-crypto-total]').textContent=amount;}
 function syncSecurity(){const s=security();q('[data-metadata]').innerHTML=metadata(s);els().denomination.innerHTML=s?option(s.denomination,fmt(s.denomination)+' '+s.currency_code):option('','Select security');q('[data-price-label]').textContent=s?.quote_basis==='PERCENT'?'Price (% of denomination)':'Price per unit';if(s)els().price.value=s.reference_price||data('securitypositions').find(p=>p.security_id===s.security_id)?.market_price||'';syncSources();calculate();}
 async function openTrade(direction='BUY',securityId='',userId=null,restored=null){
  if(!await dependencies())return;side=direction;holder=userId;mode='TRADE';step=0;review=null;busy=false;requestKey=crypto.randomUUID();submitKey=crypto.randomUUID();
  const names=['Security',side==='BUY'?'Debit account':'Receive proceeds','Quantity & denomination','Price & total','Review & order'];
  shell(side==='BUY'?'Buy security':'Sell security',`<ol class="payment-progress">${names.map((n,i)=>`<li><span>${i+1}</span><small>${n}</small></li>`).join('')}</ol><p class="step-caption" aria-live="polite"></p><form novalidate><div class="payment-viewport"><div class="payment-track">
   <section class="payment-slide">${selector()}<div data-metadata></div></section>
   <section class="payment-slide">${select('paymentMethod',side==='BUY'?'Pay with':'Receive into',[['ACCOUNT','Bank account'],['CARD','Card'],['CRYPTO','Crypto']],'required')}${select('source',side==='BUY'?'Debit account / holding':'Credit account / holding',[],'required')}<p class="account-balance" data-balance></p><div data-offer>${select('offerId','Crypto exchange quote',[],'required')}</div><p data-held></p></section>
   <section class="payment-slide">${input('quantity','Quantity','required inputmode="decimal"')}${select('denomination','Denomination',[],'required')}</section>
   <section class="payment-slide"><label><span data-price-label>Price</span><input name="price" aria-label="Price" required inputmode="decimal"><span class="field-error" data-error="price"></span></label>${input('total',side==='BUY'?'Total price for debiting':'Total sale proceeds','readonly required')}<p data-crypto-total></p>${input('reference','Reference','required maxlength="128"')}</section>
   <section class="payment-slide"><h3>Please check your order</h3><div data-review></div></section>
  </div></div><p class="payment-error" role="alert"></p><div class="payment-footer"><button type="button" data-back>Back</button><button type="submit" class="primary" data-next>Next</button></div></form>`);
  els().paymentMethod.value='ACCOUNT';els().securityId.value=securityId;els().reference.value=(direction==='BUY'?'Buy ':'Sell ');syncSecurity();
  if(restored){for(const[n,v]of Object.entries(restored))if(els().namedItem(n)&&n!=='source')els()[n].value=v;syncSources();if(restored.source!==undefined)els().source.value=restored.source;syncBalance();}
  els().securityId.onchange=syncSecurity;els().paymentMethod.onchange=syncSources;els().source.onchange=syncBalance;els().offerId.onchange=calculate;els().quantity.oninput=calculate;els().price.oninput=calculate;
  q('[data-add-security]')?.addEventListener('click',()=>{draft={...values(),direction:side,holder};void addSecurity('TRADE');});
  q('[data-back]').onclick=()=>{review=null;requestKey=crypto.randomUUID();q('.payment-error').textContent='';show(step-1);};
  form().onsubmit=async e=>{e.preventDefault();if(busy)return;q('.payment-error').textContent='';for(const el of q('.payment-slide[aria-hidden="false"]').querySelectorAll('input,select'))if(!el.reportValidity())return;const serial=epoch;setBusy(true);
   try{
    if(step===3){const v=values(),s=security(),a=selectedSource();review=await api('portfolio/orders/review',{securityId:s.security_id,side,accountId:v.paymentMethod==='CARD'?a.card_account_id:a.account_id,cardId:v.paymentMethod==='CARD'?a.card_id:undefined,paymentMethod:v.paymentMethod,offerId:v.offerId,quantity:v.quantity,denomination:v.denomination,price:v.price,total:v.total,reference:v.reference},requestKey);if(serial!==epoch)return;showReview(review.instruction);}
    if(step===4){const result=await api('portfolio/orders/submit',{orderId:review.id,reviewHash:review.reviewHash},submitKey);if(serial!==epoch)return;close();notice(result.status==='FILLED'?'Trade executed · '+result.executionReference:'Order entered in AVISPay Exchange.');await refresh();return;}
    show(step+1);
   }catch(e){if(serial===epoch)error(e);}finally{if(serial===epoch)setBusy(false);}
  };show(0);
 }
 function showReview(v){q('[data-review]').innerHTML=metadata({name:v.name,short_name:v.shortName,currency_code:v.currency,isin:v.isin,cusip:v.cusip,denomination:v.denomination,quote_basis:v.quoteBasis})+`<dl class="payment-summary">${[['Order',v.side],['Quantity',fmt(v.quantity)],['Price',fmt(v.price)+(v.quoteBasis==='PERCENT'?'%':'')],['Total',fmt(v.total)+' '+v.currency],['Payment',v.paymentMethod],['Account',v.accountLabel],...(v.cryptoAmount?[['Crypto',fmt(v.cryptoAmount)+' '+v.cryptoCurrency],['Exchange rate',fmt(v.unitPrice)+' '+v.currency]]:[]),['Reference',v.reference]].map(([k,val])=>`<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl><p class="field-help">All-or-none order at the reviewed price. Funds or securities are reserved until execution or cancellation.</p>`;}
 async function openRecord(positionId='',selected='',restored=null){
  const catalogueError=await ensureBookingCatalogue();
  if(!await dependencies())return;mode='RECORD';busy=false;requestKey=crypto.randomUUID();const p=data('securitypositions').find(p=>p.position_id===positionId);
  shell(p?'Edit portfolio holding':'Record portfolio holding',`<form><div class="portfolio-fields">${select('userId','Portfolio holder',data('customers').map(c=>[c.user_id,c.full_name+' · User '+c.user_id]),'required')}${selector()}<div data-metadata></div><div class="payment-grid">${input('quantity','Quantity','required inputmode="decimal"')}${input('issuingPrice','Issuing price','required inputmode="decimal"')}${input('marketPrice','Market price','required inputmode="decimal"')}${input('portfolioValue','Portfolio value','readonly')}</div><p data-price-basis></p>${input('reference','Booking reference','required maxlength="128"')}</div><p class="payment-error" role="alert"></p><div class="payment-footer"><button type="submit" class="primary">Save holding</button></div></form>`);
  if(catalogueError)q('.payment-error').textContent='Green Bond catalogue refresh: '+catalogueError+'. You may register this security manually.';
  if(p){els().userId.value=p.user_id;els().securityId.value=p.security_id;els().userId.disabled=true;els().securityId.disabled=true;els().quantity.value=p.quantity;els().issuingPrice.value=p.issuing_price;els().marketPrice.value=p.market_price;q('[data-add-security]').hidden=true;}
  else els().securityId.value=selected;
  if(restored)for(const[n,v]of Object.entries(restored))if(els().namedItem(n))els()[n].value=v;
  function sync(){const s=security();q('[data-metadata]').innerHTML=metadata(s);q('[data-price-basis]').textContent=s?.quote_basis==='PERCENT'?'Issuing and market prices are % of denomination.':'Issuing and market prices are per unit.';try{els().portfolioValue.value=portfolioValue(els().quantity.value,s.denomination,els().marketPrice.value,s.quote_basis,s.currency_code);}catch{els().portfolioValue.value='';}}
  els().securityId.onchange=()=>{const s=security();if(s?.reference_price){els().issuingPrice.value=s.reference_price;els().marketPrice.value=s.reference_price;}sync();};els().quantity.oninput=sync;els().marketPrice.oninput=sync;sync();
  q('[data-add-security]')?.addEventListener('click',()=>{draft=values();void addSecurity('RECORD');});
  form().onsubmit=async e=>{e.preventDefault();if(busy)return;setBusy(true);const serial=epoch;try{await api('portfolio/positions',{...values(),userId:p?.user_id||els().userId.value,securityId:p?.security_id||els().securityId.value,version:p?.version},requestKey);if(serial!==epoch)return;close();notice('Portfolio holding saved.');await refresh();}catch(e){if(serial===epoch)error(e);}finally{if(serial===epoch)setBusy(false);}};
 }
 async function addSecurity(returnTo='RECORD'){
  mode='ADD';busy=false;requestKey=crypto.randomUUID();shell('Add security',`<form><div class="portfolio-fields">${input('name','Name of security','required maxlength="200"')}${input('shortName','Short name','required maxlength="80"')}<div class="payment-grid">${select('currency','Currency',['EUR','USD','GBP','CHF','SEK','NOK','DKK','PLN','CZK','HUF','RON','AED','SGD','JPY'].map(c=>[c,c]),'required')}${select('kind','Security type',[['bond','Bond'],['note','Note'],['cd','Certificate of deposit'],['share','Share'],['fund','Fund'],['token','Crypto / security token'],['other','Other']],'required')}${input('isin','ISIN','maxlength="12"')}${input('cusip','CUSIP','maxlength="9"')}${input('denomination','Denomination','required inputmode="decimal"')}${select('quoteBasis','Price basis',[['PERCENT','% of denomination'],['UNIT','Price per unit']],'required')}</div></div><p class="payment-error" role="alert"></p><div class="payment-footer"><button type="button" data-return>Back</button><button type="submit" class="primary">Add security</button></div></form>`);
  const back=async id=>returnTo==='TRADE'?openTrade(draft.direction,id||draft.securityId,draft.holder,{...draft,...(id?{securityId:id}:{} )}):openRecord('',id||draft.securityId,{...draft,...(id?{securityId:id}:{} )});q('[data-return]').onclick=()=>void back();
  form().onsubmit=async e=>{e.preventDefault();if(busy)return;setBusy(true);const serial=epoch;try{const r=await api('portfolio/securities',values(),requestKey);if(serial!==epoch)return;await back(r.id);}catch(e){if(serial===epoch)error(e);}finally{if(serial===epoch)setBusy(false);}};
 }
 async function viewOrder(id){const serial=++epoch,r=await api('portfolio/orders/'+id);if(serial!==epoch)return;mode='ORDER';busy=false;shell('Exchange order',`<form><div class="portfolio-fields"><div data-review></div><p>${esc(r.status==='FILLED'?'Executed':r.status==='OPEN'?'Open':'Cancelled')}${r.execution_reference?' · '+esc(r.execution_reference):''}</p></div><p class="payment-error" role="alert"></p><div class="payment-footer">${r.status==='OPEN'?'<button type="submit">Cancel order</button>':''}</div></form>`);showReview(r.instruction);const cancelKey=crypto.randomUUID();form().onsubmit=async e=>{e.preventDefault();if(busy||r.status!=='OPEN')return;setBusy(true);try{await api('portfolio/orders/cancel',{orderId:id},cancelKey);if(serial!==epoch)return;close();notice('Order cancelled; reservation released.');await refresh();}catch(e){if(serial===epoch)error(e);}finally{if(serial===epoch)setBusy(false);}};}
 function bind(root){
  root.querySelectorAll('[data-register-treasury]').forEach(button=>button.onclick=()=>fromTreasury(button.dataset.registerTreasury).catch(err=>{
   const issue=button.closest('[data-stock-register]')?.querySelector('[data-stock-register-error]');
   if(button.isConnected&&issue)issue.textContent=err.message;
  }));
  function bindAction(selector,open){
   root.querySelectorAll(selector).forEach(button=>button.onclick=()=>open(button.dataset).catch(err=>{
    if(button.isConnected)actionError(err,button);
   }));
  }
  bindAction('[data-security-buy]',d=>openTrade('BUY',d.securityBuy));
  bindAction('[data-security-sell]',d=>openTrade('SELL',d.securitySell,d.holder));
  bindAction('[data-position]',d=>openRecord(d.position));
  bindAction('[data-security-order]',d=>viewOrder(d.securityOrder));
  bindAction('[data-book-security]',d=>openTrade(d.side,d.bookSecurity,null,{quantity:d.quantity,price:d.price}));
 }
 async function open(action){if(action==='syncsecurities'){const serial=epoch;await api('portfolio/catalogue/sync',{});if(serial!==epoch)return;notice('Green Bond catalogue refreshed.');await refresh();return;}if(action==='recordsecurity')return openRecord();return openTrade(action==='sellsecurity'?'SELL':'BUY');}
 async function fromExchange(intent){
  const serial=++epoch,r=await api('portfolio/exchange-security',{symbol:intent.symbol});if(serial!==epoch)return;
  await openTrade(intent.side,r.id,null,{...(intent.quantity?{quantity:intent.quantity}:{}),...(intent.price?{price:intent.price}:{}),reference:(intent.side==='BUY'?'Buy ':'Sell ')+intent.symbol});
 }
 async function fromTreasury(bookingId){
  if(!isAdmin())return;
  const serial=++epoch;
  const {openTreasurySource}=await import('./treasury-source.mjs');
  if(serial!==epoch||!isAdmin())return;
  return openTreasurySource({api,bookingId,isCurrent:()=>serial===epoch&&isAdmin(),
   modal:(title,body)=>{shell(title,body);return dialog;},
   onRegistered:async()=>{if(serial===epoch){close();notice('Treasury source registered in Portfolio.');await refresh();}}
  });
 }
 function pendingIntent(){
  const s=mode==='TRADE'&&form()?security():null;if(!s?.exchange_symbol)return null;
  return {side,symbol:s.exchange_symbol,...(els().quantity.value?{quantity:els().quantity.value}:{}),...(els().price.value?{price:els().price.value}:{})};
 }
 return {close,open,bind,fromExchange,fromTreasury,pendingIntent};
}
