import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {checkoutIpAdminControls} from '../public/checkout-ip.mjs';
import {finTerminalControls,createFinTerminalSwitch,finTerminalWindowFeatures,FIN_TERMINAL_PATH,FIN_TERMINAL_WINDOW} from '../public/fin-terminal-switch.mjs';
import {startFinTerminal} from '../public/fin-terminal.mjs';
import {createBankServer} from '../server.mjs';

// Requested by the bank owner with the FinTerminal ISO 20022 specification: "That must be a further SWITCH to be opened in
// the payments in sovereign admin"; the design "Dark blue and orange is OK".
const screen={availWidth:1920,availHeight:1080,availLeft:0,availTop:0};
function harness({open}={}){
 const dom=new JSDOM('<!doctype html><body><div id="view">'+checkoutIpAdminControls()+finTerminalControls()+'</div></body>',{url:'https://bank.example/#payments'}),doc=dom.window.document;
 const windows=[],calls=[],timers=new Map();let sequence=0;
 const windowApi={screen,open:(...args)=>{
  calls.push(args);if(open)return open(...args);
  const child={closed:false,focused:0,navigations:[],location:{pathname:'blank',replace(url){child.navigations.push(url);child.location.pathname=new URL(url,'https://bank.example').pathname;}},focus(){child.focused++;},close(){child.closed=true;}};
  windows.push(child);return child;
 },setInterval:fn=>{timers.set(++sequence,fn);return sequence;},clearInterval:id=>timers.delete(id)};
 const controller=createFinTerminalSwitch({root:doc,windowApi});controller.bind(doc.querySelector('#view'));
 const button=()=>doc.querySelector('[data-fin-terminal-switch]'),poll=()=>{for(const fn of [...timers.values()])fn();};
 return {dom,doc,windows,calls,timers,controller,button,poll,close(){controller.close();dom.window.close();}};
}

test('the Payments page has the FinTerminal switch in a section of its own under the Manual IP-Handler, off',()=>{
 const h=harness();try{
  const ip=h.doc.querySelector('[data-ip-admin-controls]'),fin=h.doc.querySelector('[data-fin-terminal-controls]');
  assert.equal(ip.nextElementSibling,fin);assert.equal(ip.querySelectorAll('[role=switch]').length,1);assert.equal(fin.querySelectorAll('[role=switch]').length,1);
  assert.equal(fin.querySelector('h2').textContent,'FinTerminal ISO 20022');
  const button=h.button();assert.equal(button.getAttribute('aria-label'),'FinTerminal ISO 20022');assert.equal(button.getAttribute('aria-checked'),'false');assert.equal(button.dataset.state,'CLOSED');
  // The same liquid switch as the Manual IP-Handler's.
  assert.equal(button.className,h.doc.querySelector('[data-ip-admin-receiver]').className);
 }finally{h.close();}
});

test('the switch opens the terminal in a window of its own at two thirds of the screen, and closes it again',()=>{
 const h=harness();try{
  h.button().click();
  assert.deepEqual(h.calls[0],['',FIN_TERMINAL_WINDOW,'popup=yes,width=1280,height=720,left=320,top=180']);
  assert.deepEqual(h.windows[0].navigations,[FIN_TERMINAL_PATH]);assert.equal(h.windows[0].focused,1);
  assert.equal(h.button().dataset.state,'ACTIVE');assert.equal(h.button().getAttribute('aria-checked'),'true');assert.equal(h.timers.size,1);
  h.button().click();
  assert.equal(h.windows[0].closed,true);assert.equal(h.button().dataset.state,'CLOSED');assert.equal(h.timers.size,0);
 }finally{h.close();}
});

