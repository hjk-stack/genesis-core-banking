import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {readFile} from 'node:fs/promises';
import {validateXML} from 'xmllint-wasm';
import {XMLParser} from 'fast-xml-parser';
import {fault} from './core.mjs';
import {sendBankMessage,connectorCredentials} from './payment-transport.mjs';
import {HEAD,newMessageId} from '../public/fin-message.mjs';
import {ABIQ_ISSUER} from './avispay-core-accounts.mjs';

// Screen A of the FinTerminal, "Peer Server Handshake & Direct IP Interaction" in the bank owner's specification (FinTerminal
// Unified NOSTRO & Crypto System v3): the bank's welcome or session message to a peer bank's server - an ISO 20022 system event
// notification (admi.004.001.02) under its business application header (head.001.001.02) - sent through the payment server's
// own connection to that bank (src/payment-transport.mjs: mutual TLS with the bank connector's certificate), and the peer's
// answer as it came. Requested by the bank owner: "No simulators only active live software ready to connect and transact" - a
// peer that does not answer is not connected, and only what a peer sent is shown as its answer.
export const ADMI004='admi.004.001.02',ADMI002='admi.002.001.01';
const NAMESPACE='urn:iso:std:iso:20022:tech:xsd:';
// The session's events, each sent with its event code: the specification's "INIT_SESSION / READY", a heartbeat, the end.
export const SESSION_EVENTS=Object.freeze({INIT:{code:'INIT',parameters:['READY']},HEARTBEAT:{code:'HBT',parameters:[]},END:{code:'END',parameters:[]}});

// A business message as the terminal writes it - its header and its document side by side in one envelope - or a document
// alone, each part checked against its official schema (schemas/, from iso20022.org). The schemas take any element they declare
// as a whole message, a header alone too: what the message starts with decides which check it gets.
const envelope=type=>`<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:head="${NAMESPACE+HEAD}" xmlns:doc="${NAMESPACE+type}">
 <xs:import namespace="${NAMESPACE+HEAD}" schemaLocation="${HEAD}.xsd"/>
 <xs:import namespace="${NAMESPACE+type}" schemaLocation="${type}.xsd"/>
 <xs:element name="Envelope"><xs:complexType><xs:sequence><xs:element ref="head:AppHdr"/><xs:element ref="doc:Document"/></xs:sequence></xs:complexType></xs:element>
</xs:schema>`;
const schemas=new Map();
const schema=type=>{
 if(!schemas.has(type))schemas.set(type,readFile(new URL('../schemas/'+type+'.xsd',import.meta.url),'utf8').then(contents=>({fileName:type+'.xsd',contents})));
 return schemas.get(type);
};
const parser=new XMLParser({ignoreAttributes:true,removeNSPrefix:true,parseTagValue:false,trimValues:true,processEntities:true,isArray:name=>name==='EvtParam'});
const first=xml=>{try{return Object.keys(parser.parse(xml)).find(key=>!key.startsWith('?'))||null;}catch{return null;}};
async function passes(xml,type){
 const root=first(xml);if(root!=='Envelope'&&root!=='Document')return false;
 const own=await schema(type),message={fileName:'message.xml',contents:xml};
 try{
  return (await validateXML(root==='Envelope'?{xml:message,schema:{fileName:'envelope.xsd',contents:envelope(type)},preload:[await schema(HEAD),own],maxMemoryPages:512}
   :{xml:message,schema:own,maxMemoryPages:512})).valid;
 }catch{return false;}
}

const esc=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const institution=bic=>'<FIId><FinInstnId><BICFI>'+esc(bic)+'</BICFI></FinInstnId></FIId>';
const stamp=at=>at.toISOString().slice(0,19)+'Z';
// The bank's message to the peer in its envelope: the business application header from this bank to the peer, then the document.
const enveloped=({localBic,peerBic,businessMessageId,at},type,document)=>['<?xml version="1.0" encoding="UTF-8"?>','<Envelope>',
 '  <AppHdr xmlns="'+NAMESPACE+HEAD+'">','    <Fr>'+institution(localBic)+'</Fr>','    <To>'+institution(peerBic)+'</To>',
 '    <BizMsgIdr>'+esc(businessMessageId)+'</BizMsgIdr>','    <MsgDefIdr>'+type+'</MsgDefIdr>','    <CreDt>'+stamp(at)+'</CreDt>','  </AppHdr>',
 '  <Document xmlns="'+NAMESPACE+type+'">',...document.map(line=>'    '+line),'  </Document>','</Envelope>',''].join('\n');
