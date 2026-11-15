import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import QRCode from 'qrcode';

let server,browser,base;
const calls=[];
const depositChecks=new Map();
const verifiedAt='2026-11-15T19:00:00.000Z';
const addresses={
 '1':{network:'ETHEREUM',public_address:'0x1234567890123456789012345678901234567890'},
 '2':{network:'SOLANA',public_address:'11111111111111111111111111111111'},
 '3':{network:'POLYGON',public_address:'0x3333333333333333333333333333333333333333'}
};
const holding=(account_id,currency_code,asset_id,name,network,address_id,available_balance,locked_balance='0')=>({account_id,currency_code,asset_id,name,network,address_id,available_balance,locked_balance,user_id:'1',full_name:'AVISPay PLC',account_role:'INSTITUTION',wallet_scope:'FUNDING',public_address:addresses[address_id].public_address});
const initialWallets=[
 holding('wallet','AG','asset-0','AVIS Green','ETHEREUM','1','100.123456789012345678'),
 holding('wallet-usdc-ethereum','USDC','asset-usdc','USD Coin','ETHEREUM','1','123.456789','2'),
 holding('wallet-usdc-solana','USDC','asset-usdc','USD Coin','SOLANA','2','987.654321','7')
];
const daiWallets=[
 holding('wallet-dai-ethereum','DAI','asset-dai','Dai','ETHEREUM','1','0'),
 holding('wallet-dai-polygon','DAI','asset-dai','Dai','POLYGON','3','0')
];
let wallets=[];
const cards=Array.from({length:10},(_,i)=>({card_id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),sort_order:i+1,name:i?'Demo security '+(i+1):'AVISPay PLC',symbol:i?'DEMO'+i:'aAVISP',mode:'DEMO',state:'DRAFT',token_quantity:'0',dossier:{assetType:'STOCK',currency:'CHF',assetValue:'100000000',issuedVolume:'100000000',faceValue:'1',marginHaircutBps:1500,tradingFeeBps:10,source:'Example dossier'}}));
const catalogue=Array.from({length:200},(_,i)=>({asset_id:'asset-'+i,currency_code:i?'COIN'+i:'AG',name:i?'Currency '+i:'AVIS Green',market_rank:i+1,market_data:{usd:'1',eur:'.9',chf:'.85',change24h:i%2?-2:3,observedAt:new Date().toISOString()},networks:[{network:'ETHEREUM',approved:i===0,verifiedAt:i===0?verifiedAt:null}]}));
Object.assign(catalogue[1],{asset_id:'asset-usdc',currency_code:'USDC',name:'USD Coin',networks:[{network:'ETHEREUM',approved:true,verifiedAt},{network:'SOLANA',approved:true,verifiedAt},{network:'BSC',approved:false,verifiedAt}]});
Object.assign(catalogue[2],{asset_id:'asset-dai',currency_code:'DAI',name:'Dai',networks:[{network:'ETHEREUM',approved:true,verifiedAt},{network:'POLYGON',approved:true,verifiedAt},{network:'SOLANA',approved:false,verifiedAt}]});
const fixtureScript=[
 "import {createCryptoWorkspace} from '/crypto-workspace.mjs';",
 "document.querySelector('#signin').hidden=true;",
 "document.querySelector('#workspace').hidden=false;",
 "const api=async(path,body,key)=>{const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:key?{'idempotency-key':key}:undefined,body:body?JSON.stringify(body):undefined});return r.json();};",
 "createCryptoWorkspace({api,identity:()=>({admin:true}),purchase(){},sell(){},send(w){void api('fixture/send',{accountId:w.account_id,network:w.network});},notice(){}}).mount(document.querySelector('#view'));"
].join('\n');

