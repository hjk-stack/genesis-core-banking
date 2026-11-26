import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';

let server,browser,base;
const id='a0000000-0000-4000-8000-000000000001';
const completedId='a0000000-0000-4000-8000-000000000002';
// A small valid PDF fixture exercises the browser's native PDF viewer and download bytes.
function proofPdf(){
 const stream='BT /F1 18 Tf 48 780 Td (IP payment proof fixture) Tj ET\n';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'endstream'];
 let pdf='%PDF-1.4\n',offsets=[0];
 for(const [i,object]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+object+'\nendobj\n';}
 const xref=Buffer.byteLength(pdf);pdf+='xref\n0 '+offsets.length+'\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
 return Buffer.from(pdf+'trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n');
}
const pdf=proofPdf();
const fixtureScript=()=>{
 const row={requestId:id,checkoutReference:'CHECKOUT-001',title:'Payment fixture',senderBankName:'Sender bank',senderIp:'192.0.2.1',authorizedPerson:'Authorised sender',
 senderAccount:'SENDER-IBAN-001',senderAccountName:'Sender fixture',amount:'200.00',currency:'EUR',source:'industrial',status:'REQUESTED',
 requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()};
 const completed={...row,requestId:completedId,checkoutReference:'CHECKOUT-002',status:'ACTIVE',receivingAccountId:'common',nostroCashAccountId:'nostro',
 processing:{bankName:'Receiving bank',bankServerSentAmount:'200.00',amountCleared:'200.00',nostroIban:'NOSTRO-IBAN',
 receivingAbiqIban:'ABIQ-COMMON',beneficiaryName:'Fixture beneficiary',beneficiaryAccount:'BENEFICIARY-IBAN',
 franchiseAllocatedPercent:'10.00',operationCompleted:true,manualReport100Digits:'0123456789'.repeat(10),transactionReference:'PAYMENT-002',
 proof:{available:true,fileName:'handler-original.pdf',sizeBytes:pdf.length,sha256:'fixture'}}};
 return [
 "import {checkoutIpRegister,checkoutIpAdminControls,createCheckoutIpAdminControls,bindCheckoutIp,checkoutIpHandlerUrl,createCheckoutIpProof,replaceCheckoutIpRegister,expireCheckoutIpControls} from '/checkout-ip.mjs';",
 'let rows='+JSON.stringify([row,completed])+';',
 "const accounts=[{account_id:'common',owner_type:'COMMON_POOL',currency_code:'EUR',abiq_iban:'ABIQ-COMMON'}];",
 "const nostros=[{cash_account_id:'nostro',currency_code:'EUR',is_active:true,institution_name:'Nostro bank',iban_or_account_no:'NOSTRO-IBAN',intermediaries:[]}];",
 'const viewer=createCheckoutIpProof();',
 "window.fixtureActivations=[];const admin=createCheckoutIpAdminControls();",
 "function bind(){bindCheckoutIp({root:document,requests:rows,nostros,activate:async input=>{window.fixtureActivations.push(input);rows=rows.map(row=>row.requestId===input.requestId?{...row,status:input.active?'ACTIVE':'CLOSED',receivingAccountId:input.receivingAccountId}:row);return {};},",
 "onChange:()=>{replaceCheckoutIpRegister(document.querySelector('[data-checkout-ip-register]'),rows,accounts,nostros);bind();},",
 "openHandler:record=>window.open(checkoutIpHandlerUrl(record),'_blank','noopener,noreferrer'),openProof:record=>viewer.open(record)});}",
 "document.querySelector('#mount').innerHTML=checkoutIpAdminControls()+checkoutIpRegister(rows,accounts,nostros);admin.bind(document);bind();",
 "window.fixtureExpireRequests=()=>{const deadline=Math.max(...rows.filter(row=>row.status==='REQUESTED').map(row=>Date.parse(row.expiresAt)));Date.now=()=>deadline;expireCheckoutIpControls(document,deadline);};"
 ].join('\n');
};
async function assertIpSlider(control,state){
 const travel={CLOSED:0,REQUESTED:36,ACTIVE:72}[state];
 const deadline=Date.now()+2000;let geometry;
 // A managed tab can background its parent and pause that page's animation
 // frames. Sample synchronously and enforce the deadline from the Node runner.
 do{
  let timeout;
  try{
   geometry=await Promise.race([
    control.evaluate(button=>{
     const knob=button.querySelector(':scope > .pos-liquid-knob'),track=button.getBoundingClientRect(),cap=knob.getBoundingClientRect();
     return {width:track.width,height:track.height,knobWidth:cap.width,knobHeight:cap.height,centre:cap.x+cap.width/2-track.x,
      translation:new DOMMatrixReadOnly(getComputedStyle(knob).transform).m41,animation:getComputedStyle(button).animationName,
      knobAnimation:getComputedStyle(knob).animationName,knobCount:button.querySelectorAll(':scope > .pos-liquid-knob').length,
      text:button.textContent,gradient:getComputedStyle(knob).backgroundImage,trackGradient:getComputedStyle(button,'::before').backgroundImage,trackInset:parseFloat(getComputedStyle(button,'::before').left)};
    }),
    new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('IP slider geometry sampling exceeded 2000ms for '+state)),Math.max(1,deadline-Date.now()));})
   ]);
  }finally{clearTimeout(timeout);}
  if(Math.abs(geometry.centre-(36+travel))<=.1)break;
  const remaining=deadline-Date.now();if(remaining<=0)break;
  await new Promise(resolve=>setTimeout(resolve,Math.min(25,remaining)));
 }while(Date.now()<deadline);
 for(const [field,expected] of Object.entries({width:144,height:60,knobWidth:60,knobHeight:48}))assert.ok(Math.abs(geometry[field]-expected)<.01,field+' remains '+expected+'px within browser sub-pixel precision');
 assert.ok(Math.abs(geometry.centre-(36+travel))<.2,'knob centre is '+(36+travel)+'px for '+state);
 assert.ok(Math.abs(geometry.translation-travel)<.2,'knob physically travels '+travel+'px for '+state);
 assert.equal(geometry.knobCount,1);assert.equal(geometry.text,'');assert.equal(geometry.animation,'none');assert.equal(geometry.knobAnimation,'none');
 assert.match(geometry.gradient,/gradient/);assert.match(geometry.gradient,{CLOSED:/255, 72, 105/,REQUESTED:/85, 186, 255/,ACTIVE:/113, 243, 190/}[state]);
 assert.equal(geometry.trackInset,6);for(const colour of [/237, 0, 40/,/21, 95, 238/,/3, 207, 20/])assert.match(geometry.trackGradient,colour);
}
async function captureIpSlider(page,control,state){
 const box=await control.boundingBox();await page.screenshot({path:'test-results/checkout-ip-slider-'+state.toLowerCase()+'-1440.png',clip:{x:box.x-14,y:box.y-14,width:box.width+28,height:box.height+28}});
}
// Match the standalone website's managementWindowClient contract. The fixture
// has no banking operations; Chromium still performs the real native tab close.
function managementWindowClient(trustedOrigin){
 if(!trustedOrigin||window.top!==window||window.opener!==null||typeof MessagePort!=='function')return;
 let token;
 try{
  const url=new URL(window.location.href),fragment=new URLSearchParams(url.hash.slice(1));
  const state=window.history.state,path=url.pathname+url.search,fromFragment=fragment.has('managementToken');
  const retained=state&&typeof state==='object'&&!Array.isArray(state)?state.avisIpManagement:null;
  token=fromFragment?fragment.get('managementToken'):(retained?.origin===trustedOrigin&&retained.path===path?retained.token:null);
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(token||'')||(fromFragment&&fragment.getAll('managementToken').length!==1))return;
  // Retain the launch capability only in this history entry so reloads can
  // establish a fresh channel. Preserve opaque application state verbatim.
  if(fromFragment&&(state===null||(typeof state==='object'&&!Array.isArray(state)))){
   fragment.delete('managementToken');url.hash=fragment.toString();
   window.history.replaceState({...state,avisIpManagement:{token,origin:trustedOrigin,path}},'',path+url.hash);
  }
 }catch{return}
 let channel=null;
 function receive(event){
  if(channel||event.origin!==trustedOrigin||event.data?.type!=='avis-ip-management-init'||event.data.token!==token||event.ports?.length!==1||!(event.ports[0] instanceof MessagePort))return;
  // A fragment capability binds this launch to the configured core origin.
  // Accept only a top-level source, then retain its port rather than its window.
  try{if(!event.source||event.source===window||event.source.top!==event.source)return}catch{return}
  channel=event.ports[0];
  window.removeEventListener('message',receive);
  channel.onmessage=({data})=>{
   if(data?.type==='avis-ip-management-close'&&data.token===token)window.close();
  };
  channel.start();
  channel.postMessage({type:'avis-ip-management-ready',token});
 }
 window.addEventListener('message',receive);
 window.addEventListener('pagehide',()=>{
  window.removeEventListener('message',receive);
  if(channel){
   try{channel.postMessage({type:'avis-ip-management-disconnect',token})}catch{}
   channel.onmessage=null;channel.close();channel=null;
  }
 });
 window.addEventListener('pageshow',()=>{if(!channel)window.addEventListener('message',receive)});
}
const managementFixture=()=>'<!doctype html><title>Management fixture</title><h1>IP-IP management</h1><script>('+managementWindowClient.toString()+')('+JSON.stringify(base)+');</script>';
async function closeManagedTab(tab,page,action,consoleMessages,{visibleControl=true}={}){
 const before=await tab.evaluate(()=>({historyLength:history.length,openerRemoved:window.opener===null,hasLaunchToken:new URLSearchParams(location.hash.slice(1)).has('managementToken')}));
 try{
  await Promise.all([tab.waitForEvent('close',{timeout:5000}),action()]);
  if(visibleControl)await page.waitForFunction(()=>document.querySelector('[data-ip-admin-receiver]')?.dataset.state==='CLOSED',{},{timeout:2000});
 }catch(reason){
  const parent=await page.evaluate(()=>{const button=document.querySelector('[data-ip-admin-receiver]');return {state:button?.dataset.state,busy:button?.getAttribute('aria-busy'),error:document.querySelector('[data-ip-admin-receiver-error]')?.textContent};});
  throw new Error('Managed tab close failed: '+JSON.stringify({before,parent,consoleMessages}),{cause:reason});
 }
}
before(async()=>{
 const appHtml=await readFile(new URL('../index.html',import.meta.url),'utf8');
 server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://fixture.invalid').pathname;
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'");
  if(path==='/admin'){res.setHeader('content-type','text/html');return res.end(appHtml);}
  if(path==='/api/session'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({admin:true,canSwitchWorkspace:false,username:'Fixture operator',csrf:'fixture-csrf'}));}
  if(path==='/api/logout'||path.startsWith('/api/views/')){res.setHeader('content-type','application/json');return res.end(JSON.stringify(path==='/api/logout'?{}:{rows:[]}));}
  if(req.url==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/fixture.css"><div id="mount" class="fixture"></div><script type="module" src="/fixture.mjs"></script>');}
  if(req.url==='/fixture.css'){res.setHeader('content-type','text/css');return res.end('.fixture{margin:12px;min-width:0}.fixture>.panel{max-width:100%}');}
  if(req.url==='/fixture.mjs'){res.setHeader('content-type','text/javascript');return res.end(fixtureScript());}
  if(req.url==='/api/checkout-ip/'+completedId+'/proof.pdf'){res.setHeader('content-type','application/pdf');res.setHeader('cache-control','no-store');return res.end(pdf);}
  if(/^\/[a-z][a-z0-9-]*\.(mjs|css)$/.test(path)){
   try{res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');return res.end(await readFile(new URL('../public'+path,import.meta.url)));}catch{res.writeHead(404);return res.end();}
  }
  res.writeHead(404);res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 // Full Chromium's headless mode includes the native PDF viewer; the shell does not.
 browser=await chromium.launch({channel:'chromium',executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

for(const width of [390,820,1440])test('IP register controls and proof popup stay usable at '+width+'px',async()=>{
 const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto(base);await page.locator('[data-checkout-ip="'+id+'"]').waitFor();
  assert.equal(await page.locator('thead th').count(),12);assert.equal(await page.locator('[data-checkout-ip="'+id+'"] td').count(),12);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await assertIpSlider(page.locator('[data-checkout-ip="'+id+'"] [data-ip-toggle]'),'REQUESTED');await assertIpSlider(page.locator('[data-checkout-ip="'+completedId+'"] [data-ip-toggle]'),'ACTIVE');
  assert.equal(await page.locator('.pos-activation-label,[data-ip-admin-access-state],[data-ip-admin-receiver-state]').count(),0);
  await page.screenshot({path:'test-results/checkout-ip-slider-'+width+'.png',fullPage:false});
  const wrap=page.locator('.table-wrap');await wrap.evaluate(el=>el.scrollLeft=el.scrollWidth);
  const toggle=page.locator('[data-checkout-ip="'+id+'"] [data-ip-toggle]'),bounds=await toggle.boundingBox();
  assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width,'Liquid Glass switch remains visible after scrolling details');
  await page.locator('[data-checkout-ip="'+completedId+'"] [data-ip-proof]').click();
  const popup=page.getByRole('dialog',{name:'Proof of Payment'});await popup.waitFor({state:'visible'});
  const box=await popup.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=1001);
  await page.locator('[data-ip-download]').waitFor({state:'visible'});
  assert.equal(await popup.locator('iframe').getAttribute('title'),'Original proof of payment PDF');
  assert.match(await popup.locator('iframe').getAttribute('src'),/^blob:/);
  await page.locator('[data-ip-print]:enabled').waitFor({timeout:15000});
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('[data-ip-download]').click()]);
  assert.equal(download.suggestedFilename(),'handler-original.pdf');assert.deepEqual(await readFile(await download.path()),pdf);
  // Exercise native print dispatch without opening an operating-system print dialog in CI.
  await popup.locator('iframe').evaluate(frame=>{frame.contentWindow.print=()=>{frame.dataset.printInvoked='true';};});
  await page.locator('[data-ip-print]').click();assert.equal(await popup.locator('iframe').getAttribute('data-print-invoked'),'true');
  await page.screenshot({path:new URL('../test-results/checkout-ip-proof-'+width+'.png',import.meta.url).pathname});
  await page.getByRole('button',{name:'Close proof of payment'}).click();assert.equal(await page.locator('dialog').count(),0);
  assert.equal(await page.locator('[data-checkout-ip="'+completedId+'"] [data-ip-proof]').evaluate(el=>el===document.activeElement),true);
  assert.deepEqual(errors,[]);
 }finally{await page.close();}
});