export function buildSessionMessage({event,text,...head}){
 const {code,parameters}=SESSION_EVENTS[event];
 return enveloped(head,ADMI004,['<SysEvtNtfctn>','  <EvtInf>','    <EvtCd>'+code+'</EvtCd>',...parameters.map(parameter=>'    <EvtParam>'+esc(parameter)+'</EvtParam>'),
  ...(text?['    <EvtDesc>'+esc(text)+'</EvtDesc>']:[]),'    <EvtTm>'+stamp(head.at)+'</EvtTm>','  </EvtInf>','</SysEvtNtfctn>']);
}
// The bank's refusal of a peer's message: a message reject naming that message, with the reason and why.
export function buildReject({reference,reason,description,...head}){
 return enveloped(head,ADMI002,['<admi.002.001.01>','  <RltdRef>','    <Ref>'+esc(reference)+'</Ref>','  </RltdRef>','  <Rsn>','    <RjctgPtyRsn>'+esc(reason)+'</RjctgPtyRsn>',
  '    <RjctnDtTm>'+stamp(head.at)+'</RjctnDtTm>','    <RsnDesc>'+esc(description)+'</RsnDesc>','  </Rsn>','</admi.002.001.01>']);
}

// The peer's answer, read only as far as it is an ISO 20022 message from that peer to this bank and answers the message sent: its
// own system event notification of the same event (INIT_SESSION with READY) is its acknowledgement, a message reject
// (admi.002.001.01) naming the message sent its refusal (review finding: another event, or a refusal of another message, is
// neither). Anything else is kept as it came and shown with the reason.
const sameBank=(one,two)=>typeof one==='string'&&typeof two==='string'&&(one.length===8?one+'XXX':one)===(two.length===8?two+'XXX':two);
// A message is to this bank when it names the connector's own BIC, or the bank's own ABIQ code - AVIS Bank Intelligence, the
// bank's IBAN system, which a peer may know the bank by (the bank owner: "Yes, accept messages to our ABIQ code too"). The bank
// as the message names it, or null.
const namedBank=(header,localBic,own)=>{const to=header.To?.FIId?.FinInstnId?.BICFI;return sameBank(to,localBic)?localBic:own.find(code=>sameBank(to,code))||null;};
export async function readPeerAnswer(xml,{localBic,peerBic,event,businessMessageId,own=[]}){
 if(/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml))return {status:'UNREAD',reason:'NOT_ISO20022'};
 const type=[ADMI004,ADMI002].find(type=>xml.includes(NAMESPACE+type));
 if(!type)return {status:'UNREAD',reason:'NOT_ISO20022'};
 if(!(await passes(xml,type)))return {status:'UNREAD',type,reason:'SCHEMA'};
 const parsed=parser.parse(xml),message=parsed.Envelope||parsed,header=message.AppHdr,document=message.Document;
 if(header&&(!sameBank(header.Fr?.FIId?.FinInstnId?.BICFI,peerBic)||!namedBank(header,localBic,own)||header.MsgDefIdr!==type))return {status:'UNREAD',type,reason:'HEADER'};
 const said={type,businessMessageId:header?.BizMsgIdr||null};
 if(type===ADMI004){
  const notified=document.SysEvtNtfctn.EvtInf,sent=SESSION_EVENTS[event],answer={...said,code:notified.EvtCd,parameters:notified.EvtParam||[],text:notified.EvtDesc||null};
  const acknowledged=answer.code===sent.code&&sent.parameters.every(parameter=>answer.parameters.includes(parameter));
  return {...answer,status:acknowledged?'ACK':'UNREAD',reason:acknowledged?null:'OTHER_EVENT'};
 }
 const reject=document[ADMI002],answer={...said,code:reject.Rsn.RjctgPtyRsn,parameters:[reject.RltdRef.Ref],text:reject.Rsn.RsnDesc||reject.Rsn.ErrLctn||null};
 return {...answer,status:reject.RltdRef.Ref===businessMessageId?'NAK':'UNREAD',reason:reject.RltdRef.Ref===businessMessageId?null:'OTHER_MESSAGE'};
}

