import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {SovereignCore} from '../src/core.mjs';
import {parseAbiqIban,resolveAbiqAccount} from '../src/avispay-core-accounts.mjs';
import {bookTreasuryOpening} from '../src/treasury-opening.mjs';

let db,pool,core,snapshot,common,suspense,legacy,cryptoIds,unbridgedFunding;
const actor={id:'bank-identifier-test',admin:true};
const rows=async(sql,args=[])=>(await pool.query(sql,args)).rows;
const sequence=async()=>Number((await rows('SELECT last_value FROM avis_core_v2.abiq_account_numbers'))[0].last_value);
const ensure=async id=>(await rows('SELECT avis_core_v2.ensure_ledger_abiq($1) AS identifier',[id]))[0].identifier;
const account=async(id)=>(await rows('SELECT * FROM avis_core_v2.abiq_account_identifiers WHERE ledger_account_id=$1',[id]))[0];
const preservedTables={
 ledger_accounts:'account_id',sovereign_users:'user_id',ledger_journals:'journal_id',ledger_entries:'entry_id',
 abiq_routing_bridge:'bridge_id',abiq_identifier_aliases:'identifier',abiq_bank_routes:'bridge_id',
 abiq_provision_requests:'user_id,participant_code,idempotency_key',abiq_customer_numbers:'user_id',
 portfolio_securities:'security_id',portfolio_positions:'position_id',portfolio_movements:'movement_id',
 treasury_opening_positions:'booking_id',operation_requests:'operation_key',operation_audit:'audit_id',
 platform_connectors:'connector_code',user_external_connectors:'binding_id',connector_outbox:'event_id'
};
async function financialSnapshot(){
 const result={};
 for(const [table,order] of Object.entries(preservedTables))result[table]=await rows(`SELECT * FROM avis_core_v2.${table} ORDER BY ${order}`);
 return result;
}
async function insertAccount(client,{owner='COMMON_POOL',currency='EUR',network=null,scope='FUNDING',user=null}={}){
 return (await client.query(`INSERT INTO avis_core_v2.ledger_accounts
  (owner_type,user_id,sub_account_code,currency_code,network,wallet_scope,account_category)
  VALUES($1,$2,$3,$4,$5,$6,'LIABILITY') RETURNING account_id`,[owner,user,'NUMBERING:'+randomUUID(),currency,network,scope])).rows[0].account_id;
}

