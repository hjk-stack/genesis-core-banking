'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {getCapabilities}=require('../src/capabilities');
const {finTemplates,normalizeFIN}=require('../src/message-adapters');

test('Payment Server is a distinct correspondent IP-to-IP and FIN module',()=>{
 const data=getCapabilities();
 const item=data.capabilities.find(x=>x.id==='payment_server');
 assert.ok(item,'Payment Server must be registered');
 assert.match(item.name,/Payment Server/);
 assert.match(item.name,/IP-to-IP/);
 assert.equal(item.stage,'adapter_required');
 assert.equal(item.operations,false);
 assert.equal(data.transactionsEnabled,false);
});

test('Payment Server does not remove existing card acquiring or payment instructions',()=>{
 const data=getCapabilities();
 const ids=new Set(data.capabilities.map(x=>x.id));
 for(const id of ['payments','acquiring','cards','correspondents','swift_iso','ledger','reconciliation']) assert.ok(ids.has(id),id);
});

test('FIN templates cannot be confused with authenticated correspondent settlement',()=>{
 const templates=finTemplates();
 assert.ok(templates.MT103);
 assert.ok(templates.MT202COV);
 assert.ok(templates.ISO20022);
 const message=normalizeFIN('MT103',{
  '20':'PAYTEST01','23B':'CRED','32A':'261103EUR123,45',
  '50K':'TEST SENDER','59':'TEST RECEIVER'
 });
 assert.equal(message.externalAuthenticity,'unverified');
 assert.equal(message.bookingState,'unposted');
 assert.equal(message.settlementConfirmed,false);
 assert.equal(message.reconciliationState,'unmatched');
});
