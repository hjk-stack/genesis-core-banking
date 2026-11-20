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
const robotId='10000000-0000-4000-8000-000000000001',configurationHash='a'.repeat(64);
const replayDataset={ticks:[{tsMicros:1000000,bid:99,ask:100,bidSize:5,askSize:5,sellVolume:0},{tsMicros:2000000,bid:100,ask:101,bidSize:5,askSize:5,sellVolume:1}],indices:[]};
let testRuns=[],testReads=0,reviewedRunId=null;
const execution=(id,side='BUY')=>({id,orderId:'recorded-'+id,side,quantity:'0.123456789012345678',price:'100',quoteValue:'12.3456789012345678',fees:[{asset:'CHF',amount:'0.000000000000000001'}],executedAt:null,recordedAt:new Date().toISOString(),evidence:'AVIS_LEDGER'});
let liveFills=[],instructionVersion=1,savedInstructionVersion=0,robotInstructions='',backingReads=0;
const fixtureBook={kind:'AVIS_ORDER_BOOK',observedAt:verifiedAt,securityId:'security-1',baseAsset:'aAVISP',quoteAsset:'CHF',quoteBasis:'CURRENCY',denomination:'1',complete:true,totalOrders:1,bids:[{price:'100',quantity:'5',quoteValue:'500',orders:1}],asks:[],lots:[{orderId:'whole-lot-1',side:'BUY',quantity:'5',price:'100',quoteValue:'500',submittedAt:verifiedAt,reservationConsistent:true}],wholeLotsOnly:true,reservationBasis:'BUY cash hold; SELL aggregate reserved securities consistency.',securityTokens:[{cardId:'registered-card-1',name:'AVISPay PLC',symbol:'aAVISP',network:'ETHEREUM',state:'BOOKED',contractAddress:'0x1111111111111111111111111111111111111111',hubAddress:'0x2222222222222222222222222222222222222222',registeredTokenQuantity:'1000000.123456789012345678',reservedSourceQuantity:'1000000',registeredAt:verifiedAt,liquidityType:'SECURITY_REGISTER'}]};
const liveSnapshot=()=>({schemaVersion:1,observedAt:new Date().toISOString(),profiles:[{robotId,name:'Treasury W-effect',venue:'AVIS',symbol:'aAVISP',indexId:'aAVISP',baseAsset:'aAVISP',quoteAsset:'CHF',enabled:false,testReviewed:!!reviewedRunId}],selectedRobotId:robotId,market:{provider:'AVIS',symbolId:'aAVISP',baseAsset:'aAVISP',quoteAsset:'CHF',quote:{bid:'100.123456789012345678',ask:'101.123456789012345678',bidSize:'123.456789012345678',askSize:'234.567890123456789',exchangeTime:verifiedAt,providerTime:verifiedAt,receivedAt:verifiedAt,ageMs:0,sourceDelayMs:0,stale:false},trades:[],connection:{state:'OPEN',lastMessageAt:verifiedAt,errorCode:null}},audit:{coverage:{scope:'ALL_RECORDED_ORDERS',complete:true,totalOrders:liveFills.length,ordersIncluded:liveFills.length,from:verifiedAt,to:verifiedAt},orders:liveFills.map(fill=>({id:fill.orderId,side:fill.side,status:'SETTLED',requestedQuantity:fill.quantity,executedQuantity:fill.quantity,quoteValue:fill.quoteValue,averagePrice:fill.price,createdAt:fill.recordedAt,recordedAt:fill.recordedAt,executedAt:fill.executedAt})),fills:liveFills,totals:{baseVolume:'1234.123456789012345678',quoteVolume:'123456.123456789012345678',buyQuantity:'1233',sellQuantity:'1.123456789012345678',buyQuoteValue:'123300',sellQuoteValue:'156.123456789012345678',executedOrders:liveFills.length,buyExecutions:1,sellExecutions:liveFills.length-1,fees:[{asset:'CHF',amount:'0.123456789012345678'}],recordedRealisedPnl:'1.123456789012345678',knownFeeAdjustedPnl:'1.123456789012345678',grossRealisedPnl:'1.246913578024691356',netRealisedPnl:'1.123456789012345678',netPnlComplete:true,unpricedFeeAssets:[],positionQuantity:'1231.876543210987654322',costBasis:'100000.123456789012345678',unrealisedPnl:null},reconciliation:{positionMatches:true,costBasisMatches:true,realisedPnlMatches:true},issues:[]},liquidity:fixtureBook});
const testReport=mode=>({schemaVersion:1,engine:'NautilusTrader',engineVersion:'1.231.0',mode,status:'PASSED',complete:true,checks:[{id:'round-trip',label:'Buy, sell and close the position',passed:true,detail:'Virtual orders are bounded by the saved profile and the position ends flat.'}],metrics:{initialCash:'10000',finalCash:'10001.123456789012345678',finalEquity:'10001.123456789012345678',realisedPnl:'1.123456789012345678',unrealisedPnl:'0',costBasis:'0',fees:'0.2',finalPosition:'0',drawdown:'0.1',drawdownFraction:'0.00001',filledOrders:2,buyFills:1,sellFills:1,ticksProcessed:250,indexObservationsUsed:1,ordersGenerated:2,rejectedOrders:0,partialFills:0,openOrders:0,duplicateSignalsIgnored:0},orders:[{id:'virtual-order-'+configurationHash,signalId:'signal-1',tsMicros:1000000,side:'BUY',requestedQuantity:'1',limitPrice:'100',filledQuantity:'1',status:'FILLED',reason:null,type:'LIMIT',timeInForce:'IOC'}],fills:[{orderId:'virtual-order-'+configurationHash,tsMicros:1000000,side:'BUY',quantity:'1',price:'100',notional:'100',fee:'0.1',cashAfter:'9899.9',positionAfter:'1'}],assumptions:{referenceSettings:{initialCash:'10000',feeBps:10,slippageBps:5}}});
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
  if(req.url==='/'){wallets=initialWallets.map(w=>({...w}));testRuns=[];testReads=0;reviewedRunId=null;backingReads=0;liveFills=[execution('first-fill')];instructionVersion=1;savedInstructionVersion=0;robotInstructions=JSON.stringify({maxNotional:'100',dailyNotional:'1000',maxLoss:'100',minimumIndex:0,trailingBps:50,notes:'Follow the saved W-effect configuration.'},null,2);res.setHeader('content-type','text/html');return res.end(html);}
  if(req.url==='/fixture.mjs'){res.setHeader('content-type','text/javascript');return res.end(fixtureScript);}
  const json=v=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(v));};
  if(req.url==='/api/crypto/trading/index-policy')return json({policyVersion:1,instructions:'Use official announcements and retain unknown values as null.',taxonomy:[{id:'EQ01',label:'Major contracts'}]});
  if(req.method==='GET'&&req.url.startsWith('/api/crypto/trading/live/liquidity')){backingReads++;return json({schemaVersion:1,robotId,observedAt:verifiedAt,cards:[{cardId:'registered-card-1',name:'AVISPay PLC',symbol:'aAVISP',network:'ETHEREUM',contractAddress:fixtureBook.securityTokens[0].contractAddress,errorCode:null,chain:{proof:{finalized:true,canonicalRechecked:true,blockNumber:24000000,blockHash:'0x'+'a'.repeat(64),blockTime:verifiedAt},identity:{operator:'0x3333333333333333333333333333333333333333',contractAddress:fixtureBook.securityTokens[0].contractAddress,hubAddress:fixtureBook.securityTokens[0].hubAddress,isin:'CH0000000001'},security:{totalSupply:'1000000.123456789012345678',custodyCap:'2000000',bridgedOutSupply:'0',lockedMarginCollateral:'100',committedSecurityAmount:'90',committedMarginPower:'90',availableTradingPower:'10.123456789012345678',capacityCurrency:'CHF',capacityBasis:'CONFIGURED_COLLATERAL_VALUATION'},settlement:[{asset:'AG',escrow:'1.123456789012345678',accumulatedFees:'0.01',contractBalance:'2',operatorBalance:'3',operatorAllowance:'4',escrowCovered:true},{asset:'AGi',escrow:'5.123456789012345678',accumulatedFees:'0.02',contractBalance:'6',operatorBalance:'7',operatorAllowance:'8',escrowCovered:true}],treasury:{address:'0x3333333333333333333333333333333333333333',isOperator:true}}}]});}
  if(req.method==='GET'&&req.url.startsWith('/api/crypto/trading/live'))return json(liveSnapshot());
  if(req.method==='GET'&&req.url.startsWith('/api/crypto/trading/robot-instructions'))return json({robotId,version:instructionVersion,instructionVersion:savedInstructionVersion,instructions:robotInstructions,updatedAt:savedInstructionVersion?verifiedAt:null});
  if(req.url==='/api/crypto/trading/testing'){
   if(testRuns.some(run=>run.status==='RUNNING')&&++testReads>=2)for(const run of testRuns.filter(run=>run.status==='RUNNING'))Object.assign(run,{status:'PASSED',completedAt:verifiedAt,report:testReport(run.mode),reviewEligible:run.mode==='REPLAY'&&!!run.robotId});
   return json({engine:{name:'NautilusTrader',version:'1.231.0',fingerprint:configurationHash},profiles:[{robotId,name:'Treasury W-effect',venue:'AVIS',symbol:'aAVISP',configurationHash,reviewedRunId,testReviewed:!!reviewedRunId}],runs:testRuns,limits:{maxTicks:10000,maxIndices:10000,maxInputBytes:2097152,maxReportBytes:2097152}});
  }
  if(req.url.startsWith('/api/views/'))return json({rows:({
   cryptocatalogue:catalogue,cryptomarkets:catalogue,cryptosecurities:cards,
   cryptowallets:wallets,
   tradingrobots:[{robot_id:robotId,name:'Treasury W-effect',venue:'AVIS',symbol:'aAVISP',enabled:false,position_quantity:'0',cost_basis:'0',realized_pnl:'0',quote_asset:'CHF',stop_price:null,max_notional:'100',daily_notional:'1000'}],tradingengine:[{ready:true,startedAt:verifiedAt}],
   cryptonetworks:[{name:'Ethereum',code:'ETHEREUM',kind:'EVM'},{name:'Solana',code:'SOLANA',kind:'SOLANA'},{name:'Polygon',code:'POLYGON',kind:'EVM'},{name:'BNB Smart Chain',code:'BSC',kind:'EVM'}],customers:[{user_id:'1',full_name:'AVISPay PLC',account_role:'INSTITUTION'}]
  })[req.url.split('/').at(-1)]||[]});
  if(req.url.startsWith('/api/crypto/securities/000'))return json({...cards.find(c=>req.url.endsWith(c.card_id)),actions:[],sourceSpecification:'v3.0'});
  if(req.method==='POST'){
   let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push({url:req.url,body,key:req.headers['idempotency-key']});
   if(req.url==='/api/crypto/trading/robot-instructions'){
    if(body.robotId!==robotId||body.expectedVersion!==instructionVersion){res.statusCode=409;return json({error:'Instruction version changed.'});}robotInstructions=body.instructions;instructionVersion++;savedInstructionVersion++;reviewedRunId=null;return json({robotId,version:instructionVersion,instructionVersion:savedInstructionVersion,instructions:robotInstructions,updatedAt:verifiedAt,enabled:false});
   }
   if(req.url==='/api/crypto/trading/tests'){
    const runId='20000000-0000-4000-8000-'+String(testRuns.length+1).padStart(12,'0');testReads=0;testRuns.unshift({runId,robotId:body.robotId||null,profileName:body.robotId?'Treasury W-effect':null,mode:body.mode,status:'RUNNING',configurationHash,engineFingerprint:configurationHash,datasetHash:configurationHash,createdAt:verifiedAt,startedAt:verifiedAt,completedAt:null,report:null,errorCode:null,reviewEligible:false,reviewedAt:null});return json({runId,status:'QUEUED'});
   }
   if(req.url==='/api/crypto/trading/tests/review'){
    const run=testRuns.find(run=>run.runId===body.runId);if(!run?.reviewEligible){res.statusCode=422;return json({error:'Test review does not qualify.'});}run.reviewedAt=verifiedAt;reviewedRunId=run.runId;return json({runId:run.runId,robotId,testReviewed:true,reviewedAt:verifiedAt});
   }
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
  if(['/treasury-source.mjs','/crypto-workspace.mjs','/wallet-trading-scroller.mjs','/wallet-trading-scroller.css','/trading-panel.mjs','/approved-robot.mjs','/approved-robot.css','/trading-testing.mjs','/trading-live.mjs','/index-advice.mjs','/crypto.css','/styles.css','/crypto-icons/ag.png','/crypto-icons/agi.png','/crypto-icons/avispay.webp','/crypto-icons/robot-approved.jpg'].includes(req.url)){
   res.setHeader('content-type',req.url.endsWith('.jpg')?'image/jpeg':req.url.endsWith('.webp')?'image/webp':req.url.endsWith('.png')?'image/png':req.url.endsWith('.css')?'text/css':'text/javascript');
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
 assert.equal(await usdc.locator('dd').nth(0).textContent(),'121.456789');
 assert.equal(await usdc.locator('dd').nth(1).textContent(),'2');
 await network.selectOption('SOLANA');
 await page.waitForFunction(()=>document.querySelector('[data-wallet="wallet-usdc-solana"] dd')?.textContent==='980.654321');
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
 assert.equal(await dialog.locator('[data-chain-balance]').count(),0);
 const solanaQr=await dialog.locator('.crypto-qr').getAttribute('src');
 await dialog.locator('select[data-receive-network]').selectOption('ETHEREUM');
 await page.waitForFunction(address=>document.querySelector('dialog[open] .crypto-receive code')?.textContent===address,addresses['1'].public_address);
 assert.equal(await page.locator('dialog[open]').count(),1,'switching QR networks must replace contents without nesting dialogs');
 assert.equal(await dialog.locator('select[data-receive-network]').inputValue(),'ETHEREUM');
 assert.equal(await dialog.locator('.crypto-qr').getAttribute('src'),addresses['1'].qr);
 assert.notEqual(await dialog.locator('.crypto-qr').getAttribute('src'),solanaQr,'the QR must encode the selected network address');
 assert.equal(await dialog.locator('[data-chain-balance],[data-deposit-form]').count(),0);
 assert.equal(calls.slice(start).filter(c=>c.url==='/api/crypto/balance').length,0);
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await usdc.getByRole('button',{name:'Wallet activity for USDC',exact:true}).click();
 await dialog.locator('select[data-receive-network]').selectOption('SOLANA');
 await dialog.getByRole('button',{name:'Read blockchain balance',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('dialog[open] [data-balance-result]')?.textContent.startsWith('Blockchain: 987.654321 USDC'));
 await dialog.locator('select[data-receive-network]').selectOption('ETHEREUM');
 assert.equal(await dialog.locator('[data-deposit-form]').count(),1);
 await dialog.getByRole('button',{name:'Read blockchain balance',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('dialog[open] [data-balance-result]')?.textContent.startsWith('Blockchain: 123.456789 USDC'));
 const reads=calls.slice(start).filter(c=>c.url==='/api/crypto/balance');
 assert.deepEqual(reads.map(c=>c.body),[{addressId:'2',assetId:'asset-usdc'},{addressId:'1',assetId:'asset-usdc'}]);
 const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1,'the network-aware receiving popup must fit the viewport');
 await mkdir('test-results',{recursive:true});
 await page.screenshot({path:'test-results/crypto-networks-'+width+'.png',fullPage:false});
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-wallet="wallet-usdc-ethereum"] dd')?.textContent==='121.456789');
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
 await dialog.getByLabel('Currency',{exact:true}).selectOption('asset-dai', {force:true});
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
 assert.equal(await usdc.locator('dd').first().textContent(),'121.456789','activating another currency must retain existing balances and selected accounts');
}

async function verifyTradingTests(page,width){
 await page.locator('.trading-advanced').evaluate(panel=>{panel.open=true;});
 const mark=calls.length,lab=page.locator('.trading-testing'),start=page.getByRole('button',{name:'Start live trading',exact:true});
 await lab.getByRole('heading',{name:'Trading tests',exact:true}).waitFor();
 assert.equal(await start.isDisabled(),true,'unreviewed robots cannot start live trading');
 assert.equal(await lab.getByRole('textbox',{name:'Virtual funds',exact:true}).isDisabled(),true,'acceptance uses fixed reference funds');
 await lab.getByRole('button',{name:'Run acceptance suite',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-test-result]')?.textContent==='Running');
 await page.waitForFunction(()=>document.querySelector('[data-test-result]')?.textContent==='Passed');
 assert.equal(await lab.locator('[data-review-test]').count(),0,'acceptance never qualifies a live robot for review');
 assert.equal(await start.isDisabled(),true);
 const acceptance=calls.slice(mark).filter(call=>call.url==='/api/crypto/trading/tests');
 assert.equal(acceptance.length,1);assert.deepEqual(acceptance[0].body,{mode:'ACCEPTANCE',initialCash:'10000',feeBps:10,slippageBps:5});
 await lab.getByLabel('Test configuration',{exact:true}).selectOption(robotId);
 await lab.getByLabel('Test mode',{exact:true}).selectOption('REPLAY');
 assert.equal(await lab.getByRole('textbox',{name:'Virtual funds',exact:true}).isDisabled(),false);
 await lab.getByLabel('Replay JSON',{exact:true}).setInputFiles({name:'market-replay.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(replayDataset))});
 await page.waitForFunction(()=>document.querySelector('[data-replay-file]')?.textContent.includes('2 ticks'));
 await lab.getByRole('button',{name:'Run market replay',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-test-result]')?.textContent==='Running');
 await page.waitForFunction(()=>document.querySelector('[data-test-result]')?.textContent==='Passed');
 const replays=calls.slice(mark).filter(call=>call.url==='/api/crypto/trading/tests'&&call.body.mode==='REPLAY');
 assert.equal(replays.length,1);assert.deepEqual(replays[0].body,{robotId,mode:'REPLAY',initialCash:'10000',feeBps:10,slippageBps:5,dataset:replayDataset});assert.match(replays[0].key,/^[a-f0-9-]{36}$/i);
 assert.equal(await start.isDisabled(),true,'passing without review still cannot enable live start');
 assert.match(await lab.locator('[data-test-report]').textContent(),/10,001\.123456789012345678/);
 await lab.getByRole('button',{name:'Mark replay reviewed',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-toggle]')?.disabled===false);
 assert.equal(calls.slice(mark).filter(call=>call.url==='/api/crypto/trading/tests/review').length,1);
 assert.equal(calls.slice(mark).some(call=>/crypto\/trading\/(toggle|order|validate-providers)/.test(call.url)),false,'test and review must not call live trading APIs');
 assert.equal(await lab.locator('[data-test-history-count]').textContent(),'2');assert.equal(await page.locator('dialog[open]').count(),0,'the test lab must stay in the page');
 await lab.locator('.trading-test-records details').nth(0).locator('summary').click();
 await lab.locator('.trading-test-records details').nth(1).locator('summary').click();
 assert.equal(await lab.locator('.trading-test-table tbody tr').count(),2);
 const bounds=await lab.evaluate(element=>({page:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth,width:element.clientWidth,scroll:element.scrollWidth,fields:[...element.querySelectorAll('input,select')].filter(field=>field.getClientRects().length).map(field=>{const fieldBox=field.getBoundingClientRect(),box=element.getBoundingClientRect();return {left:fieldBox.left,right:fieldBox.right,parentLeft:box.left,parentRight:box.right};})}));
 assert.ok(bounds.page<=bounds.viewport,'test reports must not widen the banking page');assert.ok(bounds.scroll<=bounds.width+1,'report and form contents must fit the test lab');assert.ok(bounds.fields.every(field=>field.left>=field.parentLeft&&field.right<=field.parentRight),'test controls must fit the lab');
 await lab.locator('[data-test-report]').getByRole('heading',{name:'Virtual funds & results',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:'test-results/crypto-trading-tests-'+width+'.png',fullPage:false});
}

async function verifyLiveTrading(page,width){
 const mark=calls.length,live=page.locator('.trading-live'),instructions=page.locator('.trading-instructions-grid');
 await page.waitForFunction(()=>document.querySelector('[data-live-quote]')?.textContent.includes('100.123456789012345678 CHF'));
 await page.waitForFunction(()=>document.querySelector('[data-robot-instruction-form] textarea')?.disabled===false);
 assert.equal(await live.locator('[data-robot-activity]').getAttribute('data-robot-activity'),'','reading existing fills must not animate a new trade');
 assert.equal(await live.locator('.ar-robot-image').count(),1);await page.waitForFunction(()=>document.querySelector('.ar-robot-image')?.naturalWidth===891);assert.equal(await instructions.locator('textarea').count(),2);
 assert.match(await live.locator('[data-live-audit]').textContent(),/1,234\.123456789012345678 aAVISP/);assert.match(await live.locator('[data-live-audit]').textContent(),/Net realised profit1\.123456789012345678 CHF/);assert.match(await live.locator('[data-live-audit]').textContent(),/Fees by currency0\.123456789012345678 CHF/);assert.doesNotMatch(await live.textContent(),/Virtual funds|Acceptance suite/);
 if(width===390)await page.emulateMedia({reducedMotion:'reduce'});
 liveFills.unshift(execution('new-sell-'+width,'SELL'));
 await live.getByRole('button',{name:'Refresh trading data',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-robot-activity]')?.dataset.robotActivity==='SELL');
 if(width===390)assert.equal(await live.locator('.ar-robot-image').evaluate(element=>getComputedStyle(element).animationName),'none','reduced motion keeps a static real-event indication');
 await live.getByRole('button',{name:'Sell executions',exact:true}).click();
 assert.equal(await live.locator('[data-live-executions] tbody tr').count(),1);assert.match(await live.locator('[data-live-executions] tbody').textContent(),/SELL/);
 await live.getByRole('button',{name:'Focus latest execution',exact:true}).click();assert.equal(await live.locator('[data-live-executions] tbody tr').count(),2);assert.equal(await live.locator('[data-live-executions] tr.is-focused').getAttribute('data-execution-id'),'new-sell-'+width);
 assert.equal(backingReads,0,'ordinary live reads must not query finalized security backing');
 await live.locator('[data-live-liquidity]>summary').click();assert.equal(await live.locator('[data-live-book] [data-live-lots] tbody tr').count(),1);
 await live.getByRole('button',{name:'Read security backing',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-live-backing]')?.textContent.includes('Finalized checkpointYes'));
 assert.equal(backingReads,1);assert.equal(await live.locator('[data-live-backing] tbody tr').count(),2);assert.match(await live.locator('[data-live-backing]').textContent(),/Configured collateral valuation/);assert.match(await live.locator('[data-live-backing]').textContent(),/1\.123456789012345678/);assert.match(await live.locator('[data-live-backing]').textContent(),/5\.123456789012345678/);
 const layout=await page.evaluate(()=>{
  const live=document.querySelector('.trading-live'),robot=live.querySelector('.trading-live-robot').getBoundingClientRect(),screen=live.querySelector('.trading-live-screen').getBoundingClientRect(),fields=[...document.querySelectorAll('.trading-instructions-grid textarea')].map(element=>{const b=element.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:element.clientWidth,scroll:element.scrollWidth};});
  return {page:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth,liveWidth:live.clientWidth,liveScroll:live.scrollWidth,robot:{left:robot.left,right:robot.right,top:robot.top,bottom:robot.bottom},screen:{left:screen.left,right:screen.right,top:screen.top,bottom:screen.bottom},fields};
 });
 assert.ok(layout.page<=layout.viewport,'live execution tables and instruction columns must not widen the document');assert.ok(layout.liveScroll<=layout.liveWidth+1,'the live screen must contain its market and audit data');
 if(width>1000){assert.ok(layout.robot.right<=layout.screen.left,'the interactive robot belongs to the left of the market screen');assert.ok(layout.fields[0].right<=layout.fields[1].left,'INDEX and robot instruction fields must form two columns');}
 else{assert.ok(layout.robot.right<=layout.screen.left,'the approved trading board retains its left robot and right market panels');const viewport=await live.locator('.ar-viewport').evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth}));assert.ok(viewport.scroll>viewport.client,'tablet and phone scroll the terminal, not the whole page');assert.ok(layout.fields[0].bottom<=layout.fields[1].top,'instruction fields must stack without overlap');}
 await live.locator('.trading-live-workspace').screenshot({path:'test-results/crypto-live-trader-'+width+'.png'});
 await instructions.screenshot({path:'test-results/crypto-trader-instructions-'+width+'.png'});
 await live.locator('[data-live-liquidity]').screenshot({path:'test-results/crypto-security-backing-'+width+'.png'});assert.equal(backingReads,1,'background market refresh must not repeat the explicit chain audit');
 const field=instructions.getByRole('textbox',{name:'Execution instructions',exact:true}),updated=JSON.parse(await field.inputValue());updated.maxNotional='75.123456789';updated.notes='Review recorded executions and fees.';await field.fill(JSON.stringify(updated,null,2));
 assert.equal(await instructions.locator('[data-robot-instruction-version]').textContent(),'Not saved · configuration v1');
  await instructions.getByRole('button',{name:'Save first instruction version',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-robot-instruction-version]')?.textContent==='Saved instructions v1 · configuration v2');
 assert.equal(await page.getByRole('button',{name:'Start live trading',exact:true}).isDisabled(),true,'saved instruction changes must close the replay gate');
 const writes=calls.slice(mark);assert.equal(writes.length,1);assert.equal(writes[0].url,'/api/crypto/trading/robot-instructions');assert.equal(writes[0].body.robotId,robotId);assert.equal(writes[0].body.expectedVersion,1);assert.equal(JSON.parse(writes[0].body.instructions).maxNotional,'75.123456789');assert.match(writes[0].key,/^[a-f0-9-]{36}$/i);
 assert.equal(await page.locator('dialog[open]').count(),0);await page.emulateMedia({reducedMotion:'no-preference'});
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
  await page.locator('.trading-advanced').evaluate(el=>{el.open=true;});
  await page.getByRole('textbox',{name:'Analysis instructions',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-run-test]')?.disabled===false);
  assert.equal(await page.locator('[data-index-policy] textarea[name=instructions]').count(),1);assert.equal(await page.locator('[data-robot-instruction-form] textarea[name=instructions]').count(),1);
  assert.equal(await page.locator('[data-security]').count(),10,'the AVISPay security and nine requested demo wallets remain in the row');
  assert.equal(await page.locator('[data-security] strong').first().textContent(),'AVISPay PLC');
  assert.equal(await page.locator('[data-stock-convert],.crypto-stock-register').count(),0,'the removed Treasury strip stays absent');
  assert.equal(await page.locator('[data-real-prepare]').count(),1,'the selected security keeps its conversion action');
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
  await page.locator('[data-wallet]').first().click({button:'right',position:{x:12,y:12}});
  const delegation=page.locator('.wallet-trading-popup');
  await delegation.waitFor();
  assert.match(await delegation.textContent(),/automated algorithmic trading using the designated portion/);
  const allocation=delegation.getByRole('textbox',{name:'Designated trading quantity'});
  const agreement=delegation.locator('[data-consent]');
  const freeze=delegation.getByRole('button',{name:'Freeze & Authorize Robot'});
  assert.equal(await freeze.isDisabled(),true);
  await allocation.fill('1.25');
  assert.equal(await agreement.isEnabled(),true);
  await agreement.check();
  assert.equal(await allocation.getAttribute('readonly'),'');
  assert.equal(await freeze.isEnabled(),true);
  await delegation.getByRole('button',{name:'Cancel'}).click();
  assert.equal(await page.locator('.wallet-trading-popup').count(),0);


  await page.getByRole('button',{name:'Receive AG',exact:true}).click();
  await page.locator('.crypto-qr').waitFor();
  const d=page.locator('dialog[open]');
  assert.equal(await d.evaluate(e=>e.parentElement.tagName),'BODY');
  assert.equal(await d.getByRole('button',{name:'Close',exact:true}).count(),1);
  const b=await d.boundingBox();assert.ok(b.x>=0&&b.x+b.width<=width+1);
  assert.equal(await d.locator('[data-chain-balance],[data-deposit-form]').count(),0);
  await d.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Wallet activity for AG',exact:true}).click();
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
  await verifyTradingTests(page,width);
  await verifyLiveTrading(page,width);
  assert.equal(await page.locator('[data-security]').count(),10,'the security scroller retains all ten requested wallets');
  assert.equal(await page.locator('[data-security] strong').first().textContent(),'AVISPay PLC');
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
