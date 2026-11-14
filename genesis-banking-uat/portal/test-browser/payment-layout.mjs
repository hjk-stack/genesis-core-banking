import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

let server,browser,base;
before(async()=>{
 server=http.createServer(async(req,res)=>{
  if(req.url==='/'){
   res.setHeader('content-type','text/html');
   return res.end(`<link rel="stylesheet" href="/styles.css"><button id="open">New payment</button><script type="module">
    import {createPaymentWizard} from '/payment-wizard.mjs';
    const address={street:'1 Test Road',city:'London',postalCode:'SW1A',country:'GB'};
    const fixture={customers:[{user_id:'2',full_name:'Receiver fixture'}],cryptoholdings:[{account_id:'crypto-fixture',user_id:'1',currency_code:'ETH',network:'ETHEREUM',available_balance:'2'}]};
    const wizard=createPaymentWizard({accounts:()=>[{user_id:'1',abiq_iban:'TN89AVIP000978000011000101',currency_code:'EUR',full_name:'Layout fixture',available_balance:'1000'}],data:v=>fixture[v]||[],notice:()=>{},refresh:async()=>{},
     api:async(path,body)=>path==='payments/check-receiver'?{account:'TN62AVIP000978000011000102',bic:'AVIPTN64XXX',receiverName:'Receiver fixture',address,addressSource:'REGISTERED',receiverBridgeId:'fixture'}:{id:'fixture',mode:'INTERNAL',format:'ISO20022',message:'Layout fixture only',instruction:body}});
    document.querySelector('#open').onclick=()=>wizard.open();
   </script>`);
  }
  if(!['/styles.css','/payment-wizard.mjs','/card-message.mjs'].includes(req.url)){res.writeHead(404);return res.end();}
  res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');
  res.end(await readFile(new URL('../public'+req.url,import.meta.url)));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch();
});
for(const method of ['CRYPTO','CARD','CODED_CARD'])test(`${method} destination and receiver fields stay visible on mobile`,async()=>{
 const page=await browser.newPage({viewport:{width:390,height:1000}});
 try{
  await page.goto(base);await page.locator('#open').click();await page.getByLabel('Sender account',{exact:true}).selectOption({index:1});await page.getByLabel('Transfer by',{exact:true}).selectOption(method);
  if(method==='CRYPTO')await page.getByLabel('Crypto holding',{exact:true}).selectOption('crypto-fixture');
  await page.getByLabel('Amount',{exact:true}).fill('1');await page.getByRole('button',{name:'Next',exact:true}).click();
  if(method==='CRYPTO')await page.getByLabel('Receiving user',{exact:true}).selectOption('2');else await page.getByLabel('Load into',{exact:true}).selectOption('NEW');
  await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByLabel('Name',{exact:true}).waitFor({state:'visible'});
  assert.equal(await page.getByLabel('Street and building',{exact:true}).isVisible(),false);assert.equal(await page.getByLabel('Receiver IBAN or account number',{exact:true}).isVisible(),false);
  await page.locator('.payment-slide[aria-hidden=false]').evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));const bounds=await page.getByLabel('Name',{exact:true}).boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=390);
  await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByLabel('Reference',{exact:true}).fill('Multi-method layout');await page.getByRole('button',{name:'OK · Build message',exact:true}).click();
  await page.getByRole('heading',{name:'Please check your transfer'}).waitFor({state:'visible'});
 }finally{await page.close();}
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
for(const width of [390,1440])test(`all five payment steps remain inside the popup at ${width}px`,async()=>{
 const page=await browser.newPage({viewport:{width,height:1000}});
 try{
  page.on('pageerror',e=>console.error(e.message));await page.goto(base);await page.locator('#open').click();assert.equal(await page.locator('dialog').isVisible(),true);
  const visible=async name=>{
   const input=page.getByLabel(name,{exact:true});await input.waitFor({state:'visible'});
   // Let the entry animation finish, then check actual browser clipping, not DOM presence.
   await page.locator('.payment-slide[aria-hidden=false]').evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
   const bounds=await input.boundingBox(),viewport=await page.locator('.payment-viewport').boundingBox();
   assert(bounds&&viewport);assert(bounds.x>=viewport.x-1&&bounds.x+bounds.width<=viewport.x+viewport.width+1,`${name} is clipped horizontally`);
   assert.equal(await page.locator('.payment-viewport').evaluate(el=>el.scrollLeft),0);
  };
  await visible('Sender account');await page.getByLabel('Sender account',{exact:true}).selectOption({index:1});await page.getByLabel('Amount',{exact:true}).fill('1');
  await page.getByRole('button',{name:'Next',exact:true}).click();await visible('Receiver IBAN or account number');
  await page.getByLabel('Receiver IBAN or account number',{exact:true}).fill('000011000102');await page.getByRole('button',{name:'Next',exact:true}).click();await visible('Name');
  await page.getByRole('button',{name:'Back',exact:true}).click();await visible('Receiver IBAN or account number');
  await page.getByRole('button',{name:'Next',exact:true}).click();await visible('Name');
  await page.getByRole('button',{name:'Next',exact:true}).click();await visible('Reference');await page.getByLabel('Reference',{exact:true}).fill('Layout check');
  await page.getByRole('button',{name:'OK · Build message',exact:true}).click();
  await page.getByRole('heading',{name:'Please check your transfer'}).waitFor({state:'visible'});
  assert.equal(await page.getByRole('button',{name:'Transfer',exact:true}).isVisible(),true);
  // This regression never executes a transfer, even in the isolated fixture.
 }finally{await page.close();}
});