// A peer's own message on the listening port (src/fin-listener.mjs), read as far as it is a session event from that peer to this
// bank - INIT_SESSION, HEARTBEAT or END_SESSION; anything else is refused with the reason (another ISO 20022 message is not taken
// on this connection).
const EVENT_OF=Object.fromEntries(Object.entries(SESSION_EVENTS).map(([event,{code}])=>[code,event]));
export async function readPeerMessage(xml,{localBic,peerBic,own=[]}){
 if(/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml))return {status:'UNREAD',reason:'NOT_ISO20022'};
 if(!xml.includes(NAMESPACE+ADMI004)){
  const other=[...xml.matchAll(/urn:iso:std:iso:20022:tech:xsd:([a-z]{4}\.\d{3}\.\d{3}\.\d{2})/g)].map(match=>match[1]).find(type=>type!==HEAD);
  return other?{status:'UNREAD',type:other,reason:'NOT_SUPPORTED'}:{status:'UNREAD',reason:'NOT_ISO20022'};
 }
 if(!(await passes(xml,ADMI004)))return {status:'UNREAD',type:ADMI004,reason:'SCHEMA'};
 const parsed=parser.parse(xml),message=parsed.Envelope||parsed,header=message.AppHdr,notified=message.Document.SysEvtNtfctn.EvtInf;
 const bank=header?namedBank(header,localBic,own):null;
 // A message to the bank refused for its header is refused by the bank as the message named it (review finding).
 if(header&&(!sameBank(header.Fr?.FIId?.FinInstnId?.BICFI,peerBic)||!bank||header.MsgDefIdr!==ADMI004))
  return {status:'UNREAD',type:ADMI004,businessMessageId:header.BizMsgIdr||null,reason:'HEADER',to:bank};
 // The bank answers as the peer named it: by the connector's BIC or by its ABIQ code.
 const said={type:ADMI004,businessMessageId:header?.BizMsgIdr||null,code:notified.EvtCd,parameters:notified.EvtParam||[],text:notified.EvtDesc||null,to:bank},
  event=EVENT_OF[said.code];
 return event?{...said,status:'RECEIVED',event}:{...said,status:'UNREAD',reason:'OTHER_EVENT'};
}
// The bank's answer to a peer's message: the same session event (INIT_SESSION with READY), or its refusal.
const ANSWERS={INIT:'WELCOME ACCEPTED // SESSION READY',HEARTBEAT:'HEARTBEAT ACCEPTED',END:'SESSION CLOSED'};
const REFUSALS={NOT_ISO20022:'Not an ISO 20022 message.',SCHEMA:'The message does not pass its official schema.',
 HEADER:'The business application header names other banks or another message.',OTHER_EVENT:'Session events taken: INIT, HBT and END.',
 NOT_SUPPORTED:'Only system event notifications (admi.004.001.02) are taken on this connection.'};

// The IP addresses a peer bank connects from, whitelisted for the listening port: single addresses, an IPv4 one as itself.
export const plainAddress=value=>{const text=String(value??'').trim(),mapped=/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);return mapped?mapped[1]:text.toLowerCase();};
const ADDRESSES='SELECT profile_id,host(address) AS address FROM avis_core_v2.fin_terminal_peer_addresses';
const LISTENING='SELECT 1 FROM avis_core_v2.fin_terminal_listener WHERE open_until>now()';
// Never both (review finding): a session message is kept as being sent, and the listening port opened (src/fin-listener.mjs), each
// under the connector's one lock - the one waits for the other, and each sees the other.
export async function underConnectorLock(pool,work){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('avis_core_v2:fin-terminal-connector',0))");
  const result=await work(client);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
 finally{client.release?.();}
}

// The bank's IP-to-IP connectors to peer banks (Administration, "Add bank connector"), enabled and on an active clearing account.
const PEERS=`SELECT p.profile_id,c.display_name,c.endpoint_url,c.credential_reference,p.local_bic,p.peer_bic
 FROM avis_core_v2.bank_connector_profiles p JOIN avis_core_v2.platform_connectors c ON c.connector_code=p.profile_id
 JOIN avis_core_v2.external_cash_accounts a USING(cash_account_id)
 WHERE p.protocol='IP_TO_IP' AND c.is_enabled AND a.is_active`;
const PROFILE=/^[A-Z0-9_]{1,35}$/;
// The bank's own ABIQ code: its own ABIQ issuer's (ABIQ_ISSUER), while that issuer takes part in the ABIQ network
// (src/abiq-interface.mjs) - never the code of an issuer the bank licensed (review finding).
const OWN_ABIQ=`SELECT i.abiq_code FROM avis_core_v2.abiq_issuers i JOIN avis_core_v2.abiq_network_participants p USING(participant_code)
 WHERE i.participant_code=$1 AND p.abiq_bic=i.abiq_code AND p.is_active`;
