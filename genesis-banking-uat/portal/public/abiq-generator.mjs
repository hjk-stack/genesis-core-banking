import {buildAbiqNumber} from './abiq-number.mjs';

const formatted = id => id.slice(0,14)+' '+id.slice(14);
const option = (value,label=value) => new Option(label,value);
const fill = (select,options) => select.replaceChildren(...options);

export function createAbiqGenerator({api}) {
 let desk;
 function close() { desk?.remove(); desk=null; }
 function windowFor(title) {
  close();
  const dialog=document.createElement('dialog');
  dialog.className='abiq-generator';
  dialog.innerHTML='<header class="dialog-heading"><h2></h2><button type="button" class="close" aria-label="Close">×</button></header><form><div class="generator-fields"></div><p class="form-error" role="alert"></p><div class="dialog-actions"><button class="primary" type="submit" disabled></button></div></form><div class="generator-result" role="status"></div>';
  dialog.querySelector('h2').textContent=title;
  dialog.querySelector('.close').onclick=close;
  dialog.oncancel=e=>{e.preventDefault();close();};
  document.body.append(dialog); desk=dialog; dialog.showModal();
  const handle=dialog.querySelector('header');
  handle.onpointerdown=e=>{
   if(e.button!==0||e.target.closest('button'))return;
   const rect=dialog.getBoundingClientRect(),left=e.clientX-rect.left,top=e.clientY-rect.top;
   handle.setPointerCapture(e.pointerId);
   handle.onpointermove=m=>{
    dialog.style.margin='0';
    dialog.style.left=Math.max(0,Math.min(innerWidth-rect.width,m.clientX-left))+'px';
    dialog.style.top=Math.max(0,Math.min(innerHeight-48,m.clientY-top))+'px';
   };
   handle.onlostpointercapture=()=>{handle.onpointermove=null;};
  };
  const form=dialog.querySelector('form');
  return {dialog,form,fields:form.querySelector('.generator-fields'),button:form.querySelector('[type=submit]'),
   error:form.querySelector('.form-error'),result:dialog.querySelector('[role=status]'),active:()=>desk===dialog};
 }
 function open() {
  const {dialog,form,fields,button,error,result,active}=windowFor('Generate ABIQ number');
  fields.innerHTML=`<label>Country<select required name="country"></select></label>
   <label>Check digits<select name="checkDigits"></select></label>
   <label>ABIQ holder short name<input required type="text" name="holderCode" maxlength="4" pattern="[A-Za-z]{4}" autocomplete="off" spellcheck="false" placeholder="e.g. AVIP"></label>
   <label>Currency<select required name="currency"></select></label>
   <label>Currency series<output name="series"></output></label>
   <label>Customer number<select name="customerNumber"></select></label>
   <label class="generator-preview">ABIQ IBAN<output name="preview"></output></label>`;
  button.textContent='Generate number';
  const history=document.createElement('details');
  history.innerHTML='<summary>Recently issued numbers</summary><ul></ul>';
  dialog.append(history);
  const f=form.elements;
  const regionNames=new Intl.DisplayNames(['en'],{type:'region'});
  let options,revision=0,requestKey=crypto.randomUUID(),pending=false;
  const selected=()=>options?.currencies.find(c=>c.currency===f.currency.value);
  function fillCustomerNumbers() {
   const previous=f.customerNumber.value;
   const combination=f.country.value+':'+f.currency.value;
   const numbers=selected()&&f.country.value?[...options.customerNumbers,...options.reusable.filter(entry=>!entry.combinations.includes(combination)).map(entry=>entry.number)]:[];
   fill(f.customerNumber,numbers.map(n=>option(n)));
   if(numbers.includes(previous))f.customerNumber.value=previous;
  }
  function preview() {
   const currency=selected();
   fill(f.checkDigits,[]); f.preview.textContent=''; button.disabled=true;
   if (!currency||!f.country.value||!f.customerNumber.value||!/^[A-Z]{4}$/.test(f.holderCode.value)) return;
   const id=buildAbiqNumber({...currency,country:f.country.value,holderCode:f.holderCode.value,customerNumber:f.customerNumber.value});
   fill(f.checkDigits,[option(id.slice(2,4))]); f.preview.textContent=formatted(id);
   button.disabled=pending;
  }
  async function load() {
   const serial=++revision;
   options=null;fill(f.customerNumber,[]);preview();

   try {
    const data=await api('abiq/generator?holder='+encodeURIComponent(/^[A-Z]{4}$/.test(f.holderCode.value)?f.holderCode.value:''));
    if (!active()||serial!==revision) return;
    options=data;
    const country=f.country.value,currency=f.currency.value;
    fill(f.country,[option('','Select country'),...data.countries.map(code=>option(code,regionNames.of(code)+' ('+code+')'))]);
    fill(f.currency,[option('','Select currency'),...data.currencies.map(c=>option(c.currency,(c.label||c.currency)+' · '+c.currencyBlock))]);
    f.country.value=data.countries.includes(country)?country:'';
    f.currency.value=data.currencies.some(c=>c.currency===currency)?currency:'';
    f.series.value=selected()?.series||'';
    fillCustomerNumbers();
    const list=history.querySelector('ul');list.replaceChildren();
    for(const entry of data.recent){const row=document.createElement('li');row.textContent=entry.currency+' · '+formatted(entry.identifier);list.append(row);}
    history.hidden=!data.recent.length;
    if (/^[A-Z]{4}$/.test(f.holderCode.value)&&selected()&&f.country.value&&!f.customerNumber.length) error.textContent='The seven-digit series for this holder is full.';
    preview();
   } catch(e) {if(active()&&serial===revision)error.textContent=e.message;}
  }
  form.oninput=e=>{
   error.textContent='';requestKey=crypto.randomUUID();
   if (e.target===f.holderCode) {f.holderCode.value=f.holderCode.value.toUpperCase();void load();return;}
   if (!options) return;
   if (e.target===f.currency) f.series.value=selected()?.series||'';
   if (e.target===f.currency||e.target===f.country) fillCustomerNumbers();
   preview();
  };
  form.onsubmit=async e=>{
   e.preventDefault();if(button.disabled||pending)return;
   const input={...Object.fromEntries(new FormData(form)),series:selected().series};pending=true;button.disabled=true;fields.inert=true;error.textContent='';
   try {
    const issued=await api('abiq/generator',input,requestKey);if(!active())return;
    result.textContent='Issued '+formatted(issued.identifier);
    requestKey=crypto.randomUUID();await load();
   } catch(e) {
    if(!active())return;
    error.textContent=e.message;
    if(e.code==='ABIQ_NUMBER_TAKEN'){requestKey=crypto.randomUUID();await load();}
   } finally {pending=false;fields.inert=false;if(active())preview();}
  };
  void load();
 }
 function assign(account,afterAssigned) {
  const {form,fields,button,error,result,active}=windowFor('Assign ABIQ number');
  fields.innerHTML='<label>Available number<select name="identifier"></select></label><button type="button" data-more hidden>Load more numbers</button>';
  const selector=form.elements.identifier,more=fields.querySelector('[data-more]');
  const key=crypto.randomUUID();button.textContent='Assign number';
  let after=null;
  async function load() {
   more.disabled=true;
   try {
    const params=new URLSearchParams({accountId:account.account_id,currency:account.currency_code,after:after||''});
    const data=await api('abiq/generator/available?'+params);if(!active())return;
    for(const id of data.numbers)selector.add(option(id,formatted(id)));
    after=data.next;more.hidden=!after;button.disabled=!selector.length;
    if(!selector.length)result.textContent='No available numbers for this account. Generate a number in Accounts & ABIQ.';
   } catch(e){if(active())error.textContent=e.message;}
   finally{more.disabled=false;}
  }
  more.onclick=load;
  form.onsubmit=async e=>{
   e.preventDefault();if(button.disabled)return;button.disabled=true;fields.inert=true;error.textContent='';
   try{await api('abiq/generator/assign',{accountId:account.account_id,identifier:selector.value},key);
    if(active()){close();await afterAssigned();}}
   catch(e){if(active()){error.textContent=e.message;button.disabled=false;}}
   finally{fields.inert=false;}
  };
  void load();
 }
 return {open,assign,close};
}
