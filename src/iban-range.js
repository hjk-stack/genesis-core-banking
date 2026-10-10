'use strict';
// Reserve/validate IBANs ONLY for institution-issued configurations.
// An arbitrary MOD-97 string is not an authorized, live bank account.
const VALID_COUNTRY_LENGTHS=Object.freeze({AT:20,BE:16,CH:21,CZ:24,DE:22,DK:18,ES:24,FI:18,FR:27,GB:22,GR:27,IE:22,IT:27,LU:20,NL:18,NO:15,PL:28,PT:25,RO:24,SE:24,TR:26,AE:23,SA:24,MT:31,LT:20,LV:21,EE:20,SK:24,HR:21,HU:28,SI:19,BG:22,CY:28});
function mod97(input){
 let remainder=0;
 for(const char of input){
  if(/[0-9]/.test(char))remainder=(remainder*10+Number(char))%97;
  else if(/[A-Z]/.test(char)){const value=char.charCodeAt(0)-55;remainder=(remainder*100+value)%97;}
  else throw Error('INVALID_IBAN_CHAR');
 }
 return remainder;
}
function validateIBAN(input){
 if(typeof input!=='string'||input.length>64)throw Error('INVALID_IBAN');
 const iban=input.toUpperCase().replace(/ /g,'');
 if(!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban))throw Error('INVALID_IBAN');
 const country=iban.slice(0,2);
 if(!VALID_COUNTRY_LENGTHS[country]||iban.length!==VALID_COUNTRY_LENGTHS[country])throw Error('UNSUPPORTED_IBAN_COUNTRY_OR_LENGTH');
 if(mod97(iban.slice(4)+iban.slice(0,4))!==1)throw Error('INVALID_IBAN_CHECKSUM');
 return iban;
}
function formatIBAN(iban){
 const valid=validateIBAN(iban);
 return valid.match(/.{1,4}/g).join(' ');
}
function buildIBAN(config,bban){
 if(!config?.approvedForIssuance||!config?.issuingBankIdentifierVerified)throw Error('IBAN_ISSUANCE_NOT_AUTHORIZED');
 const country=config.country;
 if(!VALID_COUNTRY_LENGTHS[country])throw Error('UNSUPPORTED_IBAN_COUNTRY');
 if(typeof bban!=='string'||bban.length!==VALID_COUNTRY_LENGTHS[country]-4||!/^[A-Z0-9]+$/.test(bban))throw Error('INVALID_NATIONAL_BBAN');
 const stem=country+'00'+bban;
 const checksum=String(98-mod97(bban+country+'00')).padStart(2,'0');
 return validateIBAN(country+checksum+bban);
}
function internalReference(serial){
 if(!Number.isInteger(serial)||serial<0||serial>=100000)throw Error('SERIAL_OUT_OF_RANGE');
 return 'GCB-INT-'+String(serial).padStart(5,'0');
}
module.exports={VALID_COUNTRY_LENGTHS,mod97,validateIBAN,formatIBAN,buildIBAN,internalReference};
