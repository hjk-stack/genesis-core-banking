import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {cryptoLedgerAccount} from '../src/crypto/rolling-ledger.mjs';
import {FinTerminal} from '../src/fin-terminal.mjs';
import {buildFinMessage,normalizeForm,newUetr,ibanValid} from '../public/fin-message.mjs';
import {createBankServer} from '../server.mjs';
import {finTerminalOwner} from './helpers/fin-example.mjs';
import {exampleForm,exampleIban} from './helpers/fin-example.mjs';

// Requested by the bank owner with the FinTerminal ISO 20022 specification: screen 1 keeps drafts, checks a message against
// the official schemas, and makes the UETR - "a UETR names one payment only".
const admin={id:'fin-terminal-admin',username:'fin-admin',admin:true},guest={id:'guest',admin:false};
let pool,db,fin,register,sender,nostro,holder,commonEur,commonUsd,suspense,nostroUsd,closed,longNumber,wallets;
const form=(overrides={})=>({...exampleForm(),uetr:newUetr(),...overrides});
const refused=code=>error=>error.code===code;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 fin=new FinTerminal(pool);register=new AccountManagement(pool,{directory:{env:{}}});
 sender=(await register.openCustomer(admin,{fullName:'Example Sender',accountType:'PERSONAL',currencies:['EUR']},randomUUID())).accounts[0];
 nostro=await register.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:'EXMPDEFFXXX',accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 // Step 3's lists: Common and Suspense accounts, NOSTRO accounts (one in dollars, one closed), and wallets of the wallet scroller.
 [commonEur,commonUsd]=(await register.openAccount(admin,{accountType:'COMMON',fullName:'Example Common',currencies:['EUR','USD']},randomUUID())).managedAccounts;
 suspense=(await register.openAccount(admin,{accountType:'SUSPENSE',fullName:'Example Suspense',currencies:['EUR']},randomUUID())).managedAccounts[0];
 nostroUsd=await register.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example Dollar NOSTRO',bic:'EXMPUS33XXX',accountNumber:'NOSTRO-EXAMPLE-2',currency:'USD'},randomUUID());
 closed=await register.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example Closed NOSTRO',bic:'EXMPGB2LXXX',accountNumber:'NOSTRO-EXAMPLE-3',currency:'EUR'},randomUUID());
 await pool.query('UPDATE avis_core_v2.external_cash_accounts SET is_active=false WHERE cash_account_id=$1',[closed.id]);
 // The register keeps account numbers of up to 128 characters; the message's settlement account holds 34.
 longNumber=await register.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example Long NOSTRO',bic:'EXMPNL2AXXX',accountNumber:'NOSTRO-'+'0'.repeat(40),currency:'EUR'},randomUUID());
 holder=(await pool.query('SELECT user_id FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[sender.accountId])).rows[0].user_id;
 wallets={usdc:await cryptoLedgerAccount(pool,{userId:holder,currency:'USDC',network:'ETHEREUM'}),ag:await cryptoLedgerAccount(pool,{userId:holder,currency:'AG',network:'ETHEREUM'}),
  agi:await cryptoLedgerAccount(pool,{userId:holder,currency:'AGi',network:'ETHEREUM'}),custody:await cryptoLedgerAccount(pool,{userId:holder,currency:'USDC',network:'SOLANA',scope:'CUSTODY'})};
});
after(async()=>{if(db)await db.close();else await pool.end()});

