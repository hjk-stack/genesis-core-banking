// The FinTerminal specification v3 (FinTerminal_Unified_NOSTRO_Crypto_System_v3), its top bar and Screen B's "Final Settlement
// Ledgers": the ROBOTIC STP / MANUAL INTERVENTION switch, the listening port's running time since it was opened, and each ledger
// - the core banking cash, the NOSTRO correspondents, the bank's own wallets on the chains - with its balance, read again
// every few seconds.
const POLL=5000;
const two=n=>String(n).padStart(2,'0');
export function uptime(seconds){const s=Math.max(0,Math.floor(seconds));return two(Math.floor(s/3600))+':'+two(Math.floor(s%3600/60))+':'+two(s%60);}
// A balance as its ledger keeps it (up to 18 decimals): money with two, a token with the places it has, up to eight.
export function balance(value,decimals=2){
 const [whole='0',fraction='']=String(value??'0').replace(/^-/,'').split('.'),negative=String(value).startsWith('-');
 const kept=decimals===2?fraction.padEnd(2,'0').slice(0,2):fraction.slice(0,8).replace(/0+$/,'');
 return (negative?'-':'')+whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(kept?'.'+kept:'');
}

export function createFinSettlement({root=document,request,view=root.defaultView||globalThis}){
 const stp=root.querySelector('[data-fin-stp]'),clock=root.querySelector('[data-fin-uptime]');if(!stp||!clock)return null;
 const lists=Object.fromEntries([...root.querySelectorAll('[data-fin-ledger]')].map(list=>[list.dataset.finLedger,list]));
 let robotic=false,since=null,skew=0,port=8443,busy=false,host='',failure=null;
 // The terminal's own address, read once: a window being closed has none any more.
 try{host=view.location?.hostname||'';}catch{}
 function paintStp(){stp.dataset.state=robotic?'ACTIVE':'LOCKED';stp.setAttribute('aria-pressed',String(robotic));stp.textContent=robotic?'ROBOTIC STP: ACTIVE':'MANUAL INTERVENTION: LOCKED';}
 // The running time counts on the server's clock, whatever this computer's says. A port opened that this server could not bind
 // says so, with why (review finding: it does not listen).
 function paintClock(){
  if(failure!==null){clock.dataset.state='FAILED';clock.textContent='○ Port '+port+' not listening'+(failure?' · '+failure:'');return;}
  if(since===null){clock.dataset.state='CLOSED';clock.textContent='○ Port '+port+' closed';return;}
  clock.dataset.state='LISTENING';clock.textContent='● AUTO-LISTENING: '+uptime((Date.now()+skew-since)/1000)+' · mTLS 1.3 · '+host+':'+port;
 }
 const row=(name,amount,unit)=>{const item=root.createElement('li'),label=root.createElement('span'),figure=root.createElement('strong');
  label.textContent=name;figure.textContent=amount+' '+unit;item.append(label,figure);return item;};
 function paintLedgers(ledgers={}){
  const rows={
   coreBanking:(ledgers.coreBanking||[]).map(account=>row([account.label,account.iban].filter(Boolean).join(' · '),balance(account.balance),account.currency)),
   nostro:(ledgers.nostro||[]).map(account=>row([account.institution,account.bic,account.account].filter(Boolean).join(' · ')+(account.active?'':' · inactive'),balance(account.balance),account.currency)),
   wallets:(ledgers.wallets||[]).map(wallet=>row(wallet.network,balance(wallet.balance,8),wallet.currency))};
  for(const [name,list] of Object.entries(lists))list.replaceChildren(...(rows[name]||[]));
 }
 async function refresh(){
  let data;try{data=await request('GET','/api/fin-terminal/telemetry');}catch{return;}
  robotic=data?.roboticStp===true;port=Number(data?.listener?.port)||port;
  const listener=data?.listener,open=listener?.open===true,listening=open&&listener.listening===true;
  since=listening&&listener.since?Date.parse(listener.since):null;failure=open&&!listening?String(listener.error||''):null;
  const server=Date.parse(data?.listener?.now);if(Number.isFinite(server))skew=server-Date.now();
  paintStp();paintClock();paintLedgers(data?.ledgers);
 }
 stp.addEventListener('click',()=>{
  if(busy)return;busy=true;
  request('POST','/api/fin-terminal/mode',{roboticStp:!robotic}).then(data=>{robotic=data?.roboticStp===true;paintStp();}).catch(()=>{}).finally(()=>{busy=false;});
 });
 paintStp();paintClock();
 return {start(){void refresh();view.setInterval(()=>void refresh(),POLL);view.setInterval(paintClock,1000);},refresh};
}
