// Isolated localhost browser fixture only. All identifiers and credentials below
// are synthetic test data; these tests do not connect to a payment or card network.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
let server,browser,base;const calls=[];
const card={card_id:'11111111-1111-4111-8111-111111111111',user_id:'1',full_name:'Card holder fixture',card_number:'AVIS-1234567890123456',last_four_digits:'3456',card_product:'GOLD_METAL',card_type:'PREPAID',card_rail_mode:'AVIS_PROPRIETARY_ONLY',card_account_id:'22222222-2222-4222-8222-222222222222',currency_code:'EUR',available_balance:'100.00',status:'ACTIVE',issued_at:'2026-01-01T00:00:00Z',expires_at:'2029-01-01T00:00:00Z'};
const account={user_id:'1',abiq_iban:'TN89AVIP000978000011000101',full_name:card.full_name,currency_code:'EUR',available_balance:'1000',account_type:'PERSONAL',account_role:'CUSTOMER'};
before(async()=>{
 server=http.createServer(async(req,res)=>{
  const respond=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
  if(['/customer','/admin'].includes(req.url)){res.setHeader('set-cookie','fixture-role='+req.url.slice(1)+'; Path=/');res.setHeader('content-type','text/html');return res.end(await readFile(new URL('../index.html',import.meta.url)));}
  if(req.url==='/api/session')return respond({username:'layout fixture',csrf:'isolated',admin:req.headers.cookie?.includes('fixture-role=admin'),customerUserId:'1',canSwitchWorkspace:false});
  if(req.url.startsWith('/api/views/')){const view=req.url.split('/').at(-1),fixtures={accounts:[account],customers:[{user_id:'1',full_name:card.full_name}],cards:[card],transfercards:[card],cardaccounts:[{account_id:card.card_account_id,user_id:'1',full_name:card.full_name,currency_code:'EUR',available_balance:'100',cards:[card]}]};return respond({rows:fixtures[view]||[]});}
  if(req.url==='/api/cards/'+card.card_id)return respond({card,cards:[card],entries:[{entry_id:1,created_at:'2026-01-02T00:00:00Z',reference_id:'Card funding fixture',direction:'CREDIT',amount:'100',running_balance:'100'}],totals:{incoming:'100',outgoing:'0'}});
  if(req.method==='POST'&&req.url.startsWith('/api/')){let raw='';for await(const chunk of req)raw+=chunk;calls.push({path:req.url,body:JSON.parse(raw)});return respond({id:card.card_id});}
  if(['/wallet-trading-scroller.mjs','/wallet-trading-scroller.css','/approved-robot.mjs','/crypto-workspace.mjs','/crypto-basket.mjs','/treasury-source.mjs','/trading-panel.mjs','/trading-testing.mjs','/trading-live.mjs','/index-advice.mjs','/crypto.css','/app.mjs','/abiq-generator.mjs','/abiq-number.mjs','/payment-wizard.mjs','/cards.mjs','/portfolio.mjs','/exchange-intent.mjs','/accounts.mjs','/card-message.mjs','/styles.css'].includes(req.url)){res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');return res.end(await readFile(new URL('../public'+req.url,import.meta.url)));}
  res.writeHead(404);res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
test('customer card account shows metadata, activity, PIN reset and card activation',async()=>{
 const page=await browser.newPage({viewport:{width:1280,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(base+'/customer#cards');await page.getByRole('button',{name:'View account',exact:true}).click();
  await page.getByRole('heading',{name:'Card account · '+card.full_name}).waitFor();await page.getByText('Gold Card Metal',{exact:true}).waitFor();assert.equal(await page.getByText('Card funding fixture',{exact:true}).isVisible(),true);
  await page.getByRole('button',{name:'Reset PIN',exact:true}).click();await page.getByLabel('New PIN',{exact:true}).fill('438219');await page.getByLabel('Repeat PIN',{exact:true}).fill('438219');await page.getByRole('button',{name:'Save PIN',exact:true}).click();await page.getByText('PIN updated',{exact:true}).waitFor();assert.equal(calls.at(-1).path,'/api/cards/pin');
  await page.getByRole('button',{name:'Close card account'}).click();assert.equal(await page.locator('nav a[href="#pos"]').isVisible(),false);assert.equal(await page.locator('nav a[href="#administration"]').isVisible(),false);
  await page.getByRole('button',{name:'Activate card account',exact:true}).click();await page.getByLabel('Card / account type',{exact:true}).selectOption('VIRTUAL');await page.getByLabel('My currency account',{exact:true}).selectOption(account.abiq_iban);await page.getByRole('button',{name:'Issue card',exact:true}).click();await page.getByText('Saved successfully.',{exact:true}).waitFor();assert.equal(calls.at(-1).path,'/api/cards/issue');assert.equal(calls.at(-1).body.product,'VIRTUAL');await page.locator('#signout').click();await page.locator('#signin').waitFor({state:'visible'});assert.equal(await page.locator('#form-fields').evaluate(el=>el.childElementCount),0);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('Cards and POS are separate administrator workspaces',async()=>{
 const page=await browser.newPage();try{await page.goto(base+'/admin#cards');await page.getByRole('button',{name:'Activate card account',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Register terminal',exact:true}).count(),0);
  await page.locator('nav a[href="#pos"]').click();await page.getByRole('heading',{name:'POS',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Register terminal',exact:true}).isVisible(),true);assert.equal(await page.getByRole('button',{name:'Activate card account',exact:true}).count(),0);
 }finally{await page.close();}
});

test('a card action finishing after navigation cannot reopen the previous card',async()=>{
 const page=await browser.newPage();let started;
 const pending=new Promise(resolve=>{started=resolve;});
 try{
  await page.route('**/api/cards/status',route=>started(route));
  await page.goto(base+'/customer#cards');
  await page.getByRole('button',{name:'View account',exact:true}).click();
  await page.getByRole('button',{name:'Block card',exact:true}).click();
  const request=await pending;
  await page.evaluate(()=>{location.hash='#accounts';});
  await page.getByRole('heading',{name:'My accounts',exact:true}).waitFor();
  const receipt=page.waitForResponse(r=>r.url()===base+'/api/cards/status');
  await request.fulfill({json:{status:'BLOCKED'}});await receipt;
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await page.locator('dialog[open]').count(),0);
  assert.equal(await page.locator('#notice').isHidden(),true);
 }finally{await page.close();}
});
