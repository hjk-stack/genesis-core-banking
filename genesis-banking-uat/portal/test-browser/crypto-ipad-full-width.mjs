import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const shell=(await readFile(new URL('../index.html',import.meta.url),'utf8'))
 .replace(/<link[^>]*>/g,'')
 .replace(/<script[^>]*><\/script>/g,'');
const styles=await readFile(new URL('../public/styles.css',import.meta.url),'utf8');
const crypto=await readFile(new URL('../public/crypto.css',import.meta.url),'utf8');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});});
after(async()=>{await browser?.close();});

async function layout(width,cryptoActive=true){
 const page=await browser.newPage({viewport:{width,height:900},deviceScaleFactor:2,hasTouch:true,isMobile:false});
 try{
  await page.setContent(shell);
  await page.addStyleTag({content:styles});
  await page.addStyleTag({content:crypto});
  await page.evaluate(active=>{
   const workspace=document.querySelector('#workspace'),view=document.querySelector('#view');
   workspace.hidden=false;
   view.innerHTML=active?
     '<section class="crypto-section" id="crypto-wallet-desk"><div class="crypto-section-heading"><div><h2>Payment & exchange wallets</h2></div></div><div class="crypto-scroller" data-wallets></div></section>'+
     '<section class="crypto-section crypto-trading-desk" id="crypto-trading-desk"><div class="trading-live"><div class="trading-live-workspace"><div class="trading-live-robot">Robot</div><div class="terminal-live-trades">Trades</div><div class="terminal-live-book">Order book</div><div class="terminal-price-screen">Price chart</div></div></div></section>'+
     '<section class="crypto-section" id="crypto-security-desk"><div class="crypto-scroller" data-security-wallets></div></section>':
     '<div class="view-header"><h1>Accounts & ABIQ</h1></div><div id="panels"></div>';
   if(active){
    for(const selector of ['[data-wallets]','[data-security-wallets]']){
     const parent=document.querySelector(selector);
     for(let i=0;i<12;i++){
      const card=document.createElement('article');card.className='crypto-wallet';
      card.textContent='Currency '+i+' · 0x1234567890123456789012345678901234567890';
      parent.append(card);
     }
    }
   }
  },cryptoActive);
  return await page.evaluate(()=>{
   const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,top:r.top,bottom:r.bottom};};
   const nav=document.querySelector('#workspace nav');
   const shell=document.querySelector('#workspace');
   const scroller=document.querySelector('.crypto-scroller');
   return {viewport:document.documentElement.clientWidth,page:document.documentElement.scrollWidth,
    shellDisplay:getComputedStyle(shell).display,aside:rect('#workspace > aside'),main:rect('#main'),
    navDirection:getComputedStyle(nav).flexDirection,navScroll:nav.scrollWidth,navClient:nav.clientWidth,
    scrollRect:scroller?rect('.crypto-scroller'):null,scrollWidth:scroller?.scrollWidth,
    sections:document.querySelectorAll('#view > .crypto-section').length,
    activePage:document.querySelector('#view > .crypto-section')!==null};
  });
 }finally{await page.close();}
}
for(const width of [768,820,834,1024,1032,1194,1366,1376]){
 test('iPad crypto uses full viewport without clipping wallets at '+width,async()=>{
  const l=await layout(width,true);
  assert.equal(l.activePage,true);
  assert.equal(l.shellDisplay,'block','tablet crypto should not reserve a bank sidebar column');
  assert.ok(Math.abs(l.main.left)<1,'crypto begins at viewport left, not after a fixed sidebar');
  assert.ok(Math.abs(l.main.right-l.viewport)<1,'crypto main reaches right edge');
  assert.ok(l.aside.bottom<=l.main.top+1,'navigation is a separate row above crypto instead of occupying a left column');
  assert.equal(l.navDirection,'row','bank navigation is a horizontal strip');
  assert.ok(l.navScroll>l.navClient,'extra banking tabs stay horizontally reachable');
  assert.ok(l.page<=l.viewport+1,'tablet must not have document-level horizontal overflow');
  assert.ok(l.scrollWidth>l.scrollRect.width,'currency tiles remain scrollable inside their own row');
  assert.equal(l.sections,3,'crypto wallets, trading and securities remain mounted');
 });
}
for(const width of [834,1024,1376,1440]){
 test('other banking views retain their regular navigation at '+width,async()=>{
  const l=await layout(width,false);
  assert.equal(l.shellDisplay,'grid');
  assert.ok(l.main.left>=179,'ordinary pages preserve bank sidebar');
  assert.ok(l.page<=l.viewport+1,'ordinary pages must not overflow');
 });
}
for(const width of [390,1440,2560]){
 test('phone and desktop crypto preserve existing shell at '+width,async()=>{
  const l=await layout(width,true);
  assert.equal(l.shellDisplay,width===390?'block':'grid');
  assert.ok(l.page<=l.viewport+1);
  assert.ok(Math.abs(l.main.right-l.viewport)<1);
 });
}
