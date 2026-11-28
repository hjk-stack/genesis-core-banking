import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRollingConverterAdminClient,legacyConversionAction,BANK_CONVERTER_PREFIX} from '../src/rolling-converter-admin-client.mjs';
import {verifyConverterRequest,CONVERTER_ADMIN_PREFIX} from '../src/rolling-converter-service-auth.mjs';
import {allowedConverterMessage} from '../public/rolling-converter-admin.mjs';
const env={AVIS_ROLLING_CONVERTER_SECRET:'fixture-only-rolling-converter-key-not-production'};
const actor={id:'fixture-admin',admin:true};
test('only the authorized bank administration can reach the canonical conversion engine',async()=>{
 let calls=0;
 const nonce=randomUUID(),body={asset:'listing:b1'},request=createRollingConverterAdminClient({env,fetcher:async(url,options)=>{
  calls++;assert.equal(url,'https://avis.land'+CONVERTER_ADMIN_PREFIX+'/records');
  assert.equal(options.redirect,'error');assert.equal(options.body,JSON.stringify(body));
  const signed=verifyConverterRequest({authorization:options.headers.authorization,method:options.method,path:CONVERTER_ADMIN_PREFIX+'/records',body,env});
  assert.equal(signed.nonce,nonce);assert.equal(signed.bodySha256.length,64);
  return Response.json({id:'AVRT-20261128-A1B2C3',status:'PREPARED'},{status:201});
 }});
 const input={method:'POST',path:BANK_CONVERTER_PREFIX+'/records',actor,body,idempotencyKey:nonce,privateDesk:true};
 for(const changes of [{privateDesk:false},{actor:{id:'customer',admin:false}},{actor:{...actor,customerUserId:'1'}},{path:BANK_CONVERTER_PREFIX+'/wallets'},{idempotencyKey:''}]){
  assert.ok((await request({...input,...changes})).status>=400);
 }
 assert.equal(calls,0);
 assert.equal((await request(input)).data.status,'PREPARED');
 assert.equal(calls,1);
});
test('bridge messages are confined to converter operations and the retired issuance actions are distinct from settlement',()=>{
 assert.equal(allowedConverterMessage('/assets',undefined),true);
 assert.equal(allowedConverterMessage('/records',{asset:'listing:b1',amount:'1000'}),true);
 assert.equal(allowedConverterMessage('/records/AVRT-20261128-A1B2C3/loop',{legs:4,channels:2,legValue:'25'}),true);
 for(const path of ['/records/../wallets','/records?x=1','https://evil.invalid','/portfolio/positions'])assert.equal(allowedConverterMessage(path,{}),false);
 assert.equal(allowedConverterMessage('/records',{asset:'listing:b1',owner:'x'}),false);
 for(const action of ['HUB','DEPLOY','CAP','MINT'])assert.equal(legacyConversionAction(action),true);
 for(const action of ['LOCK','APPROVE','ROLL','BATCH','CLOSE','RELEASE'])assert.equal(legacyConversionAction(action),false);
});
