import {randomUUID,randomBytes,X509Certificate} from 'node:crypto';
import {isIP} from 'node:net';
import tls from 'node:tls';
import {readFile} from 'node:fs/promises';
import {validateXML} from 'xmllint-wasm';
import {XMLParser} from 'fast-xml-parser';
import {fault} from './core.mjs';
import {sendBankMessage,connectorCredentials} from './payment-transport.mjs';
import {HEAD,PACS008,PACS003,LIMITS,newMessageId,readFinMessage,normalizeForm} from '../public/fin-message.mjs';
import {ABIQ_ISSUER} from './avispay-core-accounts.mjs';
import {ServerDOMParser} from './fin-xml.mjs';
import {FinTerminal} from './fin-terminal.mjs';
import {FinAccess} from './fin-access.mjs';
import {PeerVault} from './peer-vault.mjs';

// Screen A of the FinTerminal, "Peer Server Handshake & Direct IP Interaction" in the bank owner's specification (FinTerminal
// Unified NOSTRO & Crypto System v3): the bank's welcome or session message to a peer bank's server - an ISO 20022 system event
// notification (admi.004.001.02) under its business application header (head.001.001.02) - sent through the payment server's
// own connection to that bank (src/payment-transport.mjs: mutual TLS with the bank connector's certificate), and the peer's
// answer as it came. Requested by the bank owner: "No simulators only active live software ready to connect and transact" - a
// peer that does not answer is not connected, and only what a peer sent is shown as its answer.
export const ADMI004='admi.004.001.02',ADMI002='admi.002.001.01',PACS002='pacs.002.001.10';
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
// The bank's answer to a peer's credit transfer (the FinTerminal specification v3: "returns pacs.002 (ACSC)"): the transfer's
// status, named by its message, end-to-end id and UETR - ACSC, booked, or RJCT with the reason and why.
export function buildPaymentStatus({original,endToEndId,uetr,status,reason=null,description=null,...head}){
 return enveloped(head,PACS002,['<FIToFIPmtStsRpt>','  <GrpHdr>','    <MsgId>'+esc(head.businessMessageId)+'</MsgId>','    <CreDtTm>'+stamp(head.at)+'</CreDtTm>','  </GrpHdr>',
  '  <OrgnlGrpInfAndSts>','    <OrgnlMsgId>'+esc(original)+'</OrgnlMsgId>','    <OrgnlMsgNmId>'+PACS008+'</OrgnlMsgNmId>','  </OrgnlGrpInfAndSts>',
  '  <TxInfAndSts>','    <OrgnlEndToEndId>'+esc(endToEndId)+'</OrgnlEndToEndId>','    <OrgnlUETR>'+esc(uetr)+'</OrgnlUETR>','    <TxSts>'+esc(status)+'</TxSts>',
  ...(reason?['    <StsRsnInf>','      <Rsn>','        <Cd>'+esc(reason)+'</Cd>','      </Rsn>',...(description?['      <AddtlInf>'+esc(description.slice(0,105))+'</AddtlInf>']:[]),'    </StsRsnInf>']:[]),
  '  </TxInfAndSts>','</FIToFIPmtStsRpt>']);
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
// The peer's answer to a credit transfer the bank sent (Screen B's Cash Wire): its status report naming that transfer - its message
// and its UETR - with the transfer's status and, refused, the reason and why (pacs.002.001.10, as the peer's own FinTerminal answers:
// buildPaymentStatus); or its reject of the message (admi.002.001.01). Anything else is kept as it came and shown with the reason.
// original: the kind of message sent, where its report must name it so (review finding: a Debit's status names a direct debit).
export async function readPeerStatus(xml,{localBic,peerBic,businessMessageId,uetr,own=[],original=null}){
 if(/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml))return {status:'UNREAD',reason:'NOT_ISO20022'};
 const type=[PACS002,ADMI002].find(type=>xml.includes(NAMESPACE+type));
 if(!type)return {status:'UNREAD',reason:'NOT_ISO20022'};
 if(!(await passes(xml,type)))return {status:'UNREAD',type,reason:'SCHEMA'};
 const parsed=parser.parse(xml),message=parsed.Envelope||parsed,header=message.AppHdr,document=message.Document;
 if(header&&(!sameBank(header.Fr?.FIId?.FinInstnId?.BICFI,peerBic)||!namedBank(header,localBic,own)||header.MsgDefIdr!==type))return {status:'UNREAD',type,reason:'HEADER'};
 const said={type,businessMessageId:header?.BizMsgIdr||null};
 if(type===ADMI002){
  const reject=document[ADMI002],named=reject.RltdRef.Ref===businessMessageId;
  return {...said,code:reject.Rsn.RjctgPtyRsn,parameters:[reject.RltdRef.Ref],text:reject.Rsn.RsnDesc||reject.Rsn.ErrLctn||null,status:named?'NAK':'UNREAD',reason:named?null:'OTHER_MESSAGE'};
 }
 // The message sent named - in the report's original group or in the transfer's own - and the transfer's status by its UETR; a
 // report on no transfer, the status of the message sent. Both blocks may be left out or repeated (pacs.002.001.10).
 const report=document.FIToFIPmtStsRpt,groups=[].concat(report.OrgnlGrpInfAndSts||[]),items=[].concat(report.TxInfAndSts||[]);
 const sent=entry=>entry?.OrgnlMsgId===businessMessageId&&(!original||entry.OrgnlMsgNmId===original);
 const item=items.find(entry=>entry.OrgnlUETR===uetr),group=groups.find(sent);
 const named=item?Boolean(group)||sent(item.OrgnlGrpInf):!items.length&&Boolean(group);
 const code=item?item.TxSts||group?.GrpSts||null:items.length?null:group?.GrpSts||null;
 const info=[].concat((item||group)?.StsRsnInf||[])[0],reason=info?.Rsn?.Cd||info?.Rsn?.Prtry||null,text=[].concat(info?.AddtlInf||[]).join(' ')||null;
 const answer={...said,code,parameters:[uetr,...(reason?[reason]:[])],text};
 return named&&code?{...answer,status:'ACK',reason:null}:{...answer,status:'UNREAD',reason:'OTHER_MESSAGE'};
}