test('a draft keeps the form as written and its message as built; saved again, it needs the revision it was opened at',async()=>{
 const written=form({debtorIban:exampleForm().debtorIban.replace(/(.{4})/g,'$1 ').toLowerCase()});
 const saved=await fin.save(admin,{form:written});
 assert.equal(saved.revision,1);assert.equal(saved.schemaValid,true);assert.equal(saved.uetr,written.uetr);
 assert.deepEqual(saved.form,normalizeForm(written));assert.equal(saved.xml,buildFinMessage(normalizeForm(written)));
 assert.equal(saved.updatedBy,admin.id);assert.equal(saved.creditorName,'Example Creditor SARL');
 const listed=(await fin.drafts(admin)).find(row=>row.draftId===saved.draftId);
 assert.deepEqual(listed,{draftId:saved.draftId,revision:1,uetr:written.uetr,messageType:'pacs.008.001.08',amount:'1250000.00',currency:'EUR',
  creditorName:'Example Creditor SARL',debtorName:'Example Debtor GmbH',schemaValid:true,direction:'OUTGOING',registered:false,updatedAt:saved.updatedAt,updatedBy:admin.id,
  conversion:null,transacted:null});
 assert.deepEqual(await fin.draft(admin,saved.draftId),saved);
 const changed=await fin.save(admin,{draftId:saved.draftId,revision:1,form:{...saved.form,amount:'990.50'}});
 assert.equal(changed.revision,2);assert.equal(changed.draftId,saved.draftId);assert.match(changed.xml,/<IntrBkSttlmAmt Ccy="EUR">990\.50<\/IntrBkSttlmAmt>/);
 // Saved meanwhile elsewhere: the older copy is refused, the draft stays as last saved.
 await assert.rejects(fin.save(admin,{draftId:saved.draftId,revision:1,form:{...saved.form,amount:'1.00'}}),e=>e.code==='FIN_DRAFT_CHANGED'&&e.status===409);
 assert.equal((await fin.draft(admin,saved.draftId)).form.amount,'990.50');
 await assert.rejects(fin.save(admin,{draftId:saved.draftId,form:saved.form}),e=>e.code==='INVALID_FIELD'&&e.field==='revision');
 for(const draftId of [randomUUID(),'not-a-draft']){
  await assert.rejects(fin.save(admin,{draftId,revision:1,form:form()}),e=>e.code==='FIN_DRAFT_NOT_FOUND'&&e.status===404);
  await assert.rejects(fin.draft(admin,draftId),e=>e.code==='FIN_DRAFT_NOT_FOUND'&&e.status===404);
 }
});

test('an IBAN written in groups of four is counted without its spaces: the longest, 34 characters, is kept (review finding)',async()=>{
 const longest=exampleIban('MT','EXMP'+'0'.repeat(25)+'1'),grouped=longest.replace(/(.{4})/g,'$1 ').trim();
 assert.equal(longest.length,34);assert.equal(grouped.length,42);
 const saved=await fin.save(admin,{form:form({debtorIban:grouped})});
 assert.equal(saved.form.debtorIban,longest);assert.equal(saved.schemaValid,true);
 assert.deepEqual(await fin.validate(admin,{form:form({debtorIban:grouped}),xml:buildFinMessage(form({debtorIban:longest}))}),{valid:true,errors:[]});
 // One character more than the schema's IBAN is refused, written in groups or not.
 for(const iban of [longest+'0',grouped+'0'])await assert.rejects(fin.save(admin,{form:form({debtorIban:iban})}),e=>e.code==='INVALID_FIELD'&&e.field==='debtorIban');
});

test('an unfinished draft is kept, marked as not passing: an empty name, a missing amount, an amount of zero',async()=>{
 for(const overrides of [{debtorName:''},{amount:''},{amount:'0.00'}]){
  const saved=await fin.save(admin,{form:form(overrides)});
  assert.equal(saved.schemaValid,false,JSON.stringify(overrides));
  assert.deepEqual((await fin.draft(admin,saved.draftId)).form,normalizeForm({...saved.form}));
 }
 // Any account number passes (the bank owner: "Accept all account numbers"): an IBAN whose check digits do not match, or a bank's own.
 const iban=exampleForm().debtorIban,wrong=iban.slice(0,-1)+((Number(iban.at(-1))+1)%10);
 for(const debtorIban of [wrong,'0012-345678-90']){
  const saved=await fin.save(admin,{form:form({debtorIban})});
  assert.deepEqual([saved.schemaValid,saved.form.debtorIban],[true,debtorIban]);
 }
});

