import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {SovereignCore} from '../src/core.mjs';
import {buildFinMessage,normalizeForm,newUetr} from '../public/fin-message.mjs';
import {exampleForm} from './helpers/fin-example.mjs';

// The bank owner: "All Nostro we control manually not automatically". An incoming transfer registered before on the bank's
// inbound suspense (migration 056's way) is booked by migration 057 as one registered now: on the NOSTRO and on AVISPay PLC's
// chosen account, the suspense cleared.
const admin={id:'fin-booked-admin',username:'fin-booked',admin:true};
let pool,db,folder;
after(async()=>{if(folder)await rm(folder,{recursive:true,force:true});if(db)await db.close();else if(pool)await pool.end();});

test('an incoming transfer registered on the suspense before migration 057 is booked on the NOSTRO and the chosen account',async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const run=async directory=>{const connection=await pool.connect();try{await migrate(connection,directory)}finally{connection.release()}};
 // The bank as it was before migration 057.
 const migrations=fileURLToPath(new URL('../migrations/',import.meta.url));
 folder=await mkdtemp(path.join(tmpdir(),'fin-057-'));
 for(const name of (await readdir(migrations)).filter(name=>/^\d{3}_[a-z_]+\.sql$/.test(name)&&name<'057'))await copyFile(path.join(migrations,name),path.join(folder,name));
 await run(pathToFileURL(folder+path.sep));
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 const suspense=(await bank.openAccount(admin,{accountType:'SUSPENSE',fullName:'AVISPay PLC',currencies:['EUR']},randomUUID())).managedAccounts[0];
 const nostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:'EXMPDEFFXXX',accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 const nostroLedger=(await pool.query('SELECT ledger_account_id FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1',[nostro.id])).rows[0].ledger_account_id;
 // Registered as migration 056's code did: expected at the NOSTRO, owed for it, both on the inbound suspense.
 const form=normalizeForm({...exampleForm(),uetr:newUetr()}),core=new SovereignCore(null),client=await pool.connect();
 try{
  await client.query('BEGIN');
  const expected=await core.system(client,'SUSPENSE_INBOUND','EUR','FIN_EXPECTED:'+nostro.id,'ASSET');
  const owed=await core.system(client,'SUSPENSE_INBOUND','EUR','FIN_INCOMING:'+nostro.id);
  const journalId=await core.post(client,admin,'fin-incoming:'+form.uetr,'FIN_INCOMING_REGISTERED',form.businessMessageId,
   [{accountId:expected,direction:'DEBIT',amount:form.amount},{accountId:owed,direction:'CREDIT',amount:form.amount}]);
  await client.query(`INSERT INTO avis_core_v2.fin_terminal_drafts(draft_id,uetr,message_type,revision,form,message,schema_valid,created_by,updated_by,
   booking_account_id,nostro_cash_account_id,direction,registered_journal_id,registered_at,registered_by)
   VALUES($1,$2,'pacs.008.001.08',1,$3::jsonb,$4,true,$5,$5,$6,$7,'INCOMING',$8,now(),$5)`,
   [randomUUID(),form.uetr,JSON.stringify(form),buildFinMessage(form),admin.id,suspense.id,nostro.id,journalId]);
  await client.query('COMMIT');
 }finally{client.release?.();}
 const balance=async(where,values)=>(await pool.query('SELECT available_balance::numeric(20,2)::text AS b FROM avis_core_v2.ledger_accounts WHERE '+where,values)).rows[0].b;
 const suspenseOf=bucket=>balance("owner_type='SUSPENSE_INBOUND' AND sub_account_code=$1",[bucket+nostro.id]);
 assert.deepEqual([await balance('account_id=$1',[nostroLedger]),await balance('account_id=$1',[suspense.id]),await suspenseOf('FIN_EXPECTED:'),await suspenseOf('FIN_INCOMING:')],
  ['0.00','0.00','1250000.00','1250000.00']);
 // Migration 057: booked on the NOSTRO and on the chosen account; the suspense cleared.
 await run();
 assert.deepEqual([await balance('account_id=$1',[nostroLedger]),await balance('account_id=$1',[suspense.id]),await suspenseOf('FIN_EXPECTED:'),await suspenseOf('FIN_INCOMING:')],
  ['1250000.00','1250000.00','0.00','0.00']);
 const journal=(await pool.query('SELECT event_type,reference_id,actor_id FROM avis_core_v2.ledger_journals WHERE idempotency_key=$1',['fin-incoming-booked:'+form.uetr])).rows[0];
 assert.deepEqual(journal,{event_type:'FIN_INCOMING_BOOKED',reference_id:form.businessMessageId,actor_id:'migration:057'});
});
