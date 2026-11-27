import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {validateXML} from 'xmllint-wasm';
import {XMLParser} from 'fast-xml-parser';
import {fault} from './core.mjs';
import {sendBankMessage,connectorCredentials} from './payment-transport.mjs';
import {HEAD,newMessageId} from '../public/fin-message.mjs';

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
export function buildSessionMessage({localBic,peerBic,businessMessageId,event,text,at}){
 const {code,parameters}=SESSION_EVENTS[event],time=at.toISOString().slice(0,19)+'Z';
 return ['<?xml version="1.0" encoding="UTF-8"?>','<Envelope>',
  '  <AppHdr xmlns="'+NAMESPACE+HEAD+'">','    <Fr>'+institution(localBic)+'</Fr>','    <To>'+institution(peerBic)+'</To>',
  '    <BizMsgIdr>'+esc(businessMessageId)+'</BizMsgIdr>','    <MsgDefIdr>'+ADMI004+'</MsgDefIdr>','    <CreDt>'+time+'</CreDt>','  </AppHdr>',
  '  <Document xmlns="'+NAMESPACE+ADMI004+'">','    <SysEvtNtfctn>','      <EvtInf>','        <EvtCd>'+code+'</EvtCd>',
  ...parameters.map(parameter=>'        <EvtParam>'+esc(parameter)+'</EvtParam>'),...(text?['        <EvtDesc>'+esc(text)+'</EvtDesc>']:[]),
  '        <EvtTm>'+time+'</EvtTm>','      </EvtInf>','    </SysEvtNtfctn>','  </Document>','</Envelope>',''].join('\n');
}

// The peer's answer, read only as far as it is an ISO 20022 message from that peer to this bank: its own system event
// notification is its acknowledgement, a message reject (admi.002.001.01) its refusal. Anything else is kept as it came and
// shown as not read, with the reason.
const sameBank=(one,two)=>typeof one==='string'&&typeof two==='string'&&(one.length===8?one+'XXX':one)===(two.length===8?two+'XXX':two);
export async function readPeerAnswer(xml,{localBic,peerBic}){
 if(/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml))return {status:'UNREAD',reason:'NOT_ISO20022'};
 const type=[ADMI004,ADMI002].find(type=>xml.includes(NAMESPACE+type));
 if(!type)return {status:'UNREAD',reason:'NOT_ISO20022'};
 if(!(await passes(xml,type)))return {status:'UNREAD',type,reason:'SCHEMA'};
 const parsed=parser.parse(xml),message=parsed.Envelope||parsed,header=message.AppHdr,document=message.Document;
 if(header&&(!sameBank(header.Fr?.FIId?.FinInstnId?.BICFI,peerBic)||!sameBank(header.To?.FIId?.FinInstnId?.BICFI,localBic)||header.MsgDefIdr!==type))return {status:'UNREAD',type,reason:'HEADER'};
 const businessMessageId=header?.BizMsgIdr||null;
 if(type===ADMI004){const event=document.SysEvtNtfctn.EvtInf;return {status:'ACK',type,businessMessageId,code:event.EvtCd,parameters:event.EvtParam||[],text:event.EvtDesc||null};}
 const reject=document[ADMI002];
 return {status:'NAK',type,businessMessageId,code:reject.Rsn.RjctgPtyRsn,parameters:[reject.RltdRef.Ref],text:reject.Rsn.RsnDesc||reject.Rsn.ErrLctn||null};
}

// The bank's IP-to-IP connectors to peer banks (Administration, "Add bank connector"), enabled and on an active clearing account.
const PEERS=`SELECT p.profile_id,c.display_name,c.endpoint_url,c.credential_reference,p.local_bic,p.peer_bic
 FROM avis_core_v2.bank_connector_profiles p JOIN avis_core_v2.platform_connectors c ON c.connector_code=p.profile_id
 JOIN avis_core_v2.external_cash_accounts a USING(cash_account_id)
 WHERE p.protocol='IP_TO_IP' AND c.is_enabled AND a.is_active`;
const PROFILE=/^[A-Z0-9_]{1,35}$/;
const peerOf=row=>{const url=new URL(row.endpoint_url);return {profileId:row.profile_id,name:row.display_name,address:url.hostname+':'+(url.port||'443'),
 transport:url.protocol==='tls:'?'TLS':'HTTPS',localBic:row.local_bic,peerBic:row.peer_bic};};
// A message still being sent a minute on (the transport gives up after 15 seconds) was never finished: its result is unknown.
const stale=alias=>`${alias}.status='SENDING' AND ${alias}.updated_at<now()-interval '1 minute'`;
const MESSAGES=`SELECT m.*,${stale('m')} AS stale,EXISTS(SELECT 1 FROM avis_core_v2.fin_terminal_peer_messages a WHERE a.answer_to=m.message_id) AS answered
 FROM avis_core_v2.fin_terminal_peer_messages m WHERE m.profile_id=$1 ORDER BY m.sequence DESC LIMIT 100`;