test('a UETR names one payment only: another draft\'s, an IP-to-IP transfer\'s or a bank payment\'s is refused',async()=>{
 const first=await fin.save(admin,{form:form()});
 await assert.rejects(fin.save(admin,{form:form({uetr:first.uetr})}),e=>e.code==='FIN_UETR_DUPLICATE'&&e.status===409&&e.field==='uetr');
 // The draft's own UETR is no duplicate of itself, also written in capitals.
 assert.equal((await fin.save(admin,{draftId:first.draftId,revision:1,form:{...first.form,uetr:first.uetr.toUpperCase()}})).revision,2);
 // An IP-to-IP transfer on the NOSTRO account, and a bank payment prepared in the payment register, each with its UETR.
 const transfer=newUetr();
 await pool.query(`INSERT INTO avis_core_v2.interbank_ip_transfers(uetr,direction,cash_account_id,debtor_iban,creditor_iban,currency_code,amount,raw_iso_payload)
  VALUES($1,'OUTBOUND',$2,'EXAMPLE-DEBTOR','EXAMPLE-CREDITOR','EUR',10,'{}'::jsonb)`,[transfer,nostro.id]);
 const prepared=await register.preparePayment(admin,{from:sender.abiqIban,currency:'EUR',amount:'10.00',receiverAccount:exampleIban('FR','00000000000000000000123'),
  receiverBic:'SMPLFRPPXXX',receiverName:'Example Creditor',address:{street:'1 Example Street',city:'Example City',postalCode:'00000',country:'FR'},reference:'Example'},randomUUID());
 const payment=(await pool.query('SELECT uetr FROM avis_core_v2.payment_requests WHERE request_id=$1',[prepared.id])).rows[0].uetr;
 for(const uetr of [transfer,payment]){
  await assert.rejects(fin.save(admin,{form:form({uetr})}),refused('FIN_UETR_DUPLICATE'));
  await assert.rejects(fin.save(admin,{draftId:first.draftId,revision:2,form:{...first.form,uetr}}),refused('FIN_UETR_DUPLICATE'));
  const checked=await fin.validate(admin,{form:form({uetr}),xml:buildFinMessage(form({uetr}))});
  assert.equal(checked.valid,false);assert.deepEqual(checked.errors,['uetr: already used by another payment or draft.']);
 }
 assert.equal((await fin.draft(admin,first.draftId)).revision,2);
 // Two saves of one new UETR at the same moment: one is kept, the other refused.
 const uetr=newUetr(),results=await Promise.allSettled([fin.save(admin,{form:form({uetr})}),fin.save(admin,{form:form({uetr})})]);
 assert.deepEqual(results.map(result=>result.status).sort(),['fulfilled','rejected']);
 assert.equal(results.find(result=>result.status==='rejected').reason.code,'FIN_UETR_DUPLICATE');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.fin_terminal_drafts WHERE uetr=$1',[uetr])).rows[0].n,1);
});

test('the check answers with the schemas\' own words and the checks the schemas leave out',async()=>{
 const written=form();
 assert.deepEqual(await fin.validate(admin,{form:written,xml:buildFinMessage(written)}),{valid:true,errors:[]});
 const saved=await fin.save(admin,{form:written});
 // A draft's own UETR is no duplicate when that draft is checked.
 assert.deepEqual(await fin.validate(admin,{form:written,xml:buildFinMessage(written),draftId:saved.draftId}),{valid:true,errors:[]});
 const broken=await fin.validate(admin,{form:form(),xml:buildFinMessage(form({senderBic:'BAD'}))});
 assert.equal(broken.valid,false);assert.match(broken.errors.join('\n'),/^AppHdr: Element 'BICFI': \[facet 'pattern'\] The value 'BAD'/m);
 const zero=await fin.validate(admin,{form:form({amount:'0.00'}),xml:buildFinMessage(form())});
 assert.deepEqual(zero.errors.map(error=>error.split(':')[0]),['amount']);
 for(const xml of ['<!DOCTYPE x [<!ENTITY e "x">]><Envelope/>','',null,'x'.repeat(65536)])
  await assert.rejects(fin.validate(admin,{form:form(),xml}),refused('FIN_MESSAGE_INVALID'));
});

