const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const option=(value,label)=>`<option value="${esc(value)}">${esc(label)}</option>`;
const field=(name,label,attributes='')=>`<label>${esc(label)}<input name="${name}" aria-label="${esc(label)}" ${attributes}></label>`;
const select=(name,label,rows,attributes='')=>`<label>${esc(label)}<select name="${name}" aria-label="${esc(label)}" ${attributes}>${option('','Select…')+rows.map(row=>option(...row)).join('')}</select></label>`;
const decimal=value=>String(value??'').replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
const currencies=['EUR','USD','GBP','CHF','SEK','NOK','DKK','PLN','CZK','HUF','RON','AED','SGD','JPY'];

// Registration connects an existing Treasury source to its Portfolio record.
// Only an explicit form submission writes metadata; opening this window is read-only.
export async function openTreasurySource({api,modal,bookingId,isCurrent=()=>true,onRegistered=()=>{}}){
 let dialog=null,epoch=0,closed=false,securities=[],positions=[],source=null;
 const active=serial=>!closed&&isCurrent()&&dialog?.isConnected&&serial===epoch;
 const [treasury,registered,holdings]=await Promise.all([
  api('views/treasurypositions'),api('views/securities'),api('views/securitypositions')
 ]);
 if(!isCurrent())return null;
 source=treasury.rows?.find(row=>row.booking_id===bookingId&&row.asset_class==='SECURITY');
 if(!source)throw new Error('Select an existing Treasury security source.');
 securities=registered.rows||[];positions=holdings.rows||[];
 const candidates=()=>securities.filter(row=>row.isin&&(!source.isin||row.isin===source.isin)&&
  (source.asset_code!=='AVISPAY-PLC-SHARES'||row.kind==='share'));
 const existing=id=>positions.find(row=>String(row.user_id)===String(source.owner_user_id)&&row.security_id===id);
 const sourceSummary=()=>`<dl class="crypto-details" data-treasury-source><dt>Recorded security</dt><dd>${esc(source.asset_name)}</dd><dt>Recorded quantity</dt><dd>${esc(decimal(source.quantity))}</dd><dt>Source reference</dt><dd>${esc(source.source_reference)}</dd></dl>`;
 const show=(title,body)=>{
  epoch++;dialog=modal(title,body);const own=dialog;
  own.addEventListener('close',()=>{if(dialog===own){closed=true;epoch++;}},{once:true});
  return {el:own,serial:epoch,form:own.querySelector('form')};
 };
 const report=(error,form)=>{
  form.querySelector('.form-error').textContent=error.message;
  const input=form.elements.namedItem(error.field);if(input){input.setAttribute('aria-invalid','true');input.focus();}
 };
 const lock=(form,busy)=>{form.setAttribute('aria-busy',String(busy));form.querySelector('fieldset').disabled=busy;};
 const receiptKey=()=>{let prior='',key='';return value=>{const next=JSON.stringify(value);if(next!==prior){prior=next;key=crypto.randomUUID();}return key;};};

 function registration(selectedId=source.security_id||'',saved={}){
  const {el,serial,form}=show('Register Treasury source in Portfolio',
   `<form><fieldset class="crypto-source-fields">${sourceSummary()}<div class="crypto-form-grid">`+
   select('securityId','Registered security',candidates().map(row=>[row.security_id,row.short_name+' · '+row.isin+' · '+row.currency_code]),'required')+
   '<button type="button" data-source-add-security>＋ Add security details</button><div data-source-metadata></div>'+
   field('issuingPrice','Issuing price','required inputmode="decimal"')+
   field('marketPrice','Market price','required inputmode="decimal"')+
   '</div><p data-source-position></p><p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" data-source-cancel>Cancel</button><button class="primary" type="submit">Register source holding</button></div></fieldset></form>');
  form.elements.securityId.value=selectedId;
  let busy=false;const key=receiptKey();
  const sync=()=>{
   const security=candidates().find(row=>row.security_id===form.elements.securityId.value),position=security&&existing(security.security_id);
   form.querySelector('[data-source-metadata]').innerHTML=security?`<dl class="crypto-details"><dt>Currency</dt><dd>${esc(security.currency_code)}</dd><dt>Denomination</dt><dd>${esc(decimal(security.denomination))}</dd><dt>Price basis</dt><dd>${security.quote_basis==='PERCENT'?'% of denomination':'Price per unit'}</dd></dl>`:'';
   for(const [name,column]of [['issuingPrice','issuing_price'],['marketPrice','market_price']]){
    const input=form.elements[name];input.readOnly=!!position;input.value=position?decimal(position[column]):'';
   }
   form.querySelector('[data-source-position]').textContent=position?'Use the existing Portfolio holding and its recorded prices.':'The recorded Treasury quantity will be linked to this Portfolio security.';
  };
  sync();if(!existing(selectedId))for(const name of ['issuingPrice','marketPrice'])if(saved[name]!==undefined)form.elements[name].value=saved[name];
  form.elements.securityId.onchange=sync;
  form.querySelector('[data-source-cancel]').onclick=()=>el.close();
  form.querySelector('[data-source-add-security]').onclick=()=>{
   const values=Object.fromEntries(new FormData(form));addSecurity(values);
  };
  form.onsubmit=async event=>{
   event.preventDefault();if(busy||!active(serial)||!form.reportValidity())return;
   const input={bookingId:source.booking_id,...Object.fromEntries(new FormData(form))};
   form.querySelector('.form-error').textContent='';busy=true;lock(form,true);
   try{
    const result=await api('portfolio/treasury-source',input,key(input));
    if(!active(serial))return;
    if(result.bookingId!==source.booking_id||result.securityId!==input.securityId||!result.positionId)
     throw new Error('The source registration receipt did not match this holding.');
    await onRegistered(result);
    if(el.isConnected)el.close();
   }catch(error){if(active(serial))report(error,form);}
   finally{busy=false;if(active(serial))lock(form,false);}
  };
 }

 function addSecurity(saved){
  const {el,serial,form}=show('Add source security details',
   `<form><fieldset class="crypto-source-fields">${sourceSummary()}<div class="crypto-form-grid">`+
   field('name','Name of security','required maxlength="200" readonly')+
   field('shortName','Short name','required maxlength="80"')+
   select('currency','Currency',currencies.map(code=>[code,code]),'required')+
   select('kind','Security type',[['share','Share'],['bond','Bond'],['note','Note'],['cd','Certificate of deposit'],['fund','Fund'],['token','Security token'],['other','Other']],'required')+
   field('isin','ISIN','required minlength="12" maxlength="12" autocapitalize="characters"')+
   field('cusip','CUSIP','maxlength="9" autocapitalize="characters"')+
   field('denomination','Denomination','required inputmode="decimal"')+
   select('quoteBasis','Price basis',[['UNIT','Price per unit'],['PERCENT','% of denomination']],'required')+
   field('quantityDecimals','Quantity decimal places','type="number" required min="0" max="18" step="1"')+
   '</div><p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" data-source-back>Back</button><button class="primary" type="submit">Save security details</button></div></fieldset></form>');
  form.elements.name.value=source.asset_name;
  form.elements.isin.value=source.isin||'';form.elements.isin.readOnly=!!source.isin;
  if(source.asset_code==='AVISPAY-PLC-SHARES'){form.elements.kind.value='share';form.elements.kind.disabled=true;}
  let busy=false;const key=receiptKey();
  form.querySelector('[data-source-back]').onclick=()=>registration(saved.securityId,saved);
  form.onsubmit=async event=>{
   event.preventDefault();if(busy||!active(serial)||!form.reportValidity())return;
   const input={...Object.fromEntries(new FormData(form)),...(source.asset_code==='AVISPAY-PLC-SHARES'?{kind:'share'}:{})};
   input.quantityDecimals=Number(input.quantityDecimals);
   form.querySelector('.form-error').textContent='';busy=true;lock(form,true);
   try{
    const result=await api('portfolio/securities',input,key(input));
    if(!active(serial))return;
    const refreshed=await api('views/securities');if(!active(serial))return;securities=refreshed.rows||[];
    if(!candidates().some(row=>row.security_id===result.id))throw new Error('The saved source security could not be loaded.');
    registration(result.id,saved);
   }catch(error){if(active(serial))report(error,form);}
   finally{busy=false;if(active(serial))lock(form,false);}
  };
 }
 registration();
 return {close(){closed=true;epoch++;dialog?.close();}};
}
