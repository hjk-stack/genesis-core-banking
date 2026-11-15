import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readExchangeIntent} from '../public/exchange-intent.mjs';
test('exchange links retain decimal draft choices and discard identity, redirect and execution fields',()=>{
 assert.deepEqual(readExchangeIntent('#exchange?symbol=reg&side=sell&quantity=12&price=98.125&accountId=other&submit=1&returnUrl=https://example.test'),{symbol:'REG',side:'SELL',quantity:'12',price:'98.125'});
 assert.deepEqual(readExchangeIntent('#exchange?view=portfolio'),{view:'portfolio'});
 assert.equal(readExchangeIntent('#portfolio'),null);
 for(const hash of ['#exchange?symbol=REG&side=DELETE','#exchange?symbol=../REG&side=BUY','#exchange?symbol=REG&side=BUY&quantity=-1','#exchange?symbol=REG&side=SELL&price=0'])assert.throws(()=>readExchangeIntent(hash));
});
