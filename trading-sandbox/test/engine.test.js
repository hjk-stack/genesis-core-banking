'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createEngine}=require('../engine');
const order=(x={})=>({clientOrderId:'test-order-0001',instrument:'SIM-TECH',side:'buy',quantity:'2',limitPriceCents:'18250',...x});
test('does not permit GENESIS Bond or actual instruments',()=>{const e=createEngine();assert.throws(()=>e.submit(order({instrument:'GENESIS-BOND'})),/INSTRUMENT_NOT_ALLOWED/);assert.equal(e.snapshot().bondInfrastructureConnected,false)});
test('executes simulated fill only',()=>{const e=createEngine();assert.equal(e.submit(order()).status,'FILLED');assert.equal(e.snapshot().cashCents,'24963500');assert.equal(e.snapshot().externalTradingEnabled,false)});
test('idempotency guards against double fill',()=>{const e=createEngine();e.submit(order());assert.equal(e.submit(order()).idempotentReplay,true);assert.equal(e.snapshot().monitoring.filledOrders,1);assert.throws(()=>e.submit(order({quantity:'3'})),/IDEMPOTENCY_CONFLICT/)});
test('enforces risk limits and rejects naked sales',()=>{const e=createEngine();assert.throws(()=>e.submit(order({quantity:'999'})),/RISK_NOTIONAL_LIMIT/);assert.throws(()=>e.submit(order({side:'sell'})),/NO_SHORT_SELLING/)});
test('nonmarketable limit can be cancelled',()=>{const e=createEngine();assert.equal(e.submit(order({limitPriceCents:'12000'})).status,'OPEN');assert.equal(e.cancel('test-order-0001').status,'CANCELLED')});
