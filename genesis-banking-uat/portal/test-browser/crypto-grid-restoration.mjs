import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

let browser;
const css=await readFile(new URL('../public/crypto.css',import.meta.url),'utf8');
before(async()=>{browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});

for(const width of [2560,1440,1408,1024,834,390])test('crypto terminal has no empty column or stretched robot at '+width,async()=>{
 const page=await browser.newPage({viewport:{width,height:1000}});
 try{
  await page.setContent(`<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0}main{margin-left:${width>720?230:0}px;padding:18px}button{font:inherit}</style></head><body><main><section class="crypto-section crypto-trading-desk"><div class="crypto-trading-console"><section class="trading-live"><div class="trading-live-workspace"><aside class="trading-live-robot"><strong>W-effect</strong><button class="trading-robot-focus"><svg class="trading-robot-art" viewBox="0 0 260 310"><rect x="70" y="40" width="120" height="190"/></svg></button><div class="trading-robot-filters"><button>All</button><button>Buy executions</button><button>Sell executions</button></div></aside><section class="terminal-live-trades"><h4>Last trades</h4><div class="terminal-scroll-tape"><table><tr><td>14:16:59</td><td>65037.36</td><td>0.003</td></tr></table></div></section><section class="terminal-live-book"><h4>Order book</h4><div class="terminal-scroll-tape">Bid and ask</div></section><section class="terminal-price-screen"><strong>BTC / USDT</strong><div class="trading-live-chart"><svg></svg></div></section></div></section></div></section><section class="crypto-section"><div class="crypto-scroller" aria-label="Security wallets">${Array.from({length:10},(_,i)=>`<button class="crypto-wallet security-wallet" data-security="${i}"><strong>${i?'Demo '+i:'AVISPay PLC'}</strong><span class="security-volume">100,000,000 units</span><code class="security-wallet-address">0x${'1'.repeat(40)}</code><span>Open converter</span></button>`).join('')}</div></section></main></body></html>`);
  await page.addStyleTag({content:css});
  const geometry=await page.evaluate(()=>{
   const rect=selector=>{const b=document.querySelector(selector).getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom};};
   const scroller=document.querySelector('.crypto-scroller');
   return {grid:rect('.trading-live-workspace'),robot:rect('.trading-live-robot'),trades:rect('.terminal-live-trades'),book:rect('.terminal-live-book'),price:rect('.terminal-price-screen'),
    bodyWidth:document.documentElement.scrollWidth,viewport:innerWidth,areas:getComputedStyle(document.querySelector('.trading-live-workspace')).gridTemplateAreas,
    scrollerWidth:scroller.clientWidth,scrollWidth:scroller.scrollWidth,cards:[...scroller.querySelectorAll('[data-security]')].map(c=>{const b=c.getBoundingClientRect();return {width:b.width,y:b.y};})};
  });
  assert.ok(geometry.bodyWidth<=width+1,'no whole-page horizontal overflow');
  assert.ok(geometry.robot.height<500,'robot height follows its content, not two grid rows');
  assert.ok(Math.abs(geometry.price.right-geometry.grid.right)<2,'price screen reaches the last grid column');
  if(geometry.grid.width>780){
   assert.equal(geometry.areas,'"robot trades book price"');
   assert.ok(Math.abs(geometry.price.y-geometry.robot.y)<2,'chart stays beside the robot');
   assert.ok(geometry.price.x>geometry.book.x&&geometry.book.x>geometry.trades.x);
  }
  assert.equal(geometry.cards.length,10);
  assert.ok(geometry.cards.every(c=>c.width>=219&&c.width<=246),'cards retain usable widths instead of shrinking');
  assert.ok(geometry.cards.every(c=>Math.abs(c.y-geometry.cards[0].y)<2),'all wallets stay in one horizontal row');
  assert.ok(geometry.scrollWidth>=geometry.scrollerWidth);
  await page.locator('[data-security="9"]').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('[data-security="9"]').isVisible(),'last wallet remains reachable');
 }finally{await page.close();}
});
