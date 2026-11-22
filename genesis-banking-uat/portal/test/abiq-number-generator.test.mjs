import test from 'node:test';
import assert from 'node:assert/strict';
import {ABIQ_COUNTRIES,buildAbiqNumber,ibanCheckDigits} from '../public/abiq-number.mjs';
import {ABIQ_PARTITIONS,ABIQ_ACCOUNT_SERIES,generateIssuedAbiqIban,isAbiqIdentifier,parseAbiqIban} from '../src/avispay-core-accounts.mjs';
import {normalizeIban} from '../src/avispay-correspondent-mapping.mjs';
import {issueGeneratorNumber} from '../src/abiq-generator.mjs';

const chf={country:'TN',holderCode:'AVIP',currencyBlock:'000756',series:'00004',customerNumber:'1000101'};

function independentRemainder(id) {
 const digits=(id.slice(4)+id.slice(0,4)).replace(/[A-Z]/g, letter=>String(letter.charCodeAt(0)-55));
 return BigInt(digits)%97n;
}

test('standard country IBAN examples reproduce their published check digits',()=>{
 for(const iban of ['GB29NWBK60161331926819','DE89370400440532013000','FR1420041010050500013M02606','TN5910006035183598478831']){
  assert.equal(normalizeIban(iban),iban);
  assert.equal(ibanCheckDigits(iban.slice(0,2),iban.slice(4)),iban.slice(2,4));
 }
});

test('the requested CHF series generates 14 for customer 1000101 and 57 for 1000103',()=>{
 assert.equal(buildAbiqNumber(chf),'TN14AVIP000756000041000101');
 assert.equal(buildAbiqNumber({...chf,customerNumber:'1000103'}),'TN57AVIP000756000041000103');
 assert.equal(generateIssuedAbiqIban({currency:'CHF',customerNumber:1000103}),buildAbiqNumber({...chf,customerNumber:1000103}));
});

test('all configured currency partitions and series round trip through the production parser',()=>{
 for(const [currency,partition] of Object.entries(ABIQ_PARTITIONS)){
  const number=buildAbiqNumber({...chf,holderCode:'TEST',currencyBlock:'000'+partition.slice(1),
   series:String(ABIQ_ACCOUNT_SERIES[currency]).padStart(5,'0')});
  const parsed=parseAbiqIban(number);assert.equal(parsed.currency,currency);assert.equal(parsed.customerNumber,'1000101');
  assert.equal(parsed.participantCode,'TEST');assert.equal(parsed.abiqCode,undefined);
  assert.equal(isAbiqIdentifier(number),true);assert.equal(independentRemainder(number),1n);
  assert.throws(()=>parseAbiqIban(number.slice(0,2)+'00'+number.slice(4)));
 }
});

test('100001 consecutive numbers and the last seven-digit number validate independently',()=>{
 const ids=new Set();
 for(let number=1000101;number<=1100101;number++){
  const id=buildAbiqNumber({...chf,customerNumber:String(number)});
  assert.equal(independentRemainder(id),1n);ids.add(id);
 }
 assert.equal(ids.size,100001);assert.equal(independentRemainder(buildAbiqNumber({...chf,customerNumber:'9999999'})),1n);
});

test('custodial account code has a dedicated series and passes MOD 97',()=>{
 const input={...chf,country:'IT',holderCode:'CUST',currencyBlock:'000579',series:'00015'};
 const id=buildAbiqNumber(input);
 assert.equal(parseAbiqIban(id).currency,'579');
 assert.equal(parseAbiqIban(id).accountSeries,'00015');
 assert.equal(independentRemainder(id),1n);
 assert.throws(()=>parseAbiqIban(buildAbiqNumber({...input,series:'00004'})));
});

test('component errors identify the offending field',()=>{
 for(const [key,value,field] of [['country','XX','country'],['holderCode','AB1P','holderCode'],['currencyBlock','756','currency'],['series','00000','series'],['customerNumber','1000100','customerNumber'],['customerNumber','10000000','customerNumber']]){
  assert.throws(()=>buildAbiqNumber({...chf,[key]:value}),e=>e.field===field);
 }
});

test('server rejects forged checksum, mismatched series, crypto and unknown holder syntax before issuing',async()=>{
 const rows=[{currency:'CHF',currencyBlock:'000756',series:'00004'}];
 const core={operation:async(_actor,_op,_body,_key,work)=>work({query:async(sql,[curr])=>{
  assert.match(sql,/FROM avis_core_v2.abiq_number_codes/);return {rows:curr==='CHF'?rows:[]};
 }})};
 const request={country:'TN',holderCode:'AVIP',currency:'CHF',series:'00004',customerNumber:'1000101',checkDigits:'14'};
 for(const [overrides,field] of [[{checkDigits:'57'},'checkDigits'],[{series:'00001'},'series'],[{currency:'BTC'},'currency'],[{currency:'AGi'},'currency'],[{holderCode:'A123'},'holderCode']]){
  await assert.rejects(issueGeneratorNumber(core,{id:'operator'},Object.assign({},request,overrides),'test'),e=>e.field===field);
 }
});

test('manual issuer uses country and currency independently for every catalogue combination',()=>{
 assert.equal(new Set(ABIQ_COUNTRIES).size,249);
 for(const country of ABIQ_COUNTRIES)for(const [currency,partition] of Object.entries(ABIQ_PARTITIONS)){
  const id=buildAbiqNumber({...chf,country,holderCode:'ABCD',series:String(ABIQ_ACCOUNT_SERIES[currency]).padStart(5,'0'),currencyBlock:'000'+partition.slice(1)});
  assert.equal(independentRemainder(id),1n);
  assert.equal(isAbiqIdentifier(id),true);
  const parsed=parseAbiqIban(id);
  assert.equal(parsed.countryCode,country);assert.equal(parsed.currency,currency);assert.equal(parsed.participantCode,'ABCD');
 }
});
