import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startStaffAccessFixture} from './helpers/staff-access-fixture.mjs';

const navigation={accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8','sec-fetch-dest':'document','sec-fetch-mode':'navigate'};
const message='You are not authorized to access this platform.';
let fixture,certificateHeader;
const envNames=['BANK_DESK_MTLS_INGRESS','BANK_DESK_CHANNEL_SECRET','BANK_DESK_ENFORCE'];
const savedEnv=Object.fromEntries(envNames.map(name=>[name,process.env[name]]));
before(async()=>{
 process.env.BANK_DESK_MTLS_INGRESS='azure-container-apps';
 process.env.BANK_DESK_CHANNEL_SECRET='isolated-staff-access-test-channel-secret';
 delete process.env.BANK_DESK_ENFORCE;
 const directory=mkdtempSync(join(tmpdir(),'bank-access-test-'));
 try {
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','1','-subj','/CN=isolated-access-test','-keyout',join(directory,'key'),'-out',join(directory,'cert')],{stdio:'ignore'});
  const pem=readFileSync(join(directory,'cert'),'utf8'),certificate=new X509Certificate(pem);
  certificateHeader='Hash='+certificate.fingerprint256.replaceAll(':','').toLowerCase()+';Cert="'+encodeURIComponent(pem)+'";';
 } finally {rmSync(directory,{recursive:true,force:true});}
 fixture=await startStaffAccessFixture();
});
after(async()=>{
 try {await fixture?.close();} finally {
  for(const name of envNames)if(savedEnv[name]===undefined)delete process.env[name];else process.env[name]=savedEnv[name];
 }
});

function jsonDenied(response,code='BANK_WORKSTATION_REQUIRED',status=403) {
 assert.equal(response.status,status);
 assert.match(response.headers['content-type'],/^application\/json/);
 const value=JSON.parse(response.body);assert.equal(value.code,code);
 assert.equal(value.requestId,response.headers['x-request-id']);
 assert.ok(!response.body.includes(message));
 return value;
}

test('an unapproved browser navigation receives the full-screen 403 document and keeps its diagnostic request ID',async t=>{
 t.mock.method(globalThis,'fetch',async()=>assert.fail('certificate denial must not call an external service'));
 const logs=[];t.mock.method(console,'error',value=>logs.push(JSON.parse(value)));
 const response=await fixture.request('/',{headers:navigation});
 assert.equal(response.status,403);assert.match(response.headers['content-type'],/^text\/html; charset=utf-8$/);
 assert.match(response.body,/<h1[^>]*>You are not authorized to access this platform\.<\/h1>/);
 assert.match(response.body,/reserved for approved AVISPay workstations/);
 assert.match(response.body,/href="https:\/\/avis\.land"/);
 assert.ok(!/<(?:script|form|img|iframe)\b/i.test(response.body));
 assert.equal(response.headers['cache-control'],'no-store');
 assert.equal(response.headers['x-content-type-options'],'nosniff');
 assert.match(response.headers['x-request-id'],/^[a-f0-9]{16}$/);
 assert.ok(logs.some(log=>log.requestId===response.headers['x-request-id']&&log.code==='BANK_WORKSTATION_REQUIRED'));
 const inlineStyle=response.body.match(/<style>([\s\S]*?)<\/style>/)?.[1];assert.ok(inlineStyle);
 const hash=createHash('sha256').update(inlineStyle).digest('base64');
 assert.equal(response.headers['content-security-policy'],`default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
 assert.equal(fixture.authentications.length,0);
});

test('HTML negotiation supports document clients and keeps fetch, asset, and non-HTML requests in JSON',async()=>{
 for(const headers of [{accept:'text/html'},{...navigation,accept:'TEXT/HTML; q=0.8'},{...navigation,host:'BANK.AVISPAY.ONLINE:443'}]){
  const response=await fixture.request('/',{headers});assert.equal(response.status,403);assert.match(response.headers['content-type'],/^text\/html/);
 }
 for(const headers of [
  {},{accept:'application/json'},{accept:'*/*'},
  {...navigation,accept:'text/html;q=0,application/json'},
  {...navigation,accept:'text/html;q=invalid'},
  {...navigation,'sec-fetch-mode':'cors','sec-fetch-dest':'empty'},
  {...navigation,'sec-fetch-mode':'no-cors','sec-fetch-dest':'script'},
  {...navigation,'sec-fetch-dest':'iframe'},
  {accept:'text/html','sec-fetch-dest':'document'}
 ])jsonDenied(await fixture.request('/',{headers}));
});

test('API routes and POST errors stay JSON even when the client asks for HTML',async()=>{
 for(const path of ['/api','/api/session','/api/login','/api/views/accounts'])jsonDenied(await fixture.request(path,{headers:navigation}));
 jsonDenied(await fixture.request('/',{method:'POST',headers:navigation}));
});

test('health remains public JSON, while private readiness retains the existing workstation denial',async()=>{
 for(const host of ['bank.avispay.online','public-bank.invalid']){
  const response=await fixture.request('/healthz',{headers:{...navigation,host}});
  assert.equal(response.status,200);assert.match(response.headers['content-type'],/^application\/json/);
  assert.deepEqual(JSON.parse(response.body),{status:'ok',release:'staff-access-fixture'});
 }
 jsonDenied(await fixture.request('/readyz',{headers:navigation}));
 const ready=await fixture.request('/readyz',{headers:{...navigation,host:'public-bank.invalid'}});
 assert.equal(ready.status,200);assert.deepEqual(JSON.parse(ready.body),{status:'ready',release:'staff-access-fixture'});
});

test('other hosts keep the original interface and ignore a forwarded staff hostname',async()=>{
 for(const host of ['public-bank.invalid','avispay.online','bank.avispay.online.invalid','bank.avispay.online:8443']){
  const response=await fixture.request('/',{headers:{...navigation,host,'x-forwarded-host':'bank.avispay.online'}});
  assert.equal(response.status,200);assert.match(response.headers['content-type'],/^text\/html/);
  assert.ok(!response.body.includes(message));
  assert.match(response.headers['content-security-policy'],/style-src 'self'/);
 }
 jsonDenied(await fixture.request('/api/session',{headers:{...navigation,host:'public-bank.invalid'}}),'UNAUTHORIZED',401);
});

test('a valid certificate still requires workstation approval before the banking document is served',async t=>{
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls.push({url:String(url),body:JSON.parse(options.body)});
  return {ok:true,json:async()=>({approved:false})};
 });
 const response=await fixture.request('/',{headers:{...navigation,'x-forwarded-client-cert':certificateHeader}});
 assert.equal(response.status,403);assert.ok(response.body.includes(message));
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://avis.land/bank/workstation-channel/admit');
 assert.match(calls[0].body.fp,/^[a-f0-9]{64}$/);assert.equal(fixture.authentications.length,0);
});

test('an approved workstation retains the original document, session requirement and phone approval step',async t=>{
 const actions=[];
 t.mock.method(globalThis,'fetch',async(url)=>{
  const action=new URL(url).pathname.split('/').at(-1);actions.push(action);
  if(action==='admit')return {ok:true,json:async()=>({approved:true})};
  assert.equal(action,'start');
  return {ok:true,json:async()=>({id:'i'.repeat(43),poll:'p'.repeat(43),qr:'data:image/png;base64,dGVzdA==',expiresAt:'2030-01-01T00:00:00Z'})};
 });
 const headers={...navigation,'x-forwarded-client-cert':certificateHeader};
 const document=await fixture.request('/',{headers});
 assert.equal(document.status,200);assert.ok(!document.body.includes(message));
 assert.match(document.headers['content-security-policy'],/style-src 'self'/);
 jsonDenied(await fixture.request('/api/session',{headers}),'UNAUTHORIZED',401);
 jsonDenied(await fixture.request('/api/login/mobile',{method:'POST',headers:{...headers,origin:'https://bank.avispay.online','content-type':'application/json'},body:'{}'}));
 const login=await fixture.request('/api/login',{method:'POST',headers:{...headers,origin:'https://bank.avispay.online','content-type':'application/json'},body:JSON.stringify({username:'isolated-operator',password:'isolated-password'})});
 assert.equal(login.status,202);assert.match(login.headers['content-type'],/^application\/json/);
 assert.equal(JSON.parse(login.body).qr,'data:image/png;base64,dGVzdA==');
 assert.ok(login.headers['set-cookie'].every(value=>value.startsWith('__Host-avis_staff_scan=')));
 assert.deepEqual(actions,['admit','admit','admit','admit','start']);
});
