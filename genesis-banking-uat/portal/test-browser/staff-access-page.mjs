import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startStaffAccessFixture} from '../test/helpers/staff-access-fixture.mjs';

// The AVIS-facing sign-in start, represented by a static page: no real credentials and no external request.
const SIGN_IN='<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AVIS sign-in</title><body><main><h1>AVIS identity sign-in</h1></main></body></html>';
// The browser never leaves this machine. Chromium follows the bank's redirect itself, past page.route (the first runs reached the
// live bank.avispay.online and timed out on its scripts): every connection goes through a proxy here, which hands bank.avispay.online
// to a local HTTPS stand-in serving the sign-in start and refuses anything else.
let fixture,browser,dir,signIn,proxy;
before(async()=>{
 fixture=await startStaffAccessFixture();
 dir=await mkdtemp(join(tmpdir(),'avis-bank-access-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=bank.avispay.online','-addext','subjectAltName=DNS:bank.avispay.online',
  '-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
 signIn=https.createServer({key:await readFile(join(dir,'key.pem')),cert:await readFile(join(dir,'cert.pem'))},(req,res)=>{
  if(req.method==='GET'&&req.url==='/access/start'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(SIGN_IN);}
  res.writeHead(404);res.end();
 });
 await new Promise(resolve=>signIn.listen(0,'127.0.0.1',resolve));
 proxy=http.createServer((_req,res)=>{res.writeHead(403);res.end();});
 proxy.on('connect',(req,socket)=>{
  if(req.url!=='bank.avispay.online:443')return socket.destroy();
  const upstream=net.connect(signIn.address().port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');upstream.pipe(socket);socket.pipe(upstream);});
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,proxy:{server:'http://127.0.0.1:'+proxy.address().port}});
 await mkdir('test-results',{recursive:true});
});
after(async()=>{
 await browser?.close();await fixture?.close();
 for(const server of [proxy,signIn])if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
 if(dir)await rm(dir,{recursive:true,force:true});
});

for(const viewport of [{width:320,height:640},{width:390,height:844},{width:1440,height:900}])
test(`private bank homepage starts secure sign-in at ${viewport.width}px`,async()=>{
 const page=await browser.newPage({viewport,ignoreHTTPSErrors:true});
 const requests=[],policyErrors=[];
 try{
  page.on('console',event=>{if(/Content Security Policy|Refused to/i.test(event.text()))policyErrors.push(event.text());});
  page.on('pageerror',error=>policyErrors.push(error.message));
  // Every request the page makes, the redirect's too.
  page.on('request',request=>requests.push(request.url()));
  // Browser navigations go through the real bank application.
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   assert.equal(url.origin,'https://bank.avispay.online');
   if(url.pathname==='/access/start'){
    await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:SIGN_IN});
    return;
   }
   const response=await fixture.request(url.pathname+url.search,{method:request.method(),
    headers:{...await request.allHeaders(),host:'bank.avispay.online'},body:request.postData()||undefined});
   if(url.pathname==='/'){
    assert.equal(response.status,303);
    assert.equal(response.headers.location,'/access/start');
    assert.equal(response.body,'');
   }
   const headers=Object.fromEntries(Object.entries(response.headers)
    .filter(([name])=>!['connection','keep-alive','transfer-encoding','content-length'].includes(name)));
   await route.fulfill({status:response.status,headers,body:response.body});
  });
  const result=await page.goto('https://bank.avispay.online/');
  assert.equal(result.status(),200);
  assert.equal(new URL(page.url()).pathname,'/access/start');
  assert.equal(await page.getByRole('heading',{name:'AVIS identity sign-in'}).isVisible(),true);
  assert.equal(requests.filter(url=>new URL(url).pathname==='/').length,1);
  assert.ok(requests.some(url=>new URL(url).pathname==='/access/start'));
  assert.ok(requests.every(url=>new URL(url).origin==='https://bank.avispay.online'),'nothing but the bank requested');
  assert.equal(await page.getByText('You are not authorized to access this platform.').count(),0);
  assert.deepEqual(policyErrors,[]);
  await page.screenshot({path:`test-results/bank-access-${viewport.width}.png`,fullPage:true});
 }finally{await page.close();}
});