test('a terminal already open comes forward as it is, never reloaded',()=>{
 const open=[];
 const h=harness({open:()=>{const child={closed:false,focused:0,location:{pathname:FIN_TERMINAL_PATH,replace:()=>assert.fail('reloaded')},focus(){child.focused++;},close(){child.closed=true;}};open.push(child);return child;}});
 try{h.button().click();assert.equal(open[0].focused,1);assert.equal(h.button().dataset.state,'ACTIVE');}finally{h.close();}
});

test('the terminal closed with its own window button turns its switch off, and a re-drawn page shows it as it is',()=>{
 const h=harness();try{
  h.button().click();
  // The Payments page drawn again while the terminal is open.
  h.doc.querySelector('#view').innerHTML=checkoutIpAdminControls()+finTerminalControls();h.controller.bind(h.doc.querySelector('#view'));
  assert.equal(h.button().dataset.state,'ACTIVE');
  h.windows[0].closed=true;h.poll();
  assert.equal(h.button().dataset.state,'CLOSED');assert.equal(h.timers.size,0);
 }finally{h.close();}
});

test('a window the browser refused leaves the switch off, its error in its own place only',()=>{
 const h=harness({open:()=>null});try{
  h.button().click();
  assert.equal(h.button().dataset.state,'CLOSED');assert.match(h.doc.querySelector('[data-fin-terminal-error]').textContent,/Allow this page to open the FinTerminal window/);
  assert.equal(h.doc.querySelector('[data-ip-admin-receiver-error]').textContent,'');assert.equal(h.timers.size,0);
 }finally{h.close();}
});

test('signing out closes the terminal opened in that session',()=>{
 const h=harness();try{h.button().click();h.controller.close();assert.equal(h.windows[0].closed,true);assert.equal(h.button().dataset.state,'CLOSED');assert.equal(h.timers.size,0);}finally{h.close();}
});

test('the terminal window is never larger than two thirds of any screen',()=>{
 assert.equal(finTerminalWindowFeatures({availWidth:1440,availHeight:900,availLeft:100,availTop:25}),'popup=yes,width=960,height=600,left=340,top=175');
 assert.equal(finTerminalWindowFeatures(),'popup=yes,width=960,height=600,left=240,top=150');
});

