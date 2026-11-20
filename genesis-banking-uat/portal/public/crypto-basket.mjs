const checkout='https://avis.land/avispay/checkout?source=crypto&own=1';
const esc=v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const percentage=v=>String(Number(v||0)/100);
function asBps(value){if(!/^\d{1,3}(\.\d{1,2})?$/.test(value))throw Error('Enter a percentage with up to two decimal places.');const [a,b='']=value.split('.');return Number(a)*100+Number(b.padEnd(2,'0'));}
export async function openCryptoBasket(api,asset,network,purpose){
 const {token}=await api('crypto/basket/start',{}),url=new URL(checkout);
 if(purpose==='wallet-payment')url.searchParams.set('source',purpose);
 if(asset)url.searchParams.set('asset',asset);if(network)url.searchParams.set('network',network);
 url.hash=new URLSearchParams({checkout:token}).toString();location.assign(url.href);
}
export const basketPolicyFields=`<form class="basket-policy" data-basket-policy hidden>
 <label>Purchase markup %<input name="markup" type="number" min="0" max="100" step="0.01" required></label>
 <label>Trading participation %<input name="participation" type="number" min="0" max="100" step="0.01" required></label>
 <button type="submit">Save percentages</button><output aria-live="polite"></output></form>`;
export async function mountBasketPolicy(host,api,registerOffer){
 const form=host.querySelector('[data-basket-policy]');if(!form)return;
 const pane=document.createElement('details');pane.className='basket-treasury';
 pane.innerHTML='<summary>Treasury purchases</summary><div data-treasury></div><p role="status" aria-live="polite"></p>';
 form.parentElement.after(pane);
 const msg=pane.querySelector('[role=status]'),content=pane.querySelector('[data-treasury]');
 const currency='<select name="fiat" required>'+['EUR','USD','GBP','CHF'].map(c=>'<option>'+c+'</option>').join('')+'</select>';
 const refresh=async()=>{
  try{const {rows}=await api('views/cryptobasketpolicy');const data=rows?.[0];if(!data||!form.isConnected)return;
   form.hidden=false;form.elements.markup.value=percentage(data.markup_bps);form.elements.participation.value=percentage(data.participation_bps);
   content.innerHTML=`<p><a href="https://portfolio.metamask.io/buy" target="_blank" rel="noopener noreferrer">Buy for treasury in MetaMask</a> <button type="button" data-native-offer>Set treasury offer</button></p>
    ${data.requests.length?'<h3>Treasury orders</h3><ul>'+data.requests.map(r=>'<li>'+esc(r.quantity.replace(/\.?0+$/,''))+' '+esc(r.asset)+' · '+esc(r.network)+' · '+(r.status==='REVIEW'?'Payment review':'Quote requested')+' · '+esc(r.order_id)+'</li>').join('')+'</ul>':''}
    <form data-lot><h3>Record MetaMask acquisition cost</h3><label>Confirmed treasury deposit<select name="journalId" required><option value="">Select receipt</option>${data.receipts.map(d=>'<option value="'+esc(d.journal_id)+'">'+esc(d.currency_code)+' · '+esc(d.amount)+' · '+esc(d.tx_hash)+'</option>').join('')}</select></label>
    <label>Provider order reference<input name="providerReference" maxlength="140" required></label><label>Cost currency${currency}</label><label>Total paid including gas<input name="cost" min="0.01" step="0.01" type="number" required></label><label>Gas included in total<input name="gasCost" type="number" min="0" step="0.01" required></label><button>Register purchase</button></form>
    <details><summary>Card acquiring terms</summary><p>${data.cardCurrencies.length?'Enabled currencies · '+data.cardCurrencies.map(esc).join(', '):'Enter the Stripe approval reference and contracted fee for crypto sales.'}</p>
    <form data-card><label>Settlement currency${currency}</label><label>Stripe crypto acquiring approval reference<input name="approvalReference" maxlength="150" required></label><label>Stripe publishable key for the embedded form<input name="publishableKey" placeholder="pk_live_…" autocomplete="off"></label><label>Processing cost ceiling %<input name="fee" type="number" min="0" max="99.99" step="0.01" required></label><label>Fixed cost in settlement currency<input name="fixed" type="number" min="0" max="1000" step="0.01" required></label><button>Save card terms</button></form></details>`;
   content.querySelector('[data-native-offer]').onclick=registerOffer;
   for(const [selector,path] of [['[data-lot]','lot'],['[data-card]','card-terms']]){
    const f=content.querySelector(selector);f.onsubmit=async e=>{e.preventDefault();const button=f.querySelector('button');button.disabled=true;try{
     const body=Object.fromEntries(new FormData(f));if(path==='card-terms'){body.feeBps=asBps(body.fee);const [a,b='']=body.fixed.split('.');body.fixedMinor=Number(a)*100+Number(b.padEnd(2,'0'));}
     await api('crypto/basket/'+path,body);msg.textContent=path==='lot'?'Treasury purchase recorded.':'Card terms saved.';await refresh();
    }catch(err){msg.textContent=err.message;}finally{button.disabled=false;}};
   }
  }catch(err){if(form.isConnected)msg.textContent=err.message;}
 };
 form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;
  try{await api('crypto/basket/policy',{markupBps:asBps(form.elements.markup.value),participationBps:asBps(form.elements.participation.value)});form.querySelector('output').textContent='Saved';}
  catch(err){form.querySelector('output').textContent=err.message;}finally{button.disabled=false;}};
 await refresh();
}
export async function resumeBasketAuthorization(api,container){
 const params=new URLSearchParams(location.search),store=params.has('store_order'),id=params.get(store?'store_order':'crypto_order');
 if(!/^[a-f0-9-]{36}$/i.test(id||'')||document.querySelector('[data-basket-authorize]'))return;
 const panel=document.createElement('dialog');panel.dataset.basketAuthorize='';container.append(panel);
 panel.addEventListener('close',()=>panel.remove(),{once:true});
 try{const order=await api('crypto/basket/'+(store?'store/':'orders/')+id);if(!panel.isConnected)return;
  panel.innerHTML='<h2>Authorize AVISPay payment</h2><p>'+(store?esc(order.title):esc(order.quantity.replace(/\.?0+$/,''))+' '+esc(order.asset)+' · '+esc(order.network))+'</p><p><strong>'+esc(order.fiat)+' '+esc(order.total)+'</strong></p><p>Order '+esc(order.id)+'</p><div class="crypto-inline-actions"><button data-pay></button><button data-cancel>Back to basket</button></div><p role="status"></p>';
  const pay=panel.querySelector('[data-pay]');pay.textContent=order.pay?'Pay '+order.pay.quantity.replace(/\.?0+$/,'')+' '+order.pay.asset+' · '+order.pay.network:'Pay '+order.fiat+' '+order.total;pay.hidden=order.status!=='QUOTED';
  const back=()=>location.assign((store?'https://avis.land/avispay/checkout?source=wallet-payment&own=1':checkout)+'&order='+encodeURIComponent(id));panel.querySelector('[data-cancel]').onclick=back;
  if(order.status==='PAID')panel.querySelector('[role=status]').textContent='Payment received.';
  pay.onclick=async()=>{pay.disabled=true;try{await api('crypto/basket/'+(store?'store-confirm':'confirm'),{id,total:order.total,quantity:order.pay?.quantity,walletId:order.pay?.walletId});back();}catch(err){panel.querySelector('[role=status]').textContent=err.message;pay.disabled=false;}};
  panel.showModal();
 }catch(err){panel.textContent=err.message;const close=document.createElement('button');close.textContent='Close';close.onclick=()=>panel.close();panel.append(close);panel.showModal();}
}
export async function openCheckoutManagement(api){
 document.querySelector('[data-checkout-management]')?.remove();
 const d=document.createElement('dialog');d.dataset.checkoutManagement='';d.className='checkout-management';
 d.innerHTML='<header><h2>Checkout management</h2><button aria-label="Close" type="button">×</button></header><label>Find a currency or network<input type="search"></label><div data-list></div><h3>MetaMask pricing</h3><form><label>Currency and blockchain<select name="asset" required></select></label><label>Fiat<select name="fiat"><option>EUR</option><option>USD</option><option>GBP</option><option>CHF</option></select></label><label>Purchase budget<input name="budget" type="number" min=".01" step=".01"></label><button>Refresh price and gas</button></form><details><summary>Treasury supplier settings</summary><form data-procurement><label>MetaMask purchasing region<input name="region" required placeholder="Country or region code"></label><label>MetaMask payment method ID<input name="payment" required></label><button>Save supplier settings</button></form></details><output aria-live="polite"></output>';
 document.body.append(d);d.querySelector('header button').onclick=()=>d.close();d.addEventListener('close',()=>d.remove(),{once:true});d.showModal();
 const out=d.querySelector('output'),list=d.querySelector('[data-list]'),filter=d.querySelector('input[type=search]'),form=d.querySelector('form');
 try{const [{rows},settings]=await Promise.all([api('views/checkouttenders'),api('views/cryptobasketpolicy')]);if(!d.isConnected)return;
  const route=d.querySelector('[data-procurement]');if(route){const current=settings.rows?.[0];route.elements.region.value=current?.procurement_region||'';route.elements.payment.value=current?.procurement_method||'';route.onsubmit=async e=>{e.preventDefault();try{await api('crypto/basket/procurement',Object.fromEntries(new FormData(route)));out.textContent='MetaMask supplier settings saved.';}catch(err){out.textContent=err.message;}};}
  const draw=()=>{const match=filter.value.toLowerCase().trim();list.replaceChildren();
   for(const row of rows.filter(r=>(r.name+' '+r.asset+' '+r.network).toLowerCase().includes(match))){
    const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.checked=row.accepted;label.append(box,document.createTextNode(row.name+' ('+row.asset+') · '+row.network));list.append(label);
    box.onchange=async()=>{box.disabled=true;const accepted=box.checked;try{await api('crypto/basket/tender',{assetId:row.asset_id,network:row.network,accepted});row.accepted=accepted;out.textContent='Accepted payment currencies saved.';}
     catch(err){box.checked=row.accepted;out.textContent=err.message;}finally{box.disabled=false;}};
   }
  };filter.oninput=draw;draw();form.elements.asset.replaceChildren(...rows.map((r,i)=>new Option(r.name+' · '+r.network,String(i))));
  form.onsubmit=async e=>{e.preventDefault();const row=rows[Number(form.elements.asset.value)];if(!row)return;const button=form.querySelector('button');button.disabled=true;
   try{const market=await api('crypto/basket/price',{asset:row.asset,network:row.network,fiat:form.elements.fiat.value,budget:form.elements.budget.value});
    const value=Number(market.rate).toLocaleString(undefined,{maximumSignificantDigits:12});
    out.textContent=market.source+' · '+value+' '+market.fiat+' per '+market.asset+' · '+new Date(market.observedAt).toLocaleTimeString()+
     (market.gas?' · '+market.gas.source+' estimate '+Number(market.gas.maxGwei)+' gwei per gas':'')+
     (market.supplier?' · '+market.supplier.provider+' quote '+(Number(market.supplier.totalMinor)/100).toFixed(2)+' '+market.fiat+' including '+(Number(market.supplier.gasMinor)/100).toFixed(2)+' in gas':market.supplierStatus?' · '+market.supplierStatus:'');
   }catch(err){out.textContent=err.message;}finally{button.disabled=false;}
  };
 }catch(err){out.textContent=err.message;}
}
