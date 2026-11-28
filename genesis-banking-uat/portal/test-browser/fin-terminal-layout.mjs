import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';

// Requested by the bank owner: "That must be a further SWITCH to be opened in the payments in sovereign admin", the
// FinTerminal ISO 20022 in its own window, "Dark blue and orange is OK".
// signedIn: the bank's own sign-in; required: its AVIS sign-in is missing, which the bank's gate sends to /access/start (gate).
let server,browser,base,signedIn=true,required=false,gate=true;
const session={admin:true,finTerminal:true,canSwitchWorkspace:false,username:'Fixture operator',csrf:'fixture-csrf'};
before(async()=>{
 const appHtml=await readFile(new URL('../index.html',import.meta.url),'utf8');
 server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://fixture.invalid').pathname;
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'");
  if(path==='/'&&required&&gate){res.writeHead(303,{location:'/access/start'});return res.end();}
  if(path==='/access/start'){res.setHeader('content-type','text/html');return res.end('<!doctype html><title>Sign in</title><p>AVIS sign-in</p>');}
  if(path==='/admin'||path==='/'){res.setHeader('content-type','text/html');return res.end(appHtml);}
  if(path==='/fin-terminal'){res.setHeader('content-type','text/html');return res.end(await readFile(new URL('../public/fin-terminal.html',import.meta.url)));}
  res.setHeader('content-type','application/json');
  if(path==='/api/logout'){signedIn=false;return res.end('{}');}
  if(required&&path.startsWith('/api/')){res.statusCode=403;return res.end(JSON.stringify({code:'BANK_WORKSTATION_REQUIRED',message:'Use the bank desk on an approved workstation.'}));}
  if(path==='/api/session'){if(!signedIn){res.statusCode=401;return res.end(JSON.stringify({code:'UNAUTHORIZED'}));}return res.end(JSON.stringify(session));}
  if(path==='/api/login'){signedIn=true;return res.end(JSON.stringify(session));}
  if(path.startsWith('/api/views/'))return res.end(JSON.stringify({rows:[]}));
  res.removeHeader('content-type');
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
 signedIn=true;required=false;gate=true;const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[];
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

test('a terminal open while its bank page is reloaded stays as it is, and closes when the bank signs out (Codex review finding, P2)',async()=>{
 signedIn=true;required=false;gate=true;const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto(base+'/admin#payments');const button=page.locator('[data-fin-terminal-switch]');await button.waitFor();
  const [terminal]=await Promise.all([context.waitForEvent('page'),button.click()]);await terminal.locator('[data-fin-terminal]').waitFor();
  await page.reload();await page.locator('[data-fin-terminal-switch]').waitFor();
  // The reloaded page has no handle on the terminal; the terminal checked its sign-in and stays.
  await page.waitForTimeout(300);assert.equal(terminal.isClosed(),false);assert.equal(await terminal.locator('[data-fin-terminal]').isVisible(),true);
  await Promise.all([terminal.waitForEvent('close',{timeout:5000}),page.locator('#signout').click()]);
  await page.locator('#signin').waitFor({state:'visible'});assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// The bank owner: "The bank must have login and log off operative" and "The sign in and out must be manually".
test('the terminal\'s own Sign out at its foot ends the bank sign-in: its window closes and the bank page shows its sign-in',async()=>{
 signedIn=true;required=false;gate=true;const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));context.on('page',tab=>tab.on('pageerror',error=>errors.push(error.message)));
 try{
  await page.goto(base+'/admin#payments');const button=page.locator('[data-fin-terminal-switch]');await button.waitFor();
  const [terminal]=await Promise.all([context.waitForEvent('page'),button.click()]);await terminal.locator('[data-fin-terminal]').waitFor();
  const out=terminal.locator('[data-fin-sign-out]');await out.scrollIntoViewIfNeeded();assert.equal(await out.textContent(),'Sign out');
  const place=await terminal.evaluate(()=>{
   const main=document.querySelector('[data-fin-terminal]').getBoundingClientRect(),button=document.querySelector('[data-fin-sign-out]').getBoundingClientRect();
   return {fromFoot:main.bottom-button.bottom,fromTop:button.top-main.top,inside:button.left>=0&&button.right<=innerWidth};
  });
  assert.ok(place.inside,'inside the window');assert.ok(place.fromFoot<60&&place.fromTop>200,'at the foot, never in an upper corner');
  await Promise.all([terminal.waitForEvent('close',{timeout:5000}),out.click()]);
  assert.equal(signedIn,false);await page.locator('#signin').waitFor({state:'visible'});
  assert.equal(await button.getAttribute('data-state'),'CLOSED');assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

// Reported directly, with a picture of the dark terminal: "After I created the PIN the page took off and I could not restart".
test('a terminal in a tab of its own whose sign-in ended goes to the sign-in, and comes back once signed in again',async()=>{
 signedIn=true;required=false;gate=true;const context=await browser.newContext({viewport:{width:1440,height:1000}}),tab=await context.newPage(),errors=[];
 tab.on('pageerror',error=>errors.push(error.message));
 try{
  await tab.goto(base+'/fin-terminal');await tab.locator('[data-fin-terminal]').waitFor();
  signedIn=false;await tab.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await tab.waitForURL(base+'/');await tab.locator('#signin').waitFor({state:'visible'});
  await tab.locator('#login-form [name=username]').fill('operator');await tab.locator('#login-form [name=password]').fill('fixture-password');
  await Promise.all([tab.waitForURL(base+'/fin-terminal'),tab.locator('#login-form button[type=submit]').click()]);
  await tab.locator('[data-fin-terminal]').waitFor();assert.equal(await tab.evaluate(()=>sessionStorage.length),0);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('a bank page whose AVIS sign-in ended goes straight to it instead of standing on an error, and never in a circle',async()=>{
 signedIn=true;required=false;gate=true;const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto(base+'/#accounts');await page.locator('#signout').waitFor({state:'visible'});
  required=true;await Promise.all([page.waitForURL(base+'/access/start'),page.evaluate(()=>{location.hash='#payments';})]);
  // Without the bank's gate it goes there once; then its sign-in form shows and it stays.
  gate=false;const went=[];page.on('framenavigated',frame=>{if(frame===page.mainFrame())went.push(frame.url());});
  await page.goto(base+'/');await page.locator('#signin').waitFor({state:'visible'});await page.waitForTimeout(500);
  assert.equal(went.length,1);assert.equal(new URL(page.url()).pathname,'/');assert.deepEqual(errors,[]);
 }finally{required=false;gate=true;await context.close();}
});
