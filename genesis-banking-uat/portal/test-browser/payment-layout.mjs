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
    const wizard=createPaymentWizard({accounts:()=>[{abiq_iban:'TN89AVIP000978000011000101',currency_code:'EUR',full_name:'Layout fixture',available_balance:'1000'}],notice:()=>{},refresh:async()=>{},
     api:async(path,body)=>path==='payments/check-receiver'?{account:'TN62AVIP000978000011000102',bic:'AVIPTN64XXX',receiverName:'Receiver fixture',address,addressSource:'REGISTERED',receiverBridgeId:'fixture'}:{id:'fixture',mode:'INTERNAL',format:'ISO20022',message:'Layout fixture only',instruction:body}});
    document.querySelector('#open').onclick=()=>wizard.open();
   </script>`);
  }
  if(!['/styles.css','/payment-wizard.mjs'].includes(req.url)){res.writeHead(404);return res.end();}
  res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');
  res.end(await readFile(new URL('../public'+req.url,import.meta.url)));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch();
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
for(const width of [390,1440])test(`all five payment steps remain inside the popup at ${width}px`,async()=>{
 const page=await browser.newPage({viewport:{width,height:1000}});
 try{
  await page.goto(base);await page.locator('#open').click();
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
