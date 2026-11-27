import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash,createPublicKey,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../../src/migrate.mjs';
import {createBankServer,authenticateFineract} from '../../server.mjs';
import {WORKSTATION_BANK_ORIGIN,WORKSTATION_FRONT_STATUS} from '../../src/workstation-admission.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const token=()=>randomBytes(32).toString('base64url');
export const navigationHeaders={accept:'text/html','sec-fetch-dest':'document','sec-fetch-mode':'navigate'};
export const handoffPath='/api/services/workstations/handoff';
export const cookiePair=value=>value.split(';')[0];

// Real core routes and migrations, with synthetic identity-provider and frontend
// authorities. All HTTP stays on loopback and every service request is injected.
export async function startWorkstationAdmissionFixture(){
 let db,pool;
 if(process.env.TEST_DATABASE_URL){
  const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
 }else{
  db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release(){}})};
 }
 const client=await pool.connect();try{await migrate(client);await migrate(client);}finally{client.release();}
 const {privateKey}=generateKeyPairSync('ed25519'),publicKey=createPublicKey(privateKey).export({format:'jwk'});
 const jwk={kty:'OKP',crv:'Ed25519',x:publicKey.x,kid:sha(publicKey.x),alg:'Ed25519',use:'sig'};
 const statuses=new Map(),serviceRequests=[],authentications=[];
 let statusMode='normal';
 const fetcher=async(url,options={})=>{
  serviceRequests.push({url:String(url),method:options.method||'GET'});
  if(String(url)==='https://avis.land/press/api/index-service/jwks')return Response.json({keys:[jwk]});
  assert.equal(String(url),WORKSTATION_FRONT_STATUS,'no unexpected external service may be contacted');
  assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
  if(statusMode==='unavailable')throw new Error('isolated service unavailable');
  if(statusMode==='oversized')return new Response(' '.repeat(9000));
  const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body),['capability']);
  const status=statuses.get(body.capability);
  return Response.json(status||{active:false});
 };
 const authenticate=async(username,password)=>{
  authentications.push(username);
  return authenticateFineract(username,password,'http://genesis-fineract-uat',async(_url,options)=>{
   const input=JSON.parse(options.body);
   if(input.password!=='fixture-password')return Response.json({}, {status:401});
   return Response.json({authenticated:true,userId:username==='second-operator'?84:42,username,
    isTwoFactorAuthenticationRequired:username==='mfa-required',permissions:username==='customer'?['READ_CLIENT']:['ALL_FUNCTIONS']});
  });
 };
 const noNetwork=async()=>assert.fail('Unexpected external service request');
 const server=createBankServer({pool,authenticate,release:'signed-workstation-fixture',transferOptions:{secretEnv:{},
  cryptoFetch:noNetwork,stripeFetch:noNetwork,indexServiceFetcher:noNetwork,posServiceFetcher:noNetwork,
  ipHandlerServiceFetcher:noNetwork,workstationFetcher:fetcher,finListener:{env:{}}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const request=(path='/',{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,agent:false,
   headers:{host:'bank.avispay.online',...headers}},res=>{
   const chunks=[];res.on('data',part=>chunks.push(part));res.on('error',reject);
   res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));
  });req.on('error',reject);req.end(body);
 });
 function signed(raw,{header={},claims={},prefix='Workstation-JWS '}={}){
  const iat=Math.floor(Date.now()/1000);
  const h={alg:'Ed25519',typ:'AVIS-WORKSTATION-REQUEST+JWT',kid:jwk.kid,...header};
  const p={iss:'https://avis.land/bank/workstations',aud:'AVIS_BANK_WORKSTATION_V1',method:'POST',path:handoffPath,
   body_sha256:sha(raw),iat,exp:iat+60,jti:randomBytes(32).toString('hex'),...claims};
  const input=[h,p].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return prefix+input+'.'+sign(null,Buffer.from(input),privateKey).toString('base64url');
 }
 async function start(headers={}){
  const response=await request('/access/start',{headers});
  assert.equal(response.status,303);
  const url=new URL(response.headers.location);
  return {response,url,state:url.searchParams.get('state'),codeChallenge:url.searchParams.get('code_challenge'),cookie:cookiePair(response.headers['set-cookie'][0])};
 }
 function grant(start,patch={}){
  const value={state:start.state,codeChallenge:start.codeChallenge,principal:'admin:owner@fixture.invalid',
   deviceId:'dv-'+token().slice(0,16),approvalId:randomUUID(),generation:randomUUID(),
   expiresAt:new Date(Date.now()+3500000).toISOString(),statusCapability:token()+'.'+token(),...patch};
  statuses.set(value.statusCapability,{active:true,...Object.fromEntries(['principal','deviceId','approvalId','generation','expiresAt'].map(key=>[key,value[key]]))});
  return value;
 }
 async function issue(start,patch={},options={}){
  const value=grant(start,patch),raw=JSON.stringify(value),authorization=signed(raw,options);
  const response=await request(handoffPath,{method:'POST',headers:{'content-type':'application/json',authorization},body:raw});
  return {response,value,raw,authorization,redirectUrl:response.status===200?JSON.parse(response.body).redirectUrl:null};
 }
 async function admit(patch={}){
  const pending=await start(),issued=await issue(pending,patch);assert.equal(issued.response.status,200);
  const url=new URL(issued.redirectUrl),complete=await request(url.pathname+url.search,{headers:{cookie:pending.cookie}});
  assert.equal(complete.status,200);
  const admission=complete.headers['set-cookie'].find(value=>value.startsWith('__Host-avis_bank_admission='));
  return {pending,issued,complete,cookie:cookiePair(admission)};
 }
 const financialSnapshot=async()=> (await pool.query(`SELECT
  (SELECT count(*)::int FROM avis_core_v2.sovereign_users) AS users,
  (SELECT count(*)::int FROM avis_core_v2.ledger_accounts) AS accounts,
  (SELECT count(*)::int FROM avis_core_v2.ledger_entries) AS entries,
  (SELECT count(*)::int FROM avis_core_v2.ledger_journals) AS journals`)).rows[0];
 const before=await financialSnapshot();
 return {pool,request,signed,start,grant,issue,admit,statuses,serviceRequests,authentications,
  statusMode(value){statusMode=value;},async close(){
   server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
   try{assert.deepEqual(await financialSnapshot(),before,'device access must not change accounts or ledgers');}
   finally{if(db)await db.close();else await pool.end();}
  }};
}

export function loginRequest(cookie,username='operator',password='fixture-password',headers={}){
 return {method:'POST',headers:{cookie,origin:WORKSTATION_BANK_ORIGIN,'content-type':'application/json','sec-fetch-site':'same-origin',...headers},body:JSON.stringify({username,password})};
}
