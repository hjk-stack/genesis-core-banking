import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {WorkstationAdmission,WORKSTATION_BANK_ORIGIN} from '../src/workstation-admission.mjs';
import {startWorkstationAdmissionFixture,handoffPath,cookiePair,navigationHeaders,loginRequest} from './helpers/workstation-admission-fixture.mjs';

let fixture;
before(async()=>{fixture=await startWorkstationAdmissionFixture();});
after(async()=>{await fixture?.close();});
const hash=value=>createHash('sha256').update(value).digest('hex');
const pathOf=value=>{const url=new URL(value);return url.pathname+url.search;};
const json=response=>JSON.parse(response.body);
const denied=response=>{assert.equal(response.status,403);assert.equal(json(response).code,'BANK_WORKSTATION_REQUIRED');};

test('public denial, JSON APIs, health, and other host behavior stay intact',async()=>{
 const document=await fixture.request('/',{headers:navigationHeaders});
 assert.equal(document.status,403);assert.match(document.body,/You are not authorized to access this platform\./);
 denied(await fixture.request('/api/session'));
 assert.equal((await fixture.request('/healthz')).status,200);
 for(const path of ['/access/start','/access/complete?state=x&code=y',handoffPath]){
  const response=await fixture.request(path,{headers:{host:'banking.avis.exchange','x-forwarded-host':'bank.avispay.online'}});
  assert.equal(response.status,404);assert.equal(json(response).code,'NOT_FOUND');
 }
 const existing=await fixture.request('/',{headers:{host:'banking.avis.exchange',...navigationHeaders}});
 assert.equal(existing.status,200);assert.doesNotMatch(existing.body,/You are not authorized to access this platform\./);
 assert.match(existing.headers['content-security-policy'],/script-src 'self'/);
 assert.equal(fixture.authentications.length,0);
});

test('bank bootstrap keeps a distinct verifier HttpOnly and exposes only its S256 challenge',async()=>{
 const pending=await fixture.start();
 assert.equal(pending.url.origin,'https://avis.land');assert.equal(pending.url.pathname,'/bank/workstations/connect');
 assert.equal(pending.url.searchParams.get('code_challenge_method'),'S256');
 assert.equal(pending.url.searchParams.size,3);
 const verifier=pending.cookie.split('=')[1];
 assert.notEqual(verifier,pending.state);assert.notEqual(verifier,pending.codeChallenge);
 assert.equal(createHash('sha256').update(verifier).digest('base64url'),pending.codeChallenge);
 assert.ok(!pending.response.headers.location.includes(verifier));
 assert.match(pending.response.headers['set-cookie'][0],/HttpOnly; Secure; Path=\/; SameSite=Lax; Max-Age=120$/);
 assert.equal(pending.response.headers['referrer-policy'],'no-referrer');
 const row=(await fixture.pool.query('SELECT * FROM avis_core_v2.workstation_device_handoffs WHERE state_hash=$1',[hash(pending.state)])).rows[0];
 assert.equal(row.code_challenge,pending.codeChallenge);assert.equal(row.code_hash,null);
 assert.ok(!JSON.stringify(row).includes(verifier),'database pending state must not contain the verifier');
 assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM avis_core_v2.operator_sessions')).rows[0].n,0);
});

test('dedicated service profile rejects unsigned, cross-purpose, changed-body and expired signatures',async()=>{
 const pending=await fixture.start(),raw=JSON.stringify(fixture.grant(pending));
 for(const options of [
  {authorization:''},
  {authorization:fixture.signed(raw,{header:{typ:'AVIS-POS-REQUEST+JWT'},claims:{iss:'https://avis.land/checkout',aud:'AVIS_BANK_POS_V1'},prefix:'Pos-JWS '})},
  {authorization:fixture.signed(raw,{claims:{aud:'AVIS_BANK_INDEX_V1'}})},
  {authorization:fixture.signed(raw,{claims:{exp:Math.floor(Date.now()/1000)-1}})},
  {authorization:fixture.signed(raw),body:raw+' '},
  {authorization:fixture.signed(raw,{claims:{path:'/api/services/checkout-pos/request'}})}
 ]){
  const response=await fixture.request(handoffPath,{method:'POST',headers:{authorization:options.authorization,'content-type':'application/json'},body:options.body||raw});
  assert.equal(response.status,401);
 }
 assert.equal((await fixture.pool.query('SELECT code_hash FROM avis_core_v2.workstation_device_handoffs WHERE state_hash=$1',[hash(pending.state)])).rows[0].code_hash,null);
});

