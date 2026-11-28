import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {FinTerminal} from '../src/fin-terminal.mjs';
import {buildFinMessage,normalizeForm,newUetr} from '../public/fin-message.mjs';
import {createBankServer} from '../server.mjs';
import {finTerminalOwner} from './helpers/fin-example.mjs';
import {exampleForm} from './helpers/fin-example.mjs';

// Requested by the bank owner: "We now register an incoming transfer so AVISPay PLC is the receiver" - AVISPay PLC's chosen
// account on the creditor side, the NOSTRO where the money arrives as the sender - and then "All Nostro we control manually not
// automatically": registered, the money is booked at once on the NOSTRO and on the chosen account (specification v3,
// "CORE_BANKING_&_NOSTRO", ACSC).
const admin={id:'fin-incoming-admin',username:'fin-incoming',admin:true},guest={id:'guest',admin:false};
let pool,db,fin,suspense,account,nostro,nostroLedger;
const refused=(code,field)=>error=>error.code===code&&(field===undefined||error.field===field);
// The example transfer turned round: the example debtor sends, AVISPay PLC's chosen account receives through the NOSTRO.
const incoming=(overrides={})=>({...exampleForm(),uetr:newUetr(),senderBic:'EXMPDEFFXXX',receiverBic:account.bic,settlement:'INGA',
 settlementAccount:'NOSTRO-EXAMPLE-1',creditorName:account.institution,creditorIban:account.iban,creditorAgentBic:account.bic,...overrides});
// The NOSTRO's and the chosen account's balances, in cents.
const balances=async()=>Object.fromEntries((await pool.query(`SELECT account_id::text,(available_balance*100)::bigint::text AS cents FROM avis_core_v2.ledger_accounts
 WHERE account_id=ANY($1::uuid[])`,[[suspense.id,nostroLedger]])).rows.map(row=>[row.account_id===suspense.id?'account':'nostro',BigInt(row.cents)]));
const registrations=async()=>(await pool.query(`SELECT (SELECT count(*) FROM avis_core_v2.ledger_journals WHERE event_type='FIN_INCOMING_BOOKED')::int AS journals,
 (SELECT count(*) FROM avis_core_v2.fin_terminal_drafts)::int AS drafts`)).rows[0];
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 fin=new FinTerminal(pool);const bank=new AccountManagement(pool,{directory:{env:{}}});
 suspense=(await bank.openAccount(admin,{accountType:'SUSPENSE',fullName:'AVISPay PLC',currencies:['EUR']},randomUUID())).managedAccounts[0];
 account=(await fin.accounts(admin)).bookingAccounts.find(item=>item.accountId===suspense.id);
 nostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:'EXMPDEFFXXX',accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 nostroLedger=(await pool.query('SELECT ledger_account_id FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1',[nostro.id])).rows[0].ledger_account_id;
});
after(async()=>{if(db)await db.close();else await pool.end()});

