import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {startStaffAccessFixture} from '../test/helpers/staff-access-fixture.mjs';

let fixture,browser;
before(async()=>{
 fixture=await startStaffAccessFixture();
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 await mkdir('test-results',{recursive:true});
});
after(async()=>{await browser?.close();await fixture?.close();});

const signIn='<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AVIS sign-in</title><body><main><h1>AVIS identity sign-in</h1></main></body></html>';
const external='https://avis.land/bank/workstations/connect?state='+('S'.repeat(43))+'&code_challenge='+('C'.repeat(43))+'&code_challenge_method=S256';

for(const viewport of [{width:320,height:640},{width:390,height:844},{width:1440,height:900}])
test(`private bank homepage reaches the secure AVIS sign-in handoff at ${viewport.width}px`,async()=>{
 const page=await browser.newPage({viewport});
 const requests=[],policyErrors=[];
 try{
  page.on('console',event=>{if(/Content Security Policy|Refused to/i.test(event.text()))policyErrors.push(event.text());});
  page.on('pageerror',error=>policyErrors.push(error.message));
  // The actual bank homepage's HTTP 303 is exercised against the production
  // request handler. The subsequent authenticated portal is static local HTML
  // so Chromium tests do not depend on external accounts or send credentials.
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   requests.push(url.href);
   if(url.origin==='https://avis.land'){
    if(url.pathname==='/bank/workstations/client.js'){
     // The actual AVIS sign-in document loads this same-origin client script.
     // Replace it in CI so the browser remains entirely network-isolated.
     await route.fulfill({status:200,contentType:'application/javascript',body:'/* bank sign-in is exercised separately */'});
     return;
    }
    assert.equal(url.pathname,'/bank/workstations/connect');
    assert.match(url.searchParams.get('state')||'',/^[A-Za-z0-9_-]{43}$/);
    assert.match(url.searchParams.get('code_challenge')||'',/^[A-Za-z0-9_-]{43}$/);
    assert.equal(url.searchParams.get('code_challenge_method'),'S256');
    await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:signIn});
    return;
   }
   assert.equal(url.origin,'https://bank.avispay.online');
   if(url.pathname==='/access/start'){
    // The full signed bootstrap including database state is covered by the
    // workstation-admission contract tests; model its external transition here.
    await route.fulfill({status:303,headers:{location:external,'cache-control':'private, no-store'},body:''});
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
  const result=await page.goto('https://bank.avispay.online/',{waitUntil:'domcontentloaded',timeout:15000});
  assert.equal(result.status(),200);
  assert.equal(new URL(page.url()).origin,'https://avis.land');
  assert.equal(new URL(page.url()).pathname,'/bank/workstations/connect',
   'the browser must arrive at the signed AVIS account handoff, not a local device-approval page');
  assert.equal(await page.locator('body').count(),1,
   'the redirected AVIS account handoff renders a document');
  assert.equal(requests.filter(url=>new URL(url).pathname==='/').length,1);
  assert.ok(requests.some(url=>new URL(url).pathname==='/access/start'));
  assert.ok(requests.some(url=>new URL(url).origin==='https://avis.land'));
  assert.equal(await page.getByText('You are not authorized to access this platform.').count(),0);
  assert.deepEqual(policyErrors,[]);
  await page.screenshot({path:`test-results/bank-access-${viewport.width}.png`,fullPage:true});
 }finally{await page.close();}
});