const peerOf=(row,addresses=[])=>{const url=new URL(row.endpoint_url);return {profileId:row.profile_id,name:row.display_name,address:url.hostname+':'+(url.port||'443'),
 transport:url.protocol==='tls:'?'TLS':'HTTPS',localBic:row.local_bic,peerBic:row.peer_bic,addresses};};
// A message still being sent a minute on (the transport gives up after 15 seconds) was never finished: its result is unknown.
const stale=alias=>`${alias}.status='SENDING' AND ${alias}.updated_at<now()-interval '1 minute'`;
const MESSAGES=`SELECT m.*,${stale('m')} AS stale,EXISTS(SELECT 1 FROM avis_core_v2.fin_terminal_peer_messages a WHERE a.answer_to=m.message_id) AS answered
 FROM avis_core_v2.fin_terminal_peer_messages m WHERE m.profile_id=$1 ORDER BY m.sequence DESC LIMIT 100`;
const messageOf=row=>({messageId:row.message_id,sequence:Number(row.sequence),direction:row.direction,answerTo:row.answer_to,at:new Date(row.created_at).toISOString(),
 type:row.message_type,businessMessageId:row.business_message_id,event:row.event_code,parameters:row.event_parameters||[],text:row.event_text,
 status:row.stale?'UNCERTAIN':row.status,error:row.error_code,answered:row.answered===true});
// Every exchange finished: a message the bank sent with the peer's answer to it, or a peer's own message with the bank's answer -
// the bank's answer to a session event it read is its acknowledgement.
const EXCHANGES=`SELECT * FROM (SELECT r.sequence,r.event_code,
  CASE WHEN r.direction='OUT' THEN r.status ELSE a.status END AS status,CASE WHEN r.direction='OUT' THEN r.error_code ELSE a.error_code END AS error_code,
  CASE WHEN r.direction='OUT' THEN ${stale('r')} ELSE coalesce(${stale('a')},false) END AS stale,
  CASE WHEN r.direction='OUT' THEN a.status WHEN r.status='RECEIVED' AND a.status='DELIVERED' THEN 'ACK' END AS answer,
  CASE WHEN r.direction='OUT' THEN a.created_at ELSE a.updated_at END AS answered_at
 FROM avis_core_v2.fin_terminal_peer_messages r LEFT JOIN avis_core_v2.fin_terminal_peer_messages a ON a.answer_to=r.message_id
 WHERE r.profile_id=$1 AND r.answer_to IS NULL) x WHERE NOT (x.status='SENDING' AND NOT x.stale)`;
const iso=value=>value?new Date(value).toISOString():null;
export const diagnostic=error=>{const code=error?.code||error?.message||'';return /^[A-Z0-9_]{1,64}$/.test(code)?code:'BANK_DELIVERY_ERROR';};