test('registered, an incoming transfer is booked at once on the NOSTRO and on AVISPay PLC\'s chosen account',async()=>{
 const selection={bookingAccountId:suspense.id,nostroAccountId:nostro.id},written=incoming(),before=await balances();
 const registered=await fin.register(admin,{form:written,selection});
 assert.equal(registered.direction,'INCOMING');assert.equal(registered.registered,true);assert.equal(registered.schemaValid,true);
 assert.match(registered.registeredAt,/^\d{4}-\d{2}-\d{2}T/);assert.equal(registered.revision,1);
 assert.deepEqual(registered.selection,{...selection,tokenWalletId:null});assert.equal(registered.xml,buildFinMessage(normalizeForm(written)));
 // AVISPay PLC is the creditor; the NOSTRO's bank sends, the instructing agent settling over the NOSTRO account.
 const message=registered.xml.replace(/\n\s*/g,'');
 assert.ok(message.includes('<Cdtr><Nm>AVISPay PLC</Nm></Cdtr><CdtrAcct><Id><IBAN>'+account.iban+'</IBAN></Id></CdtrAcct>'));
 assert.ok(message.includes('<SttlmInf><SttlmMtd>INGA</SttlmMtd><SttlmAcct><Id><Othr><Id>NOSTRO-EXAMPLE-1</Id></Othr></Id></SttlmAcct></SttlmInf>'));
 // On the NOSTRO, where the money arrived, and on the chosen account, AVISPay PLC's.
 const entries=(await pool.query(`SELECT j.event_type,j.reference_id,e.direction,e.amount::numeric(20,2)::text AS amount,a.owner_type,a.account_category,a.sub_account_code,a.currency_code
  FROM avis_core_v2.fin_terminal_drafts d JOIN avis_core_v2.ledger_journals j ON j.journal_id=d.registered_journal_id
  JOIN avis_core_v2.ledger_entries e USING(journal_id) JOIN avis_core_v2.ledger_accounts a USING(account_id) WHERE d.draft_id=$1 ORDER BY e.direction DESC`,[registered.draftId])).rows;
 assert.deepEqual(entries,[
  {event_type:'FIN_INCOMING_BOOKED',reference_id:written.businessMessageId,direction:'DEBIT',amount:'1250000.00',owner_type:'CORRESPONDENT_NOSTRO',account_category:'ASSET',sub_account_code:entries[0].sub_account_code,currency_code:'EUR'},
  {event_type:'FIN_INCOMING_BOOKED',reference_id:written.businessMessageId,direction:'CREDIT',amount:'1250000.00',owner_type:'SUSPENSE_INBOUND',account_category:'LIABILITY',sub_account_code:entries[1].sub_account_code,currency_code:'EUR'}]);
 const after=await balances();
 assert.deepEqual([after.nostro-before.nostro,after.account-before.account],[125000000n,125000000n]);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM avis_core_v2.operation_audit WHERE operation='FIN_INCOMING_BOOKED' AND actor_id=$1",[admin.id])).rows[0].n,1);
 // Kept for good: not saved, registered or deleted again; its UETR names this payment only.
 const again={draftId:registered.draftId,revision:registered.revision,form:registered.form,selection};
 await assert.rejects(fin.save(admin,{...again,direction:'INCOMING'}),e=>refused('FIN_DRAFT_REGISTERED','draftId')(e)&&e.status===409);
 await assert.rejects(fin.register(admin,again),refused('FIN_DRAFT_REGISTERED','draftId'));
 await assert.rejects(fin.register(admin,{form:registered.form,selection}),refused('FIN_UETR_DUPLICATE','uetr'));
 await assert.rejects(pool.query('UPDATE avis_core_v2.fin_terminal_drafts SET schema_valid=false WHERE draft_id=$1',[registered.draftId]),/FIN_DRAFT_REGISTERED/);
 await assert.rejects(pool.query('DELETE FROM avis_core_v2.fin_terminal_drafts WHERE draft_id=$1',[registered.draftId]),/FIN_DRAFT_REGISTERED/);
 const listed=(await fin.drafts(admin)).find(row=>row.draftId===registered.draftId);
 assert.deepEqual([listed.direction,listed.registered,listed.debtorName,listed.creditorName],['INCOMING',true,'Example Debtor GmbH','AVISPay PLC']);
 assert.equal((await registrations()).journals,1);
});

test('an incoming draft is saved first and registered from it, at the revision it was opened at',async()=>{
 const selection={bookingAccountId:suspense.id,nostroAccountId:nostro.id},before=await balances();
 const saved=await fin.save(admin,{form:incoming({amount:'990.50'}),selection,direction:'INCOMING'});
 assert.deepEqual([saved.direction,saved.registered,saved.registeredAt],['INCOMING',false,null]);
 await assert.rejects(fin.register(admin,{draftId:saved.draftId,revision:0,form:saved.form,selection}),e=>refused('FIN_DRAFT_CHANGED','draftId')(e)&&e.status===409);
 const registered=await fin.register(admin,{draftId:saved.draftId,revision:saved.revision,form:saved.form,selection});
 assert.deepEqual([registered.draftId,registered.revision,registered.registered],[saved.draftId,2,true]);
 const after=await balances();
 assert.deepEqual([after.nostro-before.nostro,after.account-before.account],[99050n,99050n]);
});

