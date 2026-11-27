// Screen A's peer panel in the FinTerminal (fin-terminal.mjs), "Peer Server Handshake & Direct IP Interaction" of the bank owner's
// specification: the peer banks' servers the bank has an IP-to-IP connector to (Administration, "Add bank connector"), the welcome
// or session message sent to one (src/fin-peer.mjs) and the stream of what was sent and what the peer answered. Only a peer's own
// answer is shown as its answer; a peer that does not answer is not connected.
const EVENTS={INIT:'INIT_SESSION',HBT:'HEARTBEAT',END:'END_SESSION'};
const SENT={SENDING:'SENDING',DELIVERED:'SENT',FAILED:'NOT DELIVERED',UNCERTAIN:'NO RESULT'};
const LINKS={READY:'READY',NOT_CONNECTED:'NOT CONNECTED',REFUSED:'REFUSED',CLOSED:'CLOSED',NO_SESSION:'NO SESSION'};
const ERRORS={BANK_TIMEOUT:'no answer within 15 seconds',ECONNREFUSED:'connection refused',ECONNRESET:'connection reset',ENOTFOUND:'address not found',
 EHOSTUNREACH:'host unreachable',ETIMEDOUT:'connection timed out',INCOMPLETE_BANK_RESPONSE:'answer cut off',RESPONSE_TOO_LARGE:'answer too large',
 INVALID_FRAME:'answer not framed',NO_RESULT:'no result recorded'};
const REASONS={NOT_ISO20022:'not an admi.004 or admi.002 message',SCHEMA:'it does not pass its official schema',HEADER:'its header names other banks or another message'};
// The stream is looked at again every few seconds while it is shown: another operator's messages come in too.
const LOOK=5;

const clock=iso=>{const date=new Date(iso);return Number.isNaN(date.getTime())?'':date.toISOString().slice(0,19).replace('T',' ')+' UTC';};
const failure=code=>{const http=/^BANK_HTTP_(\d{3})$/.exec(code||'');return http?'the peer server answered HTTP '+http[1]:ERRORS[code]?ERRORS[code]+' ('+code+')':code||'';};
const duration=seconds=>[Math.floor(seconds/3600),Math.floor(seconds%3600/60),Math.floor(seconds%60)].map(part=>String(part).padStart(2,'0')).join(':');
export function streamLine(message){
 const when='['+clock(message.at)+']',text=message.text?['·',message.text]:[];
 if(message.direction==='OUT')return ['>>>',when,EVENTS[message.event]||message.event,SENT[message.status]||message.status,'(Seq #'+String(message.sequence).padStart(6,'0')+')',
  ...(message.status==='FAILED'?['·',failure(message.error)]:[]),...(message.status==='DELIVERED'&&!message.answered?['· no answer message']:[]),...text].join(' ');
 if(message.status==='ACK')return ['<<<',when,'PEER_ACK:',message.type,[message.event,...message.parameters].join(' '),...text].join(' ');
 if(message.status==='NAK')return ['<<<',when,'PEER_NAK:',message.type,message.event,...text,...(message.parameters[0]?['(ref '+message.parameters[0]+')']:[])].join(' ');
 return ['<<<',when,'PEER ANSWER NOT READ:',REASONS[message.error]||message.error||''].join(' ');
}
// The message each event starts with, for the chosen peer, as the specification writes it; changed by hand, it stays as written.
const suggestion=(event,peer)=>!peer?'':{INIT:'HELLO '+peer.name+' // SESSION INIT '+peer.localBic+' -> '+peer.peerBic+' // READY FOR MANUAL PACS.008 DISPATCH',
 HEARTBEAT:'HEARTBEAT '+peer.localBic+' -> '+peer.peerBic,END:'END OF SESSION '+peer.localBic+' -> '+peer.peerBic}[event]||'';