test('only a bank administrator: a customer, or an administrator in a customer\'s workspace, is refused',async()=>{
 const saved=await fin.save(admin,{form:form()});
 for(const actor of [guest,{id:admin.id+':customer:1',admin:false,customerUserId:'1'},null]){
  await assert.rejects(fin.drafts(actor),refused('FORBIDDEN'));await assert.rejects(fin.draft(actor,saved.draftId),refused('FORBIDDEN'));
  await assert.rejects(fin.save(actor,{form:form()}),refused('FORBIDDEN'));
  await assert.rejects(fin.validate(actor,{form:form(),xml:buildFinMessage(form())}),refused('FORBIDDEN'));
 }
});

test('the accounts to choose: the Common and Suspense accounts, the NOSTRO register and the "+" wallets - never AG or AGi',async()=>{
 const listed=await fin.accounts(admin),booking=Object.fromEntries(listed.bookingAccounts.map(account=>[account.accountId,account]));
 assert.deepEqual([commonEur.id,commonUsd.id,suspense.id].map(id=>[booking[id].type,booking[id].label,booking[id].currency]),
  [['COMMON','Example Common','EUR'],['COMMON','Example Common','USD'],['SUSPENSE','Example Suspense','EUR']]);
 // The bank's own account: its IBAN, the bank's BIC and name - the debtor's account when the message is booked against it.
 assert.equal(booking[commonEur.id].iban,commonEur.abiqIban);assert.ok(ibanValid(commonEur.abiqIban));
 assert.match(booking[commonEur.id].bic,/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/);assert.ok(booking[commonEur.id].institution);
 assert.equal(booking[sender.accountId],undefined,'a customer account is not booked against here');
 const nostros=Object.fromEntries(listed.nostroAccounts.map(account=>[account.accountId,account]));
 assert.deepEqual(nostros[nostro.id],{accountId:nostro.id,institution:'Example NOSTRO',bic:'EXMPDEFFXXX',account:'NOSTRO-EXAMPLE-1',accountName:'',currency:'EUR',active:true,settles:true});
 assert.equal(nostros[nostroUsd.id].currency,'USD');assert.equal(nostros[closed.id].active,false);
 // A number longer than the settlement account holds is offered for an incoming transfer only: nothing of it is written in the message.
 assert.equal(nostros[longNumber.id].settles,false);
 const offered=listed.tokenWallets.map(wallet=>wallet.accountId);
 assert.deepEqual(listed.tokenWallets.find(wallet=>wallet.accountId===wallets.usdc),{accountId:wallets.usdc,holder:'Example Sender',currency:'USDC',network:'ETHEREUM',name:'USDC'});
 for(const excluded of [wallets.ag,wallets.agi,wallets.custody,commonEur.id])assert.ok(!offered.includes(excluded),excluded);
 assert.ok(listed.tokenWallets.every(wallet=>!['AG','AGi'].includes(wallet.currency)));
 for(const actor of [guest,{id:admin.id+':customer:'+holder,admin:false,customerUserId:String(holder)}])await assert.rejects(fin.accounts(actor),refused('FORBIDDEN'));
});

// A message as the terminal writes it for chosen accounts: the debtor's account, INDA and the settlement account.
async function written(selection,overrides={}){
 const listed=await fin.accounts(admin),booking=listed.bookingAccounts.find(account=>account.accountId===selection.bookingAccountId),
  nostroAccount=listed.nostroAccounts.find(account=>account.accountId===selection.nostroAccountId);
 return form({...(booking?{debtorName:booking.institution,debtorIban:booking.iban,debtorAgentBic:booking.bic}:{}),
  ...(nostroAccount?{settlement:'INDA',settlementAccount:nostroAccount.account}:{}),...overrides});
}