before(async()=>{
 // Use the real shell and stylesheet, including its main-width constraint.
 const html=(await readFile(new URL('../index.html',import.meta.url),'utf8')).replace('src="/app.mjs"','src="/fixture.mjs"');
 for(const address of Object.values(addresses))address.qr=await QRCode.toDataURL(address.public_address,{margin:2,width:256,errorCorrectionLevel:'M'});
 server=http.createServer(async(req,res)=>{
  if(req.url==='/'){wallets=initialWallets.map(w=>({...w}));res.setHeader('content-type','text/html');return res.end(html);}
  if(req.url==='/fixture.mjs'){res.setHeader('content-type','text/javascript');return res.end(fixtureScript);}
  const json=v=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(v));};
  if(req.url==='/api/crypto/trading/index-policy')return json({policyVersion:1,instructions:'Use official announcements and retain unknown values as null.',taxonomy:[{id:'EQ01',label:'Major contracts'}]});
  if(req.url.startsWith('/api/views/'))return json({rows:({
   cryptocatalogue:catalogue,cryptomarkets:catalogue,cryptosecurities:cards,
   cryptowallets:wallets,
   cryptonetworks:[{name:'Ethereum',code:'ETHEREUM',kind:'EVM'},{name:'Solana',code:'SOLANA',kind:'SOLANA'},{name:'Polygon',code:'POLYGON',kind:'EVM'},{name:'BNB Smart Chain',code:'BSC',kind:'EVM'}],customers:[{user_id:'1',full_name:'AVISPay PLC',account_role:'INSTITUTION'}]
  })[req.url.split('/').at(-1)]||[]});
  if(req.url.startsWith('/api/crypto/securities/000'))return json({...cards.find(c=>req.url.endsWith(c.card_id)),actions:[],sourceSpecification:'v3.0'});
  if(req.method==='POST'){
   let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push({url:req.url,body,key:req.headers['idempotency-key']});
   if(req.url==='/api/crypto/wallet')return json({address_id:String(body.addressId),...addresses[String(body.addressId)],destination_tag:null});
   if(req.url==='/api/crypto/balance'){
    const selected=wallets.find(w=>String(w.address_id)===String(body.addressId)&&w.asset_id===body.assetId);
    return json({balance:selected?.available_balance||'0',observedAt:'2026-11-15T19:00:00.000Z'});
   }
   if(req.url==='/api/crypto/activate'){
    for(const w of daiWallets)if(!wallets.some(existing=>existing.account_id===w.account_id))wallets.push({...w});
    return json({userId:'1',assetId:'asset-dai',currency:'DAI',wallets:daiWallets.map(w=>({addressId:w.address_id,accountId:w.account_id,address:w.public_address,network:w.network,assetId:w.asset_id}))});
   }
   if(req.url==='/api/crypto/deposits/reconcile'){
    const count=(depositChecks.get(body.txHash)||0)+1;depositChecks.set(body.txHash,count);
    return json(count===1?{status:'PENDING',confirmations:12,finalized:false}:{status:'CONFIRMED',accountId:body.accountId,addressId:body.addressId,amount:'0.123456789012345678',currency:'AG',txHash:body.txHash,confirmations:64,finalized:true});
   }
   return json({id:'result'});
  }
  if(['/crypto-workspace.mjs','/trading-panel.mjs','/index-advice.mjs','/crypto.css','/styles.css','/crypto-icons/ag.png','/crypto-icons/agi.png'].includes(req.url)){
   res.setHeader('content-type',req.url.endsWith('.png')?'image/png':req.url.endsWith('.css')?'text/css':'text/javascript');
   return res.end(await readFile(new URL('../public'+req.url,import.meta.url)));
  }
  res.writeHead(404);res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});