// The bank's pages and its terminal talk over a channel of the browser's (Node's own here, let go after each test).
const channels=new Set();
class Channel extends BroadcastChannel{constructor(name){super(name);channels.add(this);}close(){channels.delete(this);super.close();}}
const letChannelsGo=()=>{for(const channel of [...channels])channel.close();};
const settle=()=>new Promise(resolve=>setTimeout(resolve,50));
async function terminalPage(session){
 const html=await readFile(new URL('../public/fin-terminal.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:'https://bank.example/fin-terminal'}),asked=[],state={session,closed:0};
 const fetcher=async(...args)=>{asked.push(args);return state.session===null?{ok:false,status:401,json:async()=>({})}:{ok:true,json:async()=>state.session};};
 const windowApi={BroadcastChannel:Channel,addEventListener:(...args)=>dom.window.addEventListener(...args),close(){state.closed++;}};
 const terminal=await startFinTerminal({root:dom.window.document,fetcher,windowApi});
 return {dom,doc:dom.window.document,asked,terminal,state,hidden:()=>dom.window.document.querySelector('[data-fin-terminal]').hidden,close(){letChannelsGo();dom.window.close();}};
}

test('the terminal shows itself to a signed-in bank administrator only',async()=>{
 for(const [session,shown] of [[{admin:true,username:'operator'},true],[{admin:false,username:'customer'},false],[null,false]]){
  const t=await terminalPage(session);try{
   assert.equal(t.asked[0][0],'/api/session');assert.equal(t.asked[0][1].credentials,'same-origin');
   assert.equal(t.hidden(),!shown);
   // Never shown: nothing to close.
   assert.equal(t.state.closed,0);
  }finally{t.close();}
 }
});

test('a terminal the bank page lost its handle on with a reload closes when the bank signs out (Codex review finding, P2)',async()=>{
 const t=await terminalPage({admin:true});try{
  // The bank page reloaded: a new switch with no handle on the open terminal.
  const page=new JSDOM('<!doctype html><body><div id="view">'+finTerminalControls()+'</div></body>',{url:'https://bank.example/#payments'});
  const controller=createFinTerminalSwitch({root:page.window.document,windowApi:{BroadcastChannel:Channel,screen,open:assert.fail,setInterval:assert.fail,clearInterval(){}}});
  controller.bind(page.window.document.querySelector('#view'));
  // Signed in again with the reload: the terminal checks and stays as it is.
  controller.close();await settle();
  assert.equal(t.hidden(),false);assert.equal(t.state.closed,0);
  // Signed out (the session ended first): the terminal closes.
  t.state.session=null;controller.close();await settle();
  assert.equal(t.hidden(),true);assert.equal(t.state.closed,1);
  page.window.close();
 }finally{t.close();}
});

test('a workspace changed to a customer, or a sign-in ended while the terminal was in the background, closes the terminal when it comes forward',async()=>{
 for(const session of [{admin:false,username:'customer workspace'},null]){
  const t=await terminalPage({admin:true});try{
   t.state.session=session;t.dom.window.dispatchEvent(new t.dom.window.Event('focus'));await settle();
   assert.equal(t.hidden(),true);assert.equal(t.state.closed,1);
  }finally{t.close();}
 }
});

test('the terminal has its two screens, the FIN composer first, chosen by a click or the arrow keys',async()=>{
 const t=await terminalPage({admin:true});try{
  const tabs=[...t.doc.querySelectorAll('[role=tab]')],screens=[...t.doc.querySelectorAll('[role=tabpanel]')];
  assert.deepEqual(tabs.map(tab=>tab.textContent),['1 · FIN – ISO 20022 Composer','2 · Interbank Direct IP-to-IP Composer']);
  assert.deepEqual(screens.map(screen=>screen.hidden),[false,true]);assert.deepEqual(tabs.map(tab=>tab.getAttribute('aria-selected')),['true','false']);
  tabs[1].click();assert.deepEqual(screens.map(screen=>screen.hidden),[true,false]);assert.deepEqual(tabs.map(tab=>tab.tabIndex),[-1,0]);
  tabs[1].dispatchEvent(new t.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.deepEqual(screens.map(screen=>screen.hidden),[false,true]);
  tabs[0].dispatchEvent(new t.dom.window.KeyboardEvent('keydown',{key:'End',bubbles:true}));assert.deepEqual(screens.map(screen=>screen.hidden),[true,false]);
  // Only what is real: no connection or peer is shown before the connector exists.
  assert.doesNotMatch(t.doc.body.textContent,/CONNECTED|mTLS|Peer IP|ACK/i);
 }finally{t.close();}
});

test('the bank serves the terminal window, its program and its style from its own address under its own policy',async()=>{
 const server=createBankServer({pool:{query:async()=>({rows:[]})},authenticate:async()=>null,secureCookies:false});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  for(const [path,type,file] of [['/fin-terminal','text/html','fin-terminal.html'],['/fin-terminal.mjs','text/javascript','fin-terminal.mjs'],['/fin-terminal.css','text/css','fin-terminal.css'],['/fin-terminal-switch.mjs','text/javascript','fin-terminal-switch.mjs']]){
   const response=await fetch(base+path);assert.equal(response.status,200,path);assert.match(response.headers.get('content-type'),new RegExp('^'+type),path);
   assert.match(response.headers.get('content-security-policy'),/script-src 'self'; style-src 'self'/);assert.match(response.headers.get('cache-control'),/no-store/);
   assert.equal(await response.text(),await readFile(new URL('../public/'+file,import.meta.url),'utf8'),path);
  }
  // Only its own page: nothing else of the folder is served under its name.
  assert.equal((await fetch(base+'/fin-terminal.html')).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
