import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
let server,browser,base;const calls=[];
const security={security_id:'11111111-1111-4111-8111-111111111111',name:'Regression Green Bond',short_name:'REG GREEN 2036',isin:'US0378331005',cusip:'037833100',currency_code:'EUR',denomination:'1000.000000000000000000',quote_basis:'PERCENT',source:'GREEN_BOND',exchange_symbol:'REGRESSION',reference_price:'98'},position={...security,position_id:'22222222-2222-4222-8222-222222222222',user_id:'2',full_name:'Portfolio holder',quantity:'10',available_quantity:'10',reserved_quantity:'0',issuing_price:'100',market_price:'98',portfolio_value:'9800',version:1};
const account={account_id:'33333333-3333-4333-8333-333333333333',abiq_iban:'TN62AVIP000978000011000102',currency_code:'EUR',user_id:'2',full_name:'Portfolio holder',available_balance:'20000'},card={...account,card_id:'44444444-4444-4444-8444-444444444444',card_account_id:'55555555-5555-4555-8555-555555555555',card_number:'AVIS-TEST-1234',card_rail_mode:'AVIS_PROPRIETARY_ONLY',status:'ACTIVE'},cryptoHolding={...account,account_id:'66666666-6666-4666-8666-666666666666',currency_code:'AG',network:'ETHEREUM',available_balance:'10000'};
before(async()=>{
 server=http.createServer(async(req,res)=>{const json=v=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(v));};
  if(['/admin','/customer','/guest'].includes(req.url)){res.setHeader('set-cookie','fixture-role='+req.url.slice(1)+'; Path=/');res.setHeader('content-type','text/html');return res.end(await readFile(new URL('../index.html',import.meta.url)));}
  const admin=req.headers.cookie?.includes('fixture-role=admin');if(req.url==='/api/session'&&req.headers.cookie?.includes('fixture-role=guest')){res.statusCode=401;return json({message:'Sign in'});}
  if(req.url==='/api/session')return json({username:'fixture',csrf:'isolated',admin,customerUserId:admin?null:'2',canSwitchWorkspace:false});
  if(req.url.startsWith('/api/views/'))return json({rows:({securities:[security],securitypositions:[position],accountsummaries:[account],transfercards:[card],cryptoholdings:[cryptoHolding],customers:[{user_id:'2',full_name:'Portfolio holder'}],cryptooffers:[{offer_id:'77777777-7777-4777-8777-777777777777',asset:'AG',network:'ETHEREUM',fiat:'EUR',unit_price:'2'}]})[req.url.split('/').at(-1)]||[]});
  if(req.method==='POST'&&req.url.startsWith('/api/')){let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push({path:req.url,body});
   if(req.url==='/api/login'){res.setHeader('set-cookie','fixture-role=customer; Path=/');return json({username:'fixture',csrf:'isolated',admin:false,customerUserId:'2',canSwitchWorkspace:false});}
   if(req.url.endsWith('/review'))return json({id:'88888888-8888-4888-8888-888888888888',reviewHash:'review-fixture',instruction:{...body,name:security.name,shortName:security.short_name,isin:security.isin,cusip:security.cusip,currency:'EUR',quoteBasis:'PERCENT',accountLabel:'Portfolio holder · EUR',...(body.paymentMethod==='CRYPTO'?{cryptoAmount:'490',cryptoCurrency:'AG',unitPrice:'2'}:{})}});
   return json({id:security.security_id,status:'OPEN'});
  }
  if(['/wallet-trading-scroller.mjs','/wallet-trading-scroller.css','/approved-robot.mjs','/crypto-workspace.mjs','/trading-panel.mjs','/trading-testing.mjs','/trading-live.mjs','/index-advice.mjs','/crypto.css','/app.mjs','/portfolio.mjs','/exchange-intent.mjs','/accounts.mjs','/cards.mjs','/payment-wizard.mjs','/card-message.mjs','/styles.css'].includes(req.url)){res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');return res.end(await readFile(new URL('../public'+req.url,import.meta.url)));}res.writeHead(404);res.end();
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
for(const width of [1440,834,390])test('securities columns and five populated horizontal steps at '+width+'px',async()=>{
 const page=await browser.newPage({viewport:{width,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{await page.goto(base+'/customer#portfolio');await page.getByRole('heading',{name:'Securities portfolio',exact:true}).waitFor();
  for(const name of ['Name of security','Currency','Short name','ISIN','CUSIP','Denomination','Quantity','Issuing price','Market price','Portfolio value'])assert.equal(await page.locator('section.panel').filter({has:page.getByRole('heading',{name:'Securities portfolio',exact:true})}).getByRole('columnheader',{name,exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Record holding',exact:true}).count(),0);await page.locator('.view-header').getByRole('button',{name:'Buy',exact:true}).click();
  const dialog=page.locator('#portfolio-dialog');await dialog.getByLabel('Security · Green Bond / registered securities').selectOption(security.security_id);await dialog.getByText(security.isin,{exact:true}).waitFor();assert.equal(await dialog.getByText(security.cusip,{exact:true}).count(),1);
  for(let step=0;step<4;step++){
   const slide=dialog.locator('.payment-slide[aria-hidden="false"]');assert.equal(await slide.count(),1);const box=await slide.boundingBox();assert.ok(box.height>40&&box.width>100);const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1);
   if(step===1){await dialog.getByText('Available balance: 20,000.00 EUR',{exact:true}).waitFor();assert.equal(await dialog.getByLabel('Debit account / holding').inputValue(),account.account_id);}
   if(step===2){await dialog.getByLabel('Quantity',{exact:true}).fill('1');assert.equal(await dialog.getByLabel('Denomination',{exact:true}).inputValue(),security.denomination);}
   if(step===3){assert.equal(await dialog.getByLabel('Total price for debiting').inputValue(),'980.00');await dialog.getByLabel('Reference',{exact:true}).fill('Browser regression buy');}
   await dialog.getByRole('button',{name:step===3?'Review order':'Next',exact:true}).click();
  }
  await dialog.getByRole('heading',{name:'Please check your order'}).waitFor();assert.equal(calls.at(-1).path,'/api/portfolio/orders/review');assert.equal(calls.at(-1).body.total,'980.00');assert.equal(calls.at(-1).body.accountId,account.account_id);await dialog.getByRole('button',{name:'Buy',exact:true}).click();await page.getByText('Order entered in AVISPay Exchange.',{exact:true}).waitFor();assert.equal(calls.at(-1).body.reviewHash,'review-fixture');assert.equal(await page.locator('dialog[open]').count(),0);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
for(const method of ['CARD','CRYPTO'])test(method+' order option uses the selected purse/holding and calculates its review',async()=>{
 const page=await browser.newPage();try{await page.goto(base+'/customer#portfolio');await page.locator('.view-header').getByRole('button',{name:'Buy',exact:true}).click();const d=page.locator('#portfolio-dialog');await d.getByLabel('Security · Green Bond / registered securities').selectOption(security.security_id);await d.getByRole('button',{name:'Next',exact:true}).click();await d.getByLabel('Pay with',{exact:true}).selectOption(method);await d.getByRole('button',{name:'Next',exact:true}).click();await d.getByLabel('Quantity',{exact:true}).fill('1');await d.getByRole('button',{name:'Next',exact:true}).click();if(method==='CRYPTO')await d.getByText('Crypto to debit: 490.00 AG',{exact:true}).waitFor();await d.getByLabel('Reference',{exact:true}).fill(method+' purchase');await d.getByRole('button',{name:'Review order',exact:true}).click();await d.getByRole('heading',{name:'Please check your order'}).waitFor();const sent=calls.at(-1).body;assert.equal(sent.paymentMethod,method);assert.equal(sent.accountId,method==='CARD'?card.card_account_id:cryptoHolding.account_id);if(method==='CARD')assert.equal(sent.cardId,card.card_id);else assert.ok(sent.offerId);await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);}finally{await page.close();}
});
test('administration can record quantity and prices, add a security and return without nesting windows',async()=>{
 const page=await browser.newPage();try{await page.goto(base+'/admin#portfolio');await page.getByRole('button',{name:'Record holding',exact:true}).click();const d=page.locator('#portfolio-dialog');await d.getByLabel('Portfolio holder').selectOption('2');await d.getByLabel('Security · Green Bond / registered securities').selectOption(security.security_id);await d.getByLabel('Quantity',{exact:true}).fill('10');await d.getByLabel('Issuing price',{exact:true}).fill('100');await d.getByLabel('Market price',{exact:true}).fill('98');assert.equal(await d.getByLabel('Portfolio value',{exact:true}).inputValue(),'9800.00');await d.getByLabel('Booking reference').fill('Custody record fixture');await d.getByRole('button',{name:'+ Add security',exact:true}).click();await d.getByRole('heading',{name:'Add security',exact:true}).waitFor();assert.equal(await page.locator('dialog[open]').count(),1);await d.getByRole('button',{name:'Back',exact:true}).click();await d.getByRole('heading',{name:'Record portfolio holding',exact:true}).waitFor();assert.equal(await d.getByLabel('Quantity',{exact:true}).inputValue(),'10');assert.equal(await d.getByLabel('Portfolio value',{exact:true}).inputValue(),'9800.00');await d.getByLabel('Booking reference').fill('Custody record fixture');await d.getByRole('button',{name:'Save holding',exact:true}).click();await page.getByText('Portfolio holding saved.',{exact:true}).waitFor();assert.equal(calls.at(-1).body.marketPrice,'98');assert.equal(calls.at(-1).body.reference,'Custody record fixture');}finally{await page.close();}
});
test('sell uses credit destination, held quantity and closes all draft state on sign-out',async()=>{
 const page=await browser.newPage();try{await page.goto(base+'/customer#portfolio');await page.locator('[data-security-sell]').click();const d=page.locator('#portfolio-dialog');await d.getByRole('button',{name:'Next',exact:true}).click();await d.getByText('Available quantity: 10.00',{exact:true}).waitFor();assert.equal(await d.getByLabel('Credit account / holding').count(),1);await page.keyboard.press('Escape');await page.locator('#signout').click();await page.locator('#signin').waitFor({state:'visible'});assert.equal(await d.evaluate(el=>el.childElementCount),0);}finally{await page.close();}
});
for(const side of ['BUY','SELL'])test('exchange '+side+' survives login and requires final review before submission',async()=>{
 const page=await browser.newPage();const start=calls.length;
 try{
  await page.goto(base+'/guest#exchange?symbol=REGRESSION&side='+side+'&quantity=3&price=97.25');
  await page.getByRole('heading',{name:'Sign in to '+side.toLowerCase()+' REGRESSION'}).waitFor();
  assert.equal(calls.slice(start).filter(c=>c.path.includes('/orders/')).length,0);
  await page.getByLabel('Username',{exact:true}).fill('fixture');await page.getByLabel('Password',{exact:true}).fill('fixture');await page.getByRole('button',{name:'Sign in →'}).click();
  const d=page.locator('#portfolio-dialog');await d.getByRole('heading',{name:side==='BUY'?'Buy security':'Sell security'}).waitFor();
  assert.equal(await d.getByLabel('Security · Green Bond / registered securities').inputValue(),security.security_id);
  await d.getByRole('button',{name:'Next',exact:true}).click();await d.getByText('Available balance: 20,000.00 EUR',{exact:true}).waitFor();await d.getByRole('button',{name:'Next',exact:true}).click();
  assert.equal(await d.getByLabel('Quantity',{exact:true}).inputValue(),'3');await d.getByRole('button',{name:'Next',exact:true}).click();assert.equal(await d.getByLabel('Price',{exact:true}).inputValue(),'97.25');
  assert.equal(calls.slice(start).filter(c=>c.path.includes('/orders/')).length,0);
  await d.getByRole('button',{name:'Review order',exact:true}).click();await d.getByRole('heading',{name:'Please check your order'}).waitFor();
  assert.equal(calls.at(-1).body.total,'2917.50');assert.equal(calls.at(-1).body.side,side);assert.equal(calls.slice(start).some(c=>c.path.endsWith('/submit')),false);
  await d.getByRole('button',{name:side==='BUY'?'Buy':'Sell',exact:true}).click();await page.getByText('Order entered in AVISPay Exchange.',{exact:true}).waitFor();assert.equal(calls.at(-1).path,'/api/portfolio/orders/submit');
 }finally{await page.close();}
});
