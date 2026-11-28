import {FIELDS,PACS008,COUNTRIES,REPORTING_CODES,blankForm,buildFinMessage,readFinMessage,normalizeForm,newUetr} from './fin-message.mjs';

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

// onTransacted: a message transacted shows at once in the ledgers and in the Peer Server's stream (fin-terminal.mjs).
export function createFinComposer({root=document,request,view=root.defaultView||globalThis,onTransacted=()=>{},onRefused=()=>{}}){
 const screen=root.querySelector('[data-fin-composer]');if(!screen)return null;
 const $=selector=>screen.querySelector(selector),inputs=[...screen.querySelectorAll('[data-fin-field]')];
 const xml=$('[data-fin-xml]'),verdict=$('[data-fin-xsd]'),problems=$('[data-fin-errors]'),state=$('[data-fin-draft-state]'),list=$('[data-fin-drafts]');
 const controls=[...screen.querySelectorAll('.fin-actions button,.fin-actions select,[data-fin-new-uetr]')],choices=[...screen.querySelectorAll('[data-fin-choice]')];
 const turn=$('[data-fin-direction]'),register=$('[data-fin-register]'),keep=$('[data-fin-save]');
 const transact=$('[data-fin-transact]'),pinBox=$('[data-fin-transact-pins]'),pins=[...screen.querySelectorAll('[data-fin-transact-pin]')];
 let form=blankForm(),draft=null,dirty=false,edits=0,broken=null,pause=null,busy=false,refused=null,selection=noChoice();
 // The bank owner: "We now register an incoming transfer so AVISPay PLC is the receiver".
 let direction='OUTGOING',registered=false,converted=null;
 // Transact (the bank owner: "When the transaction is filled, then add a button for press Transact for the transaction executed"):
 // the message as it passed Validate XML (passed, its edit), the Peer Server chosen above it, 4-Eyes, and what became of it.
 let passed=-1,peer=null,fourEyes=false,transacted=null;
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
  state.textContent=registered?(direction==='OUTGOING'?'Transacted · '+(transacted||'SENDING'):converted?'Incoming converted · ACSC · '+converted.quantity+' '+converted.asset:'Incoming booked · ACSC'):
   draft?(dirty?'Draft · changes not saved':'Draft saved · revision '+draft.revision):(dirty?'New message · not saved':'New message');
  list.value=draft?.draftId||'';
 }
 // Transact works an outgoing message that passed Validate XML as it stands, with its Common or Suspense account and its NOSTRO
 // chosen, to a Peer Server chosen; PIN 1 and PIN 2 while 4-Eyes is on.
 function paintTransact(){
  transact.hidden=direction!=='OUTGOING'||registered;pinBox.hidden=transact.hidden||!fourEyes;
  transact.disabled=busy||transact.hidden||passed!==edits||!!broken||!selection.bookingAccountId||!selection.nostroAccountId||!peer;
 }
 // Registered, an incoming transfer is not saved or registered again; transacted, an outgoing message is not saved or sent again.
 function paintDirection(){turn.value=direction;turn.disabled=registered;register.hidden=direction!=='INCOMING'||registered;keep.hidden=registered;paintTransact();}
 function changed(){edits++;dirty=true;refused=null;show('unchecked','XSD: not checked');paintState();paintTransact();}

 // The Common and Suspense accounts and the NOSTRO accounts in the message's currency; the "+" wallets, never AG or AGi
 // (the server lists them so). A choice a draft keeps that the lists no longer hold is shown as not available.
 const option=(value,text,enabled=true)=>{const item=root.createElement('option');item.value=value;item.textContent=text;item.disabled=!enabled;return item;};
 // The Authority Country's country and reporting code are chosen from their lists (fin-message.mjs), each with its name; a code
 // the XML holds that the lists do not offer is shown as a choice of its own (choose).
 const regions=(()=>{try{return new Intl.DisplayNames(['en'],{type:'region'});}catch{return null;}})();
 const named=(code,name)=>name&&name!==code?code+' · '+name:code;
 for(const [field,items] of [['regulatoryCountry',COUNTRIES.map(code=>[code,regions?.of(code)])],['regulatoryCode',REPORTING_CODES]])
  $('[data-fin-field="'+field+'"]')?.replaceChildren(option('','—'),...items.map(([code,name])=>option(code,named(code,name))));
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
 // A chosen account writes the message's fields it stands for. Outgoing, the Common or Suspense account is the debtor's account
 // at the bank and the NOSTRO account is the receiver's bank and the account the transfer settles through there (INDA, SttlmAcct).
 // Incoming, the Common or Suspense account is the creditor's, AVISPay PLC's, and its bank the receiver; the NOSTRO account is
 // the sender's bank, where the money arrives (INGA, SttlmAcct).
 const fills={
  bookingAccountId:id=>{const account=accounts.bookingAccounts.find(item=>item.accountId===id);return account&&(direction==='INCOMING'
   ?{creditorName:account.institution,creditorIban:account.iban,creditorAgentBic:account.bic,receiverBic:account.bic}
   :{debtorName:account.institution,debtorIban:account.iban,debtorAgentBic:account.bic});},
  nostroAccountId:id=>{const account=accounts.nostroAccounts.find(item=>item.accountId===id);return account&&(direction==='INCOMING'
   ?{...(account.bic?{senderBic:account.bic}:{}),settlement:'INGA',settlementAccount:account.account}
   :{...(account.bic?{receiverBic:account.bic}:{}),settlement:'INDA',settlementAccount:account.account});},
  tokenWalletId:()=>null};
 // The fields that name a chosen account: written otherwise, the message no longer goes with that account (review finding).
 const binds={OUTGOING:{bookingAccountId:['debtorIban','debtorAgentBic'],nostroAccountId:['receiverBic','settlement','settlementAccount']},
  INCOMING:{bookingAccountId:['creditorIban','creditorAgentBic','receiverBic'],nostroAccountId:['senderBic','settlement','settlementAccount']}};
 // The fields a chosen account wrote that are let go with it: all but the settlement method.
 const wrote={OUTGOING:{bookingAccountId:['debtorName','debtorIban','debtorAgentBic'],nostroAccountId:['receiverBic','settlementAccount']},
  INCOMING:{bookingAccountId:['creditorName','creditorIban','creditorAgentBic','receiverBic'],nostroAccountId:['senderBic','settlementAccount']}};
 const bound=(name,now=normalizeForm(form))=>{
  const fill=selection[name]&&fills[name](selection[name]);if(!fill)return null;
  const filled=normalizeForm({...form,...fill});
  return binds[direction][name].filter(field=>field in fill).every(field=>filled[field]===now[field])?fill:false;
 };
 // The fields a chosen account wrote that still say so, emptied.
 const unwritten=(name,now)=>{
  const fill=bound(name,now),clear={};
  if(fill)for(const field of wrote[direction][name])if(field in fill&&normalizeForm({...form,...fill})[field]===now[field])clear[field]='';
  return clear;
 };
 // The settlement account is written by the NOSTRO account chosen only (the bank owner: "Nostro accounts are registered and must
 // select via the listed NOSTROS"): none chosen, what the former one wrote that still says so goes with it.
 for(const select of choices)select.addEventListener('change',()=>{
  const name=select.dataset.finChoice;if(selection[name]===select.value)return;
  const clear=name==='nostroAccountId'&&!select.value?unwritten(name,normalizeForm(form)):{};
  selection={...selection,[name]:select.value};
  const fill=select.value&&fills[name](select.value);
  if(fill||Object.keys(clear).length){form={...form,...clear,...fill};paint();broken=null;write();}
  changed();
 });
 // After the form changed: in another currency, the accounts chosen in the former one are let go, and the fields they wrote
 // that still say so are emptied (review finding); a chosen account whose fields were written otherwise is let go.
 function rebind(before){
  let clear={};const now=normalizeForm(form),was=JSON.stringify(selection),moved=now.currency!==normalizeForm(before).currency;
  if(moved)for(const name of ['bookingAccountId','nostroAccountId']){clear={...clear,...unwritten(name,now)};selection={...selection,[name]:''};}
  for(const name of Object.keys(binds[direction]))if(bound(name,now)===false)selection={...selection,[name]:''};
  // The settlement account is the chosen NOSTRO account's only (the bank owner: "must select via the listed NOSTROS"): one the XML
  // writes without it goes (review finding).
  if(!selection.nostroAccountId&&now.settlementAccount)clear={...clear,settlementAccount:''};
  if(Object.keys(clear).length){form={...form,...clear};paint();write();}
  if(moved||JSON.stringify(selection)!==was)paintChoices();
 }
 // Turned to the other direction, the chosen accounts go to the other side: what they wrote on the side they leave is emptied
 // where it still says so, and they write the side they take; one whose fields were written otherwise is let go.
 turn.addEventListener('change',()=>{
  const next=turn.value==='INCOMING'?'INCOMING':'OUTGOING';if(next===direction)return;
  const now=normalizeForm(form);let clear={};
  for(const name of ['bookingAccountId','nostroAccountId']){if(bound(name,now)===false)selection={...selection,[name]:''};else clear={...clear,...unwritten(name,now)};}
  direction=next;
  for(const name of ['bookingAccountId','nostroAccountId'])if(selection[name])clear={...clear,...fills[name](selection[name])};
  form={...form,...clear};broken=null;paint();paintChoices();write();paintDirection();changed();
 });
 // The form writes the XML.
 const take=event=>{
  const field=event.target?.dataset?.finField;if(!field||form[field]===event.target.value)return;
  if(event.target.tagName==='SELECT')choose(event.target,event.target.value);
  const before=form;form={...form,[field]:event.target.value};broken=null;write();rebind(before);changed();
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
  const before=form;form=result.form;paint();rebind(before);changed();
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
  // An incoming transfer is listed with its sender, an outgoing one with its creditor; a transacted one with what became of it.
  const incoming=row=>row.direction==='INCOMING';
  const status=row=>incoming(row)?['·',row.registered?(row.conversion?'Incoming converted':'Incoming booked'):'Incoming']:row.registered?['·','Transacted',...(row.transacted?[row.transacted]:[])]:[];
  list.replaceChildren(choice('','New message'),...rows.map(row=>choice(row.draftId,[row.schemaValid?'XSD ✓':'XSD ✗',...status(row),
   '·',row.amount||'—',row.currency,'·',(incoming(row)?row.debtorName:row.creditorName)||'—','·',when(row.updatedAt)].join(' '))));
  list.value=draft?.draftId||'';
 }
 // One action at a time; a refusal is shown with its reason and its field. The button pressed shows it is pressed until its action
 // is done (the bank owner: "all buttons must be interactive, showing that they are pressed").
 async function act(work,pressed=null){
  if(busy)return false;busy=true;for(const control of controls)control.disabled=true;pressed?.setAttribute('aria-busy','true');
  try{return await work();}
  catch(error){
   show('error',error?.message||'This action could not be completed.',[],error?.field);
   if(['FIN_DRAFT_CHANGED','FIN_DRAFT_NOT_FOUND'].includes(error?.code))void listDrafts();
   return false;
  }
  finally{busy=false;for(const control of controls)control.disabled=false;pressed?.removeAttribute('aria-busy');paintTransact();}
 }
 async function check(){
  flush();const at=edits;
  const result=await request('POST','/api/fin-terminal/validate',{form,xml:xml.value,...(draft?{draftId:draft.draftId}:{})});
  // Changed while it was checked, the message shown is not the one checked: its verdict is not shown (review finding).
  if(edits!==at)return;
  passed=result.valid?at:-1;
  show(result.valid?'passed':'failed',result.valid?'XSD: PASSED':'XSD: FAILED',Array.isArray(result.errors)?result.errors:[]);
 }
 // A draft keeps the form; saved again it carries the revision it was opened at. What is written while it saves stays.
 async function save(){
  flush();
  if(broken)throw Object.assign(new Error('XML: '+broken),{code:'FIN_MESSAGE_INVALID'});
  const at=edits,{draft:saved}=await request('POST','/api/fin-terminal/drafts',{form,selection,direction,...(draft?{draftId:draft.draftId,revision:draft.revision}:{})});
  draft={draftId:saved.draftId,revision:saved.revision};
  if(edits===at){form=whole(saved.form);selection=chosen(saved.selection);dirty=false;paint();paintChoices();xml.value=saved.xml;}
  await listDrafts();paintState();
  return saved;
 }
 // Registered, the incoming transfer is kept as the server has it; what was written meanwhile is shown, not kept.
 async function registerIncoming(){
  flush();
  if(broken)throw Object.assign(new Error('XML: '+broken),{code:'FIN_MESSAGE_INVALID'});
  const at=edits,{draft:kept}=await request('POST','/api/fin-terminal/incoming',{form,selection,...(draft?{draftId:draft.draftId,revision:draft.revision}:{})});
  draft={draftId:kept.draftId,revision:kept.revision};registered=kept.registered===true;converted=kept.conversion||null;
  if(edits===at){form=whole(kept.form);selection=chosen(kept.selection);dirty=false;paint();paintChoices();xml.value=kept.xml;show('passed','XSD: PASSED');}
  await listDrafts();paintState();paintDirection();
 }
 // Transacted, the message is kept as the bank has it and closed: what was written meanwhile is shown, not kept. Pressed again, it
 // is refused (the bank owner: "Multiple pressing are not generating duplicated a transaction"). The PINs leave the page at once.
 async function transactMessage(){
  flush();
  if(broken)throw Object.assign(new Error('XML: '+broken),{code:'FIN_MESSAGE_INVALID'});
  const body={form,selection,direction,...(draft?{draftId:draft.draftId,revision:draft.revision}:{}),...(fourEyes?{pin1:pins[0].value,pin2:pins[1].value}:{})};
  for(const input of pins)input.value='';
  const at=edits,to=peer;let result;
  try{result=await request('POST','/api/fin-terminal/peers/'+encodeURIComponent(to)+'/transact',body);}
  catch(error){if(['FIN_PIN','FIN_PIN_MISSING'].includes(error?.code))onRefused();throw error;}
  const kept=result.draft;draft={draftId:kept.draftId,revision:kept.revision};registered=kept.registered===true;transacted=kept.transacted||result.wire?.status||null;
  if(edits===at){form=whole(kept.form);selection=chosen(kept.selection);dirty=false;paint();paintChoices();xml.value=kept.xml;show('passed','XSD: PASSED');}
  await listDrafts();paintState();paintDirection();onTransacted(to,result);
 }
 const chosen=kept=>Object.fromEntries(CHOICES.map(name=>[name,typeof kept?.[name]==='string'?kept[name]:'']));
 function start(){
  form=blankForm(new Date());selection=noChoice();draft=null;dirty=false;broken=null;refused=null;direction='OUTGOING';registered=false;converted=null;
  passed=-1;transacted=null;paint();paintChoices();write();show('unchecked','XSD: not checked');paintState();paintDirection();
 }
 async function open(draftId){
  const {draft:loaded}=await request('GET','/api/fin-terminal/drafts/'+encodeURIComponent(draftId));
  form=whole(loaded.form);selection=chosen(loaded.selection);draft={draftId:loaded.draftId,revision:loaded.revision};dirty=false;broken=null;refused=null;
  direction=loaded.direction==='INCOMING'?'INCOMING':'OUTGOING';registered=loaded.registered===true;converted=loaded.conversion||null;
  passed=-1;transacted=loaded.transacted||null;paint();paintChoices();xml.value=loaded.xml;paintState();paintDirection();await check();
 }
 async function listAccounts(){
  let listed;try{listed=(await request('GET','/api/fin-terminal/accounts'))?.accounts;}catch{return;}
  accounts={bookingAccounts:[],nostroAccounts:[],tokenWallets:[],...Object.fromEntries(Object.entries(listed||{}).filter(([,rows])=>Array.isArray(rows)))};
  paintChoices();
 }
 // Another message replaces this one only once this one is kept: it is saved as a draft first - a registered incoming transfer
 // is kept already. Refused, it stays with the reason shown; asked for the same again without a change in between, the other
 // message is opened as asked.
 async function go(target){
  if(dirty&&!registered&&refused!==target){try{await save();}catch(error){refused=target;throw error;}}
  if(target)await open(target);else start();
 }
 list.addEventListener('change',()=>{const target=list.value;list.value=draft?.draftId||'';void act(()=>go(target));});
 const fresh=$('[data-fin-new]'),validate=$('[data-fin-validate]');
 fresh.addEventListener('click',()=>void act(()=>go(''),fresh));
 $('[data-fin-new-uetr]').addEventListener('click',()=>{form={...form,uetr:newUetr()};paint();broken=null;write();changed();});
 keep.addEventListener('click',()=>void act(async()=>{await save();await check();},keep));
 validate.addEventListener('click',()=>void act(check,validate));
 register.addEventListener('click',()=>void act(registerIncoming,register));
 transact.addEventListener('click',()=>{if(!transact.disabled)void act(transactMessage,transact);});

 return {start(){start();void listDrafts();void listAccounts();},listDrafts,
  // The Peer Server chosen above the composer (fin-peer.mjs), and the 4-Eyes switch with the PINs' holders (fin-access.mjs).
  peer(chosen){peer=chosen?.profileId||null;paintTransact();},
  access(state){
   fourEyes=state?.fourEyes?.on===true;
   for(const [index,input] of pins.entries()){const holder=state?.pins?.[index]?.holder;input.placeholder='PIN '+(index+1)+(holder?' · '+holder:'');}
   paintTransact();
  }};
}
