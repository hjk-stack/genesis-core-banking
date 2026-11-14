import {fault} from './core.mjs';

// FIN MT103 is retained for counterparties accepting a manual FIN instruction.
// Connected ISO 20022 routes send the reviewed pacs.008 payload instead.
const finText=value=>{
 const s=String(value).replace(/\s+/g,' ').trim();
 if(!/^[A-Za-z0-9 /?:().,'+\-]*$/.test(s))fault('FIN_CHARACTER_SET');
 return s;
};
function lines(values,max){
 const result=[];
 for(const value of values.filter(Boolean)){
  let rest=finText(value);
  while(rest.length){let end=Math.min(35,rest.length);if(end<rest.length&&rest.lastIndexOf(' ',end)>0)end=rest.lastIndexOf(' ',end);result.push(rest.slice(0,end));rest=rest.slice(end).trimStart();}
 }
 if(result.length>max)fault('FIN_FIELD_LENGTH');
 return result.join('\r\n');
}
const lt=bic=>bic.slice(0,8)+'X'+(bic.slice(8)||'XXX');
export function buildFin103(p){
 const [whole,fraction='']=p.amount.split('.'),amount=whole+','+fraction.replace(/0+$/,'');
 if(amount.length>15)fault('FIN_FIELD_LENGTH');
 const date=p.date.replaceAll('-','').slice(2),reference=p.messageId.replaceAll('-','').slice(0,16).toUpperCase();
 const receiver=lines([p.creditorName,p.creditorAddress.street,[p.creditorAddress.postalCode,p.creditorAddress.city].filter(Boolean).join(' '),p.creditorAddress.country],4);
 const sender=lines([p.debtorName],4),remittance=lines([p.reference],4);
 return `{1:F01${lt(p.senderBic)}0000000000}{2:I103${lt(p.creditorBic)}N}{3:{121:${p.uetr}}}{4:\r\n:20:${reference}\r\n:23B:CRED\r\n:32A:${date}${p.currency}${amount}\r\n:50K:/${p.debtorIban}\r\n${sender}\r\n:57A:${p.creditorBic}\r\n:59:/${p.creditorIban}\r\n${receiver}\r\n:70:${remittance}\r\n:71A:SHA\r\n-}`;
}
