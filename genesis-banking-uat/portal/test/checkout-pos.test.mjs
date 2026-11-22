import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {SovereignCore} from '../src/core.mjs';
import {CheckoutPosControl} from '../src/checkout-pos.mjs';
import {CheckoutPosAuthenticator} from '../src/checkout-pos-auth.mjs';

const admin={id:'operator:pos',admin:true},customer={id:'buyer',admin:false};
const milestone={terminalId:'11ITCON03',checkoutKind:'MILESTONE',reference:'AVIS-IT-03',title:'Italy · Construction milestone 03'};
const basket={terminalId:'SH1234567890ABCDEF1234',checkoutKind:'SHOP',reference:'SHOP-1234567890abcdef1234',title:'AVIS.Land basket checkout'};
const actor={id:'service:avis-land-checkout',posService:true,admin:false};
async function withDb(fn){
 const db=new PGlite();
 const pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),release(){}})};
 try{
  await migrate(db);
  const core=new SovereignCore(pool);
  await core.registerShop(admin,{merchantId:'AVISPAY-WEB-POS',shopName:'AVISPay Web POS',ownerUserId:'1',commissionBps:0},'pos-merchant');
  return await fn({pool,db,core,control:new CheckoutPosControl(pool)});
 }finally{await db.close()}
}
test('each checkout has its own unique terminal, blue request, admin approval, closure and durable timestamps',async()=>{
 await withDb(async({pool,control})=>{
  const ledgerBefore=(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries')).rows[0].n;
  const first=await control.resolve(actor,milestone);
  assert.equal(first.state,'CLOSED');assert.equal(first.terminalId,'11ITCON03');
  const shop=await control.resolve(actor,basket);
  assert.equal(shop.state,'CLOSED');assert.notEqual(shop.terminalId,first.terminalId);
  const requested=await control.request(actor,milestone);
  assert.equal(requested.state,'REQUESTED');assert.ok(requested.requestedAt);
  const duplicate=await control.request(actor,milestone);assert.equal(String(duplicate.requestedAt),String(requested.requestedAt));
  assert.equal((await control.status(actor,basket)).state,'CLOSED');
  await assert.rejects(control.setActive(customer,{terminalId:first.terminalId,active:true}),/FORBIDDEN/);
  const approved=await control.setActive(admin,{terminalId:first.terminalId,active:true});
  assert.equal(approved.state,'ACTIVE');assert.ok(approved.approvedAt);
  assert.equal((await control.status(actor,milestone)).state,'ACTIVE');
  const closed=await control.setActive(admin,{terminalId:first.terminalId,active:false});
  assert.equal(closed.state,'CLOSED');assert.equal(closed.approvedAt,null);
  assert.equal((await control.status(actor,basket)).state,'CLOSED');
  const events=(await pool.query('SELECT event_type FROM avis_core_v2.checkout_pos_events WHERE terminal_id=$1 ORDER BY event_id',[milestone.terminalId])).rows.map(r=>r.event_type);
  assert.deepEqual(events,['REQUEST','APPROVE','CLOSE']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries')).rows[0].n,ledgerBefore);
 });
});
test('a previously registered POS ID can be linked once to its actual milestone',async()=>{
 await withDb(async({core,control,pool})=>{
  await core.registerTerminal(admin,{terminalId:milestone.terminalId,merchantId:'AVISPAY-WEB-POS',terminalType:'WEB_POS'},'pre-register');
  const placeholder=await control.status(actor,{terminalId:milestone.terminalId});
  assert.equal(placeholder.checkoutKind,'REGISTERED');
  const linked=await control.resolve(actor,milestone);
  assert.equal(linked.checkoutKind,'MILESTONE');assert.equal(linked.reference,milestone.reference);
  const modified=await control.resolve(actor,{...milestone,title:'Italy · Updated milestone title'});
  assert.equal(modified.title,'Italy · Updated milestone title');
  await assert.rejects(control.resolve(actor,{...milestone,reference:'DIFFERENT-PRODUCT'}),/POS_TERMINAL_CONFLICT/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.pos_terminals WHERE terminal_id=$1',[milestone.terminalId])).rows[0].n,1);
 });
});
test('checkout ID cannot be reused for a different merchant, milestone or source reference',async()=>{
 await withDb(async({pool,control})=>{
  await control.resolve(actor,milestone);
  await assert.rejects(control.resolve(actor,{...milestone,reference:'ANOTHER-PRODUCT'}),/POS_TERMINAL_CONFLICT/);
  await assert.rejects(control.request(actor,{...milestone,checkoutKind:'SHOP'}),/POS_TERMINAL_ID/);
  await assert.rejects(control.request(actor,{...milestone,terminalId:'../../other'}),/POS_TERMINAL_ID/);
  await control.resolve(actor,basket);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM avis_core_v2.pos_terminals WHERE terminal_id = ANY($1::varchar[])",[[milestone.terminalId,basket.terminalId]])).rows[0].n,2);
 });
});
test('only a signed site-to-bank request may resolve or request a checkout POS; nonce replay and INDEX scope rejected',async()=>{
 await withDb(async({pool})=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const jwk=publicKey.export({format:'jwk'}),kid='valid-pos-test-key';
  const fetcher=async()=>Response.json({keys:[{...jwk,kid,alg:'Ed25519',use:'sig'}]});
  const verifier=new CheckoutPosAuthenticator(pool,{fetcher});
  const path='/api/services/checkout-pos/request';
  const data=Buffer.from(JSON.stringify(milestone));
  const sha=x=>createHash('sha256').update(x).digest('hex');
  function token(overrides={}){
   const now=Math.floor(Date.now()/1000);
   const head=Buffer.from(JSON.stringify({alg:'Ed25519',typ:'AVIS-POS-REQUEST+JWT',kid})).toString('base64url');
   const payload=Buffer.from(JSON.stringify({iss:'https://avis.land/checkout',aud:'AVIS_BANK_POS_V1',method:'POST',path,body_sha256:sha(data),iat:now,exp:now+50,jti:sha(String(Math.random())),...overrides})).toString('base64url');
   const body=head+'.'+payload;
   return 'Index-JWS '+body+'.'+sign(null,Buffer.from(body),privateKey).toString('base64url');
  }
  const req=authorization=>({method:'POST',url:path,headers:{authorization}});
  const good=token();
  assert.equal((await verifier.authenticate(req(good),data)).posService,true);
  await assert.rejects(verifier.authenticate(req(good),data),/POS_SERVICE_AUTH/);
  await assert.rejects(verifier.authenticate(req(token({aud:'AVIS_BANK_INDEX_V1'})),data),/POS_SERVICE_AUTH/);
  await assert.rejects(verifier.authenticate(req(token()),Buffer.from('wrong body')),/POS_SERVICE_AUTH/);
 });
});
