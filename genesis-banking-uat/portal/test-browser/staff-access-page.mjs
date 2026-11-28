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

for(const viewport of [{width:320,height:640},{width:390,height:844},{width:1440,height:900}])
test(`private bank homepage starts secure sign-in at ${viewport.width}px`,async()=>{
 const page=await browser.newPage({viewport});
 const requests=[],policyErrors=[];
 try{
  page.on('console',event=>{if(/Content Security Policy|Refused to/i.test(event.text()))policyErrors.push(event.text());});
  page.on('pageerror',error=>policyErrors.push(error.message));
  // Browser navigations go through the real bank application. The AVIS-facing
  // bootstrap is represented here by a static page, avoiding real credentials
  // and external requests during this browser routing regression.
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   requests.push(url.href);
   assert.equal(url.origin,'https://bank.avispay.online');
   if(url.pathname==='/access/start'){
    await route.fulfill({status:200,contentType:'text/html; charset=utf-8',
     body:'<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AVIS sign-in</title><body><main><h1>AVIS identity sign-in</h1></main></body></html>'});
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
  assert.equal(await page.getByText('You are not authorized to access this platform.').count(),0);
  assert.deepEqual(policyErrors,[]);
  await page.screenshot({path:`test-results/bank-access-${viewport.width}.png`,fullPage:true});
 }finally{await page.close();}
});
