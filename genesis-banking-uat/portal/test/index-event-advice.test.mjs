import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,generateKeyPairSync,createHash,sign} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {TradingRobotCore} from '../src/trading-robot.mjs';
import {CustomerAccess} from '../src/customer-access.mjs';
import {TradingRuntime} from '../src/trading/runtime.mjs';
import {INDEX_CANDIDATE_FIELDS,INDEX_TAXONOMY,indexPolicyHash,validateIndexCandidate} from '../src/index-event-advice.mjs';
import {IndexServiceAuthenticator,INDEX_SERVICE_ISSUER,INDEX_SERVICE_AUDIENCE,INDEX_SERVICE_JWKS} from '../src/index-service-auth.mjs';
import {createBankServer} from '../server.mjs';
import {migrate} from '../src/migrate.mjs';

const admin={id:'index-test-admin',admin:true},customer={id:'index-test-customer',admin:false,customerUserId:'2'},service={id:'service:avis-press-index',admin:true,indexService:true,indexAuthMethod:'ED25519_JWS'},key=()=>randomUUID(),hex=()=>randomBytes(32).toString('hex'),iso=n=>new Date(n).toISOString();
let pool,db,core,securityId,robotId,robotConfig,identity;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname,'/avispay_ci');pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};}
 const client=await pool.connect();try{await migrate(client);}finally{client.release();}
 core=new TradingRobotCore(pool,{secretEnv:{AVIS_INDEX_SERVICE_TOKEN:'isolated-index-service-token-'.repeat(2)}});
 securityId=(await core.addSecurity(admin,{name:'Index fixture issuer',shortName:'IDXTEST',currency:'EUR',denomination:'1',quoteBasis:'UNIT',kind:'share'},key())).id;
 const account=(await core.list(admin,'accountsummaries')).find(a=>String(a.user_id)==='1'&&a.currency_code==='EUR');
 robotConfig={name:'Index fixture robot',userId:'1',venue:'AVIS',symbol:'IDXTEST',indexId:'IDXTEST',securityId,accountId:account.account_id,maxNotional:'100',dailyNotional:'1000',maxLoss:'100',trailingBps:50,minimumIndex:0};
 robotId=(await core.configureRobot(admin,robotConfig,key())).id;
 identity=(await core.indexPolicy(admin)).instruments.find(i=>i.instrument_id==='AVIS:'+securityId);
});
after(async()=>{if(db)await db.close();else await pool.end();});
const candidate=(extra={})=>({ ...Object.fromEntries(INDEX_CANDIDATE_FIELDS.map(k=>[k,null])),signal_id:hex(),event_id:'event:'+key(),event_version:1,event_category:'EQ01',event_status:'PENDING',source_urls:['https://issuer.example/announcement'],source_published_at:iso(Date.now()-5000),first_seen_at:iso(Date.now()-4000),analysed_at:iso(Date.now()-1000),original_language:'en',evidence_summary:'The issuer published a contract announcement.',issuer_or_asset_name:'Index fixture issuer',affected_role:'direct',proposed_action:'WATCH',model_version:'isolated-extraction-v1',expires_at:iso(Date.now()+90000),...extra});
const matched=(extra={})=>candidate({...structuredClone(identity),...extra});
const actionable=(action='BUY',extra={})=>matched({proposed_action:action,event_status:'CONFIRMED',materiality_estimate:'0.02',surprise_estimate:'0.01',price_before_event:'100',current_bid:'100',current_ask:'100.02',quote_timestamp:iso(Date.now()-1500),price_reaction:'0.001',spread:'0.02',available_depth:'1000',forecast_horizon:'PT30M',expected_net_return_range:{low:'0.001',high:'0.02',unit:'fraction',costs_included:true},evidence_confidence:.8,entry_condition:'Fresh executable quote and the existing strategy checks.',invalidation_condition:'Cancellation or expiry of the announcement.',...extra});
async function batch(candidates,extra={}){const p=await core.indexPolicy(admin);return {schemaVersion:1,producer:'AVIS_PRESS_ROBOT',batchId:hex(),policyVersion:p.policyVersion,policyHash:p.policyHash,generatedAt:iso(Date.now()),candidates,...extra};}
const rejects=(promise,code,field)=>assert.rejects(promise,e=>e.code===code&&(field===undefined||e.field===field));

