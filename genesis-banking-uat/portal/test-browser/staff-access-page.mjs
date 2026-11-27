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

for(const viewport of [{width:320,height:640},{width:390,height:844},{width:1440,height:900}])test(`private bank access denial fills the viewport at ${viewport.width}px`,async()=>{
 const page=await browser.newPage({viewport});
 const requests=[],policyErrors=[];
 try {
  page.on('console',event=>{if(/Content Security Policy|Refused to/i.test(event.text()))policyErrors.push(event.text());});
  page.on('pageerror',error=>policyErrors.push(error.message));
  // Keep the actual staff origin and browser navigation headers, then forward
  // locally to the real server. Fulfil its unmodified status, body and CSP.
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());requests.push(url.href);
   assert.equal(url.origin,'https://bank.avispay.online','the denied page must not request external assets');
   const response=await fixture.request(url.pathname+url.search,{method:request.method(),headers:{...await request.allHeaders(),host:'bank.avispay.online'},body:request.postData()||undefined});
   const headers=Object.fromEntries(Object.entries(response.headers).filter(([name])=>!['connection','keep-alive','transfer-encoding','content-length'].includes(name)));
   await route.fulfill({status:response.status,headers,body:response.body});
  });
  const response=await page.goto('https://bank.avispay.online/');
  assert.equal(response.status(),403);assert.match(response.headers()['content-type'],/^text\/html/);
  const title=page.getByRole('heading',{level:1,name:'You are not authorized to access this platform.',exact:true});
  await title.waitFor({state:'visible'});
  const layout=await page.evaluate(()=>{
   const main=document.querySelector('main'),link=document.querySelector('.public-link');
   const bounds=main.getBoundingClientRect(),target=link.getBoundingClientRect();
   return {width:bounds.width,height:bounds.height,scrollWidth:document.documentElement.scrollWidth,
    background:getComputedStyle(document.documentElement).backgroundColor,linkHeight:target.height,
    embeddedAssets:document.querySelectorAll('script,img,iframe,link[rel="stylesheet"]').length};
  });
  assert.equal(layout.width,viewport.width);assert.ok(layout.height>=viewport.height);
  assert.ok(layout.scrollWidth<=viewport.width,'the full-screen message must not overflow horizontally');
  assert.equal(layout.background,'rgb(7, 22, 43)','the response CSP must allow the page stylesheet');
  assert.ok(layout.linkHeight>=44);assert.equal(layout.embeddedAssets,0);
  const link=page.getByRole('link',{name:'Go to AVIS.LAND',exact:true});
  assert.equal(await link.getAttribute('href'),'https://avis.land');
  assert.equal(await page.locator('input,form,dialog').count(),0);
  await page.keyboard.press('Tab');assert.equal(await link.evaluate(element=>element===document.activeElement),true);
  assert.deepEqual(policyErrors,[]);assert.ok(requests.length>=1);
  await page.screenshot({path:`test-results/bank-access-${viewport.width}.png`,fullPage:true});
 } finally {await page.close();}
});
