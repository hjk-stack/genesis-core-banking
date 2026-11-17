import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {SovereignCore} from '../src/core.mjs';
import {ABIQ_PARTITIONS,ABIQ_ACCOUNT_SERIES,generateIssuedAbiqIban,parseAbiqIban,resolveAbiqAccount,linkAbiqBankRoute} from '../src/avispay-core-accounts.mjs';
import {processAbiqRequest} from '../src/abiq-interface.mjs';
import {createBankServer} from '../server.mjs';
let db,pool,core,legacy,snapshot,issuedBefore,requestsBefore,server,base;let serial=0;
const actor={id:'abiq-test',admin:true},key=()=>`abiq-test-${++serial}`;
const order=(userId,currency='978',requestID=key())=>({userId,fitREQUEST:{HEADER:{requestID,function:'ORDER'},ORDER_INFO:{abiqCODE:'AVIPTN64XXX',abiqCURRENCY:currency,numberIBANS:'1'}}});
const rows=async(sql,args=[])=>(await pool.query(sql,args)).rows;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release(){}})};}
 core=new SovereignCore(pool);
 // Upgrade a populated v7 database: preserve financial history, old routing and a separate legacy schema.
 const client=await pool.connect();try{
  await client.query('CREATE SCHEMA avis_core_v2');
  await client.query('CREATE TABLE avis_core_v2.schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>/^00[1-7]_.*sql$/.test(n)).sort()){
   const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
   if(client.exec)await client.exec(sql);else await client.query(sql);
   await client.query('INSERT INTO avis_core_v2.schema_migrations(version,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);
  }
  await client.query("INSERT INTO avis_core_v2.sovereign_users(user_id,avis_account_no,full_name,account_type) VALUES(1,'legacy-corporate-1','AVISPay PLC','BUSINESS'),(50,'legacy-customer-50','Existing Customer','BUSINESS')");
  legacy=(await client.query("SELECT avis_core_v2.provision_abiq_accounts(50,'AVIS',ARRAY['EUR'],'legacy-request') AS result")).rows[0].result[0];
  await client.query("INSERT INTO avis_core_v2.platform_connectors(connector_code,display_name,is_enabled) VALUES('LEGACY','Preserved connector',true)");
  await client.query("INSERT INTO avis_core_v2.abiq_bank_routes(bridge_id,currency_code,connector_code,provider_account_id,account_type,account_number,country_code,bank_bic,provider_reference) VALUES($1,'EUR','LEGACY','existing-50','IBAN','DE89370400440532013000','DE','COBADEFFXXX','existing-response')",[legacy.bridgeId]);
  const reserve=await core.system(client,'CORRESPONDENT_NOSTRO','EUR','LEGACY','ASSET');
  await core.post(client,actor,'legacy-funding','FIXTURE','preserved journal',[{accountId:reserve,direction:'DEBIT',amount:'123.456'},{accountId:legacy.accountId,direction:'CREDIT',amount:'123.456'}]);
  // Install the already-deployed v9, then seed funded issued accounts and saved responses.
  for(const name of ['008_abiq_issuer.sql','009_abiq_institution_role.sql']){
   const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
   if(client.exec)await client.exec(sql);else await client.query(sql);
   await client.query('INSERT INTO avis_core_v2.schema_migrations(version,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);
  }
  const funded=(await client.query("SELECT avis_core_v2.provision_abiq_accounts(50,'AVIP',ARRAY['EUR'],'prior-issue') AS result")).rows[0].result[0];
  await core.post(client,actor,'issued-funding','FIXTURE','preserved issued balance',[{accountId:reserve,direction:'DEBIT',amount:'50'},{accountId:funded.accountId,direction:'CREDIT',amount:'50'}]);
  await client.query("INSERT INTO avis_core_v2.abiq_bank_routes(bridge_id,currency_code,connector_code,provider_account_id,account_type,account_number,country_code,bank_bic,provider_reference) VALUES($1,'EUR','LEGACY','issued-50','IBAN','GB29NWBK60161331926819','GB','NWBKGB2LXXX','issued-response')",[funded.bridgeId]);
  issuedBefore=await rows("SELECT * FROM avis_core_v2.abiq_routing_bridge WHERE participant_code='AVIP' ORDER BY account_number");
  requestsBefore=await rows('SELECT * FROM avis_core_v2.abiq_provision_requests ORDER BY user_id,participant_code,idempotency_key');
  snapshot={accounts:await rows('SELECT * FROM avis_core_v2.ledger_accounts ORDER BY account_id'),routes:await rows('SELECT * FROM avis_core_v2.abiq_bank_routes ORDER BY bridge_id'),entries:await rows('SELECT * FROM avis_core_v2.ledger_entries ORDER BY entry_id'),connectors:await rows('SELECT * FROM avis_core_v2.platform_connectors ORDER BY connector_code')};
  await migrate(client);await migrate(client);
 }finally{client.release();}
});
after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(db)await db.close();else await pool.end();});

