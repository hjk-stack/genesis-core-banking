// One ISO 20022 business message of the FinTerminal's composer (fin-terminal.mjs): its business application header
// (head.001.001.02) and one FI-to-FI customer credit transfer (pacs.008.001.08), in the order their official schemas
// (schemas/) give, side by side in one envelope. The same module builds the XML in the terminal's window and on the server
// (src/fin-terminal.mjs), and reads the XML back into the form: requested by the bank owner, "live two-way XML
// synchronization" of the FinTerminal ISO 20022 specification.
export const HEAD='head.001.001.02',PACS008='pacs.008.001.08';
const namespace=type=>'urn:iso:std:iso:20022:tech:xsd:'+type;
export const PRIORITIES={'HIGH/URGP':['HIGH','URGP'],'NORM/NURG':['NORM','NURG']};
export const SETTLEMENTS={'CLRG/TGT':['CLRG','TGT'],INDA:['INDA',''],INGA:['INGA','']};
export const CHARGE_BEARERS=['SHAR','DEBT','CRED','SLEV'];
export const FIELDS=Object.freeze(['messageType','businessMessageId','createdAt','senderBic','receiverBic','uetr','endToEndId','priority',
 'currency','amount','valueDate','chargeBearer','settlement','debtorName','debtorIban','debtorAgentBic','creditorName','creditorIban',
 'creditorAgentBic','intermediaryBic','intermediaryLei','ultimateDebtorName','ultimateDebtorLei','ultimateCreditorName',
 'ultimateCreditorLei','structuredReference','unstructuredRemittance','regulatoryCountry','regulatoryCode','regulatoryDetails']);
// The longest each field may be: its element's own limit, the details ten Inf elements of 35.
export const LIMITS=Object.freeze({messageType:15,businessMessageId:35,createdAt:35,senderBic:11,receiverBic:11,uetr:36,endToEndId:35,
 priority:9,currency:3,amount:25,valueDate:10,chargeBearer:4,settlement:8,debtorName:140,debtorIban:34,debtorAgentBic:11,creditorName:140,
 creditorIban:34,creditorAgentBic:11,intermediaryBic:11,intermediaryLei:20,ultimateDebtorName:140,ultimateDebtorLei:20,ultimateCreditorName:140,
 ultimateCreditorLei:20,structuredReference:35,unstructuredRemittance:140,regulatoryCountry:2,regulatoryCode:10,regulatoryDetails:359});

export const newUetr=()=>globalThis.crypto.randomUUID();
const stamp=now=>now.toISOString().slice(0,19)+'Z';
export function newMessageId(now=new Date()){
 const letters='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',random=globalThis.crypto.getRandomValues(new Uint8Array(4));
 return 'FT'+stamp(now).replace(/[^0-9]/g,'')+[...random].map(n=>letters[n%letters.length]).join('');
}
export function blankForm(now=new Date()){
 return {...Object.fromEntries(FIELDS.map(field=>[field,''])),messageType:PACS008,businessMessageId:newMessageId(now),createdAt:stamp(now),uetr:newUetr(),
  endToEndId:'NOTPROVIDED',priority:'HIGH/URGP',currency:'EUR',valueDate:stamp(now).slice(0,10),chargeBearer:'SHAR',settlement:'CLRG/TGT'};
}
// Every field as text, trimmed; the details with single spaces, as the XML gives them back; codes written as their schema
// has them - IBANs, BICs and LEIs in capitals without spaces (an IBAN is often written in groups of four), the UETR in small
// letters.
const CODES=new Set(['senderBic','receiverBic','debtorIban','debtorAgentBic','creditorIban','creditorAgentBic','intermediaryBic','intermediaryLei',
 'ultimateDebtorLei','ultimateCreditorLei','currency','regulatoryCountry']);
export function normalizeForm(input={}){
 const form={};
 for(const field of FIELDS){
  const value=typeof input?.[field]==='string'?input[field].trim():'';
  form[field]=field==='regulatoryDetails'?value.replace(/\s+/g,' '):CODES.has(field)?value.replace(/\s+/g,'').toUpperCase():field==='uetr'?value.toLowerCase():value;
 }
 return form;
}