// A peer's own message on the listening port (src/fin-listener.mjs), read as far as it is a session event from that peer to this
// bank - INIT_SESSION, HEARTBEAT or END_SESSION - or a credit transfer to it in its envelope (pacs.008.001.08, the FinTerminal
// specification v3's receive_ip2ip_pacs008), read into the composer's form; anything else is refused with the reason.
const EVENT_OF=Object.fromEntries(Object.entries(SESSION_EVENTS).map(([event,{code}])=>[code,event]));
export async function readPeerMessage(xml,{localBic,peerBic,own=[]}){
 if(/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml))return {status:'UNREAD',reason:'NOT_ISO20022'};
 const type=[ADMI004,PACS008].find(type=>xml.includes(NAMESPACE+type));
 if(!type){
  const other=[...xml.matchAll(/urn:iso:std:iso:20022:tech:xsd:([a-z]{4}\.\d{3}\.\d{3}\.\d{2})/g)].map(match=>match[1]).find(type=>type!==HEAD);
  return other?{status:'UNREAD',type:other,reason:'NOT_SUPPORTED'}:{status:'UNREAD',reason:'NOT_ISO20022'};
 }
 if(!(await passes(xml,type)))return {status:'UNREAD',type,reason:'SCHEMA'};
 const parsed=parser.parse(xml),message=parsed.Envelope||parsed,header=message.AppHdr;
 const bank=header?namedBank(header,localBic,own):null;
 // A message to the bank refused for its header is refused by the bank as the message named it (review finding); a transfer comes
 // with its header.
 if(header?!sameBank(header.Fr?.FIId?.FinInstnId?.BICFI,peerBic)||!bank||header.MsgDefIdr!==type:type===PACS008)
  return {status:'UNREAD',type,businessMessageId:header?.BizMsgIdr||null,reason:'HEADER',to:bank};
 if(type===PACS008){
  // One credit transfer per message (review finding: a batch's other transfers would go unanswered).
  const credit=message.Document.FIToFICstmrCdtTrf;
  if(Array.isArray(credit.CdtTrfTxInf)||credit.GrpHdr.NbOfTxs!=='1')return {status:'UNREAD',type,businessMessageId:header.BizMsgIdr||null,reason:'BATCH',to:bank};
  // Its status answer names it by its own message id (GrpHdr MsgId), which the header's need not repeat.
  const {form}=readFinMessage(xml,ServerDOMParser);
  return {status:'RECEIVED',type,businessMessageId:header.BizMsgIdr,code:null,parameters:[form.uetr],text:'RECEIVED '+form.amount+' '+form.currency,to:bank,transfer:form,
   original:credit.GrpHdr.MsgId};
 }
 // The bank answers as the peer named it: by the connector's BIC or by its ABIQ code.
 const notified=message.Document.SysEvtNtfctn.EvtInf;
 const said={type:ADMI004,businessMessageId:header?.BizMsgIdr||null,code:notified.EvtCd,parameters:notified.EvtParam||[],text:notified.EvtDesc||null,to:bank},
  event=EVENT_OF[said.code];
 return event?{...said,status:'RECEIVED',event}:{...said,status:'UNREAD',reason:'OTHER_EVENT'};
}
// The bank's answer to a peer's message: the same session event (INIT_SESSION with READY), or its refusal.
const ANSWERS={INIT:'WELCOME ACCEPTED // SESSION READY',HEARTBEAT:'HEARTBEAT ACCEPTED',END:'SESSION CLOSED'};
const REFUSALS={NOT_ISO20022:'Not an ISO 20022 message.',SCHEMA:'The message does not pass its official schema.',
 HEADER:'The business application header names other banks or another message.',OTHER_EVENT:'Session events taken: INIT, HBT and END.',
 NOT_SUPPORTED:'Only system event notifications (admi.004.001.02) and credit transfers (pacs.008.001.08) are taken on this connection.',
 BATCH:'One credit transfer per message is taken (NbOfTxs 1).'};

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

// The bank's connectors to peer banks (Administration, "Add bank connector", and the FinTerminal's register), enabled - every type
// that form registers. The bank owner: "Peer server is only our form or connection IP-IP, API, ISO20022". A peer server registered
// in the FinTerminal has no NOSTRO of its own (the bank owner: "Remove from the Peer register the NOSTRO account"); one registered
// with a NOSTRO before is offered while that NOSTRO is active.
const PEERS=`SELECT p.profile_id,p.protocol,c.display_name,c.endpoint_url,c.credential_reference,p.local_bic,p.peer_bic,p.cash_account_id,a.currency_code
 FROM avis_core_v2.bank_connector_profiles p JOIN avis_core_v2.platform_connectors c ON c.connector_code=p.profile_id
 LEFT JOIN avis_core_v2.external_cash_accounts a ON a.cash_account_id=p.cash_account_id
 WHERE p.protocol IN ('IP_TO_IP','BANK_API','SWIFT_ISO20022') AND c.is_enabled AND (p.cash_account_id IS NULL OR a.is_active)`;
