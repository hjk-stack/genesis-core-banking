import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';

let server,browser,base;
const fixture=`import {mountWalletTradingScroller} from '/wallet-trading-scroller.mjs';
import {installApprovedRobot} from '/approved-robot.mjs';
const records=[
 {account_id:'11111111-1111-4111-8111-111111111111',currency_code:'AG',name:'AVIS Green',network:'ETHEREUM',quantity:'2000.000000000000000000',full_name:'AVISPay PLC',enabled:false,version:0},
 {account_id:'22222222-2222-4222-8222-222222222222',currency_code:'AGi',name:'AVIS Green Investment',network:'ETHEREUM',quantity:'1000.000000000000000000',full_name:'AVISPay PLC',enabled:false,version:0}
];
window.selectionWrites=[];
const api=async(path,input)=>{
 if(path==='views/tradingallowances')return {rows:structuredClone(records)};
 if(path==='views/cryptomarkets')return {rows:[]};
 if(path==='crypto/trading/select-wallet'){
  const row=records.find(r=>r.account_id===input.accountId);
  if(!row||row.version!==input.expectedVersion)throw new Error('Selection changed');
  window.selectionWrites.push(structuredClone(input));row.enabled=input.enabled;row.version++;
  return structuredClone(row);
 }
 throw new Error('Unexpected request '+path);
};
const controller=mountWalletTradingScroller({api,host:document.querySelector('[data-trading-allowances]'),pollMs:0});
const robot=installApprovedRobot({api,host:document.querySelector('[data-trading-live]')});
robot.mount();
window.addAcceptedCoins=async()=>{
 for(let i=0;i<10;i++)records.push({account_id:'extra-'+i,currency_code:'TEST'+i,name:'Isolated coin '+i,network:'ETHEREUM',quantity:'0.123456789012345678',full_name:'Isolated holder',enabled:false,version:0});
 window.dispatchEvent(new Event('avispay:trade-allowance-changed'));
};
window.reloadAllowanceRow=async()=>{controller.close();window.reloaded=mountWalletTradingScroller({api,host:document.querySelector('[data-trading-allowances]'),pollMs:0});await window.reloaded.ready;};
await controller.ready;document.body.dataset.ready='true';`;
const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/crypto.css"><style>body{margin:0;padding:14px;font-family:Arial,sans-serif;box-sizing:border-box}#crypto-trading-desk{max-width:100%;min-width:0}.crypto-trading-console{max-width:100%;min-width:0}*{box-sizing:border-box}</style></head><body><section id="crypto-trading-desk" class="crypto-trading-desk"><div data-trading-allowances></div><div data-trading-panel class="crypto-trading-console"><div data-trading-live><div class="trading-live-workspace"><aside class="trading-live-robot"><button type="button" data-focus-execution disabled></button></aside><section class="terminal-live-trades"><h4>Last trades</h4></section><section class="terminal-live-book"><h4>Order book</h4></section><div class="terminal-price-screen"><div data-live-chart></div></div></div><div data-live-financial-metrics></div></div></div></section><script type="module" src="/fixture.mjs"></script></body></html>`;

before(async()=>{
 server=http.createServer(async(req,res)=>{
  if(req.url==='/'){res.setHeader('content-type','text/html');return res.end(html);}
  if(req.url==='/fixture.mjs'){res.setHeader('content-type','text/javascript');return res.end(fixture);}
  if(!/^\/(?:[a-z-]+\.(?:mjs|css)|crypto-icons\/[a-z-]+\.(?:png|jpg))$/.test(req.url||'')){res.statusCode=404;return res.end();}
  try{const bytes=await readFile(new URL('../public'+req.url,import.meta.url));res.setHeader('content-type',req.url.endsWith('.css')?'text/css':req.url.endsWith('.mjs')?'text/javascript':req.url.endsWith('.png')?'image/png':'image/jpeg');res.end(bytes);}catch{res.statusCode=404;res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve));});

for(const width of [1440,834,390])test('accepted wallet coins occupy first robot row and activate independently at '+width,async()=>{
 const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto(base);await page.waitForSelector('body[data-ready=true]');
  await page.waitForFunction(()=>!!document.querySelector('link[data-wallet-trading-style]')?.sheet&&!!document.querySelector('link[data-approved-robot-style]')?.sheet);
  const strip=page.locator('.ar-board>[data-trading-allowances]');
  assert.equal(await strip.count(),1,'the coin allowances must be inside the first terminal row');
  assert.equal(await page.locator('[data-ar-markets]').isVisible(),false,'reference prices must not replace accepted coins');
  assert.match(await strip.textContent(),/2,000 AG/);assert.match(await strip.textContent(),/1,000 AGi/);
  const ag=strip.getByRole('switch',{name:'Activate AG on ETHEREUM for robot',exact:true});
  const agi=strip.getByRole('switch',{name:'Activate AGi on ETHEREUM for robot',exact:true});
  await ag.click();await page.waitForFunction(()=>document.querySelectorAll('[data-trading-allowances] [aria-checked=true]').length===1);
  await agi.click();await page.waitForFunction(()=>document.querySelectorAll('[data-trading-allowances] [aria-checked=true]').length===2);
  await ag.click();await page.waitForFunction(()=>document.querySelectorAll('[data-trading-allowances] [aria-checked=true]').length===1);
  assert.equal(await ag.getAttribute('aria-checked'),'false');assert.equal(await agi.getAttribute('aria-checked'),'true');
  await page.evaluate(()=>window.reloadAllowanceRow());
  assert.equal(await strip.locator('[aria-checked=true]').count(),1);assert.equal(await page.evaluate(()=>window.selectionWrites.length),3);
  await page.evaluate(()=>window.addAcceptedCoins());await page.waitForFunction(()=>document.querySelectorAll('[data-trading-wallet]').length===12);
  const dimensions=await strip.locator('[data-trading-allowance-coins]').evaluate(element=>({client:element.clientWidth,scroll:element.scrollWidth}));
  assert.ok(dimensions.scroll>dimensions.client,'multiple coins must scroll within the trading row');
  await strip.getByRole('button',{name:'Next authorised coins'}).click();
  await page.waitForFunction(()=>document.querySelector('[data-trading-allowance-coins]').scrollLeft>0);
  assert.match(await strip.textContent(),/0\.123456789012345678 TEST0/);
  assert.equal(await page.locator('.ar-ticker').count(),1,'public market ticker remains in the footer');
  await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/crypto-trading-tests-multicoin-'+width+'.png',fullPage:true});
  assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