test('IP handler opens an ordinary tab and activation remains an explicit routed action',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 try{
  await page.route('https://avis.land/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Handler fixture</title><h1>IP-to-IP handler</h1>'}));
  await page.goto(base);const row=page.locator('[data-checkout-ip="'+id+'"]');await row.waitFor();
  const access=row.locator('[data-ip-toggle]');assert.equal(await page.locator('[data-ip-admin-request],[data-ip-admin-access]').count(),0);


  await assertIpSlider(access,'REQUESTED');await captureIpSlider(page,access,'REQUESTED');await access.focus();await page.keyboard.press('Enter');assert.equal(await row.locator('[data-ip-toggle]').getAttribute('data-state'),'REQUESTED');assert.equal(await row.locator('[data-ip-account]').evaluate(el=>el===document.activeElement),true);
  assert.deepEqual(await page.evaluate(()=>window.fixtureActivations),[]);
  await row.locator('[data-ip-account]').selectOption('common');await access.focus();await page.keyboard.press('Space');
  await page.locator('[data-checkout-ip="'+id+'"] [data-ip-toggle][data-state="ACTIVE"]').waitFor();
  assert.equal(await access.getAttribute('data-state'),'ACTIVE');assert.equal((await page.evaluate(()=>window.fixtureActivations)).length,1);
  await assertIpSlider(access,'ACTIVE');await captureIpSlider(page,access,'ACTIVE');await assertIpSlider(row.locator('[data-ip-toggle]'),'ACTIVE');
  const [tab]=await Promise.all([page.context().waitForEvent('page'),page.locator('[data-checkout-ip="'+id+'"] [data-ip-handler]').click()]);
  await tab.waitForLoadState();assert.equal(new URL(tab.url()).searchParams.get('checkoutRequest'),id);
  assert.equal(await page.locator('iframe').count(),0);await tab.close();await access.focus();await page.keyboard.press('Enter');
  await page.locator('[data-checkout-ip="'+id+'"] [data-ip-toggle][data-state="CLOSED"]').waitFor();await assertIpSlider(access,'CLOSED');await assertIpSlider(row.locator('[data-ip-toggle]'),'CLOSED');
  assert.deepEqual((await page.evaluate(()=>window.fixtureActivations)).map(action=>({requestId:action.requestId,active:action.active})),[{requestId:id,active:true},{requestId:id,active:false}]);
 }finally{await page.close();}
});