test('nothing is booked or kept for an incoming transfer that does not name its accounts as chosen or does not pass its check',async()=>{
 const selection={bookingAccountId:suspense.id,nostroAccountId:nostro.id},before=await registrations();
 for(const [body,code,field] of [
  [{form:incoming(),selection:{nostroAccountId:nostro.id}},'FIN_BOOKING_ACCOUNT','bookingAccountId'],
  [{form:incoming(),selection:{bookingAccountId:suspense.id}},'FIN_NOSTRO_ACCOUNT','nostroAccountId'],
  [{form:incoming({currency:'USD'}),selection},'FIN_BOOKING_ACCOUNT','bookingAccountId'],
  // AVISPay PLC on the debtor side is an outgoing transfer, not an incoming one.
  [{form:incoming({creditorIban:exampleForm().creditorIban,debtorIban:account.iban}),selection},'FIN_CREDITOR_MISMATCH','bookingAccountId'],
  [{form:incoming({creditorAgentBic:'SMPLFRPPXXX'}),selection},'FIN_CREDITOR_MISMATCH','bookingAccountId'],
  // AVISPay PLC's bank is the message's receiver too (review finding).
  [{form:incoming({receiverBic:'SMPLFRPPXXX'}),selection},'FIN_CREDITOR_MISMATCH','bookingAccountId'],
  [{form:incoming({settlement:'INDA'}),selection},'FIN_NOSTRO_SENDER_MISMATCH','nostroAccountId'],
  [{form:incoming({senderBic:'SMPLFRPPXXX'}),selection},'FIN_NOSTRO_SENDER_MISMATCH','nostroAccountId'],
  [{form:incoming({settlementAccount:'NOSTRO-OTHER-9'}),selection},'FIN_NOSTRO_SENDER_MISMATCH','nostroAccountId'],
  [{form:incoming({amount:''}),selection},'FIN_INCOMING_INVALID','xml'],
  [{form:incoming({amount:'0.00'}),selection},'FIN_INCOMING_INVALID','xml'],
  [{form:incoming(),selection,draftId:randomUUID(),revision:1},'FIN_DRAFT_NOT_FOUND','draftId']])
  await assert.rejects(fin.register(admin,body),refused(code,field),code+' '+JSON.stringify(body.form?.settlement));
 await assert.rejects(fin.register(guest,{form:incoming(),selection}),e=>e.code==='FORBIDDEN'&&e.status===403);
 await assert.rejects(fin.save(admin,{form:incoming(),selection,direction:'SIDEWAYS'}),refused('INVALID_FIELD','direction'));
 assert.deepEqual(await registrations(),before);
 // An outgoing draft still names the chosen account as the debtor's: the incoming message is refused as outgoing.
 await assert.rejects(fin.save(admin,{form:incoming(),selection:{bookingAccountId:suspense.id}}),refused('FIN_BOOKING_MISMATCH','bookingAccountId'));
});

test('over HTTP: a signed-in bank administrator with the session\'s CSRF token registers an incoming transfer',async()=>{
 const server=createBankServer({pool,authenticate:async()=>admin,finTerminalAccess:async()=>finTerminalOwner,secureCookies:false});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  const post=(body,token=csrf)=>fetch(base+'/api/fin-terminal/incoming',{method:'POST',headers:{origin:base,cookie,'content-type':'application/json',...(token?{'x-csrf-token':token}:{})},body:JSON.stringify(body)});
  const selection={bookingAccountId:suspense.id,nostroAccountId:nostro.id},written=incoming();
  const unprotected=await post({form:written,selection},null);
  assert.equal(unprotected.status,403);assert.equal((await unprotected.json()).code,'CSRF');
  const registered=await post({form:written,selection});assert.equal(registered.status,200);
  const {draft}=await registered.json();assert.deepEqual([draft.uetr,draft.direction,draft.registered],[written.uetr,'INCOMING',true]);
  const again=await post({draftId:draft.draftId,revision:draft.revision,form:draft.form,selection});
  assert.equal(again.status,409);assert.deepEqual((({code,field,message})=>({code,field,message}))(await again.json()),
   {code:'FIN_DRAFT_REGISTERED',field:'draftId',message:'This incoming transfer is registered and is not changed any more.'});
  const outgoing=await post({form:incoming({settlement:'INDA'}),selection});
  assert.equal(outgoing.status,409);assert.equal((await outgoing.json()).message,'The sender, INGA and the settlement account are not those of the chosen NOSTRO account.');
 }finally{await new Promise(resolve=>server.close(resolve))}
});
