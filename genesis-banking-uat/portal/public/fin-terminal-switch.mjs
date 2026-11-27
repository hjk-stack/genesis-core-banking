// Requested by the bank owner with the FinTerminal ISO 20022 specification: "That must be a further SWITCH to be opened in
// the payments in sovereign admin". Its own section under the Manual IP-Handler, the same switch; the terminal is a window of
// this bank (/fin-terminal) sharing its sign-in.
export const FIN_TERMINAL_PATH='/fin-terminal';
export const FIN_TERMINAL_WINDOW='avis-fin-terminal';
export const FIN_TERMINAL_CHANNEL='avis-fin-terminal-session';

export function finTerminalControls(){
 return '<section class="panel ip-admin-controls fin-terminal-controls" data-fin-terminal-controls aria-label="FinTerminal administrator controls">'+
  '<div class="ip-admin-management"><div class="ip-admin-control-title"><h2>FinTerminal ISO 20022</h2><div class="ip-admin-switch-state">'+
  '<button type="button" class="pos-liquid-switch ip-liquid-slider" role="switch" aria-label="FinTerminal ISO 20022" aria-checked="false" data-fin-terminal-switch data-state="CLOSED"><span class="pos-liquid-knob" aria-hidden="true"></span></button></div></div>'+
  '<p class="form-error" role="alert" data-fin-terminal-error></p></div></section>';
}

// A window of its own at two thirds of the screen, centred on it - never maximised and never exactly over the bank's page.
export function finTerminalWindowFeatures(screen={}){
 const wide=screen.availWidth||1440,high=screen.availHeight||900,width=Math.round(wide*2/3),height=Math.round(high*2/3);
 return 'popup=yes,width='+width+',height='+height+',left='+Math.round((screen.availLeft||0)+(wide-width)/2)+',top='+Math.round((screen.availTop||0)+(high-height)/2);
}

export function createFinTerminalSwitch({root=document,windowApi=root.defaultView}={}){
 let panel=null,terminal=null,timer=null;
 const isOpen=()=>{try{return !!terminal&&!terminal.closed;}catch{return false;}};
 const error=message=>{const slot=panel?.querySelector('[data-fin-terminal-error]');if(slot)slot.textContent=message;};
 function paint(){
  const button=panel?.isConnected?panel.querySelector('[data-fin-terminal-switch]'):null;if(!button)return;
  const state=isOpen()?'ACTIVE':'CLOSED';button.dataset.state=state;button.setAttribute('aria-checked',String(state==='ACTIVE'));
 }
 function stop(){if(timer!==null){windowApi.clearInterval(timer);timer=null;}}
 // The terminal closed with its own window button turns its switch off.
 function watch(){if(timer===null)timer=windowApi.setInterval(()=>{if(isOpen())return;stop();terminal=null;paint();},500);}
 function open(){
  error('');
  try{
   const child=windowApi.open('',FIN_TERMINAL_WINDOW,finTerminalWindowFeatures(windowApi.screen));
   if(!child)throw Error('Allow this page to open the FinTerminal window.');
   // A terminal already open - its switch lost with a reload of this page - comes forward as it is, never reloaded, so
   // nothing written in it is lost.
   let shown='';try{shown=child.location.pathname;}catch{}
   if(shown!==FIN_TERMINAL_PATH){try{child.sessionStorage?.setItem('avisFinTerminalAfterAdmission',FIN_TERMINAL_PATH);}catch{}child.location.replace(FIN_TERMINAL_PATH);}
   try{child.focus();}catch{}
   terminal=child;watch();
  }catch(reason){terminal=null;error(reason.message||'Could not open the FinTerminal window. Try again.');}
  paint();
 }
 function shut(){const child=terminal;terminal=null;stop();try{child?.close();}catch{}paint();}
 function bind(container=root){
  const next=container.matches?.('[data-fin-terminal-controls]')?container:container.querySelector?.('[data-fin-terminal-controls]');if(!next)return;
  panel=next;panel.querySelector('[data-fin-terminal-switch]').onclick=()=>isOpen()?shut():open();
  if(isOpen())watch();
  paint();
 }
 // Signing out or changing the workspace closes the terminal with the session it was opened in. A terminal this page lost
 // its handle on with a reload is told as well: it checks its sign-in again and closes once that has ended (Codex review
 // finding, P2).
 function announce(){try{const channel=new windowApi.BroadcastChannel(FIN_TERMINAL_CHANNEL);channel.postMessage({type:'session-changed'});channel.close();}catch{}}
 function close(){shut();error('');announce();}
 return {bind,close};
}
