import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';

let server,browser,base;
const cases=new Map();
const cash='41000000-0000-4000-8000-000000000001',intermediaryId='42000000-0000-4000-8000-000000000001',statementId='43000000-0000-4000-8000-000000000001';
const account={cashAccountId:cash,institutionName:'External Fixture Bank',accountNumber:'EXTERNAL-ACCOUNT-01',bic:'TESTGB2LXXX',currency:'EUR'};
const intermediary={intermediaryId,bankName:'Transit Fixture Bank',bankAddress:'2 Transit Road',accountName:'Transit holder',aba:'',reference:'TRANSIT-01',bic:'TESTGB2LXXX',accountNumber:'TRANSIT-ACCOUNT'};
const register={cash_account_id:cash,institution_name:account.institutionName,institution_type:'CORRESPONDENT_BANK',iban_or_account_no:account.accountNumber,bic_code:account.bic,currency_code:'EUR',bank_address:'1 Bank Road',account_name:'Settlement holder',aba:'',bank_reference:'BANK-REG-01',available_balance:'999999999',locked_balance:'888888888',bank_connectors:'PRIVATE_CONNECTOR_VALUE',card_gateways:'PRIVATE_GATEWAY_VALUE',intermediaries:[intermediary,{intermediaryId:'42000000-0000-4000-8000-000000000002',bankName:'TBA',bankAddress:'N/A',accountName:'NA',reference:'—'}]};
const statement={statementId,reference:'BANK-STATEMENT-01',currency:'EUR',openingBalance:'125.000000000000000001',closingBalance:'225.250000000000000001',importedAt:'2026-11-23T09:30:00Z',entryCount:2};
const entries=[{bankReference:'BANK-CREDIT-01',direction:'CREDIT',amount:'110.250000000000000001'},{bankReference:'BANK-DEBIT-02',direction:'DEBIT',amount:'10.000000000000000001'}];
const session={admin:true,canSwitchWorkspace:false,username:'Fixture operator',csrf:'fixture-csrf'};