const messageOf=row=>({messageId:row.message_id,sequence:Number(row.sequence),direction:row.direction,answerTo:row.answer_to,at:new Date(row.created_at).toISOString(),
 type:row.message_type,businessMessageId:row.business_message_id,event:row.event_code,parameters:row.event_parameters||[],text:row.event_text,
 status:row.stale?'UNCERTAIN':row.status,error:row.error_code,answered:row.answered===true});
// Every message sent and finished, with the peer's answer to it.
const EXCHANGES=`SELECT o.sequence,o.event_code,o.status,o.error_code,${stale('o')} AS stale,a.status AS answer,a.created_at AS answered_at
 FROM avis_core_v2.fin_terminal_peer_messages o LEFT JOIN avis_core_v2.fin_terminal_peer_messages a ON a.answer_to=o.message_id
 WHERE o.profile_id=$1 AND o.direction='OUT' AND NOT (o.status='SENDING' AND NOT (${stale('o')}))`;
const iso=value=>value?new Date(value).toISOString():null;
const diagnostic=error=>{const code=error?.code||error?.message||'';return /^[A-Z0-9_]{1,64}$/.test(code)?code:'BANK_DELIVERY_ERROR';};

export class FinPeers{
 constructor(pool,{send=sendBankMessage,credentials=connectorCredentials}={}){this.pool=pool;this.transmit=send;this.credentials=credentials;}
 #administrator(actor){if(!actor?.admin)fault('FORBIDDEN',null,403);}
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
  const latest=(await this.pool.query(EXCHANGES+' ORDER BY o.sequence DESC LIMIT 1',[profileId])).rows[0];
  const session=(await this.pool.query(`WITH e AS (${EXCHANGES}),b AS (SELECT coalesce(max(sequence),0) AS at FROM e WHERE answer IS DISTINCT FROM 'ACK' OR event_code='END')
   SELECT min(e.answered_at) AS since,(SELECT max(created_at) FROM avis_core_v2.fin_terminal_peer_messages WHERE profile_id=$1 AND direction='IN') AS last_answer,now() AS now
   FROM e,b WHERE e.sequence>b.at AND e.event_code='INIT' AND e.answer='ACK'`,[profileId])).rows[0];
  const failed=latest&&(latest.stale||latest.status==='FAILED');
  const state=session.since?'READY':!latest||failed?'NOT_CONNECTED':latest.answer==='NAK'?'REFUSED':latest.answer==='ACK'&&latest.event_code==='END'?'CLOSED':'NO_SESSION';
  return {state,since:iso(session.since),lastAnswerAt:iso(session.last_answer),error:failed?(latest.stale?'NO_RESULT':latest.error_code):null,now:iso(session.now)};
 }
 async list(actor){
  this.#administrator(actor);
  return (await this.pool.query(PEERS+' ORDER BY c.display_name,p.profile_id')).rows.map(peerOf);
 }
 async messages(actor,profileId){
  this.#administrator(actor);
  const peer=await this.#peer(profileId),rows=(await this.pool.query(MESSAGES,[peer.profile_id])).rows.reverse();
  return {peer:peerOf(peer),link:await this.#link(peer.profile_id),messages:rows.map(messageOf)};
 }
 // The message is kept before it leaves, then with what became of it: the peer's answer, or why none came. A connector whose
 // certificate is not in place sends nothing and keeps nothing.
 async send(actor,profileId,body){
  this.#administrator(actor);
  if(typeof body?.event!=='string'||!Object.hasOwn(SESSION_EVENTS,body.event))fault('INVALID_FIELD','event');
  const text=this.#text(body.text),peer=await this.#peer(profileId),credentials=this.credentials(peer.credential_reference);
  const at=new Date(),businessMessageId=newMessageId(at),{code,parameters}=SESSION_EVENTS[body.event];
  const xml=buildSessionMessage({localBic:peer.local_bic,peerBic:peer.peer_bic,businessMessageId,event:body.event,text,at});
  if(!(await passes(xml,ADMI004)))fault('INVALID_FIELD','text');
  const messageId=randomUUID();
  await this.pool.query(`INSERT INTO avis_core_v2.fin_terminal_peer_messages(message_id,profile_id,direction,message_type,business_message_id,event_code,event_parameters,event_text,status,content,created_by)
   VALUES($1,$2,'OUT',$3,$4,$5,$6,$7,'SENDING',$8,$9)`,[messageId,peer.profile_id,ADMI004,businessMessageId,code,parameters,text||null,xml,String(actor.id)]);
  let answer=null,error=null;
  try{answer=await this.transmit(peer,xml,credentials);}catch(failure){error=diagnostic(failure);}
  // An answer is kept as it came; text cannot hold a zero byte.
  const received=typeof answer==='string'&&answer.length?answer.replaceAll('\0',''):null;
  const read=received&&await readPeerAnswer(received,{localBic:peer.local_bic,peerBic:peer.peer_bic});
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
}