before(async()=>{
 if(process.env.TEST_DATABASE_URL){
  const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
 }else{
  db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release(){}})};
 }
 core=new SovereignCore(pool);
 const client=await pool.connect();
 try{
  await client.query('CREATE SCHEMA avis_core_v2');
  await client.query('CREATE TABLE avis_core_v2.schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>/^\d{3}_[a-z_]+\.sql$/.test(n)&&Number(n.slice(0,3))<29).sort()){
   const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
   if(client.exec)await client.exec(sql);else await client.query(sql);
   await client.query('INSERT INTO avis_core_v2.schema_migrations(version,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);
  }
  await client.query("INSERT INTO avis_core_v2.sovereign_users(user_id,avis_account_no,full_name,account_type) VALUES(50,'EXISTING-HOLDER-50','Existing account holder','BUSINESS')");
  legacy=(await client.query("SELECT avis_core_v2.provision_abiq_accounts(50,'AVIS',ARRAY['EUR'],'existing-legacy-account') AS result")).rows[0].result[0];
  unbridgedFunding=(await client.query(`INSERT INTO avis_core_v2.ledger_accounts
   (owner_type,user_id,sub_account_code,currency_code,account_category)
   VALUES('USER',2,'ABIQ:AVIP','CHF','LIABILITY') RETURNING account_id`)).rows[0].account_id;
  common=await core.system(client,'COMMON_POOL','EUR','EXISTING-COMMON');
  suspense=await core.system(client,'SUSPENSE_INBOUND','EUR','EXISTING-SUSPENSE');
  const reserve=await core.system(client,'CORRESPONDENT_NOSTRO','EUR','EXISTING-RESERVE','ASSET');
  await core.post(client,actor,'numbering-existing-funds','FIXTURE','Preserve funded account',[
   {accountId:reserve,direction:'DEBIT',amount:'125.25'},
   {accountId:common,direction:'CREDIT',amount:'100.25'},
   {accountId:legacy.accountId,direction:'CREDIT',amount:'25'}
  ]);
  await core.post(client,actor,'numbering-existing-suspense','FIXTURE','Preserve suspense movement',[
   {accountId:common,direction:'DEBIT',amount:'12.34'},{accountId:suspense,direction:'CREDIT',amount:'12.34'}
  ]);
  await client.query("INSERT INTO avis_core_v2.platform_connectors(connector_code,display_name,is_enabled) VALUES('IDENTIFIER_FIXTURE','Existing bank route',true)");
  await client.query(`INSERT INTO avis_core_v2.abiq_bank_routes
   (bridge_id,currency_code,connector_code,provider_account_id,account_type,account_number,country_code,bank_bic,provider_reference)
   VALUES($1,'EUR','IDENTIFIER_FIXTURE','existing-holder-50','IBAN','DE89370400440532013000','DE','COBADEFFXXX','preserved-route')`,[legacy.bridgeId]);
  const security=(await client.query(`INSERT INTO avis_core_v2.portfolio_securities
   (name,short_name,currency_code,denomination,quote_basis,kind,source,created_by)
   VALUES('Existing security','EXISTING','CHF',1,'UNIT','share','MANUAL','fixture') RETURNING security_id`)).rows[0];
  const position=(await client.query(`INSERT INTO avis_core_v2.portfolio_positions
   (user_id,security_id,quantity,reserved_quantity,issuing_price,market_price)
   VALUES(1,$1,100,7,2,3) RETURNING position_id`,[security.security_id])).rows[0];
  await client.query(`INSERT INTO avis_core_v2.portfolio_movements(position_id,quantity_delta,resulting_quantity,reference,actor_id)
   VALUES($1,100,100,'Existing securities custody','fixture')`,[position.position_id]);
  cryptoIds=[
   await insertAccount(client,{owner:'SUSPENSE_OUTBOUND',currency:'BTC',network:'BITCOIN'}),
   await insertAccount(client,{owner:'SUSPENSE_OUTBOUND',currency:'EUR',network:'ETHEREUM'}),
   await insertAccount(client,{owner:'USER',user:1,currency:'TOKEN',network:'ETHEREUM',scope:'CUSTODY'})
  ];
 }finally{client.release();}
 const treasury=await bookTreasuryOpening(pool,{CONTAINER_APP_NAME:'genesis-banking-uat',CONTAINER_APP_ENV_DNS_SUFFIX:'orangemushroom-9faae382.italynorth.azurecontainerapps.io',PGDATABASE:'fineract_default'});
 cryptoIds.push(...treasury.positions.filter(p=>p.accountId).map(p=>p.accountId));
 snapshot=await financialSnapshot();
 const upgrade=await pool.connect();try{await migrate(upgrade);await migrate(upgrade);}finally{upgrade.release();}
});
after(async()=>{if(db)await db.close();else await pool.end();});

test('populated upgrade adds identifiers without creating accounts or changing financial and securities history',async()=>{
 assert.deepEqual(await financialSnapshot(),snapshot);
 const eligible=await rows(`SELECT a.account_id,a.currency_code FROM avis_core_v2.ledger_accounts a
  JOIN avis_core_v2.abiq_currencies c USING(currency_code) WHERE a.network IS NULL ORDER BY a.account_id`);
 const identifiers=await rows('SELECT * FROM avis_core_v2.abiq_account_identifiers ORDER BY ledger_account_id');
 assert.equal(identifiers.length,eligible.length);
 assert.equal(new Set(identifiers.map(a=>a.abiq_iban)).size,identifiers.length);
 for(const row of eligible){
  const numbered=identifiers.find(i=>i.ledger_account_id===row.account_id);
  assert.ok(numbered,row.account_id);assert.equal(parseAbiqIban(numbered.abiq_iban).currency,row.currency_code);
 }
 for(const id of [common,suspense]){
  const numbered=await account(id);assert.equal(numbered.identifier_source,'LEDGER_REGISTRY');
  assert.equal(numbered.abiq_iban.length,25);assert.equal(numbered.status,'ACTIVE');
 }
 const custody=await rows("SELECT a.account_id FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.abiq_account_identifiers i ON i.ledger_account_id=a.account_id WHERE a.wallet_scope='CUSTODY' AND a.network IS NULL");
 assert.ok(custody.length>0);
});