test('issuer migration keeps existing balances, ledger IDs, journals, bank routes and connectors',async()=>{
 for(const account of snapshot.accounts)assert.deepEqual((await rows('SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[account.account_id]))[0],{...account,display_name:null,wallet_visible:true});
 assert.deepEqual(await rows('SELECT * FROM avis_core_v2.abiq_bank_routes ORDER BY bridge_id'),snapshot.routes);
 assert.deepEqual(await rows('SELECT * FROM avis_core_v2.ledger_entries ORDER BY entry_id'),snapshot.entries);
 assert.deepEqual(await rows('SELECT * FROM avis_core_v2.platform_connectors ORDER BY connector_code'),snapshot.connectors);
 assert.equal((await resolveAbiqAccount(pool,{identifier:legacy.abiqIban,currency:'EUR'})).ledger_account_id,legacy.accountId);
 assert.equal((await resolveAbiqAccount(pool,{identifier:'DE89370400440532013000',currency:'EUR'})).ledger_account_id,legacy.accountId);
});
test('corporate user 1 and frontend user 2 have distinct zero-balance EUR USD GBP accounts',async()=>{
 const holders=await rows('SELECT user_id,full_name,account_type,account_role FROM avis_core_v2.sovereign_users WHERE user_id IN(1,2) ORDER BY user_id');
 assert.deepEqual(holders.map(u=>[String(u.user_id),u.full_name,u.account_type,u.account_role]),[['1','AVISPay PLC','BUSINESS','INSTITUTION'],['2','Frontend user','PERSONAL','CUSTOMER']]);
 const accounts=(await core.list(actor,'accounts')).filter(a=>['1','2'].includes(String(a.user_id)));
 assert.equal(accounts.length,6);assert.equal(new Set(accounts.map(a=>a.abiq_iban)).size,6);
 for(const a of accounts){assert.equal(a.abiq_bic,'AVIPTN64XXX');assert.equal(a.available_balance,'0.000000000000000000');assert.equal(parseAbiqIban(a.abiq_iban).currency,a.currency_code);}
 assert.equal(Number((await rows('SELECT count(*) AS n FROM avis_core_v2.ledger_accounts WHERE user_id IN(1,2)'))[0].n),18);
});
test('an existing corporate holder receives the institution role without replacing its account reference',async()=>{
 const holder=(await rows('SELECT full_name,avis_account_no,account_role FROM avis_core_v2.sovereign_users WHERE user_id=1'))[0];
 assert.deepEqual(holder,{full_name:'AVISPay PLC',avis_account_no:'legacy-corporate-1',account_role:'INSTITUTION'});
 const audit=await rows("SELECT resource_id FROM avis_core_v2.operation_audit WHERE actor_id='migration:009' AND operation='ASSIGN_INSTITUTION_ROLE'");
 assert.deepEqual(audit,[{resource_id:'1'}]);
});
test('numbering uses fixed currency series and one customer number with calculated check digits',async()=>{
 const vectors={EUR:'TN89AVIP000978000011000101',USD:'TN37AVIP000840000021000101',GBP:'TN07AVIP000826000031000101',CHF:'TN14AVIP000756000041000101'};
 for(const [currency,expected] of Object.entries(vectors))assert.equal(generateIssuedAbiqIban({customerNumber:'1000101',currency}),expected);
 for(const currency of Object.keys(ABIQ_PARTITIONS)){
  for(const customerNumber of ['1000101','1100101','9999999']){
   const n=generateIssuedAbiqIban({customerNumber,currency}),p=parseAbiqIban(n.slice(0,14)+' '+n.slice(14));
   assert.equal(n.length,26);assert.equal(p.currency,currency);assert.equal(p.customerNumber,customerNumber);
   assert.equal(p.accountNumber,String(ABIQ_ACCOUNT_SERIES[currency]).padStart(5,'0')+customerNumber);
   assert.equal(p.userId,undefined);
   const sql=(await rows("SELECT avis_core_v2.customer_abiq_identifier('TN','AVIP',$1,$2,$3) AS identifier",[ABIQ_PARTITIONS[currency].slice(1),ABIQ_ACCOUNT_SERIES[currency],Number(customerNumber)]))[0].identifier;
   assert.equal(sql,n);assert.throws(()=>parseAbiqIban(n.slice(0,2)+'00'+n.slice(4)));
  }
 }
 for(const n of ['1000100','10000000','1e6','-1',1000101.5,null])assert.throws(()=>generateIssuedAbiqIban({customerNumber:n,currency:'EUR'}));
 const badSeries=(await rows("SELECT avis_core_v2.customer_abiq_identifier('TN','AVIP','978',2,1000101) AS identifier"))[0].identifier;
 assert.throws(()=>parseAbiqIban(badSeries),/ABIQ_INVALID_IDENTIFIER/);
 const p=parseAbiqIban('TN73 AVIP 9780 0000 0000 0000 1');assert.equal(p.accountNumber,'00000000000001');
 const holders=await rows('SELECT user_id,customer_number FROM avis_core_v2.abiq_customer_numbers WHERE user_id IN(1,2) ORDER BY user_id');
 assert.deepEqual(holders.map(u=>[String(u.user_id),u.customer_number]),[['1',1000101],['2',1000102]]);
});
test('more than 100,000 customer numbers issue unique EUR accounts without changing width',()=>{
 const identifiers=new Set();
 for(let customerNumber=1000101;customerNumber<=1100101;customerNumber++)identifiers.add(generateIssuedAbiqIban({customerNumber,currency:'EUR'}));
 assert.equal(identifiers.size,100001);
});
test('v9 identifiers remain aliases to the same funded ledgers, bank routes and saved requests',async()=>{
 assert.deepEqual(await rows('SELECT * FROM avis_core_v2.abiq_provision_requests ORDER BY user_id,participant_code,idempotency_key'),requestsBefore);
 for(const old of issuedBefore){
  const current=(await rows('SELECT * FROM avis_core_v2.abiq_routing_bridge WHERE bridge_id=$1',[old.bridge_id]))[0];
  assert.notEqual(current.abiq_iban,old.abiq_iban);assert.equal(current.account_number,old.account_number);
  assert.equal(current.ledger_account_id,old.ledger_account_id);
  const a=await resolveAbiqAccount(pool,{identifier:old.abiq_iban,currency:old.currency_code});
  const b=await resolveAbiqAccount(pool,{identifier:current.abiq_iban,currency:old.currency_code});assert.deepEqual(a,b);
 }
 const old=issuedBefore.find(a=>String(a.user_id)==='50');
 assert.equal((await resolveAbiqAccount(pool,{identifier:'GB29NWBK60161331926819',currency:'EUR'})).ledger_account_id,old.ledger_account_id);
 const replay=(await rows("SELECT avis_core_v2.provision_abiq_accounts(50,'AVIP',ARRAY['EUR'],'prior-issue') AS result"))[0].result[0];assert.equal(replay.abiqIban,old.abiq_iban);
 const bankRoute={accountType:'IBAN',country:'GB',accountNumber:'GB29NWBK60161331926819',bic:'NWBKGB2LXXX',connectorCode:'LEGACY',providerAccountId:'issued-50',providerReference:'issued-response'};
 assert.equal((await linkAbiqBankRoute(pool,{userId:'50',participantCode:'AVIP',abiqIban:old.abiq_iban,bankRoute})).bridge_id,old.bridge_id);
 await assert.rejects(linkAbiqBankRoute(pool,{userId:'1',participantCode:'AVIP',abiqIban:old.abiq_iban,bankRoute}),/ABIQ_BANK_ROUTE_NOT_LINKED/);
 await pool.query("UPDATE avis_core_v2.abiq_routing_bridge SET status='SUSPENDED' WHERE bridge_id=$1",[old.bridge_id]);
 assert.equal(await resolveAbiqAccount(pool,{identifier:old.abiq_iban,currency:'EUR'}),null);
 await pool.query("UPDATE avis_core_v2.abiq_routing_bridge SET status='ACTIVE' WHERE bridge_id=$1",[old.bridge_id]);
});
test('database rejects cross-customer and cross-currency numbering assignments',async()=>{
 const own=issuedBefore[0];
 await assert.rejects(pool.query('UPDATE avis_core_v2.abiq_routing_bridge SET customer_number=1000102 WHERE bridge_id=$1',[own.bridge_id]));
 await assert.rejects(pool.query('UPDATE avis_core_v2.abiq_routing_bridge SET account_series=2 WHERE bridge_id=$1',[own.bridge_id]));
 await assert.rejects(pool.query('UPDATE avis_core_v2.abiq_routing_bridge SET customer_number=NULL WHERE bridge_id=$1',[own.bridge_id]));
 await assert.rejects(pool.query("SELECT avis_core_v2.customer_abiq_identifier('TN','AVIP','978',1,10000000)"));
});
test('old and new numbers settle against the same balances and reject transfers to their own alias',async()=>{
 const old=issuedBefore.find(a=>String(a.user_id)==='50');
 const current=(await rows('SELECT abiq_iban FROM avis_core_v2.abiq_routing_bridge WHERE bridge_id=$1',[old.bridge_id]))[0].abiq_iban;
 const receiver=(await rows("SELECT abiq_iban,ledger_account_id FROM avis_core_v2.abiq_routing_bridge WHERE user_id=2 AND currency_code='EUR' AND participant_code='AVIP'"))[0];
 const input={from:old.abiq_iban,to:receiver.abiq_iban,currency:'EUR',amount:'10',reference:'alias-routing'},k=key();
 const first=await core.transfer(actor,input,k);assert.deepEqual(await core.transfer(actor,input,k),first);
 assert.equal((await rows('SELECT available_balance::text AS balance FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[old.ledger_account_id]))[0].balance,'40.000000000000000000');
 await core.transfer(actor,{...input,from:receiver.abiq_iban,to:current,reference:'return-funds'},key());
 assert.equal((await rows('SELECT available_balance::text AS balance FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[old.ledger_account_id]))[0].balance,'50.000000000000000000');
 await assert.rejects(core.transfer(actor,{...input,to:current},key()),/SAME_ACCOUNT/);
});
test('currency request creates once; retries return the same identifier and do not allocate another sequence',async()=>{
 const input=order('2','756'),a=await processAbiqRequest(core,actor,input),b=await processAbiqRequest(core,actor,input);
 assert.deepEqual(a,b);assert.equal(a.fitRESPONSE.RESPONSE_INFO.responseCODE,'00');
 const result=a.fitRESPONSE.ABIQ_INFO.IBAN001;assert.equal(parseAbiqIban(result.abiqIBAN).currency,'CHF');assert.equal(result.abiqACCOUNT,'000041000102');
 const differentKey=await processAbiqRequest(core,actor,order('2','756'));assert.deepEqual(differentKey.fitRESPONSE.ABIQ_INFO,a.fitRESPONSE.ABIQ_INFO);
 await assert.rejects(processAbiqRequest(core,actor,{...input,fitREQUEST:{...input.fitREQUEST,ORDER_INFO:{...input.fitREQUEST.ORDER_INFO,abiqCURRENCY:'840'}}}),/IDEMPOTENCY_CONFLICT/);
 const resolved=await resolveAbiqAccount(pool,{identifier:result.abiqIBAN,currency:'CHF'});assert.equal(String(resolved.user_id),'2');
 await assert.rejects(linkAbiqBankRoute(pool,{userId:'1',participantCode:'AVIP',abiqIban:result.abiqIBAN,bankRoute:{accountType:'IBAN',country:'GB',accountNumber:'GB29NWBK60161331926819',connectorCode:'LEGACY',providerAccountId:'wrong-owner',providerReference:'wrong-owner'}}),/ABIQ_BANK_ROUTE_NOT_LINKED/);
});
test('ORDER validates currency, ownership, count and issuer without partial accounts',async()=>{
 const before=(await rows('SELECT count(*) AS n FROM avis_core_v2.abiq_routing_bridge'))[0].n;
 await assert.rejects(processAbiqRequest(core,actor,order('2','999')),/ABIQ_UNSUPPORTED_CURRENCY/);
 await assert.rejects(processAbiqRequest(core,actor,order('9999','978')),/ABIQ_CUSTOMER_NOT_FOUND/);
 const count=order('2');count.fitREQUEST.ORDER_INFO.numberIBANS=2;await assert.rejects(processAbiqRequest(core,actor,count),/ABIQ_ACCOUNT_ORDER_COUNT/);
 const issuer=order('2');issuer.fitREQUEST.ORDER_INFO.abiqCODE='AVIPTN64BAD';assert.equal((await processAbiqRequest(core,actor,issuer)).fitRESPONSE.RESPONSE_INFO.responseCODE,'52');
 await assert.rejects(processAbiqRequest(core,{id:'reader'},order('2')),/FORBIDDEN/);
 assert.equal((await rows('SELECT count(*) AS n FROM avis_core_v2.abiq_routing_bridge'))[0].n,before);
});
test('SEARCH returns the configured issuer and IBANCHECK verifies assigned currency accounts',async()=>{
 const request=(fn,info)=>({fitREQUEST:{HEADER:{requestID:key(),function:fn},ABIQ_INFO:info}});
 const search=await processAbiqRequest(core,actor,request('SEARCH',{abiqCODE:'AVIPTN64XXX'}));assert.equal(search.fitRESPONSE.BUSINESS_INFO.businessNAME,'AVISPay PLC');assert.equal(search.fitRESPONSE.BUSINESS_INFO.businessCOUNTRY,'TN');
 for(const [identifier,expected] of [['TN73AVIP97800000000000001','00'],[generateIssuedAbiqIban({customerNumber:1999999,currency:'EUR'}),'34'],['TN00AVIP97800000000000001','34']])
  assert.equal((await processAbiqRequest(core,actor,request('IBANCHECK',{abiqIBAN:identifier}))).fitRESPONSE.RESPONSE_INFO.responseCODE,expected);
});
test('PostgreSQL concurrent account openings and repeated currency orders cannot duplicate identifiers',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const same=order('2','392');const repeats=await Promise.all(Array.from({length:8},()=>processAbiqRequest(core,actor,same)));
 for(const r of repeats)assert.deepEqual(r,repeats[0]);
 const accounts=await Promise.all(Array.from({length:10},(_,i)=>core.openCustomer(actor,{fullName:'Concurrent '+i,accountType:'PERSONAL',currencies:['EUR','USD','GBP']},key())));
 assert.equal(new Set(accounts.flatMap(c=>c.accounts.map(a=>a.accountNumber))).size,30);
 assert.equal(new Set(accounts.map(c=>c.userId)).size,10);
 assert.equal(new Set(accounts.map(c=>c.accounts[0].customerNumber)).size,10);
 for(const c of accounts)assert.equal(new Set(c.accounts.map(a=>a.customerNumber)).size,1);
});
test('authenticated HTTP account creation and ORDER return the issued identifier; anonymous orders fail',async()=>{
 server=createBankServer({pool,authenticate:async()=>({...actor,username:'operator'}),secureCookies:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{origin:base,'content-type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await post('/api/abiq',order('2'))).status,401);
 const login=await post('/api/login',{username:'operator',password:'fixture-password'}),session=await login.json();
 const headers={cookie:login.headers.get('set-cookie').split(';')[0],'x-csrf-token':session.csrf,'idempotency-key':key()};
 const opened=await post('/api/customers',{fullName:'HTTP currency account',accountType:'PERSONAL',currencies:['USD']},headers);assert.equal(opened.status,200);
 const c=await opened.json();assert.equal(c.accounts[0].accountSeries,'00002');assert.equal(c.accounts[0].abiqCode,'AVIPTN64XXX');assert.equal(parseAbiqIban(c.accounts[0].abiqIban).currency,'USD');
 const added=await post('/api/abiq',order(c.userId,'826'),headers);assert.equal(added.status,200);assert.equal((await added.json()).fitRESPONSE.RESPONSE_INFO.responseCODE,'00');
});