const PROFILE=/^[A-Z0-9_]{1,35}$/;
// A peer server registered in the FinTerminal: one of the three types, its bank named by its BIC.
const REGISTER_PROTOCOLS=['IP_TO_IP','BANK_API','SWIFT_ISO20022'];
const BIC=/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
// The X.509 certificates of a PEM bundle that read as certificates.
const certificateBlocks=bundle=>(String(bundle||'').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)||[])
 .filter(item=>{try{new X509Certificate(item);return true;}catch{return false;}});
// The bank's own ABIQ code: its own ABIQ issuer's (ABIQ_ISSUER), while that issuer takes part in the ABIQ network
// (src/abiq-interface.mjs) - never the code of an issuer the bank licensed (review finding).
const OWN_ABIQ=`SELECT i.abiq_code FROM avis_core_v2.abiq_issuers i JOIN avis_core_v2.abiq_network_participants p USING(participant_code)
 WHERE i.participant_code=$1 AND p.abiq_bic=i.abiq_code AND p.is_active`;
const peerOf=(row,addresses=[])=>{const url=new URL(row.endpoint_url);return {profileId:row.profile_id,name:row.display_name,protocol:row.protocol,address:url.hostname+':'+(url.port||'443'),
 transport:url.protocol==='tls:'?'TLS':'HTTPS',localBic:row.local_bic,peerBic:row.peer_bic,currency:row.currency_code,addresses};};
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
// A wire's exchange: the transfer the bank sent and the peer's answer to it.
const EXCHANGE=`SELECT m.*,${stale('m')} AS stale,EXISTS(SELECT 1 FROM avis_core_v2.fin_terminal_peer_messages a WHERE a.answer_to=m.message_id) AS answered
 FROM avis_core_v2.fin_terminal_peer_messages m WHERE m.message_id=$1 OR m.answer_to=$1 ORDER BY m.sequence`;
const UETR=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// What becomes of a wire's money with the peer's answer: settled on the NOSTRO when the peer settled the transfer, returned when it
// refused it or never got it - its server not reached, its certificate or TLS refused, or the request refused before it was taken
// (HTTP 4xx). Any other answer, or none, may have reached it: the money stays held in the wires' suspense account.
const SETTLED=['ACSC','ACCC'];
const UNSENT=/^(CONNECTOR_CONFIGURATION|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_CERT_ALTNAME_INVALID|ERR_SSL_[A-Z0-9_]*ALERT[A-Z0-9_]*|ERR_SSL_WRONG_VERSION_NUMBER|ERR_SSL_UNSUPPORTED_PROTOCOL|BANK_HTTP_4\d\d)$/;
// The stream's words for it, the settled one as the specification's terminal writes a wire sent: "(NOSTRO & Core Synced)".
const OUTCOMES={SETTLED:'NOSTRO & Core Synced',RETURNED:'returned to the account',HELD:'held in suspense'};
// A wire's amount in euros, as its ledger keeps it with two decimals.
const cents=value=>{const [whole,fraction='']=String(value).split('.');return whole+'.'+fraction.padEnd(2,'0').slice(0,2);};
const wireOf=row=>({uetr:row.uetr,status:row.status,peerStatus:row.peer_status,reason:row.reason_code,amount:cents(row.amount),currency:row.currency_code,
 creditorName:row.creditor_name,creditorIban:row.creditor_iban,fourEyes:row.four_eyes,checkers:row.checkers});
// What became of a Debit in the stream: booked - "(NOSTRO & Core Synced)", as a settled transfer - or converted into the wallet;
// refused, or not taken by the debtor's bank; neither, not settled. Only a settled Debit is booked.
const DEBITED={SETTLED:'NOSTRO & Core Synced',CONVERTED:'converted into the wallet',REFUSED:'refused, nothing booked',HELD:'not settled, nothing booked'};
const debitOf=row=>({uetr:row.uetr,status:row.status,peerStatus:row.peer_status,reason:row.reason_code,amount:cents(row.amount),currency:row.currency_code,
 debtorName:row.debtor_name,debtorAccount:row.debtor_account,mandateId:row.mandate_id,wallet:row.token_wallet_account_id!==null,fourEyes:row.four_eyes,checkers:row.checkers});

