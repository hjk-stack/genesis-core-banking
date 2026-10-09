'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {balanced,minorUnits,currency}=require('../src/domain');
test('amounts only positive decimal integer strings',()=>{
 assert.equal(minorUnits('100').toString(),'100');
 for(const x of ['0','-1','1.1',1,'1e3',' 50']) assert.throws(()=>minorUnits(x));
});
test('currency format is bounded',()=>{
 assert.equal(currency('EUR'),'EUR');
 for(const x of ['eur','','$USD','WAYTOOLONGCURRENCY']) assert.throws(()=>currency(x));
});
test('double entry balance',()=>{
 assert.equal(balanced([{side:'debit',amountMinor:'25',currency:'EUR'},{side:'credit',amountMinor:'25',currency:'EUR'}]),true);
 assert.throws(()=>balanced([{side:'debit',amountMinor:'25',currency:'EUR'},{side:'credit',amountMinor:'24',currency:'EUR'}]));
 assert.throws(()=>balanced([{side:'debit',amountMinor:'25',currency:'EUR'},{side:'credit',amountMinor:'25',currency:'USD'}]));
});