const esc=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
// An element: its text, or its children with the empty optional ones left out; an optional element with nothing in it is
// left out too, a required one stays (empty) so its place shows in the XML.
const node=(name,content,{optional=false,attrs={}}={})=>{
 const children=Array.isArray(content)?content.filter(Boolean):null;
 if(optional&&(children?!children.length:!content))return null;
 return {name,content:children??String(content??''),attrs};
};
const optional=(name,content,attrs)=>node(name,content,{optional:true,attrs});
function serialize(element,depth){
 const pad='  '.repeat(depth),attrs=Object.entries(element.attrs).map(([key,value])=>' '+key+'="'+esc(value)+'"').join('');
 if(!Array.isArray(element.content))return pad+'<'+element.name+attrs+'>'+esc(element.content)+'</'+element.name+'>';
 return pad+'<'+element.name+attrs+'>\n'+element.content.map(child=>serialize(child,depth+1)).join('\n')+'\n'+pad+'</'+element.name+'>';
}
const agent=(name,bic,lei='',isOptional=false)=>isOptional&&!bic&&!lei?null:node(name,[node('FinInstnId',[isOptional?optional('BICFI',bic):node('BICFI',bic),optional('LEI',lei)])]);
const party=(name,partyName,lei)=>optional(name,[optional('Nm',partyName),optional('Id',[optional('OrgId',[optional('LEI',lei)])])]);
// The details in pieces of at most 35 characters (Inf is Max35Text), broken between words where it can.
export function detailPieces(text){
 const pieces=[];let current='';
 for(const word of String(text||'').split(' ').filter(Boolean)){
  for(let rest=word;rest;){
   const room=current?34-current.length:35;
   if(rest.length<=room){current=current?current+' '+rest:rest;rest='';}
   else if(current){pieces.push(current);current='';}
   else{pieces.push(rest.slice(0,35));rest=rest.slice(35);}
  }
 }
 if(current)pieces.push(current);
 return pieces;
}
export function buildFinMessage(input){
 const f=normalizeForm(input),[priority,serviceLevel]=PRIORITIES[f.priority]||['',''],[method,clearing]=SETTLEMENTS[f.settlement]||[f.settlement,''];
 const header=node('AppHdr',[
  node('Fr',[node('FIId',[node('FinInstnId',[node('BICFI',f.senderBic)])])]),
  node('To',[node('FIId',[node('FinInstnId',[node('BICFI',f.receiverBic)])])]),
  node('BizMsgIdr',f.businessMessageId),node('MsgDefIdr',f.messageType),node('CreDt',f.createdAt)],{attrs:{xmlns:namespace(HEAD)}});
 const transfer=node('CdtTrfTxInf',[
  node('PmtId',[node('EndToEndId',f.endToEndId),node('UETR',f.uetr)]),
  optional('PmtTpInf',[optional('InstrPrty',priority),optional('SvcLvl',[optional('Cd',serviceLevel)])]),
  node('IntrBkSttlmAmt',f.amount,{attrs:{Ccy:f.currency}}),node('IntrBkSttlmDt',f.valueDate),node('ChrgBr',f.chargeBearer),
  agent('IntrmyAgt1',f.intermediaryBic,f.intermediaryLei,true),
  party('UltmtDbtr',f.ultimateDebtorName,f.ultimateDebtorLei),
  node('Dbtr',[node('Nm',f.debtorName)]),node('DbtrAcct',[node('Id',[node('IBAN',f.debtorIban)])]),agent('DbtrAgt',f.debtorAgentBic),
  agent('CdtrAgt',f.creditorAgentBic),node('Cdtr',[node('Nm',f.creditorName)]),node('CdtrAcct',[node('Id',[node('IBAN',f.creditorIban)])]),
  party('UltmtCdtr',f.ultimateCreditorName,f.ultimateCreditorLei),
  optional('RgltryRptg',[optional('Authrty',[optional('Ctry',f.regulatoryCountry)]),optional('Dtls',[optional('Cd',f.regulatoryCode),...detailPieces(f.regulatoryDetails).map(piece=>node('Inf',piece))])]),
  optional('RmtInf',[optional('Ustrd',f.unstructuredRemittance),optional('Strd',[optional('CdtrRefInf',f.structuredReference&&[node('Tp',[node('CdOrPrtry',[node('Cd','SCOR')])]),node('Ref',f.structuredReference)])])])]);
 const document=node('Document',[node('FIToFICstmrCdtTrf',[
  node('GrpHdr',[node('MsgId',f.businessMessageId),node('CreDtTm',f.createdAt),node('NbOfTxs','1'),
   node('SttlmInf',[node('SttlmMtd',method),optional('ClrSys',[optional('Cd',clearing)])]),
   agent('InstgAgt',f.senderBic),agent('InstdAgt',f.receiverBic)]),transfer])],{attrs:{xmlns:namespace(f.messageType||PACS008)}});
 return '<?xml version="1.0" encoding="UTF-8"?>\n'+serialize(node('Envelope',[header,document]),0)+'\n';
}

