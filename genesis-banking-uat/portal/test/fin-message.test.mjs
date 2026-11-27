import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {FIELDS,PACS008,blankForm,buildFinMessage,readFinMessage,normalizeForm,detailPieces,fieldProblems,ibanValid,leiValid,newMessageId} from '../public/fin-message.mjs';
import {validateFinMessage} from '../src/fin-terminal.mjs';
import {exampleForm,exampleIban} from './helpers/fin-example.mjs';

// Requested by the bank owner with the FinTerminal ISO 20022 specification: screen 1, "FIN - ISO 20022 Composer" - head.001 and
// pacs.008 with live two-way XML, checked against the official schemas. Example parties only (test/helpers/fin-example.mjs).
const {DOMParser}=new JSDOM('').window;

test('a complete message passes both official schemas: the header against head.001.001.02, the transfer against pacs.008.001.08',async()=>{
 const xml=buildFinMessage(exampleForm());
 assert.match(xml,/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<Envelope>\n  <AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head\.001\.001\.02">/);
 assert.match(xml,/\n  <\/AppHdr>\n  <Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs\.008\.001\.08">/);
 assert.deepEqual(await validateFinMessage(xml),{valid:true,errors:[]});
 // The schemas' order and the spec's parts: the transfer's UETR, the intermediary, the ultimate parties, regulatory reporting.
 for(const piece of ['<BizMsgIdr>FT20261127090000','<MsgDefIdr>pacs.008.001.08</MsgDefIdr>','<SttlmMtd>CLRG</SttlmMtd>','<Cd>TGT</Cd>',
  '<UETR>9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d</UETR>','<InstrPrty>HIGH</InstrPrty>','<Cd>URGP</Cd>','<IntrBkSttlmAmt Ccy="EUR">1250000.00</IntrBkSttlmAmt>',
  '<IntrmyAgt1>','<UltmtDbtr>','<UltmtCdtr>','<RgltryRptg>','<Cd>SCOR</Cd>','<Ref>RF18539007547034</Ref>'])assert.ok(xml.includes(piece),piece);
 const order=['<PmtId>','<PmtTpInf>','<IntrBkSttlmAmt','<IntrBkSttlmDt>','<ChrgBr>','<IntrmyAgt1>','<UltmtDbtr>','<Dbtr>','<DbtrAcct>','<DbtrAgt>','<CdtrAgt>','<Cdtr>','<CdtrAcct>','<UltmtCdtr>','<RgltryRptg>','<RmtInf>'];
 assert.deepEqual(order.map(tag=>xml.indexOf(tag)),[...order.map(tag=>xml.indexOf(tag))].sort((a,b)=>a-b));
});

test('optional parts left empty are left out, and the message still passes both schemas',async()=>{
 const form={...exampleForm()};
 for(const field of ['intermediaryBic','intermediaryLei','ultimateDebtorName','ultimateDebtorLei','ultimateCreditorName','ultimateCreditorLei','structuredReference','unstructuredRemittance','regulatoryCountry','regulatoryCode','regulatoryDetails'])form[field]='';
 for(const [settlement,method] of [['INDA','INDA'],['INGA','INGA']]){
  const xml=buildFinMessage({...form,settlement,priority:'NORM/NURG'});
  assert.equal((await validateFinMessage(xml)).valid,true,settlement);
  assert.ok(xml.includes('<SttlmMtd>'+method+'</SttlmMtd>'));assert.doesNotMatch(xml,/<ClrSys>|<IntrmyAgt1>|<UltmtDbtr>|<UltmtCdtr>|<RgltryRptg>|<RmtInf>/);
 }
});

test('the XML read back gives the same form: the form and the XML are kept in step both ways',()=>{
 for(const form of [exampleForm(),{...exampleForm(),settlement:'INGA',priority:'NORM/NURG',intermediaryLei:'',ultimateCreditorName:''}]){
  const read=readFinMessage(buildFinMessage(form),DOMParser);
  assert.equal(read.error,undefined);assert.deepEqual(read.form,normalizeForm(form));
 }
 // A value changed in the XML reaches the form.
 const xml=buildFinMessage(exampleForm()).replace('>1250000.00<','>990.50<').replace('<Nm>Example Creditor SARL</Nm>','<Nm>Another Creditor</Nm>');
 const {form}=readFinMessage(xml,DOMParser);assert.equal(form.amount,'990.50');assert.equal(form.creditorName,'Another Creditor');
});

test('text with XML\'s own characters stays text, there and back',async()=>{
 const form={...exampleForm(),creditorName:'Müller & Söhne <Export> "GmbH"',unstructuredRemittance:"Invoice 7 & 8 < 9 'paid'"};
 const xml=buildFinMessage(form);
 assert.ok(xml.includes('<Nm>Müller &amp; Söhne &lt;Export&gt; &quot;GmbH&quot;</Nm>'));
 assert.equal((await validateFinMessage(xml)).valid,true);
 assert.deepEqual(readFinMessage(xml,DOMParser).form,normalizeForm(form));
});

test('regulatory details longer than 35 characters go in several Inf elements, as the schema allows, and come back whole',()=>{
 const details='Goods payment for industrial equipment, non-military use, licence EX-2201';
 const pieces=detailPieces(details);
 assert.ok(pieces.every(piece=>piece.length<=35));assert.equal(pieces.join(' '),details);
 assert.deepEqual(detailPieces('X'.repeat(80)),['X'.repeat(35),'X'.repeat(35),'X'.repeat(10)]);
 const xml=buildFinMessage({...exampleForm(),regulatoryDetails:details});
 assert.equal((xml.match(/<Inf>/g)||[]).length,pieces.length);
 assert.equal(readFinMessage(xml,DOMParser).form.regulatoryDetails,details);
});

test('a NOSTRO account settles the transfer: its account right after the settlement method, an IBAN as IBAN, any other number as written',async()=>{
 const iban=exampleIban('GB','EXMP00000012345678');
 for(const [written,kept,element] of [[iban.replace(/(.{4})/g,'$1 ').toLowerCase(),iban,'<IBAN>'+iban+'</IBAN>'],[' NOSTRO-example-1 ','NOSTRO-example-1','<Othr><Id>NOSTRO-example-1</Id></Othr>']]){
  const form={...exampleForm(),settlement:'INDA',settlementAccount:written},xml=buildFinMessage(form);
  assert.equal(normalizeForm(form).settlementAccount,kept);
  assert.ok(xml.replace(/\n\s*/g,'').includes('<SttlmInf><SttlmMtd>INDA</SttlmMtd><SttlmAcct><Id>'+element+'</Id></SttlmAcct></SttlmInf>'),xml);
  assert.deepEqual(await validateFinMessage(xml),{valid:true,errors:[]});
  assert.equal(readFinMessage(xml,DOMParser).form.settlementAccount,kept);
 }
 // Cleared through TARGET2 without an account, the settlement part is as before.
 assert.ok(buildFinMessage(exampleForm()).replace(/\n\s*/g,'').includes('<SttlmInf><SttlmMtd>CLRG</SttlmMtd><ClrSys><Cd>TGT</Cd></ClrSys></SttlmInf>'));
});

test('a message the schemas refuse is answered with their own words, element by element',async()=>{
 const result=await validateFinMessage(buildFinMessage({...exampleForm(),senderBic:'BAD',debtorName:''}));
 assert.equal(result.valid,false);
 assert.ok(result.errors.some(error=>/^AppHdr: Element 'BICFI': \[facet 'pattern'\] The value 'BAD'/.test(error)),result.errors.join('\n'));
 assert.ok(result.errors.some(error=>/^Document: Element 'Nm':/.test(error)),result.errors.join('\n'));
 assert.ok(result.errors.every(error=>!error.includes('{urn:')));
 const missing=await validateFinMessage('<?xml version="1.0"?><Envelope></Envelope>');
 assert.deepEqual(missing,{valid:false,errors:["XML: Element 'Envelope': Missing child element(s). Expected is ( AppHdr (head.001.001.02) )."]});
});

test('the message is checked whole: an envelope that does not read, or holds its parts out of place, is refused (review finding)',async()=>{
 const xml=buildFinMessage(exampleForm()),[head,rest]=xml.split('  <Document');
 // Both parts as the schemas want them, the envelope not closed.
 const open=await validateFinMessage(xml.replace('</Envelope>',''));
 assert.equal(open.valid,false);assert.match(open.errors[0],/^XML: Premature end of data in tag Envelope/);
 assert.ok(open.errors.every(error=>/^XML: /.test(error)),open.errors.join('\n'));
 for(const [wrong,finding] of [
  ['<Envelope>\n  <Document'+rest.replace('</Envelope>','')+head.split('<Envelope>')[1]+'</Envelope>',"XML: Element 'Document (pacs.008.001.08)': This element is not expected. Expected is ( AppHdr (head.001.001.02) )."],
  [xml.replace(' xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02"',''),"XML: Element 'AppHdr': This element is not expected. Expected is ( AppHdr (head.001.001.02) )."],
  [xml.replace('<Envelope>','<Message>').replace('</Envelope>','</Message>'),"XML: Element 'Message': No matching global declaration available for the validation root."],
  [xml.replace('</Envelope>','  <Extra/>\n</Envelope>'),"XML: Element 'Extra': This element is not expected."]])
  assert.deepEqual(await validateFinMessage(wrong),{valid:false,errors:[finding]});
 // An XML comment is no part of the message: the parts are read from the message itself.
 assert.deepEqual(await validateFinMessage(xml.replace('<Envelope>','<Envelope>\n<!-- '+head.split('<Envelope>')[1].replaceAll('--','')+' -->')),{valid:true,errors:[]});
 // A part alone passes its own schema as a whole message: the header alone or the transfer alone is no message (reported
 // directly: "XSD: PASSED" for only part of a message). The envelope with both is.
 const part=(open,close)=>xml.slice(xml.indexOf(open),xml.indexOf(close)+close.length);
 for(const [alone,root] of [[part('<AppHdr','</AppHdr>'),'AppHdr'],[part('<Document','</Document>'),'Document'],
  ['<?xml version="1.0" encoding="UTF-8"?>\n<!-- the transfer -->\n'+part('<Document','</Document>'),'Document']])
  assert.deepEqual(await validateFinMessage(alone),{valid:false,errors:["XML: Element '"+root+"': Not the message's envelope. Expected is ( Envelope ), with the AppHdr and the Document inside."]});
 assert.deepEqual(await validateFinMessage(xml),{valid:true,errors:[]});
});

test('what the schemas do not check: IBAN and LEI check digits, and an amount above zero',()=>{
 const form=exampleForm();
 assert.ok(ibanValid(form.debtorIban)&&ibanValid(form.creditorIban)&&leiValid(form.intermediaryLei));
 assert.deepEqual(fieldProblems(form),[]);
 const wrong=fieldProblems({...form,debtorIban:form.debtorIban.slice(0,-1)+((Number(form.debtorIban.at(-1))+1)%10),ultimateCreditorLei:form.ultimateCreditorLei.slice(0,-2)+'00',amount:'0.00'});
 assert.deepEqual(wrong.map(problem=>problem.field),['debtorIban','ultimateCreditorLei','amount']);
 // Written in groups of four, an IBAN is the same IBAN; codes in capitals.
 assert.equal(normalizeForm({...form,debtorIban:form.debtorIban.replace(/(.{4})/g,'$1 ').toLowerCase()}).debtorIban,form.debtorIban);
});

test('a document type is never read, and broken XML leaves the form as it is',()=>{
 assert.match(readFinMessage('<!DOCTYPE x [<!ENTITY e "x">]><Envelope/>',DOMParser).error,/document type/);
 assert.ok(readFinMessage('<Envelope><AppHdr>',DOMParser).error);
 assert.match(readFinMessage('<Envelope/>',DOMParser).error,/AppHdr and its Document/);
});

test('a new message has its own UETR and message ID, the pacs.008 type and the spec\'s defaults',()=>{
 const one=blankForm(new Date('2026-11-27T09:00:00Z')),two=blankForm(new Date('2026-11-27T09:00:00Z'));
 assert.deepEqual(Object.keys(one),[...FIELDS]);
 assert.notEqual(one.uetr,two.uetr);assert.match(one.uetr,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 assert.match(newMessageId(new Date('2026-11-27T09:00:00Z')),/^FT20261127090000[A-Z0-9]{4}$/);
 assert.deepEqual({messageType:one.messageType,priority:one.priority,currency:one.currency,chargeBearer:one.chargeBearer,settlement:one.settlement,endToEndId:one.endToEndId,valueDate:one.valueDate,createdAt:one.createdAt},
  {messageType:PACS008,priority:'HIGH/URGP',currency:'EUR',chargeBearer:'SHAR',settlement:'CLRG/TGT',endToEndId:'NOTPROVIDED',valueDate:'2026-11-27',createdAt:'2026-11-27T09:00:00Z'});
});
