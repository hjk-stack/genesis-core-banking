import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';

let server,browser,base;
const cases=new Map();
const BOOKING='31000000-0000-4000-8000-000000000001';
const SECURITY='32000000-0000-4000-8000-000000000001';
const POSITION='33000000-0000-4000-8000-000000000001';
const CARD='34000000-0000-4000-8000-000000000001';
const ADDRESS='0x'+'1'.repeat(40);
const source=Object.freeze({booking_id:BOOKING,owner_user_id:'1',asset_class:'SECURITY',asset_code:'AVISPAY-PLC-SHARES',
 asset_name:'AVISPay PLC shares',isin:null,quantity:'100000000.000000000000000000',
 source_system:'ISOLATED_BROWSER_FIXTURE',source_reference:'AVISPAY-PLC-RECORDED-SOURCE',destination:'TREASURY_PORTFOLIO'});
const card=Object.freeze({card_id:CARD,sort_order:1,name:'AVISPay PLC',symbol:'aAVISP',mode:'DEMO',state:'DRAFT',
 token_quantity:'0',user_id:'1',network:'ETHEREUM',wallet_address_id:'51',wallet_public_address:ADDRESS,
 dossier:{assetType:'STOCK',marginHaircutBps:1500,tradingFeeBps:10},actions:[],sourceSpecification:'Isolated registered-source fixture'});
const createCase=()=>({securities:[],positions:[],writes:[],unexpected:[]});
function sourceHolding(state){
 const position=state.positions[0],security=state.securities[0];
 return {bookingId:BOOKING,positionId:position?.position_id||null,securityId:position?.security_id||null,userId:'1',
  name:source.asset_name,quantity:source.quantity,assetType:'STOCK',isin:position?security.isin:null,cusip:position?security.cusip:null,
  currency:position?security.currency_code:null,price:position?position.market_price:null,
  assetValue:position?'275000000.000000000000000000':null,reference:source.source_reference,
  source:position?'Portfolio Management':'Portfolio Management / Treasury register'};
}
const script=`
 import {createCryptoWorkspace} from '/crypto-workspace.mjs';
 document.querySelector('#signin').hidden=true;
 document.querySelector('#workspace').hidden=false;
 const api=async(path,body,key)=>{
  const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',
   headers:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},
   body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok)throw Object.assign(new Error(result.message||'Fixture request failed'),result);
  return result;
 };
 window.fixtureWorkspace=createCryptoWorkspace({api,identity:()=>({admin:true}),
  purchase(){throw Error('Unexpected purchase');},sell(){throw Error('Unexpected sale');},send(){throw Error('Unexpected transfer');},notice(){}});
 await window.fixtureWorkspace.mount(document.querySelector('#view'));
`;

