'use strict';
const {createHash}=require('node:crypto');

// SWIFT FIN MT messages are legacy message types, NOT ISO 20022 XML.
// This adapter normalizes a permitted subset into a shared internal envelope.
// This is a validation/workbench layer; NO funds credit, settlement, or external sending.
const SUPPORTED = Object.freeze({
 MT103:{service:'customer_credit_transfer',iso20022:'pacs.008',coverRequired:false,required:['20','23B','32A','50K','59']},
 MT202COV:{service:'cover_transfer',iso20022:'pacs.009.COV',coverRequired:true,required:['20','21','32A','58A','50K','59']},
 MT202:{service:'financial_institution_transfer',iso20022:'pacs.009',coverRequired:false,required:['20','21','32A','58A']},
 MT203:{service:'multiple_financial_institution_transfer_legacy',iso20022:null,retired:true,coverRequired:false,required:[]}
});
const ISO_TYPES = Object.freeze({
 'pacs.008':'customer_credit_transfer',
 'pacs.009':'financial_institution_transfer',
 'pacs.009.COV':'cover_transfer',
 'pacs.002':'payment_status',
 'camt.052':'intraday_statement',
 'camt.053':'account_statement',
 'camt.054':'credit_debit_notification'
});
function text(value,name,max=140){
 if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value))throw Error('INVALID_'+name);
 return value.trim();
}
function amount(value){
 if(typeof value!=='string'||!/^(0|[1-9]\d{0,16})(?:\.\d{1,5})?$/.test(value)||Number(value)<=0)throw Error('INVALID_AMOUNT');
 return value;
}
function parse32A(value){
 const m=/^(\d{6})([A-Z]{3})(\d{1,16},\d{0,5})$/.exec(text(value,'32A',30));
 if(!m)throw Error('INVALID_32A');
 const yy=Number(m[1].slice(0,2)),mm=Number(m[1].slice(2,4)),dd=Number(m[1].slice(4,6));
 const date=new Date(Date.UTC(2000+yy,mm-1,dd));
 if(date.getUTCFullYear()!==2000+yy||date.getUTCMonth()!==mm-1||date.getUTCDate()!==dd)throw Error('INVALID_VALUE_DATE');
 return {valueDate:date.toISOString().slice(0,10),currency:m[2],amount:amount(m[3].replace(',','.'))};
}
function parseFINFields(input){
 if(typeof input!=='string'||input.length>16000||!/^[\s\S]*$/.test(input))throw Error('INVALID_FIN_INPUT');
 // Accept plain tagged Block 4 contents. No claimed authenticity or SWIFT signature.
 const stripped=input.replace(/^\s*\{4:\s*/,'').replace(/\s*-\}\s*$/,'').trim();
 const fields={};
 let current=null;
 for(const line of stripped.split(/\r?\n/)){
  const match=/^:(\d{2}[A-Z]?):(.*)$/.exec(line);
  if(match){current=match[1];if(Object.hasOwn(fields,current))throw Error('DUPLICATE_TAG_'+current);fields[current]=match[2];}
  else if(current)fields[current]+='\n'+line;
  else if(line.trim())throw Error('INVALID_FIN_TAG');
 }
 return fields;
}
function normalizeFIN(type,body){
 const def=SUPPORTED[type];if(!def)throw Error('UNSUPPORTED_MESSAGE_TYPE');
 if(def.retired)throw Error('MT203_RETIRED_USE_MT202_COV_OR_ISO20022');
 const fields=typeof body==='string'?parseFINFields(body):body;
 if(!fields||typeof fields!=='object'||Array.isArray(fields))throw Error('INVALID_FIN_FIELDS');
 // Variable option tags, e.g. 50A/50F/50K and 59/59A.
 const f=(tag)=>fields[tag]??(tag==='50K'?fields['50A']??fields['50F']:tag==='58A'?fields['58D']:tag==='59'?fields['59A']??fields['59F']:undefined);
 for(const key of def.required)if(!f(key))throw Error('REQUIRED_FIN_TAG_'+key);
 const reference=text(f('20'),'REFERENCE',16);
 const related=f('21')?text(f('21'),'RELATED_REFERENCE',16):null;
 const settlement=parse32A(f('32A'));
 const credit=f('59')?text(f('59'),'BENEFICIARY',600):null;
 const ordering=f('50K')?text(f('50K'),'ORDERING_PARTY',600):null;
 if(type==='MT103' && f('23B')!=='CRED')throw Error('INVALID_BANK_OPERATION_CODE');
 const normalized={
  format:'SWIFT_FIN',type,iso20022Mapping:def.iso20022,reference,
  relatedReference:related,settlement,
  senderReference:f('52A')?text(f('52A'),'SENDER',140):null,
  receivingInstitution:f('58A')?text(f('58A'),'RECEIVER',140):null,
  orderingParty:ordering,beneficiary:credit,
  transactionInformation:f('70')?text(f('70'),'REMITTANCE',560):null,
  charges:f('71A')?text(f('71A'),'CHARGES',12):null,
  reconciliationState:'unmatched',bookingState:'unposted',
  externalAuthenticity:'unverified',settlementConfirmed:false,
  duplicateControl:createHash('sha256').update(type+'|'+reference+'|'+(related||'')+'|'+settlement.currency+'|'+settlement.amount).digest('hex')
 };
 return normalized;
}
function normalizeISO20022(type,metadata){
 if(!Object.hasOwn(ISO_TYPES,type))throw Error('UNSUPPORTED_ISO20022_TYPE');
 if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw Error('INVALID_ISO_METADATA');
 // Metadata is presumed to have been parsed from signed/validated ISO XML by
 // an approved bank or PSP adapter. A name/reference alone proves neither.
 const messageId=text(metadata.messageId,'MESSAGE_ID',35);
 const reference=text(metadata.endToEndId||metadata.transactionId,'TX_ID',35);
 const currency=text(metadata.currency,'CURRENCY',3);
 if(!/^[A-Z]{3}$/.test(currency))throw Error('INVALID_CURRENCY');
 const normalized={
  format:'ISO20022',type,service:ISO_TYPES[type],messageId,reference,
  relatedReference:metadata.relatedReference?text(metadata.relatedReference,'RELATED_REFERENCE',35):null,
  uetr:metadata.uetr?text(metadata.uetr,'UETR',36):null,
  settlement:{currency,amount:amount(metadata.amount)},
  reconciliationState:'unmatched',bookingState:'unposted',
  externalAuthenticity:'unverified',settlementConfirmed:false
 };
 return normalized;
}
function finTemplates(){
 return {
  MT103:{description:'Customer credit transfer; sample only, not an executable SWIFT instruction',
   requiredFields:['20','23B','32A','50K/50A/50F','59/59A/59F'],optionalFields:['21','52A','57A','70','71A']},
  MT202COV:{description:'Cover leg for customer payment; match MT103 and do not double-credit',
   requiredFields:['20','21','32A','58A/58D','50K/50A/50F','59/59A/59F'],optionalFields:['52A','56A','57A','72']},
  MT203:{description:'Retired legacy multiple FI transfer. Read-only historical identification; not a cover payment',retired:true},
  ISO20022:{types:Object.keys(ISO_TYPES),canonicalEnvelope:'pacs.008/pacs.009/pacs.009.COV with camt.052/053/054 and pacs.002 reconciliation'}
 };
}
module.exports={SUPPORTED,ISO_TYPES,parseFINFields,normalizeFIN,normalizeISO20022,finTemplates};
