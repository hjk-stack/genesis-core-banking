import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';

let server,browser,base;
const calls=[];
const depositChecks=new Map();
const cards=Array.from({length:10},(_,i)=>({card_id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),sort_order:i+1,name:i?'Demo security '+(i+1):'AVISPay PLC',symbol:i?'DEMO'+i:'aAVISP',mode:'DEMO',state:'DRAFT',token_quantity:'0',dossier:{assetType:'STOCK',currency:'CHF',assetValue:'100000000',issuedVolume:'100000000',faceValue:'1',marginHaircutBps:1500,tradingFeeBps:10,source:'Example dossier'}}));
const catalogue=Array.from({length:200},(_,i)=>({asset_id:'asset-'+i,currency_code:i?'COIN'+i:'AG',name:i?'Currency '+i:'AVIS Green',market_rank:i+1,market_data:{usd:'1',eur:'.9',chf:'.85',change24h:i%2?-2:3,observedAt:new Date().toISOString()},networks:[{network:'ETHEREUM',approved:i===0}]}));
const fixtureScript=[
 "import {createCryptoWorkspace} from '/crypto-workspace.mjs';",
 "document.querySelector('#signin').hidden=true;",
 "document.querySelector('#workspace').hidden=false;",
 "const api=async(path,body,key)=>{const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:key?{'idempotency-key':key}:undefined,body:body?JSON.stringify(body):undefined});return r.json();};",
 "createCryptoWorkspace({api,identity:()=>({admin:true}),purchase(){},sell(){},send(){},notice(){}}).mount(document.querySelector('#view'));"
].join('\n');