test('signed handoff binds an existing bank state and a bounded non-operator grant',async()=>{
 const pending=await fixture.start();
 for(const patch of [
  {state:randomBytes(32).toString('base64url')},
  {codeChallenge:randomBytes(32).toString('base64url')},
  {expiresAt:new Date(Date.now()-1).toISOString()},
  {expiresAt:new Date(Date.now()+3700000).toISOString()},
  {actor:'fineract:1'}, {admin:true}, {statusUrl:'https://other.invalid/'},
  {approvalId:'not-a-real-approval-id'}
 ])denied((await fixture.issue(pending,patch)).response);
 const issued=await fixture.issue(pending);assert.equal(issued.response.status,200);
 const callback=new URL(issued.redirectUrl);
 assert.equal(callback.origin,WORKSTATION_BANK_ORIGIN);assert.equal(callback.pathname,'/access/complete');
 assert.equal(callback.searchParams.get('state'),pending.state);assert.equal(callback.searchParams.size,2);
 assert.ok(!issued.redirectUrl.includes(issued.value.statusCapability));
 assert.deepEqual(Object.keys(json(issued.response)),['redirectUrl']);
 const replay=await fixture.request(handoffPath,{method:'POST',headers:{'content-type':'application/json',authorization:issued.authorization},body:issued.raw});
 assert.equal(replay.status,401,'signed service jti is atomically one-use');
});

test('a stolen signed handoff/code and fabricated public-challenge cookie cannot admit another browser',async()=>{
 const pending=await fixture.start(),issued=await fixture.issue(pending);assert.equal(issued.response.status,200);
 const path=pathOf(issued.redirectUrl);
 denied(await fixture.request(path));
 denied(await fixture.request(path,{headers:{cookie:'__Host-avis_bank_pending='+pending.codeChallenge}}));
 denied(await fixture.request(path,{headers:{cookie:'__Host-avis_bank_pending='+pending.state}}));
 denied(await fixture.request(path,{headers:{cookie:pending.cookie+'; '+pending.cookie}}));
 denied(await fixture.request(path+'&code=duplicate',{headers:{cookie:pending.cookie}}));
 const complete=await fixture.request(path,{headers:{cookie:pending.cookie}});
 assert.equal(complete.status,200);
 denied(await fixture.request(path,{headers:{cookie:pending.cookie}}));
 assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM avis_core_v2.operator_sessions')).rows[0].n,0,'admission never creates an operator session');
});

test('concurrent callback consumption produces only one admission cookie',async()=>{
 const pending=await fixture.start(),issued=await fixture.issue(pending),path=pathOf(issued.redirectUrl);
 const results=await Promise.all([1,2].map(()=>fixture.request(path,{headers:{cookie:pending.cookie}})));
 assert.deepEqual(results.map(result=>result.status).sort(),[200,403]);
 const successes=results.filter(result=>result.status===200);
 assert.equal(successes[0].headers['set-cookie'].filter(value=>value.startsWith('__Host-avis_bank_admission=')).length,1);
});

test('redemption rejects expired pending state and revocation before completion',async()=>{
 const expired=await fixture.start(),expiredIssue=await fixture.issue(expired);
 await fixture.pool.query("UPDATE avis_core_v2.workstation_device_handoffs SET expires_at=now()-interval '1 second' WHERE state_hash=$1",[hash(expired.state)]);
 denied(await fixture.request(pathOf(expiredIssue.redirectUrl),{headers:{cookie:expired.cookie}}));
 const revoked=await fixture.start(),revokedIssue=await fixture.issue(revoked);
 fixture.statuses.set(revokedIssue.value.statusCapability,{active:false});
 denied(await fixture.request(pathOf(revokedIssue.redirectUrl),{headers:{cookie:revoked.cookie}}));
});