export function createFinPeer({root=document,request,view=root.defaultView||globalThis}){
 const panel=root.querySelector('[data-fin-peer]');if(!panel)return null;
 const $=selector=>panel.querySelector(selector);
 const server=$('[data-fin-peer-server]'),node=$('[data-fin-peer-node]'),text=$('[data-fin-peer-text]'),event=$('[data-fin-peer-event]');
 const button=$('[data-fin-peer-send]'),stream=$('[data-fin-peer-stream]'),link=$('[data-fin-peer-link]'),problem=$('[data-fin-peer-problem]');
 let peers=[],current=null,suggested='',busy=false,shown='',timer=null,ticks=0,up=0,fetched=0,looks=0;
 const chosen=()=>peers.find(peer=>peer.profileId===server.value)||null;
 const option=(value,label)=>{const item=root.createElement('option');item.value=value;item.textContent=label;return item;};
 function say(message){problem.textContent=message||'';problem.hidden=!message;}
 function suggest(){const next=suggestion(event.value,chosen());if(!text.value.trim()||text.value===suggested)text.value=next;suggested=next;}
 function paintLink(){
  const state=current?.link?.state||'NOT_CONNECTED',parts=['Peer link: '+(LINKS[state]||state)];
  if(state==='READY')parts.push('up '+duration(up+(Date.now()-fetched)/1000));
  if(current?.link?.lastAnswerAt)parts.push('last answer '+clock(current.link.lastAnswerAt));
  if(state==='NOT_CONNECTED'&&current?.link?.error)parts.push(failure(current.link.error));
  link.dataset.state=state;link.textContent=parts.join(' · ');
 }
 // The newest at the foot, as a terminal writes; one reading back up keeps their place.
 function paintStream(messages){
  const key=JSON.stringify(messages);if(key===shown)return;shown=key;
  const foot=stream.scrollTop+stream.clientHeight>=stream.scrollHeight-4;
  stream.replaceChildren(...messages.map(message=>{const item=root.createElement('li');item.dataset.direction=String(message.direction).toLowerCase();
   item.dataset.status=String(message.status).toLowerCase();item.textContent=streamLine(message);return item;}));
  if(foot)stream.scrollTop=stream.scrollHeight;
 }
 function take(result){
  current=result;fetched=Date.now();
  const since=Date.parse(result?.link?.since),now=Date.parse(result?.link?.now);up=Number.isFinite(since)&&Number.isFinite(now)?Math.max(0,(now-since)/1000):0;
  paintStream(Array.isArray(result?.messages)?result.messages:[]);paintLink();
 }
 async function look(){
  const profileId=server.value,at=++looks;
  if(!profileId){current=null;paintStream([]);paintLink();return;}
  let result;try{result=await request('GET','/api/fin-terminal/peers/'+encodeURIComponent(profileId)+'/messages');}catch{return;}
  if(at===looks&&profileId===server.value)take(result);
 }
 function paintPeers(){
  server.replaceChildren(...(peers.length?peers.map(peer=>option(peer.profileId,[peer.name,peer.address,peer.peerBic].join(' · '))):[option('','No peer server registered')]));
  server.disabled=!peers.length;button.disabled=busy||!peers.length;node.textContent=chosen()?.name||'—';
 }
 async function send(){
  const profileId=server.value;if(busy||!profileId)return;
  busy=true;button.disabled=true;say('');
  try{const result=await request('POST','/api/fin-terminal/peers/'+encodeURIComponent(profileId)+'/messages',{event:event.value,text:text.value});looks++;if(profileId===server.value)take(result);}
  catch(error){say(error?.message||'This action could not be completed.');}
  finally{busy=false;button.disabled=!peers.length;}
 }
 // The uptime counts on each second while the session is ready; the stream is looked at again while the screen is shown.
 function tick(){
  ticks++;if(current?.link?.state==='READY')paintLink();
  if(ticks%LOOK===0&&!busy&&!panel.closest('[hidden]')&&root.visibilityState!=='hidden')void look();
 }
 // Another peer: its own stream and link only, never the former peer's while its own are on their way.
 server.addEventListener('change',()=>{node.textContent=chosen()?.name||'—';say('');suggest();current=null;paintStream([]);paintLink();void look();});
 event.addEventListener('change',suggest);
 button.addEventListener('click',()=>void send());
 async function start(){
  let listed;try{listed=(await request('GET','/api/fin-terminal/peers'))?.peers;}catch{listed=null;}
  peers=Array.isArray(listed)?listed:[];paintPeers();suggest();paintLink();await look();
  if(timer===null)timer=view.setInterval(tick,1000);
 }
 return {start,look,stop(){view.clearInterval(timer);timer=null;}};
}
