import {FIN_TERMINAL_CHANNEL} from './fin-terminal-switch.mjs';

// The FinTerminal window opened by its switch on the Payments page (fin-terminal-switch.mjs). It shares the bank's sign-in
// and shows itself to a signed-in bank administrator only; its address opened by anyone else stays empty.
export async function administrator(fetcher=fetch){
 try{const response=await fetcher('/api/session',{credentials:'same-origin',cache:'no-store'});if(!response.ok)return false;return (await response.json())?.admin===true;}
 catch{return false;}
}

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
 let checks=0,shown=false;
 async function check(){
  const serial=++checks,admitted=await administrator(fetcher);if(serial!==checks)return;
  terminal.hidden=!admitted;
  if(admitted){shown=true;return;}
  if(shown)try{windowApi.close();}catch{}
 }
 try{const channel=new windowApi.BroadcastChannel(FIN_TERMINAL_CHANNEL);channel.onmessage=({data})=>{if(data?.type==='session-changed')void check();};}catch{}
 windowApi.addEventListener('focus',()=>void check());
 await check();
 return {show,check};
}

if(typeof document!=='undefined'&&document.querySelector('[data-fin-terminal]'))void startFinTerminal();
