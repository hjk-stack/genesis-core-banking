import {FIN_TERMINAL_CHANNEL} from './fin-terminal-switch.mjs';
import {createFinComposer} from './fin-composer.mjs';
import {createFinPeer} from './fin-peer.mjs';
import {createFinSettlement} from './fin-settlement.mjs';
import {createFinConverter} from './fin-converter.mjs';

// The FinTerminal window opened by its switch on the Payments page (fin-terminal-switch.mjs). It shares the bank's sign-in
// and shows itself to a signed-in bank administrator only; its address opened by anyone else stays empty.
export async function administratorSession(fetcher=fetch){
 try{const response=await fetcher('/api/session',{credentials:'same-origin',cache:'no-store'});if(!response.ok)return null;const session=await response.json();return session?.admin===true?session:null;}
 catch{return null;}
}
export const administrator=async(fetcher=fetch)=>(await administratorSession(fetcher))!==null;

export async function startFinTerminal({root=document,fetcher=fetch,windowApi=root.defaultView}={}){
 const terminal=root.querySelector('[data-fin-terminal]'),tabs=[...root.querySelectorAll('[data-fin-screen-tab]')];
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
 // from any of its pages) and whenever the terminal comes forward; a terminal whose administrator sign-in has ended closes.
 let checks=0,shown=false,csrf='',composer=null,peer=null,settlement=null;
 async function check(){
  const serial=++checks,session=await administratorSession(fetcher);if(serial!==checks)return;
  terminal.hidden=!session;csrf=session?.csrf||'';
  if(session){
   shown=true;
   if(!composer){composer=createFinComposer({root,request});composer?.start();peer=createFinPeer({root,request});void peer?.start();settlement=createFinSettlement({root,request});settlement?.start();createFinConverter({root,request})?.start();}
   return;
  }
  // Closed once: the terminal's other requests that find the sign-in ended do not close it again.
  if(shown){shown=false;try{windowApi.close();}catch{}}
 }
 // The terminal's own requests go with the bank's sign-in and, to change anything, its CSRF token; a sign-in that ended
 // is found out at once.
 async function request(method,path,body){
  const response=await fetcher(path,{method,credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)})});
  const data=await response.json().catch(()=>({}));
  if(response.ok)return data;
  if([401,403].includes(response.status))void check();
  throw Object.assign(new Error(data?.message||'This action could not be completed.'),{code:data?.code,field:data?.field,status:response.status});
 }
 try{const channel=new windowApi.BroadcastChannel(FIN_TERMINAL_CHANNEL);channel.onmessage=({data})=>{if(data?.type==='session-changed')void check();};}catch{}
 windowApi.addEventListener('focus',()=>void check());
 await check();
 return {show,check,request};
}

if(typeof document!=='undefined'&&document.querySelector('[data-fin-terminal]'))void startFinTerminal();
