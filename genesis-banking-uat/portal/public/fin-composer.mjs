import {FIELDS,PACS008,blankForm,buildFinMessage,readFinMessage,normalizeForm,newUetr} from './fin-message.mjs';

// Screen 1 of the FinTerminal (fin-terminal.mjs), the "FIN - ISO 20022 Composer" of the bank owner's specification: the form
// and its XML kept in step both ways (fin-message.mjs), the XML checked against the official schemas on the server
// (src/fin-terminal.mjs), the UETR made here and refused there when another payment or draft has it, and drafts.
const PAUSE=300;
const whole=form=>Object.fromEntries(FIELDS.map(field=>[field,typeof form?.[field]==='string'?form[field]:'']));
// The accounts a message is booked against (step 3 of the specification's job): the Common or Suspense account, the NOSTRO
// account and the "+" wallet for the converted tokens. Chosen, an account writes what the message says of it; nothing is booked.
const CHOICES=['bookingAccountId','nostroAccountId','tokenWalletId'];
const noChoice=()=>Object.fromEntries(CHOICES.map(name=>[name,'']));
const same=(one,two)=>{const a=normalizeForm(one),b=normalizeForm(two);return FIELDS.every(field=>a[field]===b[field]);};

export function createFinComposer({root=document,request,view=root.defaultView||globalThis}){
 const screen=root.querySelector('[data-fin-composer]');if(!screen)return null;
 const $=selector=>screen.querySelector(selector),inputs=[...screen.querySelectorAll('[data-fin-field]')];
 const xml=$('[data-fin-xml]'),verdict=$('[data-fin-xsd]'),problems=$('[data-fin-errors]'),state=$('[data-fin-draft-state]'),list=$('[data-fin-drafts]');
 const controls=[...screen.querySelectorAll('.fin-actions button,.fin-actions select,[data-fin-new-uetr]')],choices=[...screen.querySelectorAll('[data-fin-choice]')];
 let form=blankForm(),draft=null,dirty=false,edits=0,broken=null,pause=null,busy=false,refused=null,selection=noChoice();
 let accounts={bookingAccounts:[],nostroAccounts:[],tokenWallets:[]};

 // A choice the XML holds that the list does not offer is shown as a choice of its own: the form shows what the XML says.
 function choose(select,value){
  for(const extra of select.querySelectorAll('[data-fin-extra]'))extra.remove();
  if(![...select.options].some(option=>option.value===value)){const extra=root.createElement('option');extra.value=value;extra.textContent=value||'—';extra.dataset.finExtra='';select.append(extra);}
  select.value=value;
 }
 function paint(){for(const input of inputs){const value=form[input.dataset.finField]??'';if(input.tagName==='SELECT')choose(input,value);else if(input.value!==value)input.value=value;}}
 const write=()=>{xml.value=buildFinMessage(form);};
 const label=input=>input.getAttribute('aria-label')||input.closest('label')?.querySelector('span')?.textContent||input.dataset.finField;
 // The check's findings under the XML, a field's own with that field's name, and the fields they name marked where they are.
 function show(kind,text,errors=[],field=null){
  verdict.dataset.state=kind;verdict.textContent=text;
  const named=new Set(field?[field]:[]);
  problems.replaceChildren(...errors.map(error=>{
   const name=/^([A-Za-z]+): /.exec(error)?.[1],input=inputs.find(input=>input.dataset.finField===name);if(input)named.add(name);
   const item=root.createElement('li');item.textContent=input?label(input)+error.slice(name.length):error;return item;
  }));
  problems.hidden=!errors.length;
  for(const input of inputs)if(named.has(input.dataset.finField))input.setAttribute('aria-invalid','true');else input.removeAttribute('aria-invalid');
 }
 function paintState(){
  state.textContent=draft?(dirty?'Draft · changes not saved':'Draft saved · revision '+draft.revision):(dirty?'New message · not saved':'New message');
  list.value=draft?.draftId||'';
 }
 function changed(){edits++;dirty=true;refused=null;show('unchecked','XSD: not checked');paintState();}

 // The Common and Suspense accounts and the NOSTRO accounts in the message's currency; the "+" wallets, never AG or AGi
 // (the server lists them so). A choice a draft keeps that the lists no longer hold is shown as not available.
 const option=(value,text,enabled=true)=>{const item=root.createElement('option');item.value=value;item.textContent=text;item.disabled=!enabled;return item;};
 function paintChoices(){
  const currency=normalizeForm(form).currency,lists={
   bookingAccountId:accounts.bookingAccounts.filter(account=>account.currency===currency).map(account=>[account.accountId,[account.label,account.iban,account.currency].join(' · ')]),
   nostroAccountId:accounts.nostroAccounts.filter(account=>account.currency===currency).map(account=>[account.accountId,[account.institution,account.account,account.currency].join(' · ')+(account.active?'':' · inactive'),account.active]),
   tokenWalletId:accounts.tokenWallets.map(wallet=>[wallet.accountId,[wallet.holder,wallet.currency,wallet.network].join(' · ')])};
  for(const select of choices){
   const name=select.dataset.finChoice,items=lists[name];
   select.replaceChildren(option('','—'),...items.map(([value,text,enabled])=>option(value,text,enabled!==false)));
   if(selection[name]&&!items.some(([value])=>value===selection[name]))select.append(option(selection[name],'Not available'));
   select.value=selection[name];
  }
 }
 // A chosen account writes the message's fields it stands for: the Common or Suspense account is the debtor's account at the
 // bank; the NOSTRO account is the receiver's bank and the account the transfer settles through there (INDA, SttlmAcct).
 const fills={
  bookingAccountId:id=>{const account=accounts.bookingAccounts.find(item=>item.accountId===id);return account&&{debtorName:account.institution,debtorIban:account.iban,debtorAgentBic:account.bic};},
  nostroAccountId:id=>{const account=accounts.nostroAccounts.find(item=>item.accountId===id);return account&&{...(account.bic?{receiverBic:account.bic}:{}),settlement:'INDA',settlementAccount:account.account};},
  tokenWalletId:()=>null};
 for(const select of choices)select.addEventListener('change',()=>{
  const name=select.dataset.finChoice;if(selection[name]===select.value)return;
  selection={...selection,[name]:select.value};
  const fill=select.value&&fills[name](select.value);
  if(fill){form={...form,...fill};paint();broken=null;write();}
  changed();
 });
 // Another currency leaves the accounts chosen in the former one.
 function currencyChanged(before){
  if(normalizeForm(form).currency===normalizeForm(before).currency)return;
  selection={...selection,bookingAccountId:'',nostroAccountId:''};paintChoices();
 }
 // The form writes the XML.
 const take=event=>{
  const field=event.target?.dataset?.finField;if(!field||form[field]===event.target.value)return;
  if(event.target.tagName==='SELECT')choose(event.target,event.target.value);
  const before=form;form={...form,[field]:event.target.value};broken=null;write();currencyChanged(before);changed();
 };
 const sheet=$('[data-fin-form]');
 sheet.addEventListener('input',take);sheet.addEventListener('change',take);sheet.addEventListener('submit',event=>event.preventDefault());
 // The XML writes the form, a moment after the last key; XML that does not read leaves the form as it is and says why.
 function read(){
  view.clearTimeout(pause);pause=null;
  const result=readFinMessage(xml.value,view.DOMParser);
  if(!result.error&&result.form.messageType!==PACS008)result.error='The message type is '+PACS008+'.';
  if(result.error){broken=result.error;show('broken','XML: '+result.error);return;}
  broken=null;
  if(same(result.form,form)){if(verdict.dataset.state==='broken')show('unchecked','XSD: not checked');return;}
  const before=form;form=result.form;paint();currencyChanged(before);changed();
 }
 const flush=()=>{if(pause!==null)read();};
 xml.addEventListener('input',()=>{view.clearTimeout(pause);pause=view.setTimeout(read,PAUSE);});
 // Leaving the XML sets it out again as the form gives it.
 xml.addEventListener('blur',()=>{flush();if(!broken)write();});

 const when=iso=>{const date=new Date(iso);return Number.isNaN(date.getTime())?'':date.toLocaleString(undefined,{dateStyle:'short',timeStyle:'short'});};
 const choice=(value,text)=>{const option=root.createElement('option');option.value=value;option.textContent=text;return option;};
 async function listDrafts(){
  let rows;try{rows=(await request('GET','/api/fin-terminal/drafts'))?.rows;}catch{return;}
  if(!Array.isArray(rows))rows=[];
  list.replaceChildren(choice('','New message'),...rows.map(row=>choice(row.draftId,[row.schemaValid?'XSD ✓':'XSD ✗','·',row.amount||'—',row.currency,'·',row.creditorName||'—','·',when(row.updatedAt)].join(' '))));
  list.value=draft?.draftId||'';
 }
 // One action at a time; a refusal is shown with its reason and its field.
 async function act(work){
  if(busy)return false;busy=true;for(const control of controls)control.disabled=true;
  try{return await work();}
  catch(error){
   show('error',error?.message||'This action could not be completed.',[],error?.field);
   if(['FIN_DRAFT_CHANGED','FIN_DRAFT_NOT_FOUND'].includes(error?.code))void listDrafts();
   return false;
  }
  finally{busy=false;for(const control of controls)control.disabled=false;}
 }
 async function check(){
  flush();const at=edits;
  const result=await request('POST','/api/fin-terminal/validate',{form,xml:xml.value,...(draft?{draftId:draft.draftId}:{})});
  // Changed while it was checked, the message shown is not the one checked: its verdict is not shown (review finding).
  if(edits!==at)return;
  show(result.valid?'passed':'failed',result.valid?'XSD: PASSED':'XSD: FAILED',Array.isArray(result.errors)?result.errors:[]);
 }
 // A draft keeps the form; saved again it carries the revision it was opened at. What is written while it saves stays.
 async function save(){
  flush();
  if(broken)throw Object.assign(new Error('XML: '+broken),{code:'FIN_MESSAGE_INVALID'});
  const at=edits,{draft:saved}=await request('POST','/api/fin-terminal/drafts',{form,selection,...(draft?{draftId:draft.draftId,revision:draft.revision}:{})});
  draft={draftId:saved.draftId,revision:saved.revision};
  if(edits===at){form=whole(saved.form);selection=chosen(saved.selection);dirty=false;paint();paintChoices();xml.value=saved.xml;}
  await listDrafts();paintState();
  return saved;
 }
 const chosen=kept=>Object.fromEntries(CHOICES.map(name=>[name,typeof kept?.[name]==='string'?kept[name]:'']));
 function start(){form=blankForm(new Date());selection=noChoice();draft=null;dirty=false;broken=null;refused=null;paint();paintChoices();write();show('unchecked','XSD: not checked');paintState();}
 async function open(draftId){
  const {draft:loaded}=await request('GET','/api/fin-terminal/drafts/'+encodeURIComponent(draftId));
  form=whole(loaded.form);selection=chosen(loaded.selection);draft={draftId:loaded.draftId,revision:loaded.revision};dirty=false;broken=null;refused=null;
  paint();paintChoices();xml.value=loaded.xml;paintState();await check();
 }
 async function listAccounts(){
  let listed;try{listed=(await request('GET','/api/fin-terminal/accounts'))?.accounts;}catch{return;}
  accounts={bookingAccounts:[],nostroAccounts:[],tokenWallets:[],...Object.fromEntries(Object.entries(listed||{}).filter(([,rows])=>Array.isArray(rows)))};
  paintChoices();
 }
 // Another message replaces this one only once this one is kept: it is saved as a draft first. Refused, it stays with the
 // reason shown; asked for the same again without a change in between, the other message is opened as asked.
 async function go(target){
  if(dirty&&refused!==target){try{await save();}catch(error){refused=target;throw error;}}
  if(target)await open(target);else start();
 }
 list.addEventListener('change',()=>{const target=list.value;list.value=draft?.draftId||'';void act(()=>go(target));});
 $('[data-fin-new]').addEventListener('click',()=>void act(()=>go('')));
 $('[data-fin-new-uetr]').addEventListener('click',()=>{form={...form,uetr:newUetr()};paint();broken=null;write();changed();});
 $('[data-fin-save]').addEventListener('click',()=>void act(async()=>{await save();await check();}));
 $('[data-fin-validate]').addEventListener('click',()=>void act(check));

 return {start(){start();void listDrafts();void listAccounts();},listDrafts};
}