test('expired IP requests stay closed until the operator manually retries the same row',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto(base);const row=page.locator('[data-checkout-ip="'+id+'"]');const access=row.locator('[data-ip-toggle]');await row.waitFor();
  await row.locator('[data-ip-account]').selectOption('common');await assertIpSlider(access,'REQUESTED');
  await page.evaluate(()=>window.fixtureExpireRequests());await assertIpSlider(access,'CLOSED');await assertIpSlider(row.locator('[data-ip-toggle]'),'CLOSED');
  assert.equal(await access.getAttribute('aria-description'),'Closed');assert.equal(await access.getAttribute('aria-disabled'),null);
  await access.focus();await page.keyboard.press('Enter');
  assert.equal((await page.evaluate(()=>window.fixtureActivations))[0].requestId,id);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});

for(const [width,mode] of [[390,'empty'],[820,'empty'],[1440,'empty'],[820,'stalled'],[1440,'failed']])test('actual Payments app exposes independent switches with '+mode+' requests at '+width+'px',async()=>{
 const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[],held=[],writes=[],consoleMessages=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST')writes.push(request.url());});
 const captureConsole=(tab,label)=>tab.on('console',message=>{if(['warning','error'].includes(message.type()))consoleMessages.push(label+': '+message.text());});
 captureConsole(page,'parent');context.on('page',tab=>captureConsole(tab,'child'));
 await context.route('https://avis.land/**',route=>route.fulfill({contentType:'text/html',body:managementFixture()}));
 if(mode==='stalled')await page.route('**/api/views/checkoutip',route=>new Promise(resolve=>held.push({route,resolve})));
 if(mode==='failed')await page.route('**/api/views/checkoutip',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Could not read checkout requests.'})}));
 try{
  await page.goto(base+'/admin#payments');const controls=page.locator('[data-ip-admin-controls]'),management=controls.locator('[data-ip-admin-receiver]');await controls.waitFor();
  if(mode==='empty')await page.locator('[data-checkout-ip-register]').waitFor();
  if(mode==='stalled')await page.waitForFunction(()=>document.querySelector('#panels')?.getAttribute('aria-busy')==='true');
  if(mode==='failed')await page.locator('#panels .panel-error').waitFor();
  assert.equal(await controls.locator('[role=switch]').count(),1);assert.equal(await page.locator('[data-checkout-ip]').count(),0);assert.equal(await management.getAttribute('data-state'),'CLOSED');assert.equal(await management.isEnabled(),true);
  assert.equal(await controls.evaluate(el=>!!el.closest('.table-wrap')),false);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  for(const control of [management]){const box=await control.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1,'administrator control stays inside viewport');}
  await assertIpSlider(management,'CLOSED');assert.equal(await controls.locator('.pos-activation-label').count(),0);
  await page.screenshot({path:'test-results/checkout-ip-admin-'+mode+'-'+width+'.png',fullPage:false});
  const [tab]=await Promise.all([context.waitForEvent('page'),management.click()]);await tab.waitForURL('https://avis.land/admin/bank/quantum/direct-transfer/entry');
  assert.equal(await tab.evaluate(()=>window.opener===null),true);assert.equal(await management.getAttribute('data-state'),'ACTIVE');await assertIpSlider(management,'ACTIVE');assert.deepEqual(writes,[]);
  await page.screenshot({path:'test-results/checkout-ip-admin-'+mode+'-management-'+width+'.png',fullPage:false});
  if(width===1440&&mode==='empty'){
   await tab.reload();await tab.waitForURL('https://avis.land/admin/bank/quantum/direct-transfer/entry');
   assert.equal(await tab.evaluate(()=>window.opener===null),true);assert.equal(await management.getAttribute('data-state'),'ACTIVE');
  }
  await closeManagedTab(tab,page,()=>management.click(),consoleMessages);assert.equal(await management.getAttribute('data-state'),'CLOSED');
  const [manual]=await Promise.all([context.waitForEvent('page'),management.click()]);await manual.waitForURL('https://avis.land/admin/bank/quantum/direct-transfer/entry');await manual.close();
  await page.waitForFunction(()=>document.querySelector('[data-ip-admin-receiver]')?.dataset.state==='CLOSED');
  const [logoutTab]=await Promise.all([context.waitForEvent('page'),management.click()]);await logoutTab.waitForURL('https://avis.land/admin/bank/quantum/direct-transfer/entry');
  await closeManagedTab(logoutTab,page,()=>page.locator('#signout').click(),consoleMessages,{visibleControl:false});await page.locator('#signin').waitFor({state:'visible'});assert.deepEqual(errors,[]);
 }finally{for(const item of held){await item.route.fulfill({contentType:'application/json',body:'{"rows":[]}'}).catch(()=>{});item.resolve();}await context.close();}
});

