import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';

// Requested by the bank owner: "That must be a further SWITCH to be opened in the payments in sovereign admin", the
// FinTerminal ISO 20022 in its own window, "Dark blue and orange is OK".
let server,browser,base;
before(async()=>{
 const appHtml=await readFile(new URL('../index.html',import.meta.url),'utf8');
 server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://fixture.invalid').pathname;
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'");
  if(path==='/admin'){res.setHeader('content-type','text/html');return res.end(appHtml);}
  if(path==='/fin-terminal'){res.setHeader('content-type','text/html');return res.end(await readFile(new URL('../public/fin-terminal.html',import.meta.url)));}
  if(path==='/api/session'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({admin:true,canSwitchWorkspace:false,username:'Fixture operator',csrf:'fixture-csrf'}));}
  if(path==='/api/logout'||path.startsWith('/api/views/')){res.setHeader('content-type','application/json');return res.end(JSON.stringify(path==='/api/logout'?{}:{rows:[]}));}
  if(/^\/[a-z][a-z0-9-]*\.(mjs|css)$/.test(path)){
   try{res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');return res.end(await readFile(new URL('../public'+path,import.meta.url)));}catch{res.writeHead(404);return res.end();}
  }
  res.writeHead(404);res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve));});

for(const width of [390,1440])test('the Payments switch opens the FinTerminal in its own window, dark blue with orange, at '+width+'px',async()=>{
 const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));context.on('page',tab=>tab.on('pageerror',error=>errors.push(error.message)));
 try{
  await page.goto(base+'/admin#payments');
  const controls=page.locator('[data-fin-terminal-controls]'),button=controls.locator('[data-fin-terminal-switch]');await controls.waitFor();
  assert.equal(await page.locator('[data-ip-admin-controls] [role=switch]').count(),1);
  assert.equal(await button.getAttribute('data-state'),'CLOSED');
  const box=await button.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1,'switch inside the viewport');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways scrolling');
  await page.screenshot({path:'test-results/fin-terminal-switch-'+width+'.png'});
  // On: the terminal in a window of its own, signed in with the bank.
  const [terminal]=await Promise.all([context.waitForEvent('page'),button.click()]);
  await terminal.waitForURL(base+'/fin-terminal');await terminal.locator('[data-fin-terminal]').waitFor();
  assert.equal(await button.getAttribute('data-state'),'ACTIVE');assert.equal(await terminal.evaluate(()=>!!window.opener),true);
  const look=await terminal.evaluate(()=>{
   const body=getComputedStyle(document.body),chosen=getComputedStyle(document.querySelector('[role=tab][aria-selected=true]'));
   return {ground:body.backgroundColor,chosen:chosen.color,border:chosen.borderTopColor,screens:[...document.querySelectorAll('[role=tabpanel]')].map(screen=>screen.hidden),sideways:document.documentElement.scrollWidth>innerWidth};
  });
  assert.deepEqual(look,{ground:'rgb(10, 18, 32)',chosen:'rgb(245, 159, 11)',border:'rgb(245, 159, 11)',screens:[false,true],sideways:false});
  await terminal.screenshot({path:'test-results/fin-terminal-window-'+width+'.png'});
  await terminal.getByRole('tab',{name:'2 · Interbank Direct IP-to-IP Composer'}).click();
  assert.deepEqual(await terminal.evaluate(()=>[...document.querySelectorAll('[role=tabpanel]')].map(screen=>screen.hidden)),[true,false]);
  // Off: the window closes.
  await Promise.all([terminal.waitForEvent('close'),button.click()]);assert.equal(await button.getAttribute('data-state'),'CLOSED');
  // Closed with its own window button: the switch turns off.
  const [again]=await Promise.all([context.waitForEvent('page'),button.click()]);await again.waitForURL(base+'/fin-terminal');await again.close();
  await page.waitForFunction(()=>document.querySelector('[data-fin-terminal-switch]')?.dataset.state==='CLOSED');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