test('the private policy contains every PDF category and only exact institution instrument identities',async()=>{
 const p=await core.indexPolicy(admin);assert.equal(p.policyVersion,0);assert.equal(p.policyHash,indexPolicyHash(p.instructions));assert.equal(p.taxonomy.length,38);assert.equal(p.candidateFields.length,47);assert.deepEqual(p.taxonomy.map(t=>t.id),INDEX_TAXONOMY.map(t=>t.id));assert.ok(p.instructions.includes('Never match by ticker alone'));
 assert.equal(p.instruments.length,1);assert.equal(identity.instrument.security_id,securityId);for(const name of ['account_id','user_id','key_ref','robot_id'])assert.equal(JSON.stringify(p.instruments).includes(name),false);
 for(const actor of [customer,{...admin,customerUserId:'2'}]){await rejects(core.indexPolicy(actor),'FORBIDDEN');await rejects(core.saveIndexPolicy(actor,{expectedVersion:0,instructions:'private'},key()),'FORBIDDEN');await rejects(core.list(actor,'indexcandidates'),'FORBIDDEN');}
 const access=new CustomerAccess(core);await rejects(access.invoke(customer,'indexPolicy',{}),'FORBIDDEN');await rejects(access.invoke(customer,'saveIndexPolicy',{},key()),'FORBIDDEN');await rejects(access.list(customer,'indexpolicies'),'FORBIDDEN');await rejects(core.ingestIndexCandidates(admin,await batch([])),'FORBIDDEN');
});

test('instruction saves are immutable, optimistic and idempotent',async()=>{
 const p=await core.indexPolicy(admin),input={expectedVersion:p.policyVersion,instructions:p.instructions+'\nPrefer official contract notices.'},k=key(),saved=await core.saveIndexPolicy(admin,input,k);assert.equal(saved.policyVersion,1);assert.equal(saved.policyHash,indexPolicyHash(input.instructions));assert.deepEqual(await core.saveIndexPolicy(admin,input,k),JSON.parse(JSON.stringify(saved)));
 await rejects(core.saveIndexPolicy(admin,input,key()),'INDEX_POLICY_CONFLICT');await rejects(core.saveIndexPolicy(admin,{...input,instructions:'Changed'},k),'IDEMPOTENCY_CONFLICT');
 await assert.rejects(pool.query('UPDATE avis_core_v2.index_analysis_policies SET instructions=$1 WHERE version=1',['overwritten']));
 assert.equal((await core.indexPolicy(admin)).instructions,input.instructions);
});

test('news-only WATCH delivery is durable, replayable, and never creates an order or enables a profile',async()=>{
 const c=matched(),b=await batch([c]),first=await core.ingestIndexCandidates(service,b);assert.equal(first.accepted,1);assert.equal(first.matched,1);assert.equal(first.signals[0].resolution.robots[0].robotId,robotId);
 assert.deepEqual(await core.ingestIndexCandidates(service,b),first);await rejects(core.ingestIndexCandidates(service,{...b,candidates:[{...c,evidence_summary:'Different content'}]}),'IDEMPOTENCY_CONFLICT');
 const saved=(await pool.query('SELECT * FROM avis_core_v2.index_event_candidates WHERE signal_id=$1',[c.signal_id])).rows[0];assert.equal(saved.payload.expected_value,null);assert.equal(saved.payload.current_bid,null);assert.equal(saved.payload.expected_net_return_range,null);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.trading_robot_orders')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_journals')).rows[0].n,0);assert.equal((await pool.query('SELECT enabled FROM avis_core_v2.trading_robots WHERE robot_id=$1',[robotId])).rows[0].enabled,false);
});

test('ticker matches, conflicting security metadata and caller account injection cannot bind to a robot',async()=>{
 for(const c of [matched({instrument:{type:'SHARE',venue:'AVIS',symbol:'IDXTEST'}}),matched({isin:'XX0000000000'}),matched({instrument_id:'a-ticker-alias'})]){const r=await core.ingestIndexCandidates(service,await batch([c]));assert.equal(r.matched,0);assert.equal(r.signals[0].resolution.status,'UNRESOLVED');}
 for(const field of ['user_id','account_id','robot_id'])await rejects(core.ingestIndexCandidates(service,await batch([{...matched(),[field]:'2'}])),'INDEX_CANDIDATE',field);
 await rejects(core.ingestIndexCandidates(service,await batch([actionable('BUY',{instrument_id:'wrong-id'})])),'INDEX_ACTIONABILITY','instrument_id');
});

