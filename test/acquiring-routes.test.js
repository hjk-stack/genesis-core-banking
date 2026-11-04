'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ROUTES,configureAcquiring,chooseAcquiringRoute,acquiringCapabilities}=require('../src/acquiring-routes');
const owner={bin:'123456',mit:'MITEXAMPLE',processorId:'AVISPAY'};
test('AVISPay is the primary acquirer; optional providers stay separate',()=>{
 const config=configureAcquiring({ownAcquirer:owner,externalRoutes:[{id:'STRIPE',configured:true},{id:'BUCKZY',configured:true}]});
 assert.equal(config.acquirer,'AVISPay');
 assert.equal(config.acquiringBin,'123456');
 assert.equal(config.mit,'MITEXAMPLE');
 assert.equal(config.routes.length,3);
 assert.equal(config.routes[0].kind,'own_acquirer');
 assert.equal(config.live,false);
 for(const id of ['AVISPAY_DIRECT','STRIPE','BUCKZY']){
  const chosen=chooseAcquiringRoute(config,{routeId:id});
  assert.equal(chosen.routeId,id);
  assert.equal(chosen.financialPosting,false);
  assert.equal(chosen.settlement,false);
 }
});
test('External provider not configured is not routable',()=>{
 const config=configureAcquiring({ownAcquirer:owner,externalRoutes:[{id:'STRIPE',configured:false}]});
 assert.throws(()=>chooseAcquiringRoute(config,{routeId:'STRIPE'}),/NOT_CONFIGURED/);
 assert.throws(()=>chooseAcquiringRoute(config,{routeId:'BUCKZY'}),/NOT_CONFIGURED/);
 assert.throws(()=>chooseAcquiringRoute(config,{routeId:'UNKNOWN'}),/UNKNOWN/);
});
test('Reject invalid BIN/MIT and duplicate provider routes',()=>{
 assert.throws(()=>configureAcquiring({ownAcquirer:{...owner,bin:'abc'}}),/BIN/);
 assert.throws(()=>configureAcquiring({ownAcquirer:{...owner,mit:'bad value'}}),/MIT/);
 assert.throws(()=>configureAcquiring({ownAcquirer:owner,externalRoutes:[{id:'STRIPE'},{id:'STRIPE'}]}),/DUPLICATE/);
 assert.throws(()=>configureAcquiring({ownAcquirer:owner,externalRoutes:[{id:'OTHER'}]}),/UNSUPPORTED/);
});
test('Status model never implies real card acquiring is connected',()=>{
 const out=acquiringCapabilities();
 assert.equal(out.financialPosting,false);
 assert.equal(out.settlement,false);
 assert.ok(out.routes.some(x=>x.id==='AVISPAY_DIRECT'));
 assert.ok(out.routes.some(x=>x.id==='STRIPE'));
 assert.ok(out.routes.some(x=>x.id==='BUCKZY'));
 assert.ok(out.routes.every(x=>x.live===false));
 assert.equal(ROUTES.AVISPAY_DIRECT.kind,'own_acquirer');
});