export class FinPeers{
 constructor(pool,{send=sendBankMessage,credentials=connectorCredentials}={}){this.pool=pool;this.transmit=send;this.credentials=credentials;}
 #administrator(actor){if(!actor?.admin)fault('FORBIDDEN',null,403);}
 async #own(){return (await this.pool.query(OWN_ABIQ,[ABIQ_ISSUER.participantCode])).rows.map(row=>row.abiq_code);}
 async #peer(profileId){
  const row=typeof profileId==='string'&&PROFILE.test(profileId)?(await this.pool.query(PEERS+' AND p.profile_id=$1',[profileId])).rows[0]:null;
  if(!row)fault('CONNECTOR_NOT_FOUND','profileId',404);
  return row;
 }
 #text(value){
  if(value===undefined||value===null)return '';
  if(typeof value!=='string'||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))fault('INVALID_FIELD','text');
  const text=value.replace(/\r\n?/g,'\n').trim();
  if([...text].length>1000)fault('INVALID_FIELD','text');
  return text;
 }
 // The link with a peer as its answers show it. The session is ready from the peer's acknowledgement of INIT_SESSION for as long
 // as the peer acknowledged every message since; a message it did not acknowledge, or the end of the session, ends it.
 async #link(profileId){
  const latest=(await this.pool.query(EXCHANGES+' ORDER BY x.sequence DESC LIMIT 1',[profileId])).rows[0];
  const session=(await this.pool.query(`WITH e AS (${EXCHANGES}),b AS (SELECT coalesce(max(sequence),0) AS at FROM e WHERE answer IS DISTINCT FROM 'ACK' OR event_code='END')
   SELECT min(e.answered_at) AS since,(SELECT max(created_at) FROM avis_core_v2.fin_terminal_peer_messages WHERE profile_id=$1 AND direction='IN') AS last_answer,now() AS now
   FROM e,b WHERE e.sequence>b.at AND e.event_code='INIT' AND e.answer='ACK'`,[profileId])).rows[0];
  const failed=latest&&(latest.stale||latest.status==='FAILED');
  const state=session.since?'READY':!latest||failed?'NOT_CONNECTED':latest.answer==='NAK'?'REFUSED':latest.answer==='ACK'&&latest.event_code==='END'?'CLOSED':'NO_SESSION';
  return {state,since:iso(session.since),lastAnswerAt:iso(session.last_answer),error:failed?(latest.stale?'NO_RESULT':latest.error_code):null,now:iso(session.now)};
 }
 async list(actor){
  this.#administrator(actor);
  const peers=(await this.pool.query(PEERS+' ORDER BY c.display_name,p.profile_id')).rows,addresses=(await this.pool.query(ADDRESSES+' ORDER BY address')).rows;
  return peers.map(row=>peerOf(row,addresses.filter(item=>item.profile_id===row.profile_id).map(item=>item.address)));
 }
 // A peer's IP addresses for the listening port, added and removed by a bank administrator.
 #address(value){
  const address=plainAddress(value);
  if(typeof value!=='string'||!isIP(address)||address.includes('%'))fault('INVALID_FIELD','address');
  return address;
 }
 async #addresses(profileId){return (await this.pool.query(ADDRESSES+' WHERE profile_id=$1 ORDER BY address',[profileId])).rows.map(row=>row.address);}
 async addAddress(actor,profileId,body){
  this.#administrator(actor);
  const address=this.#address(body?.address),peer=await this.#peer(profileId);
  await this.pool.query('INSERT INTO avis_core_v2.fin_terminal_peer_addresses(profile_id,address,created_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[peer.profile_id,address,String(actor.id)]);
  return {addresses:await this.#addresses(peer.profile_id)};
 }
 async removeAddress(actor,profileId,body){
  this.#administrator(actor);
  const address=this.#address(body?.address),peer=await this.#peer(profileId);
  await this.pool.query('DELETE FROM avis_core_v2.fin_terminal_peer_addresses WHERE profile_id=$1 AND address=$2::inet',[peer.profile_id,address]);
  return {addresses:await this.#addresses(peer.profile_id)};
 }
 async messages(actor,profileId){
  this.#administrator(actor);
  const peer=await this.#peer(profileId),rows=(await this.pool.query(MESSAGES,[peer.profile_id])).rows.reverse();
  return {peer:peerOf(peer,await this.#addresses(peer.profile_id)),link:await this.#link(peer.profile_id),messages:rows.map(messageOf)};
 }
 // The message is kept before it leaves, then with what became of it: the peer's answer, or why none came. A connector whose
 // certificate is not in place sends nothing and keeps nothing; nor does the terminal while its listening port is open (the bank
 // owner: "not both working at the same time"). Over TLS 1.3, as the specification's connector.
 async send(actor,profileId,body){
  this.#administrator(actor);
  if(typeof body?.event!=='string'||!Object.hasOwn(SESSION_EVENTS,body.event))fault('INVALID_FIELD','event');
  const text=this.#text(body.text),peer=await this.#peer(profileId),credentials=this.credentials(peer.credential_reference);
  const at=new Date(),businessMessageId=newMessageId(at),{code,parameters}=SESSION_EVENTS[body.event];
  const xml=buildSessionMessage({localBic:peer.local_bic,peerBic:peer.peer_bic,businessMessageId,event:body.event,text,at});
  if(!(await passes(xml,ADMI004)))fault('INVALID_FIELD','text');
  const messageId=randomUUID();
  await underConnectorLock(this.pool,async db=>{
   if((await db.query(LISTENING)).rows.length)fault('FIN_LISTENING',null,409);
   await db.query(`INSERT INTO avis_core_v2.fin_terminal_peer_messages(message_id,profile_id,direction,message_type,business_message_id,event_code,event_parameters,event_text,status,content,created_by)
    VALUES($1,$2,'OUT',$3,$4,$5,$6,$7,'SENDING',$8,$9)`,[messageId,peer.profile_id,ADMI004,businessMessageId,code,parameters,text||null,xml,String(actor.id)]);
  });
  let answer=null,error=null;
  try{answer=await this.transmit(peer,xml,credentials,{minVersion:'TLSv1.3'});}catch(failure){error=diagnostic(failure);}
  // An answer is kept as it came; text cannot hold a zero byte.
  const received=typeof answer==='string'&&answer.length?answer.replaceAll('\0',''):null;
  const read=received&&await readPeerAnswer(received,{localBic:peer.local_bic,peerBic:peer.peer_bic,event:body.event,businessMessageId,own:await this.#own()});
  const client=await this.pool.connect();
  try{
   await client.query('BEGIN');
   await client.query('UPDATE avis_core_v2.fin_terminal_peer_messages SET status=$2,error_code=$3,updated_at=now() WHERE message_id=$1',[messageId,error?'FAILED':'DELIVERED',error]);
   if(read)await client.query(`INSERT INTO avis_core_v2.fin_terminal_peer_messages(message_id,profile_id,direction,answer_to,message_type,business_message_id,event_code,event_parameters,event_text,status,error_code,content)
    VALUES($1,$2,'IN',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[randomUUID(),peer.profile_id,messageId,read.type||null,read.businessMessageId||null,read.code||null,read.parameters||[],read.text||null,read.status,read.reason||null,received]);
   await client.query('COMMIT');
  }catch(failure){await client.query('ROLLBACK').catch(()=>{});throw failure;}
  finally{client.release?.();}
  return this.messages(actor,profileId);
 }
 // A peer's own message, taken on the listening port once its TLS, certificate and IP address were checked (src/fin-listener.mjs):
 // kept as it came, with the bank's answer as it leaves; the listener tells what became of the answer.
 async receive(profileId,xml){
  const peer=await this.#peer(profileId),received=String(xml).replaceAll('\0','');
  const read=await readPeerMessage(received,{localBic:peer.local_bic,peerBic:peer.peer_bic,own:await this.#own()});
  const at=new Date(),head={localBic:read.to||peer.local_bic,peerBic:peer.peer_bic,businessMessageId:newMessageId(at),at};
  const answer=read.status==='RECEIVED'
   ?{type:ADMI004,code:SESSION_EVENTS[read.event].code,parameters:SESSION_EVENTS[read.event].parameters,text:ANSWERS[read.event],xml:buildSessionMessage({...head,event:read.event,text:ANSWERS[read.event]})}
   :{type:ADMI002,code:read.reason,parameters:[read.businessMessageId||'NONE'],text:REFUSALS[read.reason],
    xml:buildReject({...head,reference:read.businessMessageId||'NONE',reason:read.reason,description:REFUSALS[read.reason]})};
  if(!(await passes(answer.xml,answer.type)))fault('FIN_MESSAGE_INVALID');
  const messageId=randomUUID(),answerId=randomUUID(),client=await this.pool.connect();
  try{
   await client.query('BEGIN');
   await client.query(`INSERT INTO avis_core_v2.fin_terminal_peer_messages(message_id,profile_id,direction,message_type,business_message_id,event_code,event_parameters,event_text,status,error_code,content)
    VALUES($1,$2,'IN',$3,$4,$5,$6,$7,$8,$9,$10)`,[messageId,peer.profile_id,read.type||null,read.businessMessageId||null,read.code||null,read.parameters||[],read.text||null,read.status,read.reason||null,received]);
   await client.query(`INSERT INTO avis_core_v2.fin_terminal_peer_messages(message_id,profile_id,direction,answer_to,message_type,business_message_id,event_code,event_parameters,event_text,status,content,created_by)
    VALUES($1,$2,'OUT',$3,$4,$5,$6,$7,$8,'SENDING',$9,'listener')`,[answerId,peer.profile_id,messageId,answer.type,head.businessMessageId,answer.code,answer.parameters,answer.text,answer.xml]);
   await client.query('COMMIT');
  }catch(failure){await client.query('ROLLBACK').catch(()=>{});throw failure;}
  finally{client.release?.();}
  return {answer:answer.xml,delivered:error=>this.pool.query('UPDATE avis_core_v2.fin_terminal_peer_messages SET status=$2,error_code=$3,updated_at=now() WHERE message_id=$1',
   [answerId,error?'FAILED':'DELIVERED',error?diagnostic(error):null])};
 }
}