async function verifyGroupedCurrency(page,width){
 const start=calls.length,usdc=page.locator('article[data-wallet-group]').filter({hasText:'USD Coin'});
 assert.equal(await page.locator('article[data-wallet-group]').count(),2,'three network holdings must render as two currency tiles');
 assert.equal(await usdc.count(),1,'Ethereum and Solana USDC must share one currency tile');
 const network=usdc.locator('select[data-wallet-network]');
 assert.deepEqual(await network.locator('option').evaluateAll(options=>options.map(o=>o.value).filter(Boolean)),['ETHEREUM','SOLANA']);
 assert.equal(await network.inputValue(),'ETHEREUM');
 assert.equal(await usdc.getAttribute('data-wallet'),'wallet-usdc-ethereum');
 assert.equal(await usdc.locator('dd').nth(0).textContent(),'123.456789');
 assert.equal(await usdc.locator('dd').nth(1).textContent(),'2');
 await network.selectOption('SOLANA');
 await page.waitForFunction(()=>document.querySelector('[data-wallet="wallet-usdc-solana"] dd')?.textContent==='987.654321');
 assert.equal(await usdc.count(),1);assert.equal(await usdc.locator('dd').nth(1).textContent(),'7');
 const sendSelected=async(accountId,network)=>{
  const mark=calls.length;
  await Promise.all([
   page.waitForResponse(response=>response.url()===base+'/api/fixture/send'),
   usdc.getByRole('button',{name:'Send USDC',exact:true}).click()
  ]);
  assert.deepEqual(calls.slice(mark).filter(c=>c.url==='/api/fixture/send').map(c=>c.body),[{accountId,network}]);
 };
 await sendSelected('wallet-usdc-solana','SOLANA');
 await usdc.getByRole('button',{name:'Receive USDC',exact:true}).click();
 const dialog=page.locator('dialog[open]');
 await page.waitForFunction(address=>document.querySelector('dialog[open] .crypto-receive code')?.textContent===address,addresses['2'].public_address);
 assert.equal(await dialog.locator('select[data-receive-network]').inputValue(),'SOLANA');
 assert.deepEqual(await dialog.locator('select[data-receive-network] option').evaluateAll(options=>options.map(o=>o.value).filter(Boolean)),['ETHEREUM','SOLANA']);
 assert.equal(await dialog.locator('.crypto-qr').getAttribute('src'),addresses['2'].qr);
 assert.equal(await dialog.locator('[data-deposit-form]').count(),0,'Ethereum receipt reconciliation must follow the selected blockchain');
 await dialog.getByRole('button',{name:'Read blockchain balance',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('dialog[open] [data-balance-result]')?.textContent.startsWith('Blockchain: 987.654321 USDC'));
 const solanaQr=await dialog.locator('.crypto-qr').getAttribute('src');
 await dialog.locator('select[data-receive-network]').selectOption('ETHEREUM');
 await page.waitForFunction(address=>document.querySelector('dialog[open] .crypto-receive code')?.textContent===address,addresses['1'].public_address);
 assert.equal(await page.locator('dialog[open]').count(),1,'switching QR networks must replace contents without nesting dialogs');
 assert.equal(await dialog.locator('select[data-receive-network]').inputValue(),'ETHEREUM');
 assert.equal(await dialog.locator('.crypto-qr').getAttribute('src'),addresses['1'].qr);
 assert.notEqual(await dialog.locator('.crypto-qr').getAttribute('src'),solanaQr,'the QR must encode the selected network address');
 assert.equal(await dialog.locator('[data-deposit-form]').count(),1);
 await dialog.getByRole('button',{name:'Read blockchain balance',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('dialog[open] [data-balance-result]')?.textContent.startsWith('Blockchain: 123.456789 USDC'));
 const reads=calls.slice(start).filter(c=>c.url==='/api/crypto/balance');
 assert.deepEqual(reads.map(c=>c.body),[{addressId:'2',assetId:'asset-usdc'},{addressId:'1',assetId:'asset-usdc'}]);
 const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1,'the network-aware receiving popup must fit the viewport');
 await mkdir('test-results',{recursive:true});
 await page.screenshot({path:'test-results/crypto-networks-'+width+'.png',fullPage:false});
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-wallet="wallet-usdc-ethereum"] dd')?.textContent==='123.456789');
 assert.equal(await network.inputValue(),'ETHEREUM','QR selection must update the same currency tile selection');
 await sendSelected('wallet-usdc-ethereum','ETHEREUM');
 const tile=await usdc.evaluate(element=>{const card=element.getBoundingClientRect(),select=element.querySelector('[data-wallet-network]').getBoundingClientRect();return {width:element.clientWidth,scroll:element.scrollWidth,left:card.left,right:card.right,selectLeft:select.left,selectRight:select.right};});
 assert.ok(tile.scroll<=tile.width+1,'the currency tile must contain its selector without overflow');
 assert.ok(tile.selectLeft>=tile.left-1&&tile.selectRight<=tile.right+1,'the blockchain dropdown must stay within the tile');
 assert.equal(calls.slice(start).filter(c=>c.url==='/api/crypto/activate').length,0,'switching existing chains must not create another currency activation');
}