export class FinPeers{
 constructor(pool,{send=sendBankMessage,credentials=connectorCredentials,terminal=new FinTerminal(pool),access=new FinAccess(pool),vault=new PeerVault()}={}){
  this.pool=pool;this.transmit=send;this.credentials=credentials;this.terminal=terminal;this.access=access;this.vault=vault;
 }
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
 // A peer server registered in the FinTerminal's popup. The bank owner: "+IP register must be active for registered senders IP by
 // incoming. The register is in a popup with IP and Bank name and login details into the receiver sever. (or for debit into the
 // sender service and first login) the data gets stored in a drop down for reuse". Its bank by its BIC, its type and its address
 // become a connector, its IP address is whitelisted for the listening port, and its login goes to Azure Key Vault only
 // (src/peer-vault.mjs) - first, so that nothing is registered without it. No NOSTRO: the bank owner, "the nostro account is the
 // job of the incoming transfer registration" - a transfer settles through the NOSTRO chosen with it; one that arrives is booked on
 // the bank's NOSTRO in its currency.
 async register(actor,body){
  this.#administrator(actor);
  const name=typeof body?.name==='string'?body.name.trim():'';
  if(!name||[...name].length>100||/[\x00-\x1f\x7f]/.test(name))fault('INVALID_FIELD','name');
  const bic=typeof body?.bic==='string'?body.bic.replace(/\s+/g,'').toUpperCase():'';
  if(!BIC.test(bic))fault('FIN_REGISTER_BIC','bic');
  if(!REGISTER_PROTOCOLS.includes(body?.protocol))fault('INVALID_FIELD','protocol');
  const endpoint=this.#endpoint(body.protocol,body.address),login=this.#login(body.protocol,body.login);
  const slug=name.toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,20).replace(/_+$/,'')||'PEER';
  const profileId='FIN_'+slug+'_'+randomBytes(3).toString('hex').toUpperCase(),secret='fin-peer-'+profileId.toLowerCase().replaceAll('_','-');
  await this.vault.put(secret,login);
  const client=await this.pool.connect();
  try{
   await client.query('BEGIN');
   await client.query('INSERT INTO avis_core_v2.platform_connectors(connector_code,display_name,is_enabled,endpoint_url,credential_reference) VALUES($1,$2,true,$3,$4)',
    [profileId,name,endpoint.url,'KEYVAULT:'+secret]);
   await client.query("INSERT INTO avis_core_v2.bank_connector_profiles(profile_id,cash_account_id,protocol,local_bic,peer_bic,operations) VALUES($1,NULL,$2,$3,$4,'{}')",
    [profileId,body.protocol,ABIQ_ISSUER.abiqCode,bic]);
   await client.query('INSERT INTO avis_core_v2.fin_terminal_peer_addresses(profile_id,address,created_by) VALUES($1,$2,$3)',[profileId,endpoint.address,String(actor.id)]);
   await client.query('INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,$2,$3)',[String(actor.id),'FIN_PEER_REGISTERED',profileId]);
   await client.query('COMMIT');
  }catch(failure){await client.query('ROLLBACK').catch(()=>{});throw failure;}
  finally{client.release?.();}
  return {profileId,peers:await this.list(actor)};
 }
 // The peer server's address as its IP address and port, as the specification writes it ("10.240.18.95:8443"): over TLS for
 // IP-to-IP, over HTTPS - with its path, where it has one - for API and ISO 20022.
 #endpoint(protocol,value){
  const match=typeof value==='string'?/^(\[[0-9A-Fa-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})(\/[A-Za-z0-9._~\/-]{0,200})?$/.exec(value.trim()):null;
  const host=match?match[1].replace(/^\[|\]$/g,''):'',port=Number(match?.[2]);
  if(!match||!isIP(host)||!(port>=1&&port<=65535)||protocol==='IP_TO_IP'&&match[3])fault('INVALID_FIELD','address');
  return {url:new URL((protocol==='IP_TO_IP'?'tls://':'https://')+match[1]+':'+port+(match[3]||'')).href,address:plainAddress(host)};
 }
 // The login the peer bank gave - the bank owner chose "Both": a certificate login (the peer's own issuer, the certificate and key
 // the bank shows, a shared secret where requests are signed), or a user name and password, which a server over HTTPS takes (its
 // issuer where the peer has its own). Over TLS (IP-to-IP) the bank shows its certificate.
 #login(protocol,value){
  const pem=field=>typeof value?.[field]==='string'&&value[field].length<=20000?value[field].trim():'';
  const issuers=certificateBlocks(pem('ca'));
  if(pem('ca')&&!issuers.length)fault('INVALID_FIELD','ca');
  if(value?.kind==='certificate'){
   const cert=pem('cert'),key=pem('key'),secret=typeof value.secret==='string'?value.secret:'';
   if(!issuers.length)fault('INVALID_FIELD','ca');
   if(!cert||!key)fault('INVALID_FIELD','cert');
   try{tls.createSecureContext({cert,key});}catch{fault('INVALID_FIELD','cert');}
   if(secret&&(Buffer.byteLength(secret)<32||Buffer.byteLength(secret)>1024||/[\x00-\x1f\x7f]/.test(secret)))fault('INVALID_FIELD','secret');
   return {kind:'certificate',ca:issuers.join('\n'),cert,key,...(secret?{hmacSecret:secret}:{})};
  }
  if(value?.kind==='password'){
   if(protocol==='IP_TO_IP')fault('FIN_REGISTER_LOGIN','login');
   const user=typeof value.user==='string'?value.user.trim():'',password=typeof value.password==='string'?value.password:'';
   if(!user||[...user].length>256||/[:\x00-\x1f\x7f]/.test(user))fault('INVALID_FIELD','user');
   if(!password||[...password].length>256||/[\x00-\x1f\x7f]/.test(password))fault('INVALID_FIELD','password');
   return {kind:'password',user,password,...(issuers.length?{ca:issuers.join('\n')}:{})};
  }
  fault('INVALID_FIELD','login');
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
 // What the operator wrote for a wire: the paying account, the amount in euros, the beneficiary's name and account, and its UETR, made
 // in the terminal (public/fin-wire.mjs) - Execute sent twice is one wire. The account is an IBAN or any other account number, taken
 // without a further check (the bank owner: "Accept all account numbers").
 #wire(body){
  const uetr=typeof body?.uetr==='string'?body.uetr.toLowerCase():'',bookingAccountId=typeof body?.bookingAccountId==='string'?body.bookingAccountId.toLowerCase():'';
  if(!UETR.test(uetr))fault('INVALID_FIELD','uetr');
  if(!ID.test(bookingAccountId))fault('FIN_BOOKING_ACCOUNT','bookingAccountId',409);
  const amount=typeof body?.amount==='string'?body.amount.trim().replace(/^0+(?=\d)/,''):'';
  if(!/^[0-9]{1,13}(\.[0-9]{1,2})?$/.test(amount)||!/[1-9]/.test(amount))fault('FIN_WIRE_AMOUNT','amount');
  const creditorName=typeof body?.creditorName==='string'?body.creditorName.trim():'';
  if(!creditorName||[...creditorName].length>140||/[\x00-\x1f\x7f]/.test(creditorName))fault('FIN_WIRE_BENEFICIARY','creditorName');
  const creditorIban=normalizeForm({creditorIban:typeof body?.creditorIban==='string'?body.creditorIban:''}).creditorIban;
  if(!creditorIban||creditorIban.length>LIMITS.creditorIban||/[\x00-\x1f\x7f]/.test(creditorIban))fault('FIN_WIRE_ACCOUNT','creditorIban');
  return {uetr,bookingAccountId,amount,creditorName,creditorIban};
 }
 // Screen B's Cash Wire (NOSTRO), the specification v3's "Execute & Dispatch": AVISPay PLC's account pays a beneficiary at the peer
 // bank (src/fin-terminal.mjs, cashWire), with PIN 1 and PIN 2 while 4-Eyes is on (src/fin-access.mjs). The bank owner: "pacs.008
 // sent; the paying account and the NOSTRO are debited; the pacs.002 answer shows in the message stream". The wire's money is
 // reserved and its message kept before it leaves, as a session message is kept; then the peer's answer as it came, and what became
 // of the money. Nothing leaves while the listening port is open.
 async dispatch(actor,person,profileId,body){
  this.#administrator(actor);
  const wire=this.#wire(body),peer=await this.#peer(profileId),credentials=this.credentials(peer.credential_reference);
  await this.#recover();
  const {form,xml}=await this.terminal.cashWire(peer,wire),check=await this.access.check(person,body);
  return this.#execute(actor,person,peer,credentials,check,{form,xml,bookingAccountId:wire.bookingAccountId,nostroAccountId:peer.cash_account_id,
   reserve:db=>this.terminal.reserveWire(db,actor,{form,bookingAccountId:wire.bookingAccountId,nostroAccountId:peer.cash_account_id})});
 }
 // Screen 1's Transact: the composer's outgoing message (src/fin-terminal.mjs, transactable) executed as a Cash Wire is, to the
 // Peer Server chosen above it - the bank sending as itself to that server's bank - settled through the NOSTRO chosen with it (the
 // bank owner: "Outgoing transfers from common accounts are delivered by ISO20022 direct via API connector service and settled by
 // our NOSTRO"), with PIN 1 and PIN 2 while 4-Eyes is on. Its message is closed with it (reserveTransact): the same message again
 // is refused.
 async transact(actor,person,profileId,body){
  this.#administrator(actor);
  const peer=await this.#peer(profileId),credentials=this.credentials(peer.credential_reference),message=await this.terminal.transactable(actor,body);
  if(message.form.senderBic!==peer.local_bic)fault('FIN_TRANSACT_SENDER','senderBic',409);
  if(message.form.receiverBic!==peer.peer_bic)fault('FIN_TRANSACT_RECEIVER','receiverBic',409);
  await this.#recover();
  const check=await this.access.check(person,body);
  if(message.direction==='DEBIT')return this.#debit(actor,person,peer,credentials,check,message);
  let draftId=null;
  const result=await this.#execute(actor,person,peer,credentials,check,{form:message.form,xml:message.xml,bookingAccountId:message.selection.bookingAccountId,
   nostroAccountId:message.selection.nostroAccountId,reserve:async db=>{const reserved=await this.terminal.reserveTransact(db,actor,message);draftId=reserved.draftId;return reserved;}});
  return {...result,draft:await this.terminal.draft(actor,draftId)};
 }
 // One execution for both: under the connector lock (#gate) the money is reserved and the message kept before it leaves.
 async #execute(actor,person,peer,credentials,check,{form,xml,bookingAccountId,nostroAccountId,reserve}){
  const messageId=randomUUID(),text=form.amount+' '+form.currency+' -> '+form.creditorIban;
  await underConnectorLock(this.pool,async db=>{
   await this.#gate(db,check);
   const reserved=await reserve(db);
   await db.query(`INSERT INTO avis_core_v2.fin_terminal_peer_messages(message_id,profile_id,direction,message_type,business_message_id,event_parameters,event_text,status,content,created_by)
    VALUES($1,$2,'OUT',$3,$4,$5,$6,'SENDING',$7,$8)`,[messageId,peer.profile_id,PACS008,form.businessMessageId,[form.uetr],text,xml,String(actor.id)]);
   await db.query(`INSERT INTO avis_core_v2.fin_terminal_wires(uetr,message_id,profile_id,booking_account_id,nostro_cash_account_id,suspense_account_id,amount,currency_code,
    creditor_name,creditor_iban,reserve_journal_id,four_eyes,checkers,dispatched_by,dispatched_by_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [form.uetr,messageId,peer.profile_id,bookingAccountId,nostroAccountId,reserved.suspense,form.amount,form.currency,form.creditorName,form.creditorIban,
     reserved.journalId,check.fourEyes,check.checkers,String(actor.id),person.name]);
   await db.query('INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,$2,$3)',[String(actor.id),'FIN_OUTGOING_DISPATCHED',form.uetr]);
  });
  // What came back is kept as it came before it is read (review finding): a wire whose finishing fails is finished later from it
  // (#recover), never sent again.
  const {received,error}=await this.#deliver(peer,xml,credentials);
  await this.pool.query(`UPDATE avis_core_v2.fin_terminal_wires SET answer=$2,delivery_error=$3,delivered_at=now(),updated_at=now() WHERE uetr=$1 AND status='SENDING'`,
   [form.uetr,received,error]);
  return this.#finish(form.uetr);
 }
 // Nothing leaves while the listening port is open, and 4-Eyes switched on since the PINs were looked at asks them first.
 async #gate(db,check){
  if((await db.query(LISTENING)).rows.length)fault('FIN_LISTENING',null,409);
  if((await db.query('SELECT four_eyes FROM avis_core_v2.fin_terminal_mode WHERE mode_id=1 FOR SHARE')).rows[0]?.four_eyes===true&&!check.fourEyes)fault('FIN_PIN','pin1');
 }
 // Over TLS 1.3, as the specification's connector; an answer as it came - text cannot hold a zero byte - or why none came.
 async #deliver(peer,xml,credentials){
  let answer=null,error=null;
  try{answer=await this.transmit(peer,xml,credentials,{minVersion:'TLSv1.3'});}catch(failure){error=diagnostic(failure);}
  return {received:typeof answer==='string'&&answer.length?answer.replaceAll('\0',''):null,error};
 }
 // Screen 1's Debit: the composer's direct debit (pacs.003) under the debtor's mandate, sent to their bank's Peer Server with the
 // login saved for it in the register, and PIN 1 and PIN 2 while 4-Eyes is on. The bank owner: "There is missing a function: Debit.
 // This is when we have authorisation for debiting an external connected account". Nothing is reserved - the money is the debtor's
 // until their bank settles it; the message is kept and closed before it leaves, with the rate a "+" wallet is loaded at.
 async #debit(actor,person,peer,credentials,check,message){
  const {form,xml,selection}=message,{wallet=null,quote=null}=selection.tokenWalletId?await this.terminal.debitQuote(selection.tokenWalletId,form):{};
  const messageId=randomUUID(),text='DEBIT '+form.amount+' '+form.currency+' <- '+form.debtorIban;let draftId;
  await underConnectorLock(this.pool,async db=>{
   await this.#gate(db,check);
   const kept=await this.terminal.keepDebit(db,actor,message);draftId=kept.draftId;
   await db.query(`INSERT INTO avis_core_v2.fin_terminal_peer_messages(message_id,profile_id,direction,message_type,business_message_id,event_parameters,event_text,status,content,created_by)
    VALUES($1,$2,'OUT',$3,$4,$5,$6,'SENDING',$7,$8)`,[messageId,peer.profile_id,PACS003,form.businessMessageId,[form.uetr],text,xml,String(actor.id)]);
   await db.query(`INSERT INTO avis_core_v2.fin_terminal_debits(uetr,message_id,draft_id,profile_id,booking_account_id,nostro_cash_account_id,nostro_ledger_account_id,
    token_wallet_account_id,asset,network,wallet_holder,wallet_address,rate,rate_source,rate_observed_at,amount,currency_code,debtor_name,debtor_account,mandate_id,
    mandate_signed,four_eyes,checkers,sent_by,sent_by_name,bank_fee) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::numeric)`,
    [form.uetr,messageId,draftId,peer.profile_id,selection.bookingAccountId,selection.nostroAccountId,kept.nostroLedger,selection.tokenWalletId,
     wallet?.currency_code??null,wallet?.network??null,wallet?.full_name??null,wallet?.public_address??null,quote?.rate??null,quote?.source??null,
     quote?quote.observedAt.toISOString():null,form.amount,form.currency,form.debtorName,form.debtorIban,form.mandateId,form.mandateSignatureDate,
     check.fourEyes,check.checkers,String(actor.id),person.name,message.bankFee??null]);
   await db.query('INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,$2,$3)',[String(actor.id),'FIN_DEBIT_SENT',form.uetr]);
  });
  const {received,error}=await this.#deliver(peer,xml,credentials);
  await this.pool.query(`UPDATE avis_core_v2.fin_terminal_debits SET answer=$2,delivery_error=$3,delivered_at=now(),updated_at=now() WHERE uetr=$1 AND status='SENDING'`,
   [form.uetr,received,error]);
  return {...await this.#finishDebit(form.uetr),draft:await this.terminal.draft(actor,draftId)};
 }
 // The peer's answer kept with a message the bank sent, read: settled (ACSC, ACCC); refused (RJCT, or its message rejected) or never
 // taken (UNSENT); or neither. original: the kind of message sent, where its report must name it so (readPeerStatus).
 async #answered(row,uetr,original=null){
  const known=row.delivered_at!=null,error=row.delivery_error;
  const read=known&&row.answer&&await readPeerStatus(row.answer,{localBic:row.local_bic,peerBic:row.peer_bic,businessMessageId:row.business_message_id,uetr,own:await this.#own(),original});
  const refused=read?.status==='NAK'||read?.status==='ACK'&&read.code==='RJCT';
  return {known,error,read,settled:read?.status==='ACK'&&SETTLED.includes(read.code),untaken:refused||known&&Boolean(error)&&UNSENT.test(error),
   peerStatus:read?.type===PACS002&&read.status==='ACK'?read.code:null,reason:refused?read.parameters[1]||read.code:null};
 }
 // The message sent and the peer's answer in the stream, with what became of it. Without a result the message stays as it was sent,
 // shown without result once its sending is a minute old.
 async #streamed(client,kept,row,{known,error,read},outcome){
  if(known)await client.query('UPDATE avis_core_v2.fin_terminal_peer_messages SET status=$2,error_code=$3,event_text=$4,updated_at=now() WHERE message_id=$1',
   [kept.message_id,error?'FAILED':'DELIVERED',error,row.event_text+' · '+outcome]);
  else await client.query('UPDATE avis_core_v2.fin_terminal_peer_messages SET event_text=$2 WHERE message_id=$1',[kept.message_id,row.event_text+' · '+outcome]);
  if(read)await client.query(`INSERT INTO avis_core_v2.fin_terminal_peer_messages(message_id,profile_id,direction,answer_to,message_type,business_message_id,event_code,event_parameters,event_text,status,error_code,content)
   VALUES($1,$2,'IN',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[randomUUID(),kept.profile_id,kept.message_id,read.type||null,read.businessMessageId||null,read.code||null,read.parameters||[],read.text||null,read.status,read.reason||null,row.answer]);
 }
 // A wire sent, finished: the peer's answer read, what became of its money booked and both in the stream, in one transaction - booked
 // for whoever dispatched it. Nothing kept of what came back, its result is unknown and its money held. Finished meanwhile, it is
 // shown as it is.
 async #finish(uetr){
  const wire=(await this.pool.query(`SELECT w.*,m.business_message_id,m.event_text,p.local_bic,p.peer_bic FROM avis_core_v2.fin_terminal_wires w
   JOIN avis_core_v2.fin_terminal_peer_messages m USING(message_id) JOIN avis_core_v2.bank_connector_profiles p ON p.profile_id=w.profile_id WHERE w.uetr=$1`,[uetr])).rows[0];
  const answered=await this.#answered(wire,uetr),outcome=answered.settled?'SETTLED':answered.untaken?'RETURNED':'HELD';
  const client=await this.pool.connect();let kept;
  try{
   await client.query('BEGIN');
   kept=(await client.query('SELECT * FROM avis_core_v2.fin_terminal_wires WHERE uetr=$1 FOR UPDATE',[uetr])).rows[0];
   if(kept.status==='SENDING'){
    const journalId=outcome==='HELD'?null:await this.terminal.finishWire(client,{id:kept.dispatched_by},kept,outcome==='SETTLED',answered.read?.businessMessageId||wire.business_message_id);
    await this.#streamed(client,kept,wire,answered,OUTCOMES[outcome]);
    kept=(await client.query(`UPDATE avis_core_v2.fin_terminal_wires SET status=$2,peer_status=$3,reason_code=$4,settle_journal_id=$5,updated_at=now() WHERE uetr=$1 RETURNING *`,
     [uetr,outcome,answered.peerStatus,answered.reason,journalId])).rows[0];
   }
   await client.query('COMMIT');
  }catch(failure){await client.query('ROLLBACK').catch(()=>{});throw failure;}
  finally{client.release?.();}
  return {wire:wireOf(kept),messages:(await this.pool.query(EXCHANGE,[kept.message_id])).rows.map(messageOf)};
 }
 // A Debit sent, finished as a wire is: settled by the debtor's bank, its money booked (src/fin-terminal.mjs, bookDebit) - for whoever
 // sent it - and both in the stream, in one transaction; refused or not taken, nothing is booked; neither, nothing is booked either.
 async #finishDebit(uetr){
  const debit=(await this.pool.query(`SELECT b.*,m.business_message_id,m.event_text,p.local_bic,p.peer_bic FROM avis_core_v2.fin_terminal_debits b
   JOIN avis_core_v2.fin_terminal_peer_messages m USING(message_id) JOIN avis_core_v2.bank_connector_profiles p ON p.profile_id=b.profile_id WHERE b.uetr=$1`,[uetr])).rows[0];
  const answered=await this.#answered(debit,uetr,PACS003),outcome=answered.settled?'SETTLED':answered.untaken?'REFUSED':'HELD';
  const client=await this.pool.connect();let kept;
  try{
   await client.query('BEGIN');
   kept=(await client.query('SELECT * FROM avis_core_v2.fin_terminal_debits WHERE uetr=$1 FOR UPDATE',[uetr])).rows[0];
   if(kept.status==='SENDING'){
    const journalId=outcome==='SETTLED'?await this.terminal.bookDebit(client,{id:kept.sent_by},kept):null;
    await this.#streamed(client,kept,debit,answered,DEBITED[outcome==='SETTLED'&&kept.token_wallet_account_id?'CONVERTED':outcome]);
    kept=(await client.query(`UPDATE avis_core_v2.fin_terminal_debits SET status=$2,peer_status=$3,reason_code=$4,booked_journal_id=$5,updated_at=now() WHERE uetr=$1 RETURNING *`,
     [uetr,outcome,answered.peerStatus,answered.reason,journalId])).rows[0];
   }
   await client.query('COMMIT');
  }catch(failure){await client.query('ROLLBACK').catch(()=>{});throw failure;}
  finally{client.release?.();}
  return {debit:debitOf(kept),messages:(await this.pool.query(EXCHANGE,[kept.message_id])).rows.map(messageOf)};
 }
 // Wires and Debits whose finishing never completed - the bank's database failed, or the bank stopped, after they left - finished at
 // the next Execute & Dispatch or Transact: the transport gives up after 15 seconds, so one still sending a minute on has its result
 // kept, or none.
 // One that cannot be finished now is left for the next time; it never holds the others up.
 async #recover(){
  const stuck=(await this.pool.query(`SELECT uetr,debit FROM (SELECT uetr,created_at,false AS debit FROM avis_core_v2.fin_terminal_wires
   WHERE status='SENDING' AND updated_at<now()-interval '1 minute' UNION ALL SELECT uetr,created_at,true FROM avis_core_v2.fin_terminal_debits
   WHERE status='SENDING' AND updated_at<now()-interval '1 minute') s ORDER BY created_at LIMIT 20`)).rows;
  for(const {uetr,debit} of stuck)await (debit?this.#finishDebit(uetr):this.#finish(uetr)).catch(()=>null);
 }
 // A peer's own message, taken on the listening port once its TLS, certificate and IP address were checked (src/fin-listener.mjs):
 // kept as it came, with the bank's answer as it leaves; the listener tells what became of the answer.
 // A peer's credit transfer is booked at once (src/fin-terminal.mjs) in the same transaction, and answered with its status; one to
 // be converted into crypto has its live rate read before.
 async receive(profileId,xml){
  const peer=await this.#peer(profileId),received=String(xml).replaceAll('\0','');
  const read=await readPeerMessage(received,{localBic:peer.local_bic,peerBic:peer.peer_bic,own:await this.#own()});
  const at=new Date(),head={localBic:read.to||peer.local_bic,peerBic:peer.peer_bic,businessMessageId:newMessageId(at),at};
  const transfer=read.status==='RECEIVED'&&read.type===PACS008?read.transfer:null;
  const messageId=randomUUID(),answerId=randomUUID();
  let answer;
  // A transfer's live rate is read before its transaction; read again once when its account's route changed meanwhile (review
  // finding), and refused if it changed again.
  for(let attempt=1;;attempt++){
   const quote=transfer&&await this.terminal.quoteIncoming(transfer),client=await this.pool.connect();
   try{
    await client.query('BEGIN');
    const settled=transfer&&await this.terminal.receiveIncoming(client,peer,transfer,quote);
    if(settled?.stale&&attempt<2){await client.query('ROLLBACK');continue;}
    answer=settled?{type:PACS002,code:settled.status,parameters:[transfer.uetr,...(settled.reason?[settled.reason]:[])],text:settled.text,
      xml:buildPaymentStatus({...head,original:read.original,endToEndId:transfer.endToEndId,uetr:transfer.uetr,status:settled.status,reason:settled.reason,description:settled.text})}
     :read.status==='RECEIVED'
     ?{type:ADMI004,code:SESSION_EVENTS[read.event].code,parameters:SESSION_EVENTS[read.event].parameters,text:ANSWERS[read.event],xml:buildSessionMessage({...head,event:read.event,text:ANSWERS[read.event]})}
     :{type:ADMI002,code:read.reason,parameters:[read.businessMessageId||'NONE'],text:REFUSALS[read.reason],
      xml:buildReject({...head,reference:read.businessMessageId||'NONE',reason:read.reason,description:REFUSALS[read.reason]})};
    if(!(await passes(answer.xml,answer.type)))fault('FIN_MESSAGE_INVALID');
    // As the specification's stream writes it: "RECEIVED <amount> -> <settlement>".
    const text=settled?read.text+' -> '+(settled.status==='RJCT'?'RJCT '+settled.reason:settled.text):read.text;
    await client.query(`INSERT INTO avis_core_v2.fin_terminal_peer_messages(message_id,profile_id,direction,message_type,business_message_id,event_code,event_parameters,event_text,status,error_code,content)
     VALUES($1,$2,'IN',$3,$4,$5,$6,$7,$8,$9,$10)`,[messageId,peer.profile_id,read.type||null,read.businessMessageId||null,read.code||null,read.parameters||[],text||null,read.status,read.reason||null,received]);
    await client.query(`INSERT INTO avis_core_v2.fin_terminal_peer_messages(message_id,profile_id,direction,answer_to,message_type,business_message_id,event_code,event_parameters,event_text,status,content,created_by)
     VALUES($1,$2,'OUT',$3,$4,$5,$6,$7,$8,'SENDING',$9,'listener')`,[answerId,peer.profile_id,messageId,answer.type,head.businessMessageId,answer.code,answer.parameters,answer.text,answer.xml]);
    await client.query('COMMIT');
    break;
   }catch(failure){await client.query('ROLLBACK').catch(()=>{});throw failure;}
   finally{client.release?.();}
  }
  return {answer:answer.xml,delivered:error=>this.pool.query('UPDATE avis_core_v2.fin_terminal_peer_messages SET status=$2,error_code=$3,updated_at=now() WHERE message_id=$1',
   [answerId,error?'FAILED':'DELIVERED',error?diagnostic(error):null])};
 }
}
