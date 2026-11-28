// The FinTerminal's "Access & 4-Eyes" (src/fin-access.mjs): the administrators the bank owner authorised in avis.land's User access
// management, by name; the 4-Eyes checker's two PINs, each made here by the administrator holding it and shown with their name; and
// its switch, which only the owner works and which shows the owner's name. The bank owner: "4 Eyes is 2 pins ... the pin creation
// must be directly on the GUI for both PINs" and "Login se the GUI must sow my name on it".
const LOOK=30000;

// onState: the 4-Eyes switch and the PINs' holders for the Cash Wire's Execute & Dispatch (fin-wire.mjs), each time they are read.
export function createFinAccess({root=document,request,view=root.defaultView||globalThis,onState=()=>{}}){
 const section=root.querySelector('[data-fin-access]'),names=root.querySelector('[data-fin-access-names]'),fourEyes=root.querySelector('[data-fin-four-eyes]');
 const pins=root.querySelector('[data-fin-pins]'),pinsOpen=root.querySelector('[data-fin-pins-open]'),problem=root.querySelector('[data-fin-access-problem]');
 if(!section||!names||!fourEyes||!pins||!pinsOpen)return null;
 let busy=false;
 const make=(tag,text)=>{const node=root.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
 function pinInput(label,autocomplete,role){
  const input=make('input');input.type='password';input.inputMode='numeric';input.autocomplete=autocomplete;input.required=true;
  input.minLength=6;input.maxLength=12;input.pattern='[0-9]{6,12}';input.placeholder=label;input.setAttribute('aria-label',label);input.dataset[role]='';return input;
 }
 function pinForm(slot){
  const form=make('form');form.className='fin-pin';form.dataset.finPin=String(slot.slot);
  const holder=make('span',['PIN '+slot.slot,slot.holder||'—',slot.locked?'locked':''].filter(Boolean).join(' · '));holder.className='fin-pin-holder';
  const button=make('button',slot.holder?'Change PIN':'Create PIN');button.type='submit';button.disabled=slot.locked;
  form.append(holder,...(slot.holder?[pinInput('Current PIN '+slot.slot,'current-password','current')]:[]),
   pinInput((slot.holder?'New PIN ':'PIN ')+slot.slot,'new-password','pin'),button);
  return form;
 }
 function paint(data){
  if(!data||typeof data!=='object')return;
  const administrators=data.administrators||[],owner=administrators.find(person=>person.owner)?.name||'';
  names.textContent=[...administrators.filter(person=>person.owner),...administrators.filter(person=>!person.owner)].map(person=>person.name).join(' · ');
  const on=data.fourEyes?.on===true;
  fourEyes.dataset.state=on?'ON':'OFF';fourEyes.setAttribute('aria-pressed',String(on));
  fourEyes.textContent='4-EYES: '+(on?'ON':'OFF')+((data.fourEyes?.by||owner)?' · '+(data.fourEyes?.by||owner):'');
  fourEyes.disabled=data.you?.owner!==true;
  // A PIN being typed is not painted over.
  if(!busy&&!pins.contains(root.activeElement))pins.replaceChildren(...(data.pins||[]).map(pinForm));
  section.hidden=false;onState(data);
 }
 function say(text){if(problem){problem.textContent=text||'';problem.hidden=!text;}}
 async function refresh(){let data;try{data=await request('GET','/api/fin-terminal/access');}catch{return;}paint(data);}
 // The button pressed shows it is pressed until the bank answered (the bank owner: "all buttons must be interactive, showing that
 // they are pressed").
 function save(path,body,pressed){
  busy=true;say('');pressed?.setAttribute('aria-busy','true');
  return request('POST',path,body).then(data=>{busy=false;root.activeElement?.blur?.();paint(data);})
   .catch(error=>{busy=false;say(error?.message||'Not saved.');void refresh();}).finally(()=>pressed?.removeAttribute('aria-busy'));
 }
 pins.addEventListener('submit',event=>{
  const form=event.target.closest?.('form[data-fin-pin]');if(!form)return;event.preventDefault();
  const pin=form.querySelector('[data-pin]')?.value||'',current=form.querySelector('[data-current]')?.value;
  // The PINs leave the page at once: never kept in its fields.
  for(const input of form.querySelectorAll('input'))input.value='';
  void save('/api/fin-terminal/pins',{slot:Number(form.dataset.finPin),pin,...(current===undefined?{}:{currentPin:current})},form.querySelector('button'));
 });
 fourEyes.addEventListener('click',()=>{if(!fourEyes.disabled)void save('/api/fin-terminal/four-eyes',{on:fourEyes.dataset.state!=='ON'},fourEyes);});
 // The bank owner: "the header referencing PIN make it in a klap menu, with default closed" - the PINs fold out under their menu
 // only while it is open; the terminal always opens with it closed.
 pinsOpen.addEventListener('click',()=>{const open=pinsOpen.getAttribute('aria-expanded')!=='true';pinsOpen.setAttribute('aria-expanded',String(open));pins.hidden=!open;});
 return {start(){void refresh();view.setInterval(()=>void refresh(),LOOK);},refresh};
}