test('completion commits the bank origin with only a hashed script before Strict-cookie navigation',async()=>{
 const admission=await fixture.admit(),response=admission.complete;
 assert.equal(response.headers['referrer-policy'],'no-referrer');assert.match(response.headers['cache-control'],/no-store/);
 assert.ok(response.headers['set-cookie'].some(value=>/^__Host-avis_bank_admission=[A-Za-z0-9_-]{43}; HttpOnly; Secure; Path=\/; SameSite=Strict; Max-Age=/.test(value)));
 assert.ok(response.headers['set-cookie'].some(value=>value.startsWith('__Host-avis_bank_pending=;')&&value.endsWith('Max-Age=0')));
 const script=response.body.match(/<script>([^<]+)<\/script>/)?.[1];assert.match(script,/avisFinTerminalAfterAdmission/);assert.match(script,/location\.replace\(next===\'\/fin-terminal\'\?next:\'\/\'\)/);
 const digest=createHash('sha256').update(script).digest('base64');
 assert.match(response.headers['content-security-policy'],new RegExp("script-src 'sha256-"+digest.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+"'"));
 assert.ok(!response.body.includes(admission.issued.value.statusCapability));
 const page=await fixture.request('/',{headers:{cookie:admission.cookie,...navigationHeaders}});assert.equal(page.status,200);
 const session=await fixture.request('/api/session',{headers:{cookie:admission.cookie}});assert.equal(session.status,401);assert.equal(json(session).code,'UNAUTHORIZED');
});

test('only real bank password and administrator permission create a bank operator session',async()=>{
 const admission=await fixture.admit();
 for(const [username,password,status] of [['operator','wrong-password',401],['customer','fixture-password',403],['mfa-required','fixture-password',403]]){
  const response=await fixture.request('/api/login',loginRequest(admission.cookie,username,password));assert.equal(response.status,status);
 }
 const response=await fixture.request('/api/login',loginRequest(admission.cookie,'second-operator'));
 assert.equal(response.status,200);assert.equal(json(response).username,'second-operator');assert.equal(json(response).admin,true);
 const bankCookie=cookiePair(response.headers['set-cookie'][0]),combined=admission.cookie+'; '+bankCookie;
 const stored=(await fixture.pool.query('SELECT actor_id,workstation_admission_id,workstation_sha256 FROM avis_core_v2.operator_sessions WHERE token_hash=$1',[hash(bankCookie.split('=')[1])])).rows[0];
 assert.equal(stored.actor_id,'fineract:84');assert.ok(stored.workstation_admission_id);assert.equal(stored.workstation_sha256,null);
 assert.equal((await fixture.request('/api/session',{headers:{cookie:combined}})).status,200);
 assert.equal((await fixture.request('/api/session',{headers:{cookie:bankCookie}})).status,403);
 assert.equal((await fixture.request('/api/session',{headers:{cookie:combined,host:'banking.avis.exchange'}})).status,403);
 denied(await fixture.request('/api/login/mobile',loginRequest(admission.cookie)));
});

test('bank login origin/CSRF rules remain independent from the signed service exception',async()=>{
 const admission=await fixture.admit();
 const cross=await fixture.request('/api/login',loginRequest(admission.cookie,'operator','fixture-password',{origin:'https://avis.land','sec-fetch-site':'cross-site'}));
 assert.equal(cross.status,403);assert.equal(json(cross).code,'CSRF');
 const login=await fixture.request('/api/login',loginRequest(admission.cookie));assert.equal(login.status,200);
 const cookie=admission.cookie+'; '+cookiePair(login.headers['set-cookie'][0]);
 const logout=await fixture.request('/api/logout',{method:'POST',headers:{cookie,origin:WORKSTATION_BANK_ORIGIN,'content-type':'application/json'},body:'{}'});
 assert.equal(logout.status,403);assert.equal(json(logout).code,'CSRF');
 const allowed=await fixture.request('/api/logout',{method:'POST',headers:{cookie,origin:WORKSTATION_BANK_ORIGIN,'content-type':'application/json','x-csrf-token':json(login).csrf},body:'{}'});
 assert.equal(allowed.status,200);
 assert.equal((await fixture.request('/api/session',{headers:{cookie}})).status,401);
});

test('current approval, generation, expiry, and reachable authority are checked on every request',async()=>{
 const admission=await fixture.admit(),capability=admission.issued.value.statusCapability;
 const original=fixture.statuses.get(capability);
 for(const patch of [{active:false},{deviceId:'dv-another-device'},{principal:'portal:another-admin'},{approvalId:randomUUID()},{generation:randomUUID()},{expiresAt:new Date(Date.now()-1).toISOString()}]){
  fixture.statuses.set(capability,{...original,...patch});denied(await fixture.request('/api/session',{headers:{cookie:admission.cookie}}));
 }
 fixture.statuses.set(capability,original);
 for(const mode of ['unavailable','oversized']){fixture.statusMode(mode);denied(await fixture.request('/api/session',{headers:{cookie:admission.cookie}}));}
 fixture.statusMode('normal');assert.equal((await fixture.request('/',{headers:{cookie:admission.cookie}})).status,200);
 const login=await fixture.request('/api/login',loginRequest(admission.cookie)),cookie=admission.cookie+'; '+cookiePair(login.headers['set-cookie'][0]);
 assert.equal((await fixture.request('/api/session',{headers:{cookie}})).status,200);
 fixture.statuses.set(capability,{active:false});denied(await fixture.request('/api/session',{headers:{cookie}}));
});

test('a new tab on the same approved device preserves its password session, another device cannot reuse it',async()=>{
 const first=await fixture.admit(),login=await fixture.request('/api/login',loginRequest(first.cookie)),bankCookie=cookiePair(login.headers['set-cookie'][0]);
 const same=await fixture.admit(Object.fromEntries(['principal','deviceId','approvalId','generation'].map(key=>[key,first.issued.value[key]])));
 assert.equal((await fixture.request('/api/session',{headers:{cookie:same.cookie+'; '+bankCookie}})).status,200);
 const other=await fixture.admit({principal:first.issued.value.principal});
 denied(await fixture.request('/api/session',{headers:{cookie:other.cookie+'; '+bankCookie}}));
});

test('anonymous bootstrap rate limiting stops writes and expires its bounded memory buckets',async()=>{
 let now=1000,writes=0;
 const controller=new WorkstationAdmission({query:async()=>{writes++;return {rows:[{state_hash:'test'}]};}},{now:()=>now});
 const req={socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-for':'different-on-every-call'}};
 for(let n=0;n<60;n++)await controller.start(req);
 await assert.rejects(controller.start(req),error=>error.code==='TOO_MANY_ATTEMPTS'&&error.status===429);assert.equal(writes,60);
 now+=60000;await controller.start(req);assert.equal(writes,61);
});

test('bootstrap cleans expired state and limits retained live pending rows',async()=>{
 const pending=await fixture.start();
 await fixture.pool.query("UPDATE avis_core_v2.workstation_device_handoffs SET expires_at=now()-interval '1 second' WHERE state_hash=$1",[hash(pending.state)]);
 await fixture.start();assert.equal((await fixture.pool.query('SELECT state_hash FROM avis_core_v2.workstation_device_handoffs WHERE state_hash=$1',[hash(pending.state)])).rows.length,0);
 const rows=Array.from({length:1000},()=>({hash:randomBytes(32).toString('hex'),challenge:randomBytes(32).toString('base64url')}));
 await fixture.pool.query(`INSERT INTO avis_core_v2.workstation_device_handoffs(state_hash,code_challenge,expires_at)
  SELECT item->>'hash',item->>'challenge',now()+interval '120 seconds' FROM jsonb_array_elements($1::jsonb) item`,[JSON.stringify(rows)]);
 const count=async()=>Number((await fixture.pool.query('SELECT count(*) AS n FROM avis_core_v2.workstation_device_handoffs')).rows[0].n),before=await count();
 denied(await fixture.request('/access/start'));assert.equal(await count(),before);
});