test('customer primaries, legacy AQ numbers and historical aliases retain their exact account mappings',async()=>{
 for(const bridge of snapshot.abiq_routing_bridge){
  const numbered=await account(bridge.ledger_account_id);
  assert.equal(numbered.abiq_iban,bridge.abiq_iban);assert.equal(numbered.identifier_source,'ROUTING_BRIDGE');
  assert.equal(await ensure(bridge.ledger_account_id),bridge.abiq_iban);
  assert.equal((await rows('SELECT * FROM avis_core_v2.abiq_ledger_identifiers WHERE ledger_account_id=$1',[bridge.ledger_account_id])).length,0);
 }
 assert.match((await account(legacy.accountId)).abiq_iban,/^AQ/);
 for(const alias of snapshot.abiq_identifier_aliases){
  const bridge=snapshot.abiq_routing_bridge.find(b=>b.bridge_id===alias.bridge_id);
  assert.equal((await resolveAbiqAccount(pool,{identifier:alias.identifier,currency:bridge.currency_code})).ledger_account_id,bridge.ledger_account_id);
 }
});

test('network wallets and unnetworked crypto treasury or clearing balances never receive bank identifiers',async()=>{
 const unnetworked=await rows("SELECT account_id FROM avis_core_v2.ledger_accounts WHERE currency_code IN ('AG','AGi') AND network IS NULL");
 assert.equal(unnetworked.length,4);
 const ids=[...new Set([...cryptoIds,...unnetworked.map(a=>a.account_id)])];
 const start=await sequence();
 for(const id of ids){assert.equal(await ensure(id),null);assert.equal(await account(id),undefined);}
 for(const fixture of [
  {owner:'SUSPENSE_OUTBOUND',currency:'AG'},
  {owner:'EXCHANGE_CLEARING',currency:'AGi'},
  {owner:'SUSPENSE_OUTBOUND',currency:'BTC',network:'BITCOIN'},
  {owner:'USER',user:2,currency:'TOKEN',network:'ETHEREUM',scope:'CUSTODY'}
 ]){const id=await insertAccount(pool,fixture);assert.equal(await ensure(id),null);assert.equal(await account(id),undefined);}
 assert.equal(await ensure(randomUUID()),null);assert.equal(await sequence(),start);
});

