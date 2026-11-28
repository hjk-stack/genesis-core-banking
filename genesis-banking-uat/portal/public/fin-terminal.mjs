import {FIN_TERMINAL_CHANNEL,FIN_TERMINAL_PATH,FIN_TERMINAL_RETURN} from './fin-terminal-switch.mjs';
import {createFinComposer} from './fin-composer.mjs';
import {createFinPeer} from './fin-peer.mjs';
import {createFinSettlement} from './fin-settlement.mjs';
import {createFinConverter} from './fin-converter.mjs';
import {createFinAccess} from './fin-access.mjs';
import {createFinWire} from './fin-wire.mjs';

// The FinTerminal window opened by its switch on the Payments page (fin-terminal-switch.mjs). It shares the bank's sign-in
// and shows itself only to a signed-in bank administrator the bank owner gave FinTerminal access (src/fin-access.mjs); its address
// opened by anyone else stays empty.
export async function administratorSession(fetcher=fetch){
 try{const response=await fetcher('/api/session',{credentials:'same-origin',cache:'no-store'});if(!response.ok)return null;const session=await response.json();return session?.admin===true&&session.finTerminal===true?session:null;}
 catch{return null;}
}
export const administrator=async(fetcher=fetch)=>(await administratorSession(fetcher))!==null;
// The sign-in as the bank answers it: the session; null once the bank says there is none for the terminal (401, 403, or no
// FinTerminal access); undefined when the bank was not reached - the terminal then stays as it is.
export async function signInOf(fetcher=fetch){
 let response;
 try{response=await fetcher('/api/session',{credentials:'same-origin',cache:'no-store'});}catch{return undefined;}
 if(!response.ok)return [401,403].includes(response.status)?null:undefined;
 try{const session=await response.json();return session?.admin===true&&session.finTerminal===true?session:null;}catch{return undefined;}
}

// inFront: whether the person is on this page - only that page starts the sign-in (check below).
export async function startFinTerminal({root=document,fetcher=fetch,windowApi=root.defaultView,inFront}={}){
 const terminal=root.querySelector('[data-fin-terminal]'),tabs=[...root.querySelectorAll('[data-fin-screen-tab]')];
 // Shown, and focused or touched a moment ago: an app's web view that never reports the focus still counts at a touch.
 let touched=0;const front=inFront||(()=>root.visibilityState!=='hidden'&&(root.hasFocus()||Date.now()-touched<10000));
 const show=name=>{
  for(const tab of tabs){const on=tab.dataset.finScreenTab===name;tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1;}
  for(const screen of root.querySelectorAll('[data-fin-screen]'))screen.hidden=screen.dataset.finScreen!==name;
 };
 for(const tab of tabs){
  tab.onclick=()=>show(tab.dataset.finScreenTab);
  tab.onkeydown=event=>{
   const keys={ArrowLeft:-1,ArrowRight:1,Home:-tabs.length,End:tabs.length};if(!(event.key in keys))return;event.preventDefault();
   const at=Math.max(0,Math.min(tabs.length-1,event.key==='Home'?0:event.key==='End'?tabs.length-1:(tabs.indexOf(tab)+keys[event.key]+tabs.length)%tabs.length));
   show(tabs[at].dataset.finScreenTab);tabs[at].focus();
  };
 }
 // Its sign-in is checked again whenever the bank signs in, out or changes workspace (fin-terminal-switch.mjs announces it,
 // from any of its pages) and whenever the terminal comes forward.
 let checks=0,csrf='',composer=null,peer=null,settlement=null,wire=null,access=null,leaving=false,waiting=false;
 // Reported directly, with a picture of the dark terminal: "After I created the PIN the page took off and I could not restart".
 // A terminal without its sign-in never stays dark: the one the desk opened closes (the desk goes to the sign-in itself); any
 // other goes to the sign-in, the desk's page, and - unless it was signed out here - comes back once signed in again (app.mjs).
 function leave(back){
  leaving=true;terminal.hidden=true;
  if(back)try{windowApi.sessionStorage.setItem(FIN_TERMINAL_RETURN,FIN_TERMINAL_PATH);}catch{}
  try{if(windowApi.opener)windowApi.close();}catch{}
  windowApi.setTimeout(()=>{if(!windowApi.closed)windowApi.location.replace('/');},300);
 }
 async function check(){
  const serial=++checks,session=await signInOf(fetcher);if(serial!==checks||session===undefined||leaving)return;
  // A browser holds one sign-in under way at a time (its pending cookie, Codex review finding, P2): a terminal of its own
  // that is not in front stays as it is and goes when it comes forward; the one the desk opened just closes.
  waiting=!session&&!windowApi.opener&&!front();if(waiting)return;
  if(!session)return leave(true);
  terminal.hidden=false;csrf=session.csrf||'';
  // A wire dispatched, or a message transacted, shows at once in the ledgers and in Screen A's stream; the PINs of both follow the
  // 4-Eyes switch, and Transact goes to the Peer Server chosen above the composer.
  if(!composer){composer=createFinComposer({root,request,onTransacted:()=>{void settlement?.refresh();void peer?.look();},onRefused:()=>void access?.refresh()});composer?.start();
   peer=createFinPeer({root,request,onRegistered:peers=>wire?.setPeers(peers),onChosen:chosen=>composer?.peer(chosen)});void peer?.start();settlement=createFinSettlement({root,request});settlement?.start();createFinConverter({root,request})?.start();
   wire=createFinWire({root,request,onDispatched:()=>{void settlement?.refresh();void peer?.look();},onRefused:()=>void access?.refresh()});
   access=createFinAccess({root,request,onState:state=>{wire?.access(state);composer?.access(state);}});access?.start();void wire?.start();}
 }
 // Sign out by hand ("The bank must have login and log off operative"): the bank session and its sign-in end (server.mjs
 // /api/logout), every bank page of this browser is told, and this one leaves. Refused, it says so and stays.
 const out=root.querySelector('[data-fin-sign-out]');
 if(out)out.onclick=async()=>{
  if(out.disabled)return;out.disabled=true;out.setAttribute('aria-busy','true');
  try{
   const response=await fetcher('/api/logout',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json','x-csrf-token':csrf},body:'{}'});
   if(!response.ok)throw new Error();
  }catch{out.disabled=false;out.removeAttribute('aria-busy');out.textContent='Not signed out - try again';return;}
  try{const channel=new windowApi.BroadcastChannel(FIN_TERMINAL_CHANNEL);channel.postMessage({type:'signed-out'});channel.close();}catch{}
  leave(false);
 };
 // The terminal's own requests go with the bank's sign-in and, to change anything, its CSRF token; a sign-in that ended
 // is found out at once.
 async function request(method,path,body){
  const response=await fetcher(path,{method,credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)})});
  const data=await response.json().catch(()=>({}));
  if(response.ok)return data;
  if([401,403].includes(response.status))void check();
  throw Object.assign(new Error(data?.message||'This action could not be completed.'),{code:data?.code,field:data?.field,status:response.status});
 }
 try{const channel=new windowApi.BroadcastChannel(FIN_TERMINAL_CHANNEL);channel.onmessage=({data})=>{if(['session-changed','signed-out'].includes(data?.type))void check();};}catch{}
 windowApi.addEventListener('focus',()=>void check());root.addEventListener('visibilitychange',()=>void check());
 for(const type of ['pointerdown','keydown'])root.addEventListener(type,()=>{touched=Date.now();if(waiting)void check();},true);
 await check();
 return {show,check,request};
}

if(typeof document!=='undefined'&&document.querySelector('[data-fin-terminal]'))void startFinTerminal();