// The XML read back into the form - in the window with its own DOMParser. Elements the form has no field for are not read.
export function readFinMessage(xml,DOMParserImpl=globalThis.DOMParser){
 if(/<!DOCTYPE|<!ENTITY/i.test(xml))return {error:'A document type is not allowed.'};
 const doc=new DOMParserImpl().parseFromString(xml,'application/xml');
 const broken=doc.getElementsByTagName('parsererror')[0];
 if(broken)return {error:(broken.textContent||'The XML is not well formed.').replace(/\s+/g,' ').trim().slice(0,200)};
 const kids=element=>element?[...element.childNodes].filter(node=>node.nodeType===1):[];
 const at=(element,...path)=>{for(const step of path)element=kids(element).find(child=>child.localName===step);return element||null;};
 const root=doc.documentElement,part=name=>root?.localName===name?root:kids(root).find(child=>child.localName===name)||null;
 const header=part('AppHdr'),document=part('Document');
 if(!header||!document)return {error:'The XML needs its AppHdr and its Document.'};
 const value=(element,...path)=>at(element,...path)?.textContent.trim()||'';
 const credit=at(document,'FIToFICstmrCdtTrf'),group=at(credit,'GrpHdr'),tx=at(credit,'CdtTrfTxInf');
 const amount=at(tx,'IntrBkSttlmAmt'),pick=(table,...codes)=>Object.keys(table).find(key=>table[key].every((code,i)=>code===(codes[i]||'')))||'';
 const details=at(tx,'RgltryRptg','Dtls');
 const form={
  messageType:value(header,'MsgDefIdr')||(document.namespaceURI||'').split(':').pop(),businessMessageId:value(header,'BizMsgIdr'),createdAt:value(header,'CreDt'),
  senderBic:value(header,'Fr','FIId','FinInstnId','BICFI'),receiverBic:value(header,'To','FIId','FinInstnId','BICFI'),
  uetr:value(tx,'PmtId','UETR'),endToEndId:value(tx,'PmtId','EndToEndId'),
  priority:pick(PRIORITIES,value(tx,'PmtTpInf','InstrPrty'),value(tx,'PmtTpInf','SvcLvl','Cd')),
  currency:amount?.getAttribute('Ccy')?.trim()||'',amount:amount?.textContent.trim()||'',valueDate:value(tx,'IntrBkSttlmDt'),chargeBearer:value(tx,'ChrgBr'),
  settlement:pick(SETTLEMENTS,value(group,'SttlmInf','SttlmMtd'),value(group,'SttlmInf','ClrSys','Cd'))||value(group,'SttlmInf','SttlmMtd'),
  debtorName:value(tx,'Dbtr','Nm'),debtorIban:value(tx,'DbtrAcct','Id','IBAN'),debtorAgentBic:value(tx,'DbtrAgt','FinInstnId','BICFI'),
  creditorName:value(tx,'Cdtr','Nm'),creditorIban:value(tx,'CdtrAcct','Id','IBAN'),creditorAgentBic:value(tx,'CdtrAgt','FinInstnId','BICFI'),
  intermediaryBic:value(tx,'IntrmyAgt1','FinInstnId','BICFI'),intermediaryLei:value(tx,'IntrmyAgt1','FinInstnId','LEI'),
  ultimateDebtorName:value(tx,'UltmtDbtr','Nm'),ultimateDebtorLei:value(tx,'UltmtDbtr','Id','OrgId','LEI'),
  ultimateCreditorName:value(tx,'UltmtCdtr','Nm'),ultimateCreditorLei:value(tx,'UltmtCdtr','Id','OrgId','LEI'),
  structuredReference:value(tx,'RmtInf','Strd','CdtrRefInf','Ref'),unstructuredRemittance:value(tx,'RmtInf','Ustrd'),
  regulatoryCountry:value(tx,'RgltryRptg','Authrty','Ctry'),regulatoryCode:value(details,'Cd'),
  regulatoryDetails:kids(details).filter(child=>child.localName==='Inf').map(child=>child.textContent.trim()).filter(Boolean).join(' '),
 };
 return {form:normalizeForm(form)};
}

// What a schema does not check: the check digits of an IBAN and of an LEI (ISO 13616 and ISO 17442, both modulo 97).
const mod97=text=>[...text].reduce((rest,character)=>{const digits=/[A-Z]/.test(character)?String(character.charCodeAt(0)-55):character;return Number(String(rest)+digits)%97;},0);
export const ibanValid=iban=>/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)&&mod97(iban.slice(4)+iban.slice(0,4))===1;
export const leiValid=lei=>/^[A-Z0-9]{18}[0-9]{2}$/.test(lei)&&mod97(lei)===1;
export function fieldProblems(input){
 const f=normalizeForm(input),problems=[];
 for(const field of ['debtorIban','creditorIban'])if(f[field]&&!ibanValid(f[field]))problems.push({field,message:'The IBAN\'s check digits do not match.'});
 for(const field of ['intermediaryLei','ultimateDebtorLei','ultimateCreditorLei'])if(f[field]&&!leiValid(f[field]))problems.push({field,message:'The LEI\'s check digits do not match.'});
 if(f.amount&&!(/^[0-9]{1,13}(\.[0-9]{1,5})?$/.test(f.amount)&&/[1-9]/.test(f.amount)))problems.push({field:'amount',message:'The amount is a number above zero with at most five decimals.'});
 return problems;
}