test('new system and custody accounts receive one identifier, including explicit issuance before commit',async()=>{
 const client=await pool.connect();let id,identifier;
 try{
  await client.query('BEGIN');id=await insertAccount(client,{owner:'SUSPENSE_CARD_FX',currency:'CHF'});
  assert.equal((await client.query('SELECT * FROM avis_core_v2.abiq_ledger_identifiers WHERE ledger_account_id=$1',[id])).rows.length,0);
  identifier=(await client.query('SELECT avis_core_v2.ensure_ledger_abiq($1) AS identifier',[id])).rows[0].identifier;
  assert.equal((await client.query('SELECT avis_core_v2.ensure_ledger_abiq($1) AS identifier',[id])).rows[0].identifier,identifier);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 assert.equal((await account(id)).abiq_iban,identifier);assert.equal(parseAbiqIban(identifier).currency,'CHF');
 for(const scope of ['CUSTODY','MARGIN']){
  const custody=await insertAccount(pool,{owner:'USER',user:2,currency:'GBP',scope});
  assert.equal(parseAbiqIban((await account(custody)).abiq_iban).currency,'GBP');
  assert.equal((await rows('SELECT * FROM avis_core_v2.abiq_routing_bridge WHERE ledger_account_id=$1',[custody])).length,0);
 }
 const current=await sequence();for(let n=0;n<10;n++)assert.equal(await ensure(id),identifier);
 assert.equal(await sequence(),current);
});

test('deferred issuance lets customer provisioning install its primary without a throwaway registry serial',async()=>{
 await pool.query("INSERT INTO avis_core_v2.sovereign_users(user_id,avis_account_no,full_name,account_type) VALUES(700,'NEW-HOLDER-700','New numbered holder','PERSONAL')");
 const start=await sequence(),client=await pool.connect();let result;
 try{
  await client.query('BEGIN');
  result=(await client.query("SELECT avis_core_v2.provision_abiq_accounts(700,'AVIP',ARRAY['CHF'],'numbering-new-holder') AS result")).rows[0].result[0];
  assert.equal((await client.query('SELECT avis_core_v2.ensure_ledger_abiq($1) AS identifier',[result.accountId])).rows[0].identifier,result.abiqIban);
  assert.equal((await client.query('SELECT last_value FROM avis_core_v2.abiq_account_numbers')).rows[0].last_value.toString(),String(start+1));
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 assert.equal(await sequence(),start+3); // One customer primary, one MARGIN and one CUSTODY.
 assert.equal(result.abiqIban.length,26);
 assert.equal((await rows('SELECT * FROM avis_core_v2.abiq_ledger_identifiers WHERE ledger_account_id=$1',[result.accountId])).length,0);
 const accounts=await rows('SELECT i.* FROM avis_core_v2.abiq_account_identifiers i JOIN avis_core_v2.ledger_accounts a ON a.account_id=i.ledger_account_id WHERE a.user_id=700');
 assert.equal(accounts.length,3);assert.equal(new Set(accounts.map(a=>a.abiq_iban)).size,3);
 await pool.query("SELECT avis_core_v2.provision_abiq_accounts(700,'AVIP',ARRAY['CHF'],'numbering-new-holder')");
 assert.equal(await sequence(),start+3);
});

test('numbered identities cannot be reassigned, changed to crypto, or collide with existing bridge aliases',async()=>{
 const numbered=await account(common),bridge=snapshot.abiq_routing_bridge.find(b=>b.account_number!==null);
 const fresh=(await rows('SELECT * FROM avis_core_v2.abiq_routing_bridge WHERE user_id=700'))[0];
 assert.equal((await rows('SELECT * FROM avis_core_v2.abiq_identifier_aliases WHERE bridge_id=$1',[fresh.bridge_id])).length,0);
 assert.equal((await rows('SELECT * FROM avis_core_v2.abiq_bank_routes WHERE bridge_id=$1',[fresh.bridge_id])).length,0);
 await assert.rejects(pool.query('DELETE FROM avis_core_v2.abiq_routing_bridge WHERE bridge_id=$1',[fresh.bridge_id]),/APPEND_ONLY_RECORD/);
 assert.equal((await account(fresh.ledger_account_id)).abiq_iban,fresh.abiq_iban);
 const reassignment=await insertAccount(pool,{owner:'USER',user:700,currency:'CHF'}),replacement=await account(reassignment);
 await assert.rejects(pool.query('UPDATE avis_core_v2.abiq_routing_bridge SET ledger_account_id=$2 WHERE bridge_id=$1',[fresh.bridge_id,reassignment]),/ABIQ_LEDGER_IDENTITY_MISMATCH/);
 assert.equal((await account(fresh.ledger_account_id)).abiq_iban,fresh.abiq_iban);
 assert.equal((await account(reassignment)).abiq_iban,replacement.abiq_iban);
 await pool.query("UPDATE avis_core_v2.abiq_routing_bridge SET status='CLOSED' WHERE bridge_id=$1",[fresh.bridge_id]);
 assert.equal((await account(fresh.ledger_account_id)).status,'CLOSED');
 await pool.query("UPDATE avis_core_v2.abiq_routing_bridge SET status='ACTIVE' WHERE bridge_id=$1",[fresh.bridge_id]);
 await assert.rejects(pool.query('UPDATE avis_core_v2.abiq_ledger_identifiers SET ledger_account_id=$2 WHERE ledger_account_id=$1',[common,suspense]),/APPEND_ONLY_RECORD/);
 await assert.rejects(pool.query('DELETE FROM avis_core_v2.abiq_ledger_identifiers WHERE ledger_account_id=$1',[common]),/APPEND_ONLY_RECORD/);
 await assert.rejects(pool.query("UPDATE avis_core_v2.ledger_accounts SET currency_code='USD' WHERE account_id=$1",[common]),/ABIQ_LEDGER_IDENTITY_MISMATCH/);
 await assert.rejects(pool.query("UPDATE avis_core_v2.ledger_accounts SET network='ETHEREUM' WHERE account_id=$1",[common]),/ABIQ_LEDGER_IDENTITY_MISMATCH/);
 for(const change of ["owner_type='SUSPENSE_INBOUND'","owner_type='USER',user_id=2","wallet_scope='CUSTODY'","account_category='ASSET'","sub_account_code='REPLACEMENT'"])
  await assert.rejects(pool.query(`UPDATE avis_core_v2.ledger_accounts SET ${change} WHERE account_id=$1`,[common]),/ABIQ_LEDGER_IDENTITY_MISMATCH/);
 await assert.rejects(pool.query('UPDATE avis_core_v2.abiq_routing_bridge SET account_number=$2 WHERE bridge_id=$1',[bridge.bridge_id,numbered.account_number]),/ABIQ_IDENTIFIER_ALREADY_ASSIGNED/);
 await assert.rejects(pool.query('INSERT INTO avis_core_v2.abiq_identifier_aliases(identifier,bridge_id) VALUES($1,$2)',[numbered.abiq_iban,bridge.bridge_id]),/ABIQ_IDENTIFIER_ALREADY_ASSIGNED/);
 const invalidAssignments=[
  {currency:'USD',partition:'0840',serial:99999999999991,expected:/ABIQ_LEDGER_IDENTITY_MISMATCH/},
  {currency:'EUR',partition:'0840',serial:99999999999992,expected:/foreign key/},
  {currency:'EUR',partition:'0978',serial:bridge.account_number,expected:/ABIQ_IDENTIFIER_ALREADY_ASSIGNED/}
 ];
 for(const invalid of invalidAssignments){
  const client=await pool.connect();
  try{
   await client.query('BEGIN');const id=await insertAccount(client);
   await assert.rejects(client.query(`INSERT INTO avis_core_v2.abiq_ledger_identifiers
    (ledger_account_id,participant_code,currency_code,iso_numeric_partition,account_number,abiq_iban)
    VALUES($1,'AVIP',$2::text,$3::text,$4::bigint,avis_core_v2.issued_abiq_identifier('TN','AVIP',right($3::text,3),$4::bigint))`,[id,invalid.currency,invalid.partition,invalid.serial]),invalid.expected);
  }finally{await client.query('ROLLBACK');client.release();}
 }
 assert.equal((await account(common)).abiq_iban,numbered.abiq_iban);
});

test('later customer provisioning preserves the registered ledger identifier as an alias',async()=>{
 const before=await account(unbridgedFunding),ledger=(await rows('SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[unbridgedFunding]))[0];
 assert.equal(before.identifier_source,'LEDGER_REGISTRY');
 const issued=(await rows("SELECT avis_core_v2.provision_abiq_accounts(2,'AVIP',ARRAY['CHF'],'attach-numbered-funding') AS result"))[0].result[0];
 assert.equal(issued.accountId,unbridgedFunding);assert.notEqual(issued.abiqIban,before.abiq_iban);
 assert.equal((await account(unbridgedFunding)).abiq_iban,issued.abiqIban);
 assert.equal((await account(unbridgedFunding)).identifier_source,'ROUTING_BRIDGE');
 assert.equal(await ensure(unbridgedFunding),issued.abiqIban);
 assert.equal((await rows('SELECT bridge_id FROM avis_core_v2.abiq_identifier_aliases WHERE identifier=$1',[before.abiq_iban]))[0].bridge_id,issued.bridgeId);
 assert.equal((await resolveAbiqAccount(pool,{identifier:before.abiq_iban,currency:'CHF'})).ledger_account_id,unbridgedFunding);
 assert.equal((await resolveAbiqAccount(pool,{identifier:issued.abiqIban,currency:'CHF'})).ledger_account_id,unbridgedFunding);
 assert.deepEqual((await rows('SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[unbridgedFunding]))[0],ledger);
 assert.equal((await rows('SELECT abiq_iban FROM avis_core_v2.abiq_ledger_identifiers WHERE ledger_account_id=$1',[unbridgedFunding]))[0].abiq_iban,before.abiq_iban);
});

test('PostgreSQL concurrent assignments issue once per existing ledger',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 // Seed eligible rows as they existed before the numbering upgrade, then race allocation.
 await pool.query('ALTER TABLE avis_core_v2.ledger_accounts DISABLE TRIGGER ensure_new_ledger_abiq');
 const ids=[];
 try{for(let i=0;i<5;i++)ids.push(await insertAccount(pool,{currency:'JPY'}));}
 finally{await pool.query('ALTER TABLE avis_core_v2.ledger_accounts ENABLE TRIGGER ensure_new_ledger_abiq');}
 const start=await sequence();
 const repeated=await Promise.all(Array.from({length:12},()=>ensure(ids[0])));
 assert.equal(new Set(repeated).size,1);
 const different=await Promise.all(ids.map(id=>ensure(id)));
 assert.equal(new Set(different).size,ids.length);assert.equal(await sequence(),start+ids.length);
 for(let i=0;i<ids.length;i++)assert.equal((await account(ids[i])).abiq_iban,different[i]);
});
