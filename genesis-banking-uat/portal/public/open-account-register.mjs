// Account opening reads the existing holder register, without generating a second customer identity.
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const holderTypes=new Set(['PERSONAL','BUSINESS']);
const validHolders=holders=>(holders||[]).filter(holder=>
 holderTypes.has(holder.account_type)&&/^[1-9][0-9]*$/.test(String(holder.user_id))
).sort((a,b)=>String(a.full_name).localeCompare(String(b.full_name))||String(a.user_id).localeCompare(String(b.user_id)));

export function holderRegisterField(holders){
 const options=validHolders(holders).map(holder=>{
  const registerId=holder.customer_number?('Customer '+holder.customer_number):('User '+holder.user_id);
  return `<option value="${esc(holder.user_id)}" data-account-type="${esc(holder.account_type)}">${esc(holder.full_name)} · ${esc(registerId)} · ${esc(holder.account_type)}</option>`;
 }).join('');
 return `<label data-open-account-holder hidden>Account holder register<select name="holderUserId" aria-label="Account holder register" disabled required><option value="">Select existing account holder or register new…</option><option value="NEW">+ Register new account holder</option>${options}</select></label>`;
}

export function connectAccountHolderRegister(form,holders){
 const type=form.elements.namedItem('accountType');
 const holder=form.elements.namedItem('holderUserId');
 const name=form.elements.namedItem('fullName');
 const holderRow=form.querySelector('[data-open-account-holder]');
 const nameRow=form.querySelector('[data-open-account-name]');
 if(!type||!holder||!name||!holderRow||!nameRow)throw Error('OPEN_ACCOUNT_FORM_INCOMPLETE');
 const registered=validHolders(holders);
 const sync=()=>{
  const isHolder=holderTypes.has(type.value);
  holderRow.hidden=!isHolder;
  holder.disabled=!isHolder;
  holder.required=isHolder;
  for(const option of holder.options){
   if(!option.dataset.accountType)continue;
   option.disabled=option.dataset.accountType!==type.value;
   option.hidden=option.disabled;
  }
  const selected=isHolder?registered.find(c=>String(c.user_id)===holder.value&&c.account_type===type.value):null;
  const newHolder=!isHolder||holder.value==='NEW';
  nameRow.hidden=isHolder&&!selected&&!newHolder;
  name.disabled=!newHolder;
  name.required=newHolder;
  name.readOnly=!!selected;
  if(selected)name.value=String(selected.full_name);
 };
 type.addEventListener('change',()=>{holder.value='';name.value='';sync();});
 holder.addEventListener('change',()=>{name.value='';sync();});
 sync();
}

export function buildAccountOpeningRequest(formData,holders){
 const accountType=String(formData.get('accountType')||'');
 const currencies=[String(formData.get('currency')||'')];
 if(holderTypes.has(accountType)){
  const selected=String(formData.get('holderUserId')||'');
  if(!selected)throw Error('Select an account holder from the register.');
  if(selected!=='NEW'){
   const holder=validHolders(holders).find(c=>String(c.user_id)===selected&&c.account_type===accountType);
   if(!holder)throw Error('Select a valid registered account holder.');
   return {userId:String(holder.user_id),accountType,currencies};
  }
 }
 return {fullName:String(formData.get('fullName')||'').trim(),accountType,currencies};
}
