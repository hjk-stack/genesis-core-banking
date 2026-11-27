// Screen A's peer panel in the FinTerminal (fin-terminal.mjs), "Peer Server Handshake & Direct IP Interaction" of the bank owner's
// specification: the peer banks' servers the bank has an IP-to-IP connector to (Administration, "Add bank connector"), the welcome
// or session message sent to one (src/fin-peer.mjs) and the stream of what was sent and what the peer answered. Only a peer's own
// answer is shown as its answer; a peer that does not answer is not connected. Step 5: the listening port opened for a chosen time
// (src/fin-listener.mjs) to each peer's whitelisted IP addresses, a peer's own messages and the bank's answers in the stream; while
// the port is open, nothing is sent out.
const EVENTS={INIT:'INIT_SESSION',HBT:'HEARTBEAT',END:'END_SESSION'};
const SENT={SENDING:'SENDING',DELIVERED:'SENT',FAILED:'NOT DELIVERED',UNCERTAIN:'NO RESULT'};
const LINKS={READY:'READY',NOT_CONNECTED:'NOT CONNECTED',REFUSED:'REFUSED',CLOSED:'CLOSED',NO_SESSION:'NO SESSION'};
const ERRORS={BANK_TIMEOUT:'no answer within 15 seconds',ECONNREFUSED:'connection refused',ECONNRESET:'connection reset',ENOTFOUND:'address not found',
 EHOSTUNREACH:'host unreachable',ETIMEDOUT:'connection timed out',INCOMPLETE_BANK_RESPONSE:'answer cut off',RESPONSE_TOO_LARGE:'answer too large',
 INVALID_FRAME:'answer not framed',NO_RESULT:'no result recorded',PEER_DISCONNECTED:'the peer left first',EADDRINUSE:'the port is in use',
 EACCES:'the port is not allowed',LISTENER_CONFIGURATION:'the listening certificate is not in place'};
const REASONS={NOT_ISO20022:'not an admi.004 or admi.002 message',SCHEMA:'it does not pass its official schema',HEADER:'its header names other banks or another message',
 OTHER_EVENT:'not an answer to the message sent',OTHER_MESSAGE:'it refers to another message'};
// Why a peer's own message was not taken; the bank answered it with a message reject saying so.
const TAKEN={NOT_ISO20022:'not an ISO 20022 message',SCHEMA:'it does not pass its official schema',HEADER:'its header names other banks or another message',
 OTHER_EVENT:'another event than INIT, HBT or END',BATCH:'more than one credit transfer in one message'};
const untaken=message=>message.error==='NOT_SUPPORTED'?'a '+message.type+' message is not taken on this connection':TAKEN[message.error]||message.error||'';
// The stream is looked at again every few seconds while it is shown: another operator's messages come in too.
const LOOK=5;