async function verifyCurrencyActivation(page,width){
 const start=calls.length;
 await page.getByRole('button',{name:'Add accepted currency',exact:true}).click();
 const dialog=page.locator('dialog[open]');
 await dialog.getByRole('heading',{name:'Add accepted currency',exact:true}).waitFor();
 assert.equal(await dialog.locator('select[name=network]').count(),0,'currency activation must not require a per-chain creation step');
 await dialog.getByLabel('Account holder',{exact:true}).selectOption('1');
 await dialog.getByLabel('Currency',{exact:true}).selectOption('asset-dai');
 const included=await dialog.locator('[data-included-networks]').textContent();
 assert.match(included,/Ethereum/i);assert.match(included,/Polygon/i);assert.doesNotMatch(included,/Solana/i,'only approved blockchains belong to activation');
 await mkdir('test-results',{recursive:true});
 await page.screenshot({path:'test-results/crypto-activation-'+width+'.png',fullPage:false});
 await Promise.all([
  page.waitForResponse(response=>response.url()===base+'/api/crypto/activate'),
  dialog.locator('button[type=submit]').click()
 ]);
 const dai=page.locator('article[data-wallet-group]').filter({hasText:'Dai'});await dai.waitFor();
 assert.equal(await dai.count(),1,'one currency activation must produce one Dai tile');
 assert.equal(await page.locator('article[data-wallet-group]').count(),3);
 assert.deepEqual(await dai.locator('select[data-wallet-network] option').evaluateAll(options=>options.map(o=>o.value).filter(Boolean)),['ETHEREUM','POLYGON']);
 const activations=calls.slice(start).filter(c=>c.url==='/api/crypto/activate');
 assert.equal(activations.length,1,'activate the currency with one request for all approved chains');
 assert.deepEqual(activations[0].body,{assetId:'asset-dai',userId:'1'});assert.match(activations[0].key,/^[0-9a-f-]{36}$/i);
 assert.equal(await page.locator('dialog[open]').count(),0);
 const usdc=page.locator('article[data-wallet-group]').filter({hasText:'USD Coin'});
 assert.equal(await usdc.count(),1);assert.equal(await usdc.getAttribute('data-wallet'),'wallet-usdc-ethereum');
 assert.equal(await usdc.locator('dd').first().textContent(),'123.456789','activating another currency must retain existing balances and selected accounts');
}

for(const width of [2560,1440,834,390])test('real banking shell fits crypto scrollers, asset details and receiving receipt at '+width,async()=>{
 const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.route('**/*',route=>{
   const url=route.request().url();if(url.startsWith(base+'/')||url.startsWith('data:')||url.startsWith('blob:'))return route.continue();
   errors.push('Unexpected external request: '+new URL(url).origin);return route.abort();
  });
  await page.goto(base);
  await page.getByRole('heading',{name:'AVISPay PLC · Asset contents & conversion'}).waitFor();
  await page.getByRole('textbox',{name:'Analysis instructions',exact:true}).waitFor();
  assert.equal(await page.locator('textarea[name=instructions]').count(),1);
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
  await verifyGroupedCurrency(page,width);
  await verifyCurrencyActivation(page,width);
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
