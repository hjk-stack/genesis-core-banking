import {FIELDS,PACS008,blankForm,buildFinMessage,readFinMessage,normalizeForm,newUetr} from './fin-message.mjs';

// Screen 1 of the FinTerminal (fin-terminal.mjs), the "FIN - ISO 20022 Composer" of the bank owner's specification: the form
// and its XML kept in step both ways (fin-message.mjs), the XML checked against the official schemas on the server
// (src/fin-terminal.mjs), the UETR made here and refused there when another payment or draft has it, and drafts.
const PAUSE=300;
const whole=form=>Object.fromEntries(FIELDS.map(field=>[field,typeof form?.[field]==='string'?form[field]:'']));
const same=(one,two)=>{const a=normalizeForm(one),b=normalizeForm(two);return FIELDS.every(field=>a[field]===b[field]);};

export function createFinComposer({root=document,request,view=root.defaultView||globalThis}){
 const screen=root.querySelector('[data-fin-composer]');if(!screen)return null;
 const $=selector=>screen.querySelector(selector),inputs=[...screen.querySelectorAll('[data-fin-field]')];
 const xml=$('[data-fin-xml]'),verdict=$('[data-fin-xsd]'),problems=$('[data-fin-errors]'),state=$('[data-fin-draft-state]'),list=$('[data-fin-drafts]');
 const controls=[...screen.querySelectorAll('.fin-actions button,.fin-actions select,[data-fin-new-uetr]')];
 let form=blankForm(),draft=null,dirty=false,edits=0,broken=null,pause=null,busy=false,refused=null;

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

 // The form writes the XML.
 const take=event=>{
  const field=event.target?.dataset?.finField;if(!field||form[field]===event.target.value)return;
  if(event.target.tagName==='SELECT')choose(event.target,event.target.value);
  form={...form,[field]:event.target.value};broken=null;write();changed();
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
  form=result.form;paint();changed();
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
  flush();
  const result=await request('POST','/api/fin-terminal/validate',{form,xml:xml.value,...(draft?{draftId:draft.draftId}:{})});
  show(result.valid?'passed':'failed',result.valid?'XSD: PASSED':'XSD: FAILED',Array.isArray(result.errors)?result.errors:[]);
 }
 // A draft keeps the form; saved again it carries the revision it was opened at. What is written while it saves stays.
 async function save(){
  flush();
  if(broken)throw Object.assign(new Error('XML: '+broken),{code:'FIN_MESSAGE_INVALID'});
  const at=edits,{draft:saved}=await request('POST','/api/fin-terminal/drafts',{form,...(draft?{draftId:draft.draftId,revision:draft.revision}:{})});
  draft={draftId:saved.draftId,revision:saved.revision};
  if(edits===at){form=whole(saved.form);dirty=false;paint();xml.value=saved.xml;}
  await listDrafts();paintState();
  return saved;
 }
 function start(){form=blankForm(new Date());draft=null;dirty=false;broken=null;refused=null;paint();write();show('unchecked','XSD: not checked');paintState();}
 async function open(draftId){
  const {draft:loaded}=await request('GET','/api/fin-terminal/drafts/'+encodeURIComponent(draftId));
  form=whole(loaded.form);draft={draftId:loaded.draftId,revision:loaded.revision};dirty=false;broken=null;refused=null;
  paint();xml.value=loaded.xml;paintState();await check();
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

 return {start(){start();void listDrafts();},listDrafts};
}