before(async()=>{
 // Use the real shell and stylesheet, including its main-width constraint.
 const html=(await readFile(new URL('../index.html',import.meta.url),'utf8')).replace('src="/app.mjs"','src="/fixture.mjs"');
 server=http.createServer(async(req,res)=>{
  if(req.url==='/'){res.setHeader('content-type','text/html');return res.end(html);}
  if(req.url==='/fixture.mjs'){res.setHeader('content-type','text/javascript');return res.end(fixtureScript);}
  const json=v=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(v));};
  if(req.url.startsWith('/api/views/'))return json({rows:({
   cryptocatalogue:catalogue,cryptomarkets:catalogue,cryptosecurities:cards,
   cryptowallets:[{account_id:'wallet',user_id:'1',full_name:'AVISPay PLC',currency_code:'AG',name:'AVIS Green',network:'ETHEREUM',wallet_scope:'FUNDING',available_balance:'100.123456789012345678',locked_balance:'0',address_id:'1',asset_id:'asset-0'}],
   cryptonetworks:[{name:'Ethereum',code:'ETHEREUM',kind:'EVM'}],customers:[{user_id:'1',full_name:'AVISPay PLC',account_role:'INSTITUTION'}]
  })[req.url.split('/').at(-1)]||[]});
  if(req.url.startsWith('/api/crypto/securities/000'))return json({...cards.find(c=>req.url.endsWith(c.card_id)),actions:[],sourceSpecification:'v3.0'});
  if(req.method==='POST'){
   let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push({url:req.url,body,key:req.headers['idempotency-key']});
   if(req.url==='/api/crypto/wallet')return json({address_id:'1',network:'ETHEREUM',public_address:'0x1234567890123456789012345678901234567890',destination_tag:null,qr:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg=='});
   if(req.url==='/api/crypto/deposits/reconcile'){
    const count=(depositChecks.get(body.txHash)||0)+1;depositChecks.set(body.txHash,count);
    return json(count===1?{status:'PENDING',confirmations:12,finalized:false}:{status:'CONFIRMED',accountId:body.accountId,addressId:body.addressId,amount:'0.123456789012345678',currency:'AG',txHash:body.txHash,confirmations:64,finalized:true});
   }
   return json({id:'result'});
  }
  if(['/crypto-workspace.mjs','/trading-panel.mjs','/crypto.css','/styles.css','/crypto-icons/ag.png','/crypto-icons/agi.png'].includes(req.url)){
   res.setHeader('content-type',req.url.endsWith('.png')?'image/png':req.url.endsWith('.css')?'text/css':'text/javascript');
   return res.end(await readFile(new URL('../public'+req.url,import.meta.url)));
  }
  res.writeHead(404);res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});

for(const width of [2560,1440,834,390])test('real banking shell fits crypto scrollers, asset details and receiving receipt at '+width,async()=>{
 const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(base);
  await page.getByRole('heading',{name:'AVISPay PLC · Asset contents & conversion'}).waitFor();
  assert.equal(await page.locator('[data-security]').count(),10);
  assert.equal(await page.locator('[data-markets] .crypto-market').count(),100);
  assert.equal(await page.locator('.crypto-currency-row').count(),200);
  const layout=await page.evaluate(()=>{
   const main=document.querySelector('#main'),markets=document.querySelector('[data-markets]'),box=main.getBoundingClientRect(),style=getComputedStyle(main);
   return {viewport:document.documentElement.clientWidth,pageWidth:document.documentElement.scrollWidth,mainRight:box.right,mainWidth:box.width,contentWidth:box.width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),marketWidth:markets.getBoundingClientRect().width,marketScroll:markets.scrollWidth};
  });
  assert.ok(layout.pageWidth<=layout.viewport,'the document must not overflow horizontally');
  assert.ok(Math.abs(layout.mainRight-layout.viewport)<=1,'crypto must fill the available width of the real banking shell');
  assert.ok(Math.abs(layout.marketWidth-layout.contentWidth)<=1,'the market scroller must span the main content width');
  assert.ok(layout.marketScroll>layout.marketWidth,'the top 100 must scroll within their own row');
  assert.equal(await page.locator('[data-wallet] dd').first().textContent(),'100.123456789012345678');
  await page.waitForFunction(()=>document.querySelector('[data-wallet] img')?.naturalWidth>0);
  await page.locator('[data-security]').nth(3).click();
  await page.getByRole('heading',{name:'Demo security 4 · Asset contents & conversion'}).waitFor();
  assert.equal(await page.locator('[data-security][aria-pressed=true]').count(),1);
  await page.getByRole('button',{name:'Receive AG',exact:true}).click();
  await page.locator('.crypto-qr').waitFor();
  const d=page.locator('dialog[open]');
  assert.equal(await d.evaluate(e=>e.parentElement.tagName),'BODY');
  assert.equal(await d.getByRole('button',{name:'Close',exact:true}).count(),1);
  const b=await d.boundingBox();assert.ok(b.x>=0&&b.x+b.width<=width+1);
  const txHash='0x'+width.toString(16).padStart(64,'a'),receipt=d.locator('[data-deposit-result]');
  await d.getByRole('textbox',{name:'Transaction hash',exact:true}).fill(txHash);
  await d.getByRole('button',{name:'Check incoming transfer',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-deposit-result]')?.textContent==='Confirmations: 12 / 12 · Awaiting blockchain finalization');
  assert.equal(await receipt.textContent(),'Confirmations: 12 / 12 · Awaiting blockchain finalization');
  await d.getByRole('button',{name:'Check incoming transfer',exact:true}).click();
  await page.waitForFunction(hash=>document.querySelector('[data-deposit-result]')?.textContent==='Received 0.123456789012345678 AG · '+hash,txHash);
  assert.equal(await receipt.textContent(),'Received 0.123456789012345678 AG · '+txHash);
  const submissions=calls.filter(c=>c.url==='/api/crypto/deposits/reconcile'&&c.body.txHash===txHash);
  assert.deepEqual(submissions.map(c=>c.body),Array.from({length:2},()=>({accountId:'wallet',addressId:'1',txHash})));
  assert.match(submissions[0].key,/^[0-9a-f-]{36}$/i);assert.equal(submissions[0].key,submissions[1].key,'pending receipt retry must keep its idempotency key');
  await receipt.scrollIntoViewIfNeeded();
  const receiveLayout=await d.evaluate(dialog=>{
   const form=dialog.querySelector('[data-deposit-form]'),result=dialog.querySelector('[data-deposit-result]'),box=result.getBoundingClientRect(),range=document.createRange();
   range.selectNodeContents(result);
   return {dialogWidth:dialog.clientWidth,dialogScroll:dialog.scrollWidth,formWidth:form.clientWidth,formScroll:form.scrollWidth,resultWidth:result.clientWidth,resultScroll:result.scrollWidth,pageWidth:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth,lines:[...range.getClientRects()].map(r=>({left:r.left,right:r.right})),left:box.left,right:box.right,top:box.top,bottom:box.bottom,height:window.innerHeight};
  });
  assert.ok(receiveLayout.dialogScroll<=receiveLayout.dialogWidth+1,'receipt must not overflow the dialog horizontally');
  assert.ok(receiveLayout.formScroll<=receiveLayout.formWidth+1,'the receiving form must fit its dialog');
  assert.ok(receiveLayout.resultScroll<=receiveLayout.resultWidth+1,'the complete transaction hash must wrap inside the receipt');
  assert.ok(receiveLayout.pageWidth<=receiveLayout.viewport,'receipt must not widen the banking page');
  assert.ok(receiveLayout.lines.every(line=>line.left>=receiveLayout.left-1&&line.right<=receiveLayout.right+1),'every receipt text line must stay inside its bounds');
  assert.ok(receiveLayout.top>=0&&receiveLayout.bottom<=receiveLayout.height,'the receipt must be readable after scrolling within the dialog');
  if(width===390)assert.ok(receiveLayout.lines.length>1,'the mobile receipt must wrap its long hash onto multiple lines');
  await mkdir('test-results',{recursive:true});
  await page.screenshot({path:'test-results/crypto-receipt-'+width+'.png',fullPage:false});
  await d.getByRole('button',{name:'Close',exact:true}).click();
  assert.equal(await page.locator('dialog[open]').count(),0);
  await page.locator('[data-security]').first().click();
  await page.getByRole('button',{name:'Convert demo security',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-security-detail] h3')?.textContent.includes('AVISPay'));
  assert.ok(calls.some(c=>c.url==='/api/crypto/securities/demo-convert'));
  await mkdir('test-results',{recursive:true});
  await page.screenshot({path:'test-results/crypto-'+width+'.png',fullPage:false});
  if(width===2560){
   await page.evaluate(()=>{document.querySelector('#view').innerHTML='<section><h1>Accounts</h1></section>';});
   const ordinaryWidth=await page.locator('#main').evaluate(e=>e.getBoundingClientRect().width);
   assert.equal(ordinaryWidth,1700,'other banking pages must keep their existing width constraint');
  }
  assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