before(async()=>{
 const html=(await readFile(new URL('../index.html',import.meta.url),'utf8')).replace('src="/app.mjs"','src="/fixture.mjs"');
 server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture.invalid');
  const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
  try{
   if(url.pathname==='/'){
    const id=url.searchParams.get('case');cases.set(id,createCase());
    res.setHeader('Set-Cookie','source_fixture='+id+'; SameSite=Strict; Path=/');
    res.setHeader('content-type','text/html');return res.end(html);
   }
   if(url.pathname==='/fixture.mjs'){res.setHeader('content-type','text/javascript');return res.end(script);}
   const id=/(?:^|;\s*)source_fixture=([^;]+)/.exec(req.headers.cookie||'')?.[1],state=cases.get(id);
   if(url.pathname.startsWith('/api/')&&!state){res.statusCode=400;return json({message:'Missing isolated fixture'});}
   if(req.method==='POST'){
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw);state.writes.push({path:url.pathname,input,key:req.headers['idempotency-key']});
    if(url.pathname==='/api/portfolio/securities'){
     state.securities=[{security_id:SECURITY,name:input.name,short_name:input.shortName,currency_code:input.currency,
      isin:input.isin,cusip:input.cusip,kind:input.kind,denomination:input.denomination,quote_basis:input.quoteBasis,quantity_decimals:input.quantityDecimals}];
     return json({id:SECURITY});
    }
    if(url.pathname==='/api/portfolio/treasury-source'){
     if(input.bookingId!==BOOKING||input.securityId!==SECURITY){res.statusCode=422;return json({message:'Select the exact recorded source.'});}
     state.positions=[{position_id:POSITION,security_id:SECURITY,user_id:'1',full_name:'AVISPay PLC',account_role:'INSTITUTION',
      name:source.asset_name,short_name:state.securities[0].short_name,currency_code:state.securities[0].currency_code,
      kind:'share',isin:state.securities[0].isin,cusip:state.securities[0].cusip,quantity:source.quantity,available_quantity:source.quantity,
      reserved_quantity:'0',issuing_price:input.issuingPrice,market_price:input.marketPrice,portfolio_value:'275000000.000000000000000000',
      treasury_booking_id:BOOKING,treasury_source_reference:source.source_reference}];
     return json({id:POSITION,positionId:POSITION,bookingId:BOOKING,securityId:SECURITY,quantity:source.quantity,created:true});
    }
    state.unexpected.push(url.pathname);res.statusCode=422;return json({message:'Unexpected write in source registration fixture.'});
   }
   if(url.pathname.startsWith('/api/views/'))return json({rows:({
    cryptosecurities:[card],securities:state.securities,securitypositions:state.positions,
    treasurypositions:[{...source,position_id:state.positions[0]?.position_id||null,security_id:state.positions[0]?.security_id||null}],
    customers:[{user_id:'1',full_name:'AVISPay PLC',account_role:'INSTITUTION'}],
    cryptonetworks:[{code:'ETHEREUM',name:'Ethereum',kind:'EVM'}],tradingengine:[]
   })[url.pathname.split('/').at(-1)]||[]});
   if(url.pathname==='/api/crypto/securities/'+CARD)return json({...card,sourceHolding:sourceHolding(state)});
   if(url.pathname==='/api/crypto/trading/index-policy')return json({policyVersion:0,instructions:'',taxonomy:[]});
   if(url.pathname==='/api/crypto/trading/testing')return json({engine:{name:'NautilusTrader',version:'1.231.0',fingerprint:'a'.repeat(64)},profiles:[],runs:[],limits:{}});
   if(url.pathname==='/api/crypto/trading/live')return json({schemaVersion:1,observedAt:new Date().toISOString(),profiles:[],selectedRobotId:null,market:null,audit:null,liquidity:null});
   if(/^\/[a-z][a-z0-9-]*\.(mjs|css)$/.test(url.pathname)||/^\/crypto-icons\/[a-z0-9-]+\.(png|webp|jpg)$/.test(url.pathname)){
    res.setHeader('content-type',url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.mjs')?'text/javascript':url.pathname.endsWith('.png')?'image/png':url.pathname.endsWith('.jpg')?'image/jpeg':'image/webp');
    return res.end(await readFile(new URL('../public'+url.pathname,import.meta.url)));
   }
   if(url.pathname.startsWith('/api/'))state.unexpected.push(url.pathname);
   res.statusCode=404;return res.end();
  }catch(error){res.statusCode=500;return json({message:error.message});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 await mkdir('test-results',{recursive:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

async function geometry(page,label){
 const measured=await page.locator('dialog.crypto-dialog[open]').evaluate(el=>{
  const r=el.getBoundingClientRect();
  return {parent:el.parentElement.tagName,count:document.querySelectorAll('dialog[open]').length,
   x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,
   clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,documentWidth:document.documentElement.scrollWidth,
   controls:[...el.querySelectorAll('input,select,button')].filter(control=>control.getClientRects().length).map(control=>{
    const b=control.getBoundingClientRect();return {name:control.name||control.textContent.trim(),x:b.x,right:b.right};
   })};
 });
 assert.equal(measured.parent,'BODY',label+': floating dialog must be attached to body');
 assert.equal(measured.count,1,label+': only one dialog may be open');
 assert.ok(measured.x>=0&&measured.right<=measured.width+1,label+': dialog fits horizontally');
 assert.ok(measured.y>=0&&measured.bottom<=measured.height+1,label+': dialog fits vertically with internal scrolling');
 assert.ok(measured.scrollWidth<=measured.clientWidth+1,label+': dialog has no horizontal clipping');
 assert.ok(measured.documentWidth<=measured.width+1,label+': page has no horizontal overflow');
 for(const control of measured.controls)assert.ok(control.x>=measured.x-1&&control.right<=measured.right+1,label+': '+control.name+' fits in dialog');
}

for(const width of [1440,834,390])test('recorded Treasury source registers through the real floating converter at '+width,async()=>{
 const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();
 const errors=[],external=[];page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',route=>{
  const url=route.request().url();
  if(new URL(url).origin===base)return route.continue();
  external.push(url);return route.abort();
 });
 try{
  await page.goto(base+'/?case='+width);
  const state=cases.get(String(width)),wallet=page.locator('[data-security="'+CARD+'"]');
  await wallet.locator('[data-security-details]').click();
  await page.getByRole('button',{name:'Register source holding',exact:true}).click();
  const dialog=()=>page.locator('dialog.crypto-dialog[open]');
  await dialog().locator('[name=securityId]').waitFor();
  await geometry(page,'empty source form '+width);
  assert.equal(await dialog().locator('[name=securityId] option').count(),1);
  assert.equal(await dialog().locator('[name=issuingPrice]').inputValue(),'');
  assert.equal(await dialog().locator('[name=marketPrice]').inputValue(),'');
  assert.match(await dialog().locator('[data-treasury-source]').textContent(),/100000000/);
  await dialog().getByRole('button',{name:'Close',exact:true}).click();
  assert.equal(await page.locator('dialog[open]').count(),0);assert.deepEqual(state.writes,[]);

  await page.getByRole('button',{name:'Register source holding',exact:true}).click();
  await dialog().locator('[data-source-add-security]').click();
  await dialog().locator('[name=shortName]').waitFor();
  await geometry(page,'security metadata form '+width);
  assert.equal(await dialog().locator('[name=name]').inputValue(),source.asset_name);
  assert.equal(await dialog().locator('[name=name]').getAttribute('readonly'),'');
  for(const name of ['currency','isin','cusip','denomination','quoteBasis','quantityDecimals'])assert.equal(await dialog().locator('[name='+name+']').inputValue(),'',name+' has no invented value');
  assert.equal(await dialog().locator('[name=kind]').inputValue(),'share');assert.equal(await dialog().locator('[name=kind]').isDisabled(),true);
  await dialog().locator('[name=shortName]').fill('AVISP');
  await dialog().locator('[name=currency]').selectOption('CHF');
  await dialog().locator('[name=isin]').fill('US0378331005');
  await dialog().locator('[name=denomination]').fill('1');
  await dialog().locator('[name=quoteBasis]').selectOption('UNIT');
  await dialog().locator('[name=quantityDecimals]').fill('0');
  await dialog().evaluate(el=>{el.scrollTop=0;});
  await page.screenshot({path:'test-results/treasury-source-metadata-'+width+'.png',fullPage:false});
  assert.deepEqual(state.writes,[],'typing metadata does not write until Save');
  await dialog().getByRole('button',{name:'Save security details',exact:true}).click();
  await page.waitForFunction(security=>document.querySelector('dialog[open] [name=securityId]')?.value===security,SECURITY);
  assert.equal(state.writes.length,1);assert.equal(state.positions.length,0);
  assert.equal(await dialog().locator('[name=issuingPrice]').inputValue(),'');assert.equal(await dialog().locator('[name=marketPrice]').inputValue(),'');
  await dialog().locator('[name=issuingPrice]').fill('1.25');
  await dialog().locator('[name=marketPrice]').fill('2.75');
  await dialog().evaluate(el=>{el.scrollTop=0;});
  await geometry(page,'priced source form '+width);
  await page.screenshot({path:'test-results/treasury-source-prices-'+width+'.png',fullPage:false});
  await dialog().getByRole('button',{name:'Register source holding',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('dialog[open]')&&document.querySelector('[data-real-prepare]')?.textContent==='Convert Portfolio security');
  assert.equal(state.positions.length,1);assert.equal(state.positions[0].quantity,source.quantity);
  assert.equal(state.positions[0].treasury_booking_id,BOOKING);
  const visible=await page.locator('.security-conversion > div').first().evaluate(el=>Object.fromEntries([...el.querySelectorAll('dt')].map(dt=>[dt.textContent,dt.nextElementSibling.textContent])));
  assert.equal(visible['Issued volume'],'100,000,000');assert.equal(visible['Value per token'],'2.75 CHF');
  assert.equal(visible['Custody reference'],source.source_reference);assert.equal(visible.ISIN,'US0378331005');
  await page.getByRole('button',{name:'Convert Portfolio security',exact:true}).click();
  await dialog().locator('[name=positionId]').waitFor();
  assert.equal(await dialog().locator('[name=positionId]').inputValue(),POSITION);
  assert.equal(await dialog().locator('[name=quantity]').inputValue(),source.quantity);
  assert.equal(await dialog().locator('[name=addressId]').inputValue(),'51');
  await geometry(page,'registered converter '+width);
  await dialog().getByRole('button',{name:'Close',exact:true}).click();
  assert.deepEqual(state.writes.map(write=>write.path),['/api/portfolio/securities','/api/portfolio/treasury-source']);
  assert.deepEqual(state.writes[0].input,{name:source.asset_name,shortName:'AVISP',currency:'CHF',isin:'US0378331005',cusip:'',denomination:'1',quoteBasis:'UNIT',quantityDecimals:0,kind:'share'});
  assert.deepEqual(state.writes[1].input,{bookingId:BOOKING,securityId:SECURITY,issuingPrice:'1.25',marketPrice:'2.75'});
  for(const write of state.writes)assert.match(write.key,/^[0-9a-f-]{36}$/);
  assert.equal(card.mode,'DEMO');assert.equal(card.state,'DRAFT');assert.equal(card.wallet_public_address,ADDRESS);
  assert.deepEqual(state.unexpected,[]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
