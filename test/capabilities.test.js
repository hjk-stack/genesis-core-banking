'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {getCapabilities}=require('../src/capabilities');
test('all financial operations disabled',()=>{const x=getCapabilities();assert.equal(x.transactionsEnabled,false);assert.equal(x.mode,'non_transactional');for(const m of x.capabilities)assert.equal(m.operations,false)});
test('all critical modules represented once',()=>{const x=getCapabilities(),ids=x.capabilities.map(m=>m.id);assert.equal(new Set(ids).size,ids.length);for(const id of ['customers','ledger','payments','custody','stocks','derivatives','exchanges','crypto','cards','acquiring'])assert.ok(ids.includes(id))});
