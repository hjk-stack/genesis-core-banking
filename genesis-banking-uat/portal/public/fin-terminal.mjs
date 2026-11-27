// The FinTerminal window opened by its switch on the Payments page (fin-terminal-switch.mjs). It shares the bank's sign-in
// and shows itself to a signed-in bank administrator only; its address opened by anyone else stays empty.
export async function administrator(fetcher=fetch){
 try{const response=await fetcher('/api/session',{credentials:'same-origin',cache:'no-store'});if(!response.ok)return false;return (await response.json())?.admin===true;}
 catch{return false;}
}

export async function startFinTerminal({root=document,fetcher=fetch}={}){
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
 terminal.hidden=!(await administrator(fetcher));
 return {show};
}

if(typeof document!=='undefined'&&document.querySelector('[data-fin-terminal]'))void startFinTerminal();