test('a handler authentication response keeps the actual tab open and scopes a failed close to its switch',async()=>{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 await context.route('https://avis.land/**',route=>route.fulfill({status:401,contentType:'application/json',body:'{"message":"Sign in"}'}));
 try{
  await page.goto(base+'/admin#payments');const management=page.locator('[data-ip-admin-receiver]');await management.waitFor();
  const [tab]=await Promise.all([context.waitForEvent('page'),management.click()]);await tab.waitForURL(url=>url.origin==='https://avis.land'&&url.pathname==='/admin/bank/quantum/direct-transfer/entry');await tab.waitForLoadState();
  assert.equal(await tab.evaluate(()=>window.opener===null),true);await management.click();
  assert.equal(await management.getAttribute('data-state'),'ACTIVE');assert.equal(await management.getAttribute('aria-busy'),'true');
  await page.waitForFunction(()=>document.querySelector('[data-ip-admin-receiver]')?.getAttribute('aria-busy')==='false',{},{timeout:6500});
  assert.equal(tab.isClosed(),false);assert.equal(await management.getAttribute('data-state'),'ACTIVE');assert.match(await page.locator('[data-ip-admin-receiver-error]').textContent(),/Could not close/);
  await tab.close();await page.waitForFunction(()=>document.querySelector('[data-ip-admin-receiver]')?.dataset.state==='CLOSED');assert.equal(await page.locator('[data-ip-admin-receiver-error]').textContent(),'');
 }finally{await context.close();}
});
