import {readFile} from 'node:fs/promises';
import {XMLParser} from 'fast-xml-parser';
import {validateXML} from 'xmllint-wasm';
import {fault,text,money,decimal} from './core.mjs';
import {normalizeIban} from './avispay-correspondent-mapping.mjs';
const parser=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false,trimValues:true,processEntities:true});
const schemaCache=new Map(),types=['pacs.008.001.08','pacs.002.001.10'];
const esc=v=>String(v).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const one=v=>{if(!v||Array.isArray(v))fault('SINGLE_TRANSACTION_REQUIRED','message');return v;};
const uuid=v=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v||''))fault('INVALID_UETR','uetr');return v;};
const bic=v=>{if(!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v||''))fault('INVALID_BIC','bic');return v;};
const agent=b=>'<FinInstnId><BICFI>'+bic(b)+'</BICFI></FinInstnId>';
const account=(v,kind='IBAN')=>{
 if(kind==='IBAN')return '<Id><IBAN>'+normalizeIban(v)+'</IBAN></Id>';
 if(kind!=='OTHER'||!/^[A-Z0-9]{1,34}$/.test(v||''))fault('INVALID_ACCOUNT','account');
 return '<Id><Othr><Id>'+esc(v)+'</Id></Othr></Id>';
};
const readAccount=v=>v?.Id?.IBAN?normalizeIban(v.Id.IBAN):text(v?.Id?.Othr?.Id,'account',34);
const postal=p=>p?'<PstlAdr><StrtNm>'+esc(text(p.street,'street',70))+'</StrtNm>'+(p.postalCode?'<PstCd>'+esc(text(p.postalCode,'postalCode',16))+'</PstCd>':'')+'<TwnNm>'+esc(text(p.city,'city',35))+'</TwnNm><Ctry>'+esc(text(p.country,'country',2))+'</Ctry></PstlAdr>':'';
export async function readIso20022(xml){
 if(typeof xml!=='string'||Buffer.byteLength(xml)>65535||/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml))fault('INVALID_XML','message');
 const type=/urn:iso:std:iso:20022:tech:xsd:(pacs\.\d{3}\.\d{3}\.\d{2})/.exec(xml)?.[1];
 if(!types.includes(type))fault('UNSUPPORTED_MESSAGE','message');
 if(!schemaCache.has(type))schemaCache.set(type,await readFile(new URL('../schemas/'+type+'.xsd',import.meta.url),'utf8'));
 if(!(await validateXML({xml,schema:schemaCache.get(type),maxMemoryPages:512})).valid)fault('INVALID_XML_SCHEMA','message');
 const document=parser.parse(xml).Document;
 if(type==='pacs.008.001.08'){
  const p=one(document.FIToFICstmrCdtTrf),tx=one(p.CdtTrfTxInf),header=one(p.GrpHdr);
  if(header.NbOfTxs!=='1')fault('SINGLE_TRANSACTION_REQUIRED','message');
  const amount=decimal(money(tx.IntrBkSttlmAmt['#text'],6),6),currency=tx.IntrBkSttlmAmt['@_Ccy'];
  if(header.CtrlSum&&money(header.CtrlSum,6)!==money(amount,6))fault('MESSAGE_TOTAL_MISMATCH','message');
  return {type,messageId:text(header.MsgId,'messageId',35),uetr:uuid(tx.PmtId?.UETR),endToEndId:text(tx.PmtId?.EndToEndId,'endToEndId',35),
   amount,currency,debtorIban:readAccount(tx.DbtrAcct),creditorIban:readAccount(tx.CdtrAcct),
   debtorName:text(tx.Dbtr?.Nm,'debtorName',140),creditorName:text(tx.Cdtr?.Nm,'creditorName',140),
   senderBic:bic(header.InstgAgt?.FinInstnId?.BICFI),receiverBic:bic(header.InstdAgt?.FinInstnId?.BICFI),reference:tx.RmtInf?.Ustrd||tx.PmtId.EndToEndId,creditorBic:bic(tx.CdtrAgt?.FinInstnId?.BICFI),creditorAddress:tx.Cdtr?.PstlAdr||null};
 }
 const p=one(document.FIToFIPmtStsRpt),tx=one(p.TxInfAndSts),header=one(p.GrpHdr);
 if(!['ACTC','ACSP','ACCC','RJCT','PDNG'].includes(tx.TxSts))fault('UNSUPPORTED_PAYMENT_STATUS','message');
 return {type,messageId:text(header.MsgId,'messageId',35),uetr:uuid(tx.OrgnlUETR),status:tx.TxSts,
  senderBic:bic(header.InstgAgt?.FinInstnId?.BICFI),receiverBic:bic(header.InstdAgt?.FinInstnId?.BICFI),bankReference:tx.AcctSvcrRef||header.MsgId};
}
export async function buildPacs008(p){
 const amount=decimal(money(p.amount,6),6),id=esc(text(p.messageId,'messageId',35)),uetr=uuid(p.uetr),date=p.date||new Date().toISOString().slice(0,10);
 const xml=`<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"><FIToFICstmrCdtTrf><GrpHdr><MsgId>${id}</MsgId><CreDtTm>${p.createdAt||new Date().toISOString()}</CreDtTm><NbOfTxs>1</NbOfTxs><CtrlSum>${amount}</CtrlSum><SttlmInf><SttlmMtd>INDA</SttlmMtd></SttlmInf><InstgAgt>${agent(p.senderBic)}</InstgAgt><InstdAgt>${agent(p.receiverBic)}</InstdAgt></GrpHdr><CdtTrfTxInf><PmtId><EndToEndId>${esc(text(p.endToEndId,'endToEndId',35))}</EndToEndId><UETR>${uetr}</UETR></PmtId><IntrBkSttlmAmt Ccy="${esc(p.currency)}">${amount}</IntrBkSttlmAmt><IntrBkSttlmDt>${esc(date)}</IntrBkSttlmDt><ChrgBr>SHAR</ChrgBr><Dbtr><Nm>${esc(text(p.debtorName,'debtorName',140))}</Nm></Dbtr><DbtrAcct>${account(p.debtorIban,p.debtorAccountType)}</DbtrAcct><DbtrAgt>${agent(p.senderBic)}</DbtrAgt><CdtrAgt>${agent(p.creditorBic||p.receiverBic)}</CdtrAgt><Cdtr><Nm>${esc(text(p.creditorName,'creditorName',140))}</Nm>${postal(p.creditorAddress)}</Cdtr><CdtrAcct>${account(p.creditorIban,p.creditorAccountType)}</CdtrAcct><RmtInf><Ustrd>${esc(text(p.reference,'reference',140))}</Ustrd></RmtInf></CdtTrfTxInf></FIToFICstmrCdtTrf></Document>`;
 await readIso20022(xml);return xml;
}
export async function buildPacs002(p){
 const xml=`<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10"><FIToFIPmtStsRpt><GrpHdr><MsgId>${esc(text(p.messageId,'messageId',35))}</MsgId><CreDtTm>${new Date().toISOString()}</CreDtTm><InstgAgt>${agent(p.senderBic)}</InstgAgt><InstdAgt>${agent(p.receiverBic)}</InstdAgt></GrpHdr><TxInfAndSts><OrgnlUETR>${uuid(p.uetr)}</OrgnlUETR><TxSts>${esc(p.status)}</TxSts><AcctSvcrRef>${esc(text(p.bankReference||p.messageId,'bankReference',35))}</AcctSvcrRef></TxInfAndSts></FIToFIPmtStsRpt></Document>`;
 await readIso20022(xml);return xml;
}