test('malformed, future-dated and stale evidence fails before intake',async()=>{
 const c=matched();for(const change of [{event_category:'EQ99'},{source_urls:['javascript:alert(1)']},{expected_value:'1'},{first_seen_at:iso(Date.now()-16000)},{source_published_at:iso(Date.now()+1000)},{quote_timestamp:'2026-02-30T00:00:00Z'},{evidence_confidence:2}])await rejects(core.ingestIndexCandidates(service,await batch([{...c,...change}])),'INDEX_CANDIDATE');
 await rejects(core.ingestIndexCandidates(service,await batch([c],{generatedAt:iso(Date.now()-181000)})),'INDEX_CANDIDATE','generatedAt');
 await rejects(core.ingestIndexCandidates(service,await batch([c],{policyHash:'a'.repeat(64)})),'INDEX_POLICY_VERSION');
 const missing={...c};delete missing.expected_value;await rejects(core.ingestIndexCandidates(service,await batch([missing])),'INDEX_CANDIDATE','expected_value');
});

test('action labels require measured opportunity and typed consensus where applicable; all six advice actions are preserved',async()=>{
 for(const action of ['BUY','SELL','SHORT','COVER'])await rejects(core.ingestIndexCandidates(service,await batch([matched({proposed_action:action})])),'INDEX_ACTIONABILITY');
 for(const patch of [{available_depth:'0'},{quote_timestamp:iso(Date.now()-61000)},{expected_net_return_range:{low:'0.1',high:'0.2',unit:'fraction',costs_included:false}},{event_status:'RUMOUR'},{entry_condition:null},{materiality_estimate:null},{event_category:'EQ02'}])await rejects(core.ingestIndexCandidates(service,await batch([actionable('BUY',patch)])),'INDEX_ACTIONABILITY');
 const delayed=actionable('BUY',{source_published_at:iso(Date.now()-95000),first_seen_at:iso(Date.now()-94000),analysed_at:iso(Date.now()-90000),quote_timestamp:iso(Date.now()-91000)});await rejects(core.ingestIndexCandidates(service,await batch([delayed],{generatedAt:iso(Date.now()-89000)})),'INDEX_ACTIONABILITY','proposed_action');
 for(const action of ['BUY','SELL','SHORT','COVER','HOLD','WATCH']){const c=['HOLD','WATCH'].includes(action)?matched({proposed_action:action}):actionable(action),r=await core.ingestIndexCandidates(service,await batch([c]));assert.equal(r.matched,1);assert.equal((await pool.query('SELECT proposed_action FROM avis_core_v2.index_event_candidates WHERE signal_id=$1',[c.signal_id])).rows[0].proposed_action,action);}
 const earnings=actionable('BUY',{event_category:'EQ02',actual_value:'1.20',expected_value:'1.10',units:'EUR per share',expectation_source:'https://consensus.example/snapshot',expectation_timestamp:iso(Date.now()-10000),metric_basis:{measure:'EPS',period:'2026Q3',basis:'adjusted diluted',source_vintage:'2026-11-15'}});assert.equal((await core.ingestIndexCandidates(service,await batch([earnings]))).matched,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.trading_robot_orders')).rows[0].n,0);
});

test('candidate metadata and receipts cannot be rewritten after acceptance',async()=>{
 const c=matched(),b=await batch([c]);await core.ingestIndexCandidates(service,b);
 await assert.rejects(pool.query("UPDATE avis_core_v2.index_event_candidates SET payload=payload||'{\"proposed_action\":\"BUY\"}'::jsonb WHERE signal_id=$1",[c.signal_id]),/INDEX_HISTORY_IMMUTABLE/);
 await assert.rejects(pool.query("UPDATE avis_core_v2.index_event_candidates SET resolution='{}' WHERE signal_id=$1",[c.signal_id]),/INDEX_HISTORY_IMMUTABLE/);
 await assert.rejects(pool.query('DELETE FROM avis_core_v2.index_event_candidates WHERE signal_id=$1',[c.signal_id]),/INDEX_HISTORY_IMMUTABLE/);
 await assert.rejects(pool.query("UPDATE avis_core_v2.index_event_batches SET receipt='{}' WHERE batch_id=$1",[b.batchId]));
});

test('corrections and cancellations supersede the prior event and revoke robot context',async()=>{
 const first=actionable();await core.ingestIndexCandidates(service,await batch([first]));const runtime=new TradingRuntime(core);runtime.configs=(await pool.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=$1',[robotId])).rows;const messages=[];runtime.send=m=>messages.push(m);await runtime.refreshEventAdvice();assert.ok(messages.at(-1).candidates.some(c=>c.signalId===first.signal_id));
 const corrected={...first,signal_id:hex(),event_version:2,event_status:'PENDING',proposed_action:'WATCH',supersedes_signal_id:first.signal_id,evidence_summary:'The issuer is checking the prior contract.'};await core.ingestIndexCandidates(service,await batch([corrected]));assert.deepEqual((await pool.query('SELECT last_event_advice FROM avis_core_v2.trading_robots WHERE robot_id=$1',[robotId])).rows[0].last_event_advice,[]);let advice=(await core.robotIndexAdvice(admin,[robotId]))[robotId];assert.equal(advice.some(c=>c.signalId===first.signal_id),false);assert.equal(advice.some(c=>c.signalId===corrected.signal_id),true);
 const cancelled={...corrected,signal_id:hex(),event_version:3,event_status:'CANCELLED',supersedes_signal_id:corrected.signal_id};await core.ingestIndexCandidates(service,await batch([cancelled]));advice=(await core.robotIndexAdvice(admin,[robotId]))[robotId];assert.equal(advice.some(c=>[first.signal_id,corrected.signal_id,cancelled.signal_id].includes(c.signalId)),false);
 await rejects(core.ingestIndexCandidates(service,await batch([{...cancelled,signal_id:hex(),event_version:4,supersedes_signal_id:first.signal_id}])),'INDEX_EVENT_VERSION');
 assert.deepEqual((await pool.query('SELECT state FROM avis_core_v2.index_event_candidates WHERE event_id=$1 ORDER BY event_version',[first.event_id])).rows.map(r=>r.state),['SUPERSEDED','SUPERSEDED','CANCELLED']);
});

test('multiline source quotes survive atomic cancellation and replacement when an exact instrument becomes known',async()=>{
 const evidence=['Issuer announces a new contract.','The contract remains subject to final approval.'].join('\n'),exposure='The issuer names its supplier.\r\n\tThe supplier confirms the relationship.';
 const first=candidate({evidence_summary:evidence,affected_role:'supplier',exposure_evidence:{source_urls:['https://issuer.example/announcement'],summary:exposure},entry_condition:'Check final approval.\n\tCheck a current executable quote.',invalidation_condition:'A cancellation is published.\r\nThe candidate expires.'});
 const initial=await core.ingestIndexCandidates(service,await batch([first]));assert.equal(initial.matched,0);
 const cancelled={...first,signal_id:hex(),event_version:2,event_status:'CANCELLED',supersedes_signal_id:first.signal_id,evidence_summary:'Prior unresolved attribution is withdrawn.\nAn exact catalogue instrument is now available.'};
 const replacement=matched({event_id:first.event_id,evidence_summary:evidence}),b=await batch([cancelled,replacement]),receipt=await core.ingestIndexCandidates(service,b);assert.equal(receipt.accepted,2);assert.equal(receipt.matched,1);assert.deepEqual(await core.ingestIndexCandidates(service,b),receipt);
 const rows=(await pool.query('SELECT signal_id,state,payload FROM avis_core_v2.index_event_candidates WHERE event_id=$1',[first.event_id])).rows,old=rows.find(r=>r.signal_id===first.signal_id),withdrawn=rows.find(r=>r.signal_id===cancelled.signal_id),current=rows.find(r=>r.signal_id===replacement.signal_id);
 assert.equal(old.state,'SUPERSEDED');assert.equal(withdrawn.state,'CANCELLED');assert.equal(current.state,'ACTIVE');assert.equal(old.payload.evidence_summary,evidence);assert.equal(old.payload.exposure_evidence.summary,exposure);assert.equal(old.payload.entry_condition,first.entry_condition);assert.equal(old.payload.invalidation_condition,first.invalidation_condition);assert.equal(withdrawn.payload.evidence_summary,cancelled.evidence_summary);
 const advice=(await core.robotIndexAdvice(admin,[robotId]))[robotId];assert.equal(advice.some(c=>c.signalId===replacement.signal_id),true);assert.equal(advice.some(c=>[first.signal_id,cancelled.signal_id].includes(c.signalId)),false);
});

test('multiline prose retains control, blank and size guards while identifiers remain single-line',()=>{
 const set=(field,value)=>field==='exposure_evidence.summary'?candidate({exposure_evidence:{source_urls:['https://issuer.example/announcement'],summary:value}}):candidate({[field]:value});
 for(const [field,max]of [['evidence_summary',4000],['exposure_evidence.summary',2000],['entry_condition',2000],['invalidation_condition',2000]]){
  assert.doesNotThrow(()=>validateIndexCandidate(set(field,'First paragraph.\nSecond paragraph.\r\n\tIndented detail.'),Date.now()));assert.doesNotThrow(()=>validateIndexCandidate(set(field,'x'.repeat(max)),Date.now()));
  for(const value of ['\n\t\r\n','x'.repeat(max+1),...['\x00','\x0b','\x1b','\x7f','\r'].map(control=>'First'+control+'Second')])assert.throws(()=>validateIndexCandidate(set(field,value),Date.now()),e=>e.code==='INVALID_FIELD'&&e.field===field);
 }
 for(const field of ['signal_id','ticker','model_version'])assert.throws(()=>validateIndexCandidate(candidate({[field]:'first\nsecond'}),Date.now()),e=>e.code==='INVALID_FIELD'&&e.field===field);
});

test('batch failure rolls back every candidate and immutable receipt',async()=>{
 const good=matched(),bad=matched({event_version:2}),b=await batch([good,bad]);await rejects(core.ingestIndexCandidates(service,b),'INDEX_EVENT_VERSION');assert.equal((await pool.query('SELECT 1 FROM avis_core_v2.index_event_candidates WHERE signal_id=$1',[good.signal_id])).rows.length,0);assert.equal((await pool.query('SELECT 1 FROM avis_core_v2.index_event_batches WHERE batch_id=$1',[b.batchId])).rows.length,0);
});

test('expired advice, changed policy and changed robot version cannot attach to an order',async()=>{
 const fresh=actionable(),expired=matched({source_published_at:iso(Date.now()-15000),first_seen_at:iso(Date.now()-14000),analysed_at:iso(Date.now()-10000),expires_at:iso(Date.now()-1000)});const b=await batch([fresh,expired]);await core.ingestIndexCandidates(service,b);let r=(await pool.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=$1',[robotId])).rows[0];const ids=[fresh.signal_id,expired.signal_id];assert.deepEqual((await core.indexOrderEvidence(pool,admin,r,{eventSignalIds:ids,side:'BUY'})).map(c=>c.signalId),[fresh.signal_id]);assert.deepEqual(await core.indexOrderEvidence(pool,admin,r,{eventSignalIds:ids,side:'SELL'}),[]);
 await core.configureRobot(admin,robotConfig,key());assert.deepEqual(await core.indexOrderEvidence(pool,admin,r,{eventSignalIds:ids,side:'BUY'}),[]);
 const current=matched(),latest=await batch([current]);await core.ingestIndexCandidates(service,latest);const p=await core.indexPolicy(admin);await core.saveIndexPolicy(admin,{expectedVersion:p.policyVersion,instructions:p.instructions+'\nRetain original language.'},key());assert.deepEqual((await core.robotIndexAdvice(admin,[robotId]))[robotId],[]);assert.equal((await core.ingestIndexCandidates(service,latest)).batchId,latest.batchId,'accepted retries survive later policy changes');await rejects(core.ingestIndexCandidates(service,{...latest,batchId:hex()}),'INDEX_POLICY_VERSION');
 await rejects(core.robotOrder(admin,{robotId,side:'BUY',signalId:hex(),eventSignalIds:[current.signal_id],quantity:'1',price:'1'},key()),'ROBOT_SYMBOL');
});

test('crypto identities remain network-specific and venue filters come from the execution catalogue',async()=>{
 let marketReads=0;core.venue={credentials(){return {};},balance:async()=>[],market:async()=>{marketReads++;return {baseAsset:'ETH',quoteAsset:'USDT',priceTick:'0.01',quantityStep:'0.001',minQuantity:'0.001',maxQuantity:'1000',minNotional:'5'};}};
 await pool.query("UPDATE avis_core_v2.crypto_asset_networks SET approved=true,verified_at=now(),decimals=18 WHERE asset_id='ethereum' AND network='ETHEREUM'");
 const id=(await core.configureRobot(admin,{...robotConfig,name:'Exact crypto',venue:'BINANCE',symbol:'ETHUSDT',indexId:'ETH',keyRef:'TRADING_TEST',securityId:null,accountId:null},key())).id;
 const cryptoIdentity=(await core.indexPolicy(admin)).instruments.find(i=>i.instrument_id==='BINANCE:ETHUSDT:ETHEREUM:NATIVE');assert.ok(cryptoIdentity);
 const good=actionable('SHORT',{...cryptoIdentity,event_category:'CR01'});const accepted=await core.ingestIndexCandidates(service,await batch([good]));assert.equal(accepted.matched,1);assert.equal(accepted.signals[0].resolution.robots[0].robotId,id);assert.equal(accepted.signals[0].resolution.venueFilters.source,'BINANCE_EXCHANGE_INFO');assert.equal(accepted.signals[0].resolution.venueFilters.minNotional,'5');assert.ok(marketReads>=2);
 const wrong=matched({...cryptoIdentity,chain_id:'56',event_category:'CR01'});assert.equal((await core.ingestIndexCandidates(service,await batch([wrong]))).matched,0);
 await rejects(core.ingestIndexCandidates(service,await batch([matched({...cryptoIdentity,isin:'XX0000000000'})])),'INDEX_CANDIDATE','isin');
 assert.deepEqual(await core.indexOrderEvidence(pool,admin,{robot_id:id},{side:'SELL',eventSignalIds:[good.signal_id]}),[],'SHORT never becomes a spot SELL');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.trading_robot_orders')).rows[0].n,0);
});

const signing=()=>{const pair=generateKeyPairSync('ed25519');return {...pair,jwk:{...pair.publicKey.export({format:'jwk'}),kid:'isolated-key',alg:'Ed25519',use:'sig'}};};
function signedRequest(pair,{method='GET',path='/api/services/press-index/policy',body=Buffer.alloc(0),payload={},header={}}={}){const now=Math.floor(Date.now()/1000),h={alg:'Ed25519',typ:'AVIS-INDEX-REQUEST+JWT',kid:pair.jwk.kid,...header},p={iss:INDEX_SERVICE_ISSUER,aud:INDEX_SERVICE_AUDIENCE,method,path,body_sha256:createHash('sha256').update(body).digest('hex'),iat:now,exp:now+60,jti:hex(),...payload},parts=[h,p].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url'));return {headers:{authorization:'Index-JWS '+parts.join('.')+'.'+sign(null,Buffer.from(parts.join('.')),pair.privateKey).toString('base64url')},method,url:path};}

test('Ed25519 service requests bind the fixed issuer, audience, verb, path, body, expiry and durable nonce',async()=>{
 const pair=signing(),calls=[],auth=new IndexServiceAuthenticator(pool,{fetcher:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({keys:[pair.jwk]}));}}),request=signedRequest(pair);assert.equal((await auth.authenticate(request)).indexService,true);assert.equal(calls.length,1);assert.equal(calls[0].url,INDEX_SERVICE_JWKS);assert.equal(calls[0].options.redirect,'error');await rejects(auth.authenticate(request),'INDEX_SERVICE_AUTH');
 const fresh=new IndexServiceAuthenticator(pool,{fetcher:async()=>new Response(JSON.stringify({keys:[pair.jwk]}))});await rejects(fresh.authenticate(request),'INDEX_SERVICE_AUTH');
 for(const payload of [{aud:'OTHER'},{iss:'https://evil.example'},{method:'POST'},{path:'/api/payments/transfer'},{body_sha256:'0'.repeat(64)},{exp:1},{iat:Math.floor(Date.now()/1000)+90,exp:Math.floor(Date.now()/1000)+120},{exp:Math.floor(Date.now()/1000)+300}])await rejects(auth.authenticate(signedRequest(pair,{payload})),'INDEX_SERVICE_AUTH');
 for(const header of [{alg:'none'},{alg:'EdDSA'},{typ:'JWT'},{jku:'https://evil.example/jwks'}])await rejects(auth.authenticate(signedRequest(pair,{header})),'INDEX_SERVICE_AUTH');
 const body=Buffer.from('{"candidate":"immutable"}'),post=signedRequest(pair,{method:'POST',path:'/api/services/press-index/candidates',body});await rejects(auth.authenticate(post,Buffer.from('{"candidate":"changed"}')),'INDEX_SERVICE_AUTH');assert.equal((await auth.authenticate(post,body)).indexService,true);assert.equal(calls.length,1);
});

test('only public Ed25519 keys from the pinned bounded JWKS response are accepted',async()=>{
 const pair=signing(),request=signedRequest(pair);
 for(const response of [new Response(JSON.stringify({keys:[{...pair.jwk,d:'secret'}]})),new Response(JSON.stringify({keys:[{...pair.jwk,crv:'X25519'}]})),new Response('x'.repeat(8200)),new Response('{}',{status:302})]){const auth=new IndexServiceAuthenticator(pool,{fetcher:async()=>response});await rejects(auth.authenticate(request),'INDEX_SERVICE_AUTH');}
 const auth=new IndexServiceAuthenticator(pool,{env:{AVIS_WALLET_ENCRYPTION_KEY:'not-an-index-service-secret'.repeat(3)},fetcher:async()=>{throw Error('No call');}});await rejects(auth.authenticate({headers:{authorization:'Bearer '+('not-an-index-service-secret'.repeat(3))},method:'GET',url:'/api/services/press-index/policy'}),'INDEX_SERVICE_AUTH');
});

test('HTTP policy/candidate routes isolate service authentication and actual back-office administrators',async()=>{
 await core.bindCustomerLogin(admin,{fineractUserId:'302',userId:'2'},key());const pair=signing(),server=createBankServer({pool,secureCookies:false,transferOptions:{secretEnv:core.secretEnv,indexServiceFetcher:async()=>new Response(JSON.stringify({keys:[pair.jwk]}))},authenticate:async username=>({id:username==='admin'?'index-http-admin':'fineract:302',username,admin:username==='admin'})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const login=async username=>{const r=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username,password:'isolated-test'})}),v=await r.json();assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],origin:base,'x-csrf-token':v.csrf,'content-type':'application/json','idempotency-key':key()};};
 try{
  assert.equal((await fetch(base+'/api/crypto/trading/index-policy')).status,401);assert.equal((await fetch(base+'/api/services/press-index/policy')).status,401);
  const customerHeaders=await login('customer'),adminHeaders=await login('admin');for(const path of ['/api/crypto/trading/index-policy','/api/crypto/trading/index-delivery','/api/views/indexpolicies','/api/views/indexcandidates'])assert.equal((await fetch(base+path,{headers:customerHeaders})).status,403);
  assert.equal((await fetch(base+'/api/crypto/trading/index-policy',{method:'POST',headers:customerHeaders,body:JSON.stringify({expectedVersion:0,instructions:'customer override'})})).status,403);
  assert.equal((await fetch(base+'/api/crypto/trading/index-policy',{headers:adminHeaders})).status,200);assert.equal((await fetch(base+'/api/workspace',{method:'POST',headers:adminHeaders,body:JSON.stringify({userId:'2'})})).status,200);assert.equal((await fetch(base+'/api/crypto/trading/index-policy',{headers:adminHeaders})).status,403);
  const signed=signedRequest(pair);let response=await fetch(base+signed.url,{headers:signed.headers});assert.equal(response.status,200);const policy=await response.json();assert.equal(policy.policyHash,indexPolicyHash(policy.instructions));assert.equal((await fetch(base+signed.url,{headers:signed.headers})).status,401);
  const b=await batch([matched()]),raw=Buffer.from(JSON.stringify(b)),post=signedRequest(pair,{method:'POST',path:'/api/services/press-index/candidates',body:raw});response=await fetch(base+post.url,{method:'POST',headers:{...post.headers,'content-type':'application/json'},body:raw});assert.equal(response.status,200);assert.equal((await response.json()).accepted,1);const delivery=await core.indexDelivery(admin);assert.equal(delivery.lastAccepted.authentication,'ED25519_JWS');assert.equal(delivery.lastAccepted.batchId,b.batchId);assert.equal(JSON.stringify(delivery).includes('evidence_summary'),false);assert.equal(JSON.stringify(delivery).includes('instructions'),false);
  const retry=signedRequest(pair,{method:'POST',path:post.url,body:raw});assert.equal((await fetch(base+retry.url,{method:'POST',headers:{...retry.headers,'content-type':'application/json'},body:raw})).status,200);
  const receipt=await (await fetch(base+'/api/crypto/trading/index-receipt')).json();for(const field of ['instructions','policyHash','candidates','instruments','signal_id'])assert.equal(Object.hasOwn(receipt,field),false);
 }finally{await new Promise(r=>server.close(r));}
});
