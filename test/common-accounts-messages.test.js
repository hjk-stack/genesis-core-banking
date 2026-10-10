'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {catalog,COMMON_ACCOUNTS,SUSPENSE_ACCOUNTS,findSuspense}=require('../src/common-accounts');
const {normalizeFIN,normalizeISO20022,finTemplates}=require('../src/message-adapters');
const {validateIBAN,buildIBAN,internalReference,formatIBAN}=require('../src/iban-range');

test('20 product COMMON accounts and exactly six suspense accounts per product',()=>{
 const m=catalog();
 assert.equal(m.commonAccounts.length,20);assert.equal(m.suspenseAccounts.length,120);
 assert.equal(new Set(COMMON_ACCOUNTS.map(x=>x.code)).size,20);
 assert.equal(new Set(SUSPENSE_ACCOUNTS.map(x=>x.code)).size,120);
 assert.equal(findSuspense('BONDS_NOTES','UNMATCHED_BENEFICIARY').code,'SUS-0003-01');
 assert.equal(m.ibanPool.slots,100000);assert.equal(m.ibanPool.issuedIbans,0);
 assert.equal(m.paymentRails.every(r=>r.status==='disabled'),true);
});

test('100000 internal references, not fabricated IBANs',()=>{
 assert.equal(internalReference(0),'GCB-INT-00000');
 assert.equal(internalReference(99999),'GCB-INT-99999');
 assert.throws(()=>internalReference(100000),/SERIAL_OUT_OF_RANGE/);
 assert.throws(()=>buildIBAN({country:'DE'},'370400440532013000'),/NOT_AUTHORIZED/);
 assert.equal(validateIBAN('DE89370400440532013000'),'DE89370400440532013000');
 assert.equal(formatIBAN('DE89370400440532013000'),'DE89 3704 0044 0532 0130 00');
 assert.throws(()=>validateIBAN('DE89370400440532013001'),/CHECKSUM/);
});

test('FIN MT103 has unverified origin and no posting',()=>{
 const fields={
  '20':'EXAMPLE123','23B':'CRED','32A':'261010EUR1000,00',
  '50K':'/DE89370400440532013000\nORDERING PARTY',
  '59':'/DE89370400440532013000\nBENEFICIARY'
 };
 const m=normalizeFIN('MT103',fields);
 assert.equal(m.iso20022Mapping,'pacs.008');
 assert.equal(m.settlement.currency,'EUR');assert.equal(m.settlement.amount,'1000.00');
 assert.equal(m.externalAuthenticity,'unverified');assert.equal(m.bookingState,'unposted');
 assert.throws(()=>normalizeFIN('MT103',{...fields,'32A':'261032EUR100,00'}),/INVALID_VALUE_DATE/);
});

test('FIN MT202 COV carries related reference and does not generate a separate credit',()=>{
 const fields={'20':'COVER001','21':'EXAMPLE123','32A':'261010USD500,25',
   '58A':'CUSTBANKXXX','50K':'ORDERING CLIENT','59':'BENEFICIARY CLIENT'};
 const m=normalizeFIN('MT202COV',fields);
 assert.equal(m.iso20022Mapping,'pacs.009.COV');assert.equal(m.relatedReference,'EXAMPLE123');
 assert.equal(m.bookingState,'unposted');assert.equal(m.settlementConfirmed,false);
 assert.throws(()=>normalizeFIN('MT202COV',{...fields,'21':''}),/REQUIRED_FIN_TAG_21/);
 assert.throws(()=>normalizeFIN('MT203',fields),/MT203_RETIRED/);
 assert.equal(finTemplates().MT203.retired,true);
});

test('ISO 20022 metadata normalization records only unconfirmed settlements',()=>{
 const m=normalizeISO20022('pacs.008',{messageId:'BANK-XYZ-1',endToEndId:'TRANS1',
 currency:'EUR',amount:'250.00'});
 assert.equal(m.reconciliationState,'unmatched');assert.equal(m.bookingState,'unposted');
 assert.throws(()=>normalizeISO20022('pacs.123',{messageId:'x'}),/UNSUPPORTED_ISO/);
});
