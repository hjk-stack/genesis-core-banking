import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
let server,browser,base;const calls=[],reads=[];
const common={account_id:'11111111-1111-4111-8111-111111111111',account_type:'COMMON',display_name:'Common settlement fixture',account_reference:'COMMON-FIXTURE',currency_code:'EUR',available_balance:'90',locked_balance:'0'},suspense={...common,account_id:'22222222-2222-4222-8222-222222222222',account_type:'SUSPENSE',display_name:'Suspense review fixture',account_reference:'SUSPENSE-FIXTURE',available_balance:'10'};
const personal={account_id:'33333333-3333-4333-8333-333333333333',account_reference:'TN62AVIP000978000011000102',credit:'1000',debit:'0',reference_id:'Opening fixture',user_id:'2',full_name:'Frontend fixture',account_type:'PERSONAL',account_role:'CUSTOMER',abiq_iban:'TN62AVIP000978000011000102',currency_code:'EUR',available_balance:'1000',locked_balance:'0'},business={...personal,account_id:'44444444-4444-4444-8444-444444444444',account_reference:'TN89AVIP000978000011000101',user_id:'1',account_type:'BUSINESS',account_role:'INSTITUTION',full_name:'AVISPay PLC',abiq_iban:'TN89AVIP000978000011000101'};
before(async()=>{
 server=http.createServer(async(req,res)=>{
  const respond=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
  if(['/admin','/customer'].includes(req.url)){res.setHeader('set-cookie','fixture-role='+req.url.slice(1)+'; Path=/');res.setHeader('content-type','text/html');return res.end(await readFile(new URL('../index.html',import.meta.url)));}
  const admin=req.headers.cookie?.includes('fixture-role=admin');
  if(req.url==='/api/session')return respond({username:'fixture',csrf:'isolated',admin,customerUserId:admin?null:'2',canSwitchWorkspace:false});
  if(req.url.startsWith('/api/views/')){const view=req.url.split('/').at(-1);reads.push(view);const fixtures={accounts:admin?[business,personal]:[personal],accountsummaries:admin?[business,personal]:[personal],customers:[business,personal],backofficeaccounts:[common,suspense],portfolio:[{currency_code:'AG',network:'ETHEREUM',available_balance:admin?'15.000000000000000000':'7.000000000000000000',locked_balance:'0'}],ledger:[{account_holder:'SHOULD NOT RENDER'}],transactions:[{reference_id:'SHOULD NOT RENDER'}]};return respond({rows:fixtures[view]||[]});}
  if(req.method==='GET'&&(req.url.startsWith('/api/backoffice-accounts/')||req.url.startsWith('/api/accounts/'))){const id=req.url.split('/')[3].split('?')[0],account=[common,suspense,personal,business].find(a=>a.account_id===id),older=req.url.includes('?before='),entry={entry_id:older?'1':'2',journal_id:'fixture-journal',event_type:'OPENING',created_at:'2026-11-14T12:00:00Z',reference_id:older?'Earlier statement entry':'Selected account entry',direction:'CREDIT',amount:'100',running_balance:'100'};if(req.url.includes('/movements/'))return respond({account,entry});return respond({account,totals:{incoming:'100',outgoing:'10'},entries:[entry],nextCursor:older?null:'2'});}
  if(req.method==='POST'&&req.url.startsWith('/api/')){let raw='';for await(const chunk of req)raw+=chunk;calls.push({path:req.url,body:JSON.parse(raw)});return respond({id:'fixture'});}
  if(['/crypto-workspace.mjs','/trading-panel.mjs','/trading-testing.mjs','/trading-live.mjs','/index-advice.mjs','/crypto.css','/app.mjs','/portfolio.mjs','/exchange-intent.mjs','/accounts.mjs','/cards.mjs','/payment-wizard.mjs','/card-message.mjs','/styles.css'].includes(req.url)){res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');return res.end(await readFile(new URL('../public'+req.url,import.meta.url)));}
  res.writeHead(404);res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
test('former ledger URL opens portfolio without customer accounts or journal tracing',async()=>{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));reads.length=0;
 try{await page.goto(base+'/admin#ledger');await page.getByRole('heading',{name:'Portfolio holdings',exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'#portfolio');assert.equal(await page.getByRole('heading',{name:'Portfolio management',exact:true}).count(),1);assert.equal(await page.getByText('AG',{exact:true}).count(),1);
  assert.equal(await page.locator('nav a[href="#ledger"]').count(),0);assert.equal(await page.getByText('SHOULD NOT RENDER').count(),0);for(const view of ['accounts','accountsummaries','customers','ledger','transactions'])assert.equal(reads.includes(view),false,view);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
for(const width of [1440,390])test('backoffice account selector and statements work at '+width+'px',async()=>{
 const page=await browser.newPage({viewport:{width,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{await page.goto(base+'/admin#accounts');await page.getByLabel('Account type',{exact:true}).selectOption('COMMON');await page.getByText(common.display_name,{exact:true}).waitFor();assert.equal(await page.locator('[data-account-row="'+personal.account_id+'"]').count(),0);assert.equal(await page.getByText(suspense.display_name,{exact:true}).count(),0);
  await page.getByRole('button',{name:'View statement',exact:true}).click();await page.getByRole('heading',{name:'Common Account statement',exact:true}).waitFor();await page.getByText('Selected account entry',{exact:true}).waitFor();await page.getByRole('button',{name:'Load older entries',exact:true}).click();await page.getByText('Earlier statement entry',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Load older entries',exact:true}).isVisible(),false);
  const bounds=await page.locator('.account-statement-dialog').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);await page.getByRole('button',{name:'Close account statement'}).click();assert.equal(await page.locator('.account-statement-dialog').evaluate(e=>e.childElementCount),0);
  await page.getByLabel('Account type',{exact:true}).selectOption('SUSPENSE');await page.getByText(suspense.display_name,{exact:true}).waitFor();await page.getByRole('button',{name:'Open account',exact:true}).click();const form=page.locator('#action-form');assert.equal(await form.getByLabel('Account type',{exact:true}).inputValue(),'SUSPENSE');await form.getByLabel('Account name / holder').fill('New suspense fixture');await form.getByLabel('Currency',{exact:true}).selectOption('EUR');await form.getByRole('button',{name:'Open account',exact:true}).click();await page.getByText('Saved successfully.',{exact:true}).waitFor();assert.equal(calls.at(-1).path,'/api/accounts/open');assert.equal(calls.at(-1).body.accountType,'SUSPENSE');
  await page.getByRole('button',{name:'View statement',exact:true}).click();await page.getByRole('heading',{name:'Suspense Account statement',exact:true}).waitFor();await page.keyboard.press('Escape');await page.locator('#signout').click();await page.locator('#signin').waitFor({state:'visible'});assert.equal(await page.locator('.account-statement-dialog').evaluate(e=>e.childElementCount),0);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('customer account summary excludes backoffice controls and has its own portfolio',async()=>{
 const page=await browser.newPage();try{await page.goto(base+'/customer#accounts');await page.getByRole('heading',{name:'My accounts',exact:true}).waitFor();assert.equal(await page.locator('#account-type-filter').count(),0);assert.equal(await page.getByRole('button',{name:'View statement',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Move to suspense',exact:true}).count(),0);
  await page.locator('nav a[href="#portfolio"]').click();await page.getByRole('heading',{name:'Portfolio holdings',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Purchase assets',exact:true}).count(),1);assert.equal(await page.getByText('7.00',{exact:true}).count(),1);
 }finally{await page.close();}
});
for(const width of [1440,390])test('collapsible accounts show credit/debit/reference and floating account/movement details at '+width+'px',async()=>{
 const page=await browser.newPage({viewport:{width,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(base+'/admin#accounts');await page.getByRole('heading',{name:'Account summary',exact:true}).waitFor();
  assert.equal(await page.getByRole('columnheader',{name:'ABIQ code',exact:true}).count(),0);
  for(const label of ['Credit','Debit','Reference'])assert.ok(await page.getByRole('columnheader',{name:label,exact:true}).count()>0);
  const row=page.locator('[data-account-row="'+business.account_id+'"]'),group=page.locator('.account-group').filter({has:row});
  await group.locator('summary').click();assert.equal(await group.getAttribute('open'),null);await group.locator('summary').click();
  await row.getByRole('button',{name:'View details',exact:true}).click();await page.getByRole('heading',{name:'Account details',exact:true}).waitFor();
  const dialog=page.locator('.account-statement-dialog'),bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
  await dialog.getByRole('button',{name:'View movement',exact:true}).click();await page.getByRole('heading',{name:'Movement details',exact:true}).waitFor();await page.getByText('fixture-journal',{exact:true}).waitFor();assert.equal(await page.locator('dialog[open]').count(),1);
  await page.getByRole('button',{name:'Back to account',exact:true}).click();await page.getByRole('heading',{name:'Account details',exact:true}).waitFor();await page.getByRole('button',{name:'Close account statement'}).click();
  await row.getByRole('button',{name:'Show movements for '+business.account_reference,exact:true}).click();
  const movements=page.locator('[data-movements-for="'+business.account_id+'"]');await movements.locator('.account-movements').waitFor();await movements.getByRole('button',{name:'View movement',exact:true}).click();await page.getByRole('heading',{name:'Movement details',exact:true}).waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);
  await row.getByRole('button',{name:'Show movements for '+business.account_reference,exact:true}).click();assert.equal(await movements.isVisible(),false);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
