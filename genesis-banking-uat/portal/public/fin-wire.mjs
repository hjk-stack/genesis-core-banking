import {paintPeerChoice,streamLine} from './fin-peer.mjs';
import {newUetr} from './fin-message.mjs';

// Screen B's Cash Wire (NOSTRO) in the FinTerminal (fin-terminal.mjs), the specification v3's IP transfer with "Execute & Dispatch":
// the amount in euros from AVISPay PLC's account to the beneficiary's name and account (an IBAN or any other account number), through
// a peer server the bank registered (Administration, "Add bank connector": IP-to-IP, API or ISO 20022), settled on the bank's NOSTRO
// there (src/fin-peer.mjs).
// While 4-Eyes is on, PIN 1 and PIN 2 go with it. The pacs.008 sent and the peer's pacs.002 answer show under it as the stream
// writes them.
export function createFinWire({root=document,request,onDispatched=()=>{},onRefused=()=>{}}){
 const panel=root.querySelector('[data-fin-wire]');if(!panel)return null;
 const $=selector=>panel.querySelector(selector);
 const peerChoice=$('[data-fin-wire-peer]'),accountChoice=$('[data-fin-wire-account]'),amount=$('[data-fin-wire-amount]'),name=$('[data-fin-wire-name]'),iban=$('[data-fin-wire-iban]');
 const pinBox=$('[data-fin-wire-pins]'),pins=[...panel.querySelectorAll('[data-fin-wire-pin]')],button=$('[data-fin-wire-send]'),problem=$('[data-fin-wire-problem]'),stream=$('[data-fin-wire-stream]');
 const fields={profileId:peerChoice,bookingAccountId:accountChoice,amount,creditorName:name,creditorIban:iban,pin1:pins[0],pin2:pins[1]};
 // The wire's UETR, made here: Execute sent twice - a click again before the answer came - is one wire (the server refuses the UETR again).
 let peers=[],accounts=[],fourEyes=false,busy=false,uetr=newUetr();
 const option=(value,text)=>{const item=root.createElement('option');item.value=value;item.textContent=text;return item;};
 const euro=()=>accounts.filter(account=>account.currency==='EUR');
 function say(text,field){
  problem.textContent=text||'';problem.hidden=!text;
  for(const [key,input] of Object.entries(fields))if(key===field)input.setAttribute('aria-invalid','true');else input.removeAttribute('aria-invalid');
 }
 function paint(){
  const account=accountChoice.value,own=euro();
  paintPeerChoice(peerChoice,peers,item=>[item.name,item.peerBic,item.currency].filter(Boolean).join(' · '));
  accountChoice.replaceChildren(...(own.length?own.map(item=>option(item.accountId,[item.label,item.iban,item.currency].filter(Boolean).join(' · '))):[option('','No EUR account')]));
  if(own.some(item=>item.accountId===account))accountChoice.value=account;
  accountChoice.disabled=!own.length;pinBox.hidden=!fourEyes;
  button.disabled=busy||!peers.length||!own.length;
 }
 // The 4-Eyes switch and the PINs' holders as the access panel reads them (fin-access.mjs).
 function access(state){
  fourEyes=state?.fourEyes?.on===true;
  for(const [index,input] of pins.entries()){const holder=state?.pins?.[index]?.holder;input.placeholder='PIN '+(index+1)+(holder?' · '+holder:'');}
  paint();
 }
 function show(messages){
  stream.replaceChildren(...messages.map(message=>{const item=root.createElement('li');item.dataset.direction=String(message.direction).toLowerCase();
   item.dataset.status=String(message.status).toLowerCase();item.textContent=streamLine(message);return item;}));
  stream.hidden=!messages.length;
 }
 async function dispatch(){
  if(busy||button.disabled)return;
  const profileId=peerChoice.value,body={uetr,bookingAccountId:accountChoice.value,amount:amount.value,creditorName:name.value,creditorIban:iban.value,
   ...(fourEyes?{pin1:pins[0].value,pin2:pins[1].value}:{})};
  // The PINs leave the page at once: never kept in its fields.
  for(const input of pins)input.value='';
  busy=true;button.setAttribute('aria-busy','true');say('');paint();
  try{
   const result=await request('POST','/api/fin-terminal/peers/'+encodeURIComponent(profileId)+'/transfers',body);
   // Sent, the UETR is the wire's: the next Execute is another wire. What was written stays only when the money came back.
   uetr=newUetr();show(Array.isArray(result?.messages)?result.messages:[]);
   if(result?.wire?.status!=='RETURNED')for(const input of [amount,name,iban])input.value='';
   onDispatched(profileId,result);
  }catch(error){
   if(error?.code==='FIN_UETR_DUPLICATE')uetr=newUetr();
   say(error?.message||'This action could not be completed.',error?.field);
   if(['FIN_PIN','FIN_PIN_MISSING'].includes(error?.code))onRefused();
  }finally{busy=false;button.removeAttribute('aria-busy');paint();}
 }
 button.addEventListener('click',()=>void dispatch());
 async function start(){
  const [listed,owned]=await Promise.all([request('GET','/api/fin-terminal/peers').catch(()=>null),request('GET','/api/fin-terminal/accounts').catch(()=>null)]);
  peers=Array.isArray(listed?.peers)?listed.peers:[];accounts=Array.isArray(owned?.accounts?.bookingAccounts)?owned.accounts.bookingAccounts:[];
  paint();
 }
 return {start,access};
}