test('a draft keeps its chosen accounts; each must be one the terminal offers, in the message\'s currency',async()=>{
 const selection={bookingAccountId:commonEur.id,nostroAccountId:nostro.id,tokenWalletId:wallets.usdc};
 const saved=await fin.save(admin,{form:await written(selection),selection});
 assert.deepEqual(saved.selection,selection);assert.deepEqual((await fin.draft(admin,saved.draftId)).selection,selection);
 assert.equal((await fin.drafts(admin)).find(row=>row.draftId===saved.draftId).selection,undefined);
 // Saved again without them, the draft keeps none.
 assert.deepEqual((await fin.save(admin,{draftId:saved.draftId,revision:1,form:saved.form})).selection,{bookingAccountId:null,nostroAccountId:null,tokenWalletId:null});
 const count=async()=>(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.fin_terminal_drafts')).rows[0].n,before=await count();
 for(const [choice,code] of [
  [{bookingAccountId:commonUsd.id},'FIN_BOOKING_ACCOUNT'],[{bookingAccountId:sender.accountId},'FIN_BOOKING_ACCOUNT'],[{bookingAccountId:randomUUID()},'FIN_BOOKING_ACCOUNT'],
  [{nostroAccountId:closed.id},'FIN_NOSTRO_ACCOUNT'],[{nostroAccountId:nostroUsd.id},'FIN_NOSTRO_ACCOUNT'],[{nostroAccountId:longNumber.id},'FIN_NOSTRO_ACCOUNT'],
  [{tokenWalletId:wallets.ag},'FIN_TOKEN_WALLET'],[{tokenWalletId:wallets.agi},'FIN_TOKEN_WALLET'],[{tokenWalletId:wallets.custody},'FIN_TOKEN_WALLET'],[{tokenWalletId:commonEur.id},'FIN_TOKEN_WALLET']])
  await assert.rejects(fin.save(admin,{form:form(),selection:choice}),e=>e.code===code&&e.status===409&&e.field===Object.keys(choice)[0],JSON.stringify(choice));
 for(const [choice,field] of [[{bookingAccountId:'not-an-account'},'bookingAccountId'],[[],'selection'],['selection','selection']])
  await assert.rejects(fin.save(admin,{form:form(),selection:choice}),e=>e.code==='INVALID_FIELD'&&e.field===field,field);
 // A message that names other accounts than the ones chosen is refused (review finding).
 for(const [choice,overrides,code] of [
  [{bookingAccountId:commonEur.id},{debtorIban:exampleForm().debtorIban},'FIN_BOOKING_MISMATCH'],[{bookingAccountId:commonEur.id},{debtorAgentBic:'EXMPDEFFXXX'},'FIN_BOOKING_MISMATCH'],
  [{nostroAccountId:nostro.id},{settlement:'CLRG/TGT'},'FIN_NOSTRO_MISMATCH'],[{nostroAccountId:nostro.id},{settlementAccount:'NOSTRO-OTHER-9'},'FIN_NOSTRO_MISMATCH']])
  await assert.rejects(fin.save(admin,{form:await written(choice,overrides),selection:choice}),e=>e.code===code&&e.status===409&&e.field===Object.keys(choice)[0],code+' '+JSON.stringify(overrides));
 assert.equal(await count(),before);
 // The NOSTRO is never a bank's BIC (the bank owner: "the nostro is selected by the currency not by the BIC"): the receiver is any bank.
 for(const receiverBic of ['SMPLFRPPXXX','EXMPDEFFXXX'])
  assert.equal((await fin.save(admin,{form:await written({nostroAccountId:nostro.id},{receiverBic}),selection:{nostroAccountId:nostro.id}})).selection.nostroAccountId,nostro.id);
 // In dollars, the dollar accounts are the ones to choose.
 const dollars={bookingAccountId:commonUsd.id,nostroAccountId:nostroUsd.id};
 assert.deepEqual((await fin.save(admin,{form:await written(dollars,{currency:'USD'}),selection:{...dollars,bookingAccountId:commonUsd.id.toUpperCase()}})).selection,
  {...dollars,tokenWalletId:null});
});

test('fields are checked before anything is kept: length, kind, control characters, the message type and the UETR',async()=>{
 const before=(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.fin_terminal_drafts')).rows[0].n;
 for(const [field,value] of [['creditorName','X'.repeat(141)],['debtorIban','DE'.repeat(18)],['amount',1250],['debtorName','Example\u0000Debtor'],
  ['messageType','pacs.009.001.08'],['uetr','not-a-uetr'],['uetr','9b1deb4d-3b7d-1bad-9bdd-2b0d7b3dcb6d']])
  await assert.rejects(fin.save(admin,{form:form({[field]:value})}),e=>e.code==='INVALID_FIELD'&&e.field===field,field);
 for(const value of [null,[],'form'])await assert.rejects(fin.save(admin,{form:value}),e=>e.code==='INVALID_FIELD'&&e.field==='form');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.fin_terminal_drafts')).rows[0].n,before);
});

test('over HTTP: a signed-in bank administrator with the session\'s CSRF token saves, lists, opens and checks drafts',async()=>{
 const server=createBankServer({pool,authenticate:async()=>admin,finTerminalAccess:async()=>finTerminalOwner,secureCookies:false});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/api/fin-terminal/drafts')).status,401);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  const post=(path,body,token=csrf)=>fetch(base+path,{method:'POST',headers:{origin:base,cookie,'content-type':'application/json',...(token?{'x-csrf-token':token}:{})},body:JSON.stringify(body)});
  const written=form();
  const unprotected=await post('/api/fin-terminal/drafts',{form:written},null);
  assert.equal(unprotected.status,403);assert.equal((await unprotected.json()).code,'CSRF');
  const saved=await post('/api/fin-terminal/drafts',{form:written});assert.equal(saved.status,200);
  const {draft}=await saved.json();assert.equal(draft.uetr,written.uetr);assert.equal(draft.schemaValid,true);
  const listed=await (await fetch(base+'/api/fin-terminal/drafts',{headers:{cookie}})).json();
  assert.ok(listed.rows.some(row=>row.draftId===draft.draftId&&!('xml' in row)));
  const opened=await (await fetch(base+'/api/fin-terminal/drafts/'+draft.draftId,{headers:{cookie}})).json();
  assert.equal(opened.draft.xml,buildFinMessage(normalizeForm(written)));
  const missing=await fetch(base+'/api/fin-terminal/drafts/'+randomUUID(),{headers:{cookie}});
  assert.equal(missing.status,404);assert.equal((await missing.json()).code,'FIN_DRAFT_NOT_FOUND');
  const duplicate=await post('/api/fin-terminal/drafts',{form:written});
  assert.equal(duplicate.status,409);assert.deepEqual((({code,field,message})=>({code,field,message}))(await duplicate.json()),
   {code:'FIN_UETR_DUPLICATE',field:'uetr',message:'This UETR is already used by another payment or draft. Make a new UETR.'});
  const other=form(),checked=await post('/api/fin-terminal/validate',{form:other,xml:buildFinMessage(other)});
  assert.equal(checked.status,200);assert.deepEqual(await checked.json(),{valid:true,errors:[]});
  const accounts=await fetch(base+'/api/fin-terminal/accounts',{headers:{cookie}});assert.equal(accounts.status,200);
  assert.ok((await accounts.json()).accounts.bookingAccounts.some(account=>account.accountId===commonEur.id));
  const chosen=await post('/api/fin-terminal/drafts',{form:form(),selection:{nostroAccountId:nostroUsd.id}});
  assert.equal(chosen.status,409);assert.deepEqual((({code,field,message})=>({code,field,message}))(await chosen.json()),
   {code:'FIN_NOSTRO_ACCOUNT',field:'nostroAccountId',message:'Select an active NOSTRO account in the message\'s currency.'});
  // Changed to a customer's workspace, the same sign-in no longer reaches the terminal.
  await pool.query('UPDATE avis_core_v2.operator_sessions SET workspace_user_id=$2 WHERE actor_id=$1',[admin.id,holder]);
  assert.equal((await fetch(base+'/api/fin-terminal/drafts',{headers:{cookie}})).status,403);
  assert.equal((await fetch(base+'/api/fin-terminal/accounts',{headers:{cookie}})).status,403);
  assert.equal((await post('/api/fin-terminal/drafts',{form:form()})).status,403);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