const clock=iso=>{const date=new Date(iso);return Number.isNaN(date.getTime())?'':date.toISOString().slice(0,19).replace('T',' ')+' UTC';};
const failure=code=>{const http=/^BANK_HTTP_(\d{3})$/.exec(code||'');return http?'the peer server answered HTTP '+http[1]:ERRORS[code]?ERRORS[code]+' ('+code+')':code||'';};
const duration=seconds=>[Math.floor(seconds/3600),Math.floor(seconds%3600/60),Math.floor(seconds%60)].map(part=>String(part).padStart(2,'0')).join(':');
export function streamLine(message){
 const when='['+clock(message.at)+']',text=message.text?['·',message.text]:[],seq='(Seq #'+String(message.sequence).padStart(6,'0')+')';
 // What the bank sent: its own message, or its answer to a peer's message - the same event, a refusal with its reason, or a
 // transfer's status (pacs.002: ACSC, or RJCT with its reason code).
 if(message.direction==='OUT'){
  const answer=Boolean(message.answerTo),refusal=message.type==='admi.002.001.01',status=message.type==='pacs.002.001.10';
  return ['>>>',when,...(answer?['ANSWER']:[]),refusal?'REJECT':status?['pacs.002',message.event,...message.parameters.slice(1)].join(' '):EVENTS[message.event]||message.event,
   SENT[message.status]||message.status,seq,
   ...(message.status==='FAILED'?['·',failure(message.error)]:[]),...(message.status==='DELIVERED'&&!answer&&!message.answered?['· no answer message']:[]),
   ...(refusal?['·',message.event]:[]),...text].join(' ');
 }
 // A peer's own message on the listening port: a session event, or a credit transfer as the specification's stream writes it,
 // "RECEIVED <amount> -> <settlement>".
 if(!message.answerTo)return message.status==='RECEIVED'?['<<<',when,'PEER',...(message.type==='pacs.008.001.08'?['pacs.008']:[EVENTS[message.event]||message.event,'RECEIVED']),seq,...text].join(' ')
  :['<<<',when,'PEER MESSAGE NOT READ',seq,'·',untaken(message)].join(' ');
 // What the peer said: its event, or its refusal with the message it names. Said, but not of the message sent, it does not count.
 const said=message.type==='admi.002.001.01'?[message.type,message.event,...text,...(message.parameters[0]?['(ref '+message.parameters[0]+')']:[])]
  :[message.type,[message.event,...message.parameters].join(' '),...text];
 if(message.status==='ACK')return ['<<<',when,'PEER_ACK:',...said].join(' ');
 if(message.status==='NAK')return ['<<<',when,'PEER_NAK:',...said].join(' ');
 if(message.event)return ['<<<',when,'PEER_OTHER:',...said,'·',REASONS[message.error]||message.error||''].join(' ');
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
 const listenTime=$('[data-fin-listen-time]'),listenButton=$('[data-fin-listen]'),listenState=$('[data-fin-listen-state]');
 const addresses=$('[data-fin-peer-addresses]'),addressInput=$('[data-fin-peer-address]'),addressButton=$('[data-fin-peer-address-add]');
 let peers=[],current=null,suggested='',busy=false,shown='',timer=null,ticks=0,up=0,fetched=0,looks=0,listener=null,listenedAt=0,listenBusy=false,listenLooks=0;
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
  server.disabled=!peers.length;node.textContent=chosen()?.name||'—';paintSend();paintAddresses();
 }
 // Nothing goes out while the listening port is open (the bank owner: "not both working at the same time").
 const listening=()=>listener?.open===true;
 function paintSend(){button.disabled=busy||!peers.length||listening();}
 // The listening port: closed, or open until its end with the time left - and whether the bank's server really listens.
 function paintListener(){
  const port=listener?.port?' '+listener.port:'',left=listening()?Math.max(0,(Date.parse(listener.until)-Date.parse(listener.now))/1000-(Date.now()-listenedAt)/1000):0;
  listenButton.textContent=(listening()?'Close Port':'Open Port')+port;listenButton.disabled=listenBusy||!listener;listenTime.disabled=listenBusy||listening();
  listenState.dataset.state=!listening()?'CLOSED':listener.listening?'LISTENING':'NOT_LISTENING';
  listenState.textContent=!listening()?'Port'+port+' closed':listener.listening?'Listening on port'+port+' until '+clock(listener.until)+' · '+duration(left)+' left'
   :'Port'+port+' open until '+clock(listener.until)+' · not listening: '+failure(listener.error);
  paintSend();
  if(listening()&&left<=0)void lookListener();
 }
 function takeListener(status){if(status&&typeof status==='object'){listener=status;listenedAt=Date.now();}paintListener();}
 async function lookListener(){
  const at=++listenLooks;let status;try{status=await request('GET','/api/fin-terminal/listener');}catch{return;}
  if(at===listenLooks)takeListener(status);
 }
 async function listen(){
  if(listenBusy||!listener)return;
  listenBusy=true;paintListener();say('');
  try{const status=await request('POST','/api/fin-terminal/listener',listening()?{open:false}:{open:true,minutes:Number(listenTime.value)});listenLooks++;takeListener(status);}
  catch(error){say(error?.message||'This action could not be completed.');}
  finally{listenBusy=false;paintListener();}
 }
 // The chosen peer's whitelisted IP addresses: added and taken off here.
 function paintAddresses(){
  const peer=chosen(),list=Array.isArray(peer?.addresses)?peer.addresses:[];
  addresses.replaceChildren(...list.map(address=>{
   const item=root.createElement('li'),shown=root.createElement('span'),remove=root.createElement('button');
   shown.className='fin-code';shown.textContent=address;remove.type='button';remove.textContent='×';remove.title='Remove';remove.setAttribute('aria-label','Remove '+address);
   remove.addEventListener('click',()=>void whitelist(address,true));item.append(shown,remove);return item;
  }));
  addressInput.disabled=addressButton.disabled=!peer;
 }
 async function whitelist(address,remove=false){
  const profileId=server.value;if(!profileId||!address.trim())return;
  say('');addressInput.removeAttribute('aria-invalid');
  try{
   const result=await request('POST','/api/fin-terminal/peers/'+encodeURIComponent(profileId)+'/addresses'+(remove?'/remove':''),{address});
   const peer=peers.find(item=>item.profileId===profileId);if(peer&&Array.isArray(result?.addresses))peer.addresses=result.addresses;
   if(!remove)addressInput.value='';paintAddresses();
  }catch(error){say(error?.message||'This action could not be completed.');if(!remove)addressInput.setAttribute('aria-invalid','true');}
 }
 async function send(){
  const profileId=server.value;if(busy||!profileId)return;
  busy=true;button.disabled=true;say('');
  try{const result=await request('POST','/api/fin-terminal/peers/'+encodeURIComponent(profileId)+'/messages',{event:event.value,text:text.value});looks++;if(profileId===server.value)take(result);}
  catch(error){say(error?.message||'This action could not be completed.');}
  finally{busy=false;paintSend();}
 }
 // The uptime counts on each second while the session is ready; the stream is looked at again while the screen is shown.
 function tick(){
  ticks++;if(current?.link?.state==='READY')paintLink();if(listening())paintListener();
  if(ticks%LOOK===0&&!busy&&!panel.closest('[hidden]')&&root.visibilityState!=='hidden'){void look();if(!listenBusy)void lookListener();}
 }
 // Another peer: its own stream and link only, never the former peer's while its own are on their way.
 server.addEventListener('change',()=>{node.textContent=chosen()?.name||'—';say('');suggest();paintAddresses();current=null;paintStream([]);paintLink();void look();});
 event.addEventListener('change',suggest);
 button.addEventListener('click',()=>void send());
 listenButton.addEventListener('click',()=>void listen());
 addressButton.addEventListener('click',()=>void whitelist(addressInput.value));
 addressInput.addEventListener('keydown',keyed=>{if(keyed.key==='Enter'){keyed.preventDefault();void whitelist(addressInput.value);}});
 async function start(){
  let listed;try{listed=(await request('GET','/api/fin-terminal/peers'))?.peers;}catch{listed=null;}
  peers=Array.isArray(listed)?listed:[];paintPeers();suggest();paintLink();await lookListener();await look();
  if(timer===null)timer=view.setInterval(tick,1000);
 }
 return {start,look,stop(){view.clearInterval(timer);timer=null;}};
}