before(async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture.invalid'),json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
  try{
   if(url.pathname==='/'){
    const id=url.searchParams.get('case');cases.set(id,{writes:[],unexpected:[]});res.setHeader('set-cookie','nostro_fixture='+id+'; SameSite=Strict; Path=/');res.setHeader('content-type','text/html');return res.end(html);
   }
   const id=/(?:^|;\s*)nostro_fixture=([^;]+)/.exec(req.headers.cookie||'')?.[1],state=cases.get(id);
   if(url.pathname.startsWith('/api/')&&!state){res.statusCode=400;return json({message:'Missing browser fixture'});}
   if(req.method==='POST'){
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw);state.writes.push({path:url.pathname,input});
    if(['/api/correspondents','/api/correspondents/details'].includes(url.pathname))return json({cashAccountId:cash});
    if(url.pathname==='/api/logout')return json({});
    state.unexpected.push(url.pathname);res.statusCode=400;return json({message:'Unexpected fixture write'});
   }
   if(url.pathname==='/api/session')return json(session);
   if(url.pathname.startsWith('/api/views/'))return json({rows:({nostroclearing:[register],nostromovements:[{created_at:'2026-11-23T08:00:00Z',institution_name:account.institutionName,currency_code:'EUR',direction:'DEBIT',amount:'3',running_balance:'3',external_reference:'INTERNAL-LEDGER-ONLY',source:'MANUAL',event_type:'MIRROR'}]})[url.pathname.split('/').at(-1)]||[]});
   if(url.pathname==='/api/nostro/'+cash+'/statements')return json({account,statements:[statement],nextCursor:null});
   if(url.pathname==='/api/nostro/'+cash+'/statements/'+statementId)return json({account,statement,entries});
   if(/^\/[a-z][a-z0-9-]*\.(mjs|css)$/.test(url.pathname)){
    res.setHeader('content-type',url.pathname.endsWith('.css')?'text/css':'text/javascript');return res.end(await readFile(new URL('../public'+url.pathname,import.meta.url)));
   }
   if(url.pathname.startsWith('/api/'))state.unexpected.push(url.pathname);
   res.statusCode=404;res.end();
  }catch(error){res.statusCode=500;json({message:error.message});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

async function popupFits(popup,width){
 const size=await popup.evaluate(el=>{const box=el.getBoundingClientRect();return {x:box.x,y:box.y,right:box.right,bottom:box.bottom,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,count:document.querySelectorAll('dialog[open]').length,documentWidth:document.documentElement.scrollWidth};});
 assert.equal(size.count,1);assert.ok(size.x>=0&&size.right<=width+1);assert.ok(size.y>=0&&size.bottom<=1001);assert.ok(size.scrollWidth<=size.clientWidth+1,'popup has no horizontal clipping');assert.ok(size.documentWidth<=width+1,'page fits viewport');
}
async function save(page,state){
 const before=state.writes.length;
 await page.locator('#submit-action').click();await page.waitForFunction(()=>!document.querySelector('#form-dialog').open);assert.equal(state.writes.length,before+1);
 await page.waitForFunction(()=>document.querySelector('#panels')?.getAttribute('aria-busy')==='false');
 return state.writes.at(-1).input;
}

for(const width of [390,834,1440])test('NOSTRO register, optional intermediary and external statement popup work at '+width+'px',async()=>{
 const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[],external=[];
 page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===base)return route.continue();external.push(route.request().url());return route.abort();});
 try{
  await page.goto(base+'/?case='+width+'#accounts');const state=cases.get(String(width)),table=page.locator('[data-nostro-register]');await table.waitFor();
  assert.deepEqual(await table.locator('th').allTextContents(),['Bank / account details','External settlement account','Currency','Manage']);
  assert.equal(await table.locator('[data-nostro-intermediary]').count(),1);assert.doesNotMatch(await table.textContent(),/999999999|888888888|PRIVATE_CONNECTOR_VALUE|PRIVATE_GATEWAY_VALUE|TBA|N\/A/);
  for(const action of ['edit','mirror','gateway','bank','statements'])assert.equal(await table.locator('[data-nostro-'+action+']').count(),1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await table.scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/nostro-clearing-register-'+width+'.png',fullPage:false});
  await table.locator('[data-nostro-statements]').click();const popup=page.locator('[data-nostro-statement-dialog]');await popup.locator('[data-nostro-statement]').waitFor();await popupFits(popup,width);
  await popup.locator('[data-nostro-statement]').click();await popup.locator('[data-nostro-back]').waitFor();
  assert.match(await popup.textContent(),/110\.250000000000000001/);assert.match(await popup.textContent(),/Incoming \(credit\)/);assert.match(await popup.textContent(),/Outgoing \(debit\)/);assert.match(await popup.textContent(),/Imported/);assert.doesNotMatch(await popup.textContent(),/INTERNAL-LEDGER-ONLY|Running balance|Booked balance/);
  await popupFits(popup,width);await page.screenshot({path:'test-results/nostro-clearing-statement-'+width+'.png',fullPage:false});
  if(width===1440){const handle=await popup.locator('.account-window-handle').boundingBox();await page.mouse.move(handle.x+100,handle.y+20);await page.mouse.down();await page.mouse.move(handle.x+160,handle.y+45);await page.mouse.up();assert.equal(await popup.evaluate(el=>el.style.margin),'0px');await popupFits(popup,width);}
  await popup.getByRole('button',{name:'Close external bank statements'}).click();assert.equal(await page.locator('[data-nostro-statement-dialog]').count(),0);
  assert.equal(await table.locator('[data-nostro-statements]').evaluate(el=>el===document.activeElement),true);
  await table.locator('[data-nostro-edit]').click();const form=page.locator('#action-form');await form.locator('[name=intermediarySelector]').waitFor();
  assert.equal(await form.locator('[name=intermediarySelector]').inputValue(),'');
  for(const field of await form.locator('.incoming-intermediary-fields input').all()){assert.equal(await field.inputValue(),'');assert.equal(await field.getAttribute('required'),null);assert.equal(await field.isDisabled(),true);}
  assert.equal(Object.hasOwn(await save(page,state),'intermediary'),false,'editing NOSTRO alone does not change any existing intermediary');
  await page.locator('[data-nostro-edit]').click();await form.locator('[name=intermediarySelector]').selectOption(intermediaryId);assert.equal(await form.locator('[name=intermediaryBankName]').inputValue(),intermediary.bankName);
  assert.equal(Object.hasOwn(await save(page,state),'intermediary'),false,'selecting an existing record without editing leaves it unchanged');
  await page.locator('[data-nostro-edit]').click();await form.locator('[name=intermediarySelector]').selectOption('NEW');
  await form.locator('[name=intermediaryBankAddress]').fill('3 Optional Transit Road');assert.equal(await form.locator('[name=intermediaryBankName]').inputValue(),'');
  await page.locator('#form-dialog').evaluate(el=>el.scrollTop=el.scrollHeight);await page.screenshot({path:'test-results/nostro-clearing-intermediary-'+width+'.png',fullPage:false});
  const partial=await save(page,state);assert.equal(partial.intermediary.bankAddress,'3 Optional Transit Road');assert.equal(partial.intermediary.bankName,'');assert.equal(partial.intermediary.intermediaryId,undefined);
  await page.locator('[data-form=cashaccount]').click();
  for(const field of await form.locator('.incoming-intermediary-fields input').all()){assert.equal(await field.inputValue(),'');assert.equal(await field.getAttribute('required'),null);}
  for(const [name,value] of Object.entries({institutionName:'New Fixture Bank',bic:'TESTGB2LXXX',accountNumber:'NEW-EXTERNAL-ACCOUNT',bankAddress:'4 Bank Road',accountName:'New settlement holder',reference:'NEW-BANK-REF'}))await form.locator('[name='+name+']').fill(value);
  await form.locator('[name=institutionType]').selectOption('CORRESPONDENT_BANK');await form.locator('[name=currency]').selectOption('EUR');
  assert.equal(Object.hasOwn(await save(page,state),'intermediary'),false,'new NOSTRO registration accepts no intermediary');
  await page.locator('[data-nostro-statements]').click();await page.locator('[data-nostro-statement]').waitFor();await page.evaluate(()=>location.hash='#payments');await page.locator('[data-nostro-statement-dialog]').waitFor({state:'detached'});
  await page.evaluate(()=>location.hash='#accounts');await page.locator('[data-nostro-statements]').click();await page.locator('[data-nostro-statement]').waitFor();
  await page.evaluate(()=>document.querySelector('#signout').click());await page.locator('#signin').waitFor({state:'visible'});assert.equal(await page.locator('[data-nostro-statement-dialog]').count(),0);
  assert.deepEqual(state.unexpected,[]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
