import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRollingConverterAdminClient,legacyConversionAction,BANK_CONVERTER_PREFIX} from '../src/rolling-converter-admin-client.mjs';
import {verifyConverterRequest,CONVERTER_ADMIN_PREFIX} from '../src/rolling-converter-service-auth.mjs';
import {portfolioConverterAssets,portfolioKey} from '../src/rolling-converter-portfolio-source.mjs';
import {allowedConverterMessage} from '../public/rolling-converter-admin.mjs';
const env={AVIS_ROLLING_CONVERTER_SECRET:'fixture-only-rolling-converter-key-not-production'};
const actor={id:'fixture-admin',admin:true};
const position={position_id:'11111111-1111-4111-8111-111111111111',security_id:'22222222-2222-4222-8222-222222222222',account_role:'INSTITUTION',name:'Registered bond',short_name:'GENESIS',isin:'USU3712QAA05',kind:'bond',currency_code:'USD',quantity:'500000.000000000000000000',available_quantity:'400000.000000000000000000',market_price:'98.000000000000000000',denomination:'1000.000000000000000000',quote_basis:'PERCENT',version:7};
const metadata=[{isinOrWkn:position.isin,assetClass:'bond',currency:'USD',issuerName:'GENESIS Collateral House Company',issuerId:'529900OWORDQKD4NG590',dateOfIssue:'2026-06-03',canonical:true,amount:'5000000000.00'}];
const stock={...position,position_id:'33333333-3333-4333-8333-333333333333',kind:'share',name:'AVISPay PLC shares',short_name:'AVIPSTN',isin:null,quantity:'100000000.000000000000000000',available_quantity:'100000000.000000000000000000',market_price:'0',currency_code:'CHF',quote_basis:'UNIT',denomination:'1'};
test('portfolio holdings alone supply quantity, market value, identity and source; no new balances',()=>{
 const rows=[position,stock,{...position,position_id:randomUUID(),kind:'token'},{...position,position_id:randomUUID(),kind:'crypto'},{...position,position_id:randomUUID(),account_role:'CUSTOMER'},{...position,position_id:randomUUID(),quantity:'0'}];
 const before=structuredClone(rows),assets=portfolioConverterAssets(rows,metadata);
 assert.equal(assets.length,2);
 assert.deepEqual([assets[0].key,assets[0].amount,assets[0].quantity,assets[0].availableQuantity,assets[0].issuerName,assets[0].dateOfIssue,assets[0].source],[portfolioKey(position.position_id),'392000000.00','500000','400000','GENESIS Collateral House Company','2026-06-03','Portfolio Management']);
 assert.deepEqual([assets[1].amount,assets[1].issuerName,assets[1].isinOrWkn],['','','']);
 assert.equal(assets[0].amountOpen,false);
 assert.equal(JSON.stringify(assets).includes(position.position_id),false);
 assert.deepEqual(rows,before);
 assert.notEqual(portfolioConverterAssets([{...position,version:8}],metadata)[0].revision,assets[0].revision);
});
test('only the authorized bank administration can prepare a freshly resolved portfolio snapshot',async()=>{
 let calls=0,positions=[position],posted=null;
 const nonce=randomUUID(),request=createRollingConverterAdminClient({env,readPositions:async()=>positions,fetcher:async(url,options)=>{
  calls++;assert.equal(options.redirect,'error');
  const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):undefined;
  const signed=verifyConverterRequest({authorization:options.headers.authorization,method:options.method,path,body,env});
  assert.ok(signed);
  if(path===CONVERTER_ADMIN_PREFIX+'/assets')return Response.json({metadata});
  assert.equal(path,CONVERTER_ADMIN_PREFIX+'/records');
  assert.equal(signed.nonce,nonce);posted=body;
  assert.equal(body.portfolio.amount,'392000000.00');
  return Response.json({id:'AVRT-20261128-A1B2C3',status:'PREPARED'},{status:201});
 }});
 const context={actor,privateDesk:true},get=await request({...context,method:'GET',path:BANK_CONVERTER_PREFIX+'/assets'});
 assert.equal(get.status,200);const asset=get.data.assets[0];
 const input={...context,method:'POST',path:BANK_CONVERTER_PREFIX+'/records',body:{asset:asset.key,revision:asset.revision},idempotencyKey:nonce};
 for(const changes of [{privateDesk:false},{actor:{id:'customer',admin:false}},{actor:{...actor,customerUserId:'1'}},{path:BANK_CONVERTER_PREFIX+'/wallets'},{idempotencyKey:''},{body:{...input.body,amount:'5000000000.00'}},{body:{asset:'genesis',revision:asset.revision}}]){
  assert.ok((await request({...input,...changes})).status>=400);
 }
 assert.equal(calls,1);
 positions=[{...position,available_quantity:'200000',version:8}];
 assert.equal((await request(input)).status,409);
 assert.equal(posted,null);
 positions=[position];
 assert.equal((await request(input)).data.status,'PREPARED');
 assert.equal(posted.portfolio.key,asset.key);
});
test('bridge messages are confined to current portfolio selections and retired issuance is distinct from settlement',()=>{
 const asset=portfolioConverterAssets([position],metadata)[0];
 assert.equal(allowedConverterMessage('/assets',undefined),true);
 assert.equal(allowedConverterMessage('/records',{asset:asset.key,revision:asset.revision}),true);
 assert.equal(allowedConverterMessage('/records',{asset:asset.key,revision:asset.revision,amount:'1000'}),false);
 assert.equal(allowedConverterMessage('/records/AVRT-20261128-A1B2C3/loop',{legs:4,channels:2,legValue:'25'}),true);
 for(const path of ['/records/../wallets','/records?x=1','https://evil.invalid','/portfolio/positions'])assert.equal(allowedConverterMessage(path,{}),false);
 for(const action of ['HUB','DEPLOY','CAP','MINT'])assert.equal(legacyConversionAction(action),true);
 for(const action of ['LOCK','APPROVE','ROLL','BATCH','CLOSE','RELEASE'])assert.equal(legacyConversionAction(action),false);
});
