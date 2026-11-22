import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {abiqMod97} from '../src/avispay-core-accounts.mjs';
let server,browser,base;const calls=[],reads=[];
const issued25=serial=>{const bban='AVIP978'+String(serial).padStart(14,'0');return 'TN'+String(98-abiqMod97(bban+'TN00')).padStart(2,'0')+bban;};
const common={account_id:'11111111-1111-4111-8111-111111111111',account_type:'COMMON',display_name:'Common settlement fixture',account_reference:issued25(900001),abiq_iban:issued25(900001),sub_account_code:'COMMON-FIXTURE',currency_code:'EUR',available_balance:'90',locked_balance:'0'},suspense={...common,account_id:'22222222-2222-4222-8222-222222222222',account_type:'SUSPENSE',display_name:'Suspense review fixture',account_reference:issued25(900002),abiq_iban:issued25(900002),sub_account_code:'SUSPENSE-FIXTURE',available_balance:'10'};
const personal={account_id:'33333333-3333-4333-8333-333333333333',account_reference:'TN62AVIP000978000011000102',credit:'1000',debit:'0',reference_id:'Opening fixture',user_id:'2',full_name:'Frontend fixture',account_type:'PERSONAL',account_role:'CUSTOMER',abiq_iban:'TN62AVIP000978000011000102',wallet_scope:'FUNDING',status:'ACTIVE',currency_code:'EUR',available_balance:'1000',locked_balance:'0'},business={...personal,account_id:'44444444-4444-4444-8444-444444444444',account_reference:'TN89AVIP000978000011000101',user_id:'1',account_type:'BUSINESS',account_role:'INSTITUTION',full_name:'AVISPay PLC',abiq_iban:'TN89AVIP000978000011000101'};
const custody={...business,account_id:'55555555-5555-4555-8555-555555555555',account_reference:issued25(900003),abiq_iban:issued25(900003),wallet_scope:'CUSTODY'},margin={...business,account_id:'66666666-6666-4666-8666-666666666666',account_reference:issued25(900004),abiq_iban:issued25(900004),wallet_scope:'MARGIN'};
const security={security_id:'77777777-7777-4777-8777-777777777777',name:'Funding source fixture',short_name:'FUNDING EUR',currency_code:'EUR',denomination:'1000',quote_basis:'PERCENT',reference_price:'98'};
const posRequestAt=new Date(Date.now()-60_000).toISOString(),posExpiresAt=new Date(Date.now()+59*60_000).toISOString();
const posFixtures=[
 {terminal_id:'11TNCON12',merchant_id:'AVISPAY-WEB-POS',terminal_type:'WEB_POS',status:'ACTIVE',activation_state:'REQUESTED',checkout_kind:'MILESTONE',checkout_reference:'AVIS-TN-12',checkout_title:'Tunisia · Road development',requested_at:posRequestAt,expires_at:posExpiresAt,approved_at:null,expired_at:null},
 {terminal_id:'11ITCON01',merchant_id:'AVISPAY-WEB-POS',terminal_type:'WEB_POS',status:'ACTIVE',activation_state:'CLOSED',checkout_kind:'MILESTONE',checkout_reference:'AVIS-IT-01',checkout_title:'Italy · Kickoff',requested_at:null,expires_at:null,approved_at:null,expired_at:null}
];
async function assertRowIban(row,account){
 assert.equal((await row.locator('.account-number').innerText()).replace(/\s/g,''),account.abiq_iban);
 assert.equal(await row.getByRole('button',{name:'Show movements for '+account.abiq_iban,exact:true}).count(),1);
}
async function assertDetailIban(dialog,account){
 const field=dialog.locator('dt').filter({hasText:/^ABIQ IBAN$/});assert.equal(await field.count(),1);
 assert.equal(await field.evaluate(el=>el.nextElementSibling.textContent.replace(/\s/g,'')),account.abiq_iban);
 assert.doesNotMatch(await dialog.innerText(),/COMMON-FIXTURE|SUSPENSE-FIXTURE/);
}
before(async()=>{
 server=http.createServer(async(req,res)=>{
  const respond=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
  if(['/admin','/customer'].includes(req.url)){res.setHeader('set-cookie','fixture-role='+req.url.slice(1)+'; Path=/');res.setHeader('content-type','text/html');return res.end(await readFile(new URL('../index.html',import.meta.url)));}
  const admin=req.headers.cookie?.includes('fixture-role=admin');
  if(req.url==='/api/session')return respond({username:'fixture',csrf:'isolated',admin,customerUserId:admin?null:'2',canSwitchWorkspace:false});
  if(req.url.startsWith('/api/abiq/generator?'))return respond({
   countries:['TN','IT'],currencies:[
    {currency:'EUR',series:'00001',currencyBlock:'000978'},
    {currency:'579',label:'Custodial account',series:'00015',currencyBlock:'000579'}],
   customerNumbers:req.url.endsWith('holder=AVIP')?['1000101']:[],reusable:[],recent:[]
  });
  if(req.url.startsWith('/api/views/')){const view=req.url.split('/').at(-1);reads.push(view);const fixtures={accounts:admin?[business,personal]:[personal],accountsummaries:admin?[business,custody,margin,personal]:[personal],customers:[business,personal],backofficeaccounts:[common,suspense],securities:[security],portfolio:[{currency_code:'AG',network:'ETHEREUM',available_balance:admin?'15.000000000000000000':'7.000000000000000000',locked_balance:'0'}],ledger:[{account_holder:'SHOULD NOT RENDER'}],transactions:[{reference_id:'SHOULD NOT RENDER'}],terminals:posFixtures};return respond({rows:fixtures[view]||[]});}
  if(req.method==='GET'&&(req.url.startsWith('/api/backoffice-accounts/')||req.url.startsWith('/api/accounts/'))){const id=req.url.split('/')[3].split('?')[0],account=[common,suspense,personal,business,custody,margin].find(a=>a.account_id===id),older=req.url.includes('?before='),entry={entry_id:older?'1':'2',journal_id:'fixture-journal',event_type:'OPENING',created_at:'2026-11-14T12:00:00Z',reference_id:older?'Earlier statement entry':'Selected account entry',direction:'CREDIT',amount:'100',running_balance:'100'};if(req.url.includes('/movements/'))return respond({account,entry});return respond({account,totals:{incoming:'100',outgoing:'10'},entries:[entry],nextCursor:older?null:'2'});}
  if(req.method==='POST'&&req.url.startsWith('/api/')){let raw='';for await(const chunk of req)raw+=chunk;calls.push({path:req.url,body:JSON.parse(raw)});if(req.url==='/api/terminals/activation'){
   const input=JSON.parse(raw),terminal=posFixtures.find(r=>r.terminal_id===input.terminalId);
   if(!terminal){res.statusCode=404;return respond({code:'TERMINAL_NOT_FOUND'})}
   terminal.activation_state=input.active?'ACTIVE':'CLOSED';
   terminal.approved_at=input.active?new Date().toISOString():null;
   if(!input.active){terminal.requested_at=null;terminal.expires_at=null}
   return respond({terminalId:terminal.terminal_id,state:terminal.activation_state,requestedAt:terminal.requested_at,approvedAt:terminal.approved_at,expiresAt:terminal.expires_at,expiredAt:terminal.expired_at});
  }return respond({id:'fixture'});}
  if(['/wallet-trading-scroller.mjs','/wallet-trading-scroller.css','/approved-robot.mjs','/crypto-workspace.mjs','/crypto-basket.mjs','/treasury-source.mjs','/trading-panel.mjs','/trading-testing.mjs','/trading-live.mjs','/index-advice.mjs','/crypto.css','/app.mjs','/open-account-register.mjs','/abiq-generator.mjs','/abiq-number.mjs','/portfolio.mjs','/nostro-clearing.mjs','/exchange-intent.mjs','/accounts.mjs','/cards.mjs','/payment-wizard.mjs','/card-message.mjs','/styles.css'].includes(req.url.split('?')[0])){const asset=req.url.split('?')[0];res.setHeader('content-type',asset.endsWith('.css')?'text/css':'text/javascript');return res.end(await readFile(new URL('../public'+asset,import.meta.url)));}
  res.writeHead(404);res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
test('iPad POS register keeps the visible glass approval switch immediately next to its terminal ID',async()=>{
 const page=await browser.newPage({viewport:{width:834,height:1112}});
 try{
  await page.goto(base+'/admin#pos');
  const row=page.locator('[data-pos-terminal="11TNCON12"]');
  await row.waitFor();
  const id=await row.locator('.account-number').boundingBox();
  const control=await row.getByRole('switch',{name:'Activate POS 11TNCON12'}).boundingBox();
  assert.ok(id&&control,'the terminal and switch are both rendered');
  assert.ok(control.x>id.x&&control.x<id.x+id.width+32,'POS approval is directly beside the terminal number');
  assert.ok(control.x+control.width<=834,'the POS switch is visible without horizontal scrolling on iPad');
 }finally{await page.close()}
});
test('POS terminal register identifies the exact checkout and shows each blinking blue approval switch',async()=>{
 const page=await browser.newPage({viewport:{width:1180,height:950}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(base+'/admin#pos');
  await page.getByRole('heading',{name:'POS terminals',exact:true}).waitFor();
  const pending=page.locator('[data-pos-terminal="11TNCON12"]'),closed=page.locator('[data-pos-terminal="11ITCON01"]');
  await pending.waitFor();
  assert.equal(await page.locator('[data-pos-register] summary').getAttribute('aria-label'),null);
  assert.equal(await page.getByRole('columnheader',{name:'Checkout / origin'}).count(),1);
  assert.equal(await page.getByRole('columnheader',{name:'Request & expiry (local time)'}).count(),1);
  assert.match(await pending.innerText(),/Tunisia · Road development/);
  assert.match(await pending.innerText(),/AVIS-TN-12/);
  assert.match(await pending.innerText(),/Requested:/);
  assert.match(await pending.innerText(),/Expires:/);
  const blue=pending.getByRole('switch',{name:'Activate POS 11TNCON12'});
  assert.equal(await blue.getAttribute('data-state'),'REQUESTED');
  assert.equal(await blue.evaluate(el=>getComputedStyle(el).animationName),'pos-request-pulse');
  assert.equal(await blue.evaluate(el=>getComputedStyle(el).width),'116px','administrator Liquid Glass switch has touch-sized chrome shell');
  assert.equal(await blue.locator('.pos-liquid-knob').evaluate(el=>getComputedStyle(el).width),'63px','three-state glass capsule is visible');
  assert.match(await blue.evaluate(el=>getComputedStyle(el,'::before').backgroundImage),/linear-gradient/,'glass control has recessed track');
  assert.match(await blue.locator('.pos-liquid-knob').evaluate(el=>getComputedStyle(el).backgroundImage),/linear-gradient/,'capsule is colored by its bank state');
  assert.equal(await closed.getByRole('switch',{name:'Activate POS 11ITCON01'}).getAttribute('data-state'),'CLOSED');
  await blue.click();
  await pending.getByRole('switch',{name:'Close POS 11TNCON12'}).waitFor();
  assert.equal(await pending.getByRole('switch',{name:'Close POS 11TNCON12'}).getAttribute('data-state'),'ACTIVE');
  assert.equal(calls.at(-1).path,'/api/terminals/activation');
  assert.deepEqual(calls.at(-1).body,{terminalId:'11TNCON12',active:true});
  await pending.getByRole('switch',{name:'Close POS 11TNCON12'}).click();
  await pending.getByRole('switch',{name:'Activate POS 11TNCON12'}).waitFor();
  assert.equal(await pending.getByRole('switch',{name:'Activate POS 11TNCON12'}).getAttribute('data-state'),'CLOSED');
  assert.deepEqual(errors,[]);
 }finally{await page.close()}
});
test('Accounts & ABIQ selects country and currency and derives the series',async()=>{
 const page=await browser.newPage();
 try{
  await page.goto(base+'/admin#accounts');
  await page.getByRole('button',{name:'Generate ABIQ number',exact:true}).click();
  const dialog=page.locator('dialog.abiq-generator');
  await dialog.waitFor({state:'visible'});
  const country=dialog.getByLabel('Country',{exact:true}),currency=dialog.getByLabel('Currency',{exact:true});
  assert.equal(await country.inputValue(),'');assert.equal(await currency.inputValue(),'');
  await country.selectOption('IT');await currency.selectOption('EUR');
  assert.equal(await dialog.locator('output[name=series]').textContent(),'00001');
  await dialog.getByLabel('ABIQ holder short name').fill('AVIP');
  await dialog.getByText(/^IT\d{2}AVIP000978 000011000101$/).waitFor();
  await currency.selectOption('579');
  assert.equal(await dialog.locator('output[name=series]').textContent(),'00015');
  await dialog.getByText(/^IT\d{2}AVIP000579 000151000101$/).waitFor();
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
 }finally{await page.close();}
});
test('former ledger URL opens portfolio without customer accounts or journal tracing',async()=>{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));reads.length=0;
 try{await page.goto(base+'/admin#ledger');await page.getByRole('heading',{name:'Portfolio holdings',exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'#portfolio');assert.equal(await page.getByRole('heading',{name:'Portfolio management',exact:true}).count(),1);assert.equal(await page.getByText('AG',{exact:true}).count(),1);
  assert.equal(await page.locator('nav a[href="#ledger"]').count(),0);assert.equal(await page.getByText('SHOULD NOT RENDER').count(),0);for(const view of ['accounts','accountsummaries','customers','ledger','transactions'])assert.equal(reads.includes(view),false,view);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
for(const width of [1440,390])test('backoffice account selector and statements work at '+width+'px',async()=>{
 const page=await browser.newPage({viewport:{width,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{await page.goto(base+'/admin#accounts');await page.getByLabel('Account type',{exact:true}).selectOption('COMMON');await page.getByText(common.display_name,{exact:true}).waitFor();assert.equal(await page.locator('[data-account-row="'+personal.account_id+'"]').count(),0);assert.equal(await page.getByText(suspense.display_name,{exact:true}).count(),0);
  assert.equal(await page.getByRole('columnheader',{name:'ABIQ IBAN',exact:true}).count(),1);await assertRowIban(page.locator('[data-account-row="'+common.account_id+'"]'),common);assert.doesNotMatch(await page.locator('#view').innerText(),/COMMON-FIXTURE|SUSPENSE-FIXTURE/);
  await page.getByRole('button',{name:'View statement',exact:true}).click();await page.getByRole('heading',{name:'Common Account statement',exact:true}).waitFor();await assertDetailIban(page.locator('.account-statement-dialog'),common);await page.getByText('Selected account entry',{exact:true}).waitFor();await page.getByRole('button',{name:'Load older entries',exact:true}).click();await page.getByText('Earlier statement entry',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Load older entries',exact:true}).isVisible(),false);
  const bounds=await page.locator('.account-statement-dialog').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);await page.getByRole('button',{name:'Close account statement'}).click();assert.equal(await page.locator('.account-statement-dialog').evaluate(e=>e.childElementCount),0);
  await page.getByLabel('Account type',{exact:true}).selectOption('SUSPENSE');await page.getByText(suspense.display_name,{exact:true}).waitFor();await assertRowIban(page.locator('[data-account-row="'+suspense.account_id+'"]'),suspense);assert.doesNotMatch(await page.locator('#view').innerText(),/COMMON-FIXTURE|SUSPENSE-FIXTURE/);
  await page.getByRole('button',{name:'Open account',exact:true}).click();const form=page.locator('#action-form');assert.equal(await form.getByLabel('Account type',{exact:true}).inputValue(),'SUSPENSE');await form.getByLabel('Account name / holder').fill('New suspense fixture');await form.getByLabel('Currency',{exact:true}).selectOption('EUR');await form.getByRole('button',{name:'Open account',exact:true}).click();await page.getByText('Saved successfully.',{exact:true}).waitFor();assert.equal(calls.at(-1).path,'/api/accounts/open');assert.equal(calls.at(-1).body.accountType,'SUSPENSE');
  await page.getByRole('button',{name:'View statement',exact:true}).click();await page.getByRole('heading',{name:'Suspense Account statement',exact:true}).waitFor();await assertDetailIban(page.locator('.account-statement-dialog'),suspense);await page.keyboard.press('Escape');await page.locator('#signout').click();await page.locator('#signin').waitFor({state:'visible'});assert.equal(await page.locator('.account-statement-dialog').evaluate(e=>e.childElementCount),0);assert.deepEqual(errors,[]);
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
  for(const label of ['ABIQ IBAN','Credit','Debit','Reference'])assert.ok(await page.getByRole('columnheader',{name:label,exact:true}).count()>0);
  const row=page.locator('[data-account-row="'+business.account_id+'"]'),group=page.locator('.account-group').filter({has:row});
  await group.locator('summary').click();assert.equal(await group.getAttribute('open'),null);await group.locator('summary').click();
  await assertRowIban(row,business);
  for(const account of [custody,margin]){
   const scopedRow=page.locator('[data-account-row="'+account.account_id+'"]'),purpose=account.wallet_scope==='CUSTODY'?'Custody':'Margin';await assertRowIban(scopedRow,account);assert.equal(await scopedRow.getByRole('cell',{name:'Business · '+purpose,exact:true}).count(),1);
   await scopedRow.getByRole('button',{name:'View details',exact:true}).click();const scopedDialog=page.locator('.account-statement-dialog');await scopedDialog.getByRole('heading',{name:'Account details',exact:true}).waitFor();await assertDetailIban(scopedDialog,account);assert.equal(await scopedDialog.locator('dt').filter({hasText:/^Account purpose$/}).evaluate(el=>el.nextElementSibling.textContent),purpose);
   const bounds=await scopedDialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);await scopedDialog.getByRole('button',{name:'Close account statement'}).click();
  }
  await row.getByRole('button',{name:'View details',exact:true}).click();await page.getByRole('heading',{name:'Account details',exact:true}).waitFor();
  const dialog=page.locator('.account-statement-dialog'),bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);await assertDetailIban(dialog,business);
  await dialog.getByRole('button',{name:'View movement',exact:true}).click();await page.getByRole('heading',{name:'Movement details',exact:true}).waitFor();await page.getByText('fixture-journal',{exact:true}).waitFor();assert.equal(await page.locator('dialog[open]').count(),1);await assertDetailIban(dialog,business);
  await page.getByRole('button',{name:'Back to account',exact:true}).click();await page.getByRole('heading',{name:'Account details',exact:true}).waitFor();await page.getByRole('button',{name:'Close account statement'}).click();
  await row.getByRole('button',{name:'Show movements for '+business.account_reference,exact:true}).click();
  const movements=page.locator('[data-movements-for="'+business.account_id+'"]');await movements.locator('.account-movements').waitFor();await movements.getByRole('button',{name:'View movement',exact:true}).click();await page.getByRole('heading',{name:'Movement details',exact:true}).waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);
  await row.getByRole('button',{name:'Show movements for '+business.account_reference,exact:true}).click();assert.equal(await movements.isVisible(),false);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
for(const width of [1440,390])for(const side of ['Buy','Sell'])test(side+' security selects funding accounts and excludes custody/margin at '+width+'px',async()=>{
 const page=await browser.newPage({viewport:{width,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));const start=calls.length;
 try{
  await page.goto(base+'/admin#portfolio');await page.locator('.view-header').getByRole('button',{name:side,exact:true}).click();const dialog=page.locator('#portfolio-dialog');await dialog.getByLabel('Security · Green Bond / registered securities').selectOption(security.security_id);await dialog.getByRole('button',{name:'Next',exact:true}).click();
  const source=dialog.getByLabel(side==='Buy'?'Debit account / holding':'Credit account / holding');assert.deepEqual(await source.locator('option').evaluateAll(options=>options.map(o=>o.value).filter(Boolean)),[business.account_id,personal.account_id]);await source.selectOption(business.account_id);await dialog.getByText('Available balance: 1,000.00 EUR',{exact:true}).waitFor();assert.equal(await source.locator('option:checked').innerText(),business.full_name+' · '+business.abiq_iban+' · 1,000.00 EUR');
  assert.equal(await source.locator('option[value="'+custody.account_id+'"], option[value="'+margin.account_id+'"]').count(),0);assert.equal(calls.slice(start).some(call=>call.path.includes('/portfolio/orders/')),false);await dialog.getByRole('button',{name:'Close portfolio window'}).click();assert.deepEqual(errors,[]);
 }finally{await page.close();}
});

test('a late POS lookup stays out of Crypto and market lookup cannot delay receiving',async()=>{
 const page=await browser.newPage();
 const response=(route,status,json)=>route.fulfill({status,json});
 let terminalRoute,marketRoute;
 const terminalRequest=new Promise(resolve=>{terminalRoute=resolve;});
 const marketRequest=new Promise(resolve=>{marketRoute=resolve;});
 const wallet={account_id:'funding-wallet',currency_code:'ETH',user_id:'1',wallet_scope:'FUNDING',network:'ETHEREUM',address_id:'address-one',available_balance:'0',locked_balance:'0'};
 try{
  await page.goto(base+'/admin#pos');
  await page.getByRole('heading',{name:'POS terminals'}).waitFor();
  await page.route('**/api/views/terminals',route=>terminalRoute(route));
  await page.route('**/api/views/cryptomarkets',route=>marketRoute(route));
  await page.route('**/api/views/cryptowallets',route=>response(route,200,{rows:[wallet]}));
  await page.route('**/api/crypto/wallet',route=>response(route,200,{address_id:wallet.address_id,network:wallet.network,public_address:'receiving-fixture',qr:'data:image/png;base64,AA=='}));
  await page.getByRole('button',{name:'Authorize',exact:true}).click();
  const terminals=await terminalRequest;
  await page.locator('nav a[href="#wallets"]').click();
  const markets=await marketRequest;
  await page.getByRole('button',{name:'Receive ETH',exact:true}).click();
  await page.locator('dialog[open] code').filter({hasText:'receiving-fixture'}).waitFor();
  await response(terminals,503,{code:'POS_READ',message:'POS terminals could not be loaded.'});
  await response(markets,503,{code:'MARKET_READ',message:'Market prices could not be loaded.'});
  await page.locator('[data-market-read-error]').filter({hasText:'Market prices could not be loaded.'}).waitFor({state:'attached'});
  assert.equal(await page.locator('#notice').isHidden(),true);
  assert.equal(await page.locator('#crypto-wallet-desk [data-crypto-error]').textContent(),'');
  assert.equal(await page.getByText('POS terminals could not be loaded.',{exact:true}).count(),0);
  assert.equal(await page.locator('dialog[open]').count(),1);
  assert.equal(await page.locator('dialog[open]').evaluate(el=>el.parentElement.tagName),'BODY');
 }finally{await page.close();}
});

test('the banking form shows server validation beside its field and accepts a corrected retry',async()=>{
 const page=await browser.newPage();let attempts=0;
 try{
  await page.route('**/api/accounts/open',route=>++attempts===1
   ?route.fulfill({status:422,json:{code:'INVALID_FIELD',field:'fullName',message:'Check the account holder.'}})
   :route.fulfill({json:{accounts:[]}}));
  await page.goto(base+'/admin#accounts');
  await page.getByRole('button',{name:'Open account',exact:true}).click();
  const dialog=page.locator('#form-dialog'),name=dialog.getByLabel('Account name / holder',{exact:true});
  await dialog.getByLabel('Account type',{exact:true}).selectOption('BUSINESS');
  await dialog.getByLabel('Account holder register',{exact:true}).selectOption('NEW');
  await name.fill('First holder');await dialog.locator('[name=currency]').selectOption('EUR');
  await dialog.getByRole('button',{name:'Open account',exact:true}).click();
  await dialog.locator('#action-field-error').waitFor();assert.equal(await name.getAttribute('aria-invalid'),'true');
  assert.equal(await name.locator('..').getByRole('alert').textContent(),'Check the account holder.');
  assert.equal(await page.locator('#notice').isHidden(),true);
  await name.fill('Updated holder');assert.equal(await name.getAttribute('aria-invalid'),null);
  await dialog.getByRole('button',{name:'Open account',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.equal(attempts,2);
 }finally{await page.close();}
});
