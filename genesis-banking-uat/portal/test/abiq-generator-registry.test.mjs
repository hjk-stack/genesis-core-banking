import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {SovereignCore} from '../src/core.mjs';
import {generatorOptions,issueGeneratorNumber,assignGeneratorNumber,availableGeneratorNumbers} from '../src/abiq-generator.mjs';
import {findAbiqAccountIdentifier,resolveAbiqAccount,parseAbiqIban} from '../src/avispay-core-accounts.mjs';
import {buildAbiqNumber} from '../public/abiq-number.mjs';

test('persistent issue, retries, scope, currency, assignment and account opening',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 const query=(...args)=>db.query(...args);
 const pool={query,connect:async()=>({query,release(){}})};
 const core=new SovereignCore(pool);
 await migrate(db);await migrate(db);
 const admin={id:'generator-operator',admin:true};
 const other={id:'separate-operator',admin:true,customerUserId:'2'};
 const issue=async(holder,number,key,currency='CHF',country='TN')=>{
  const options=await generatorOptions(db,admin,holder);
  const c=options.currencies.find(x=>x.currency===currency);
  const form={...c,country,holderCode:holder,customerNumber:number};
  return issueGeneratorNumber(core,admin,{...form,checkDigits:buildAbiqNumber(form).slice(2,4)},key);
 };
 const choices=(await generatorOptions(db,admin,'ACME')).customerNumbers;
 assert.deepEqual(choices.slice(0,3),['1000101','1000102','1000103']);
 const saved=await issue('ACME',choices[2],'out-of-order');
 assert.equal((await issue('ACME',choices[2],'out-of-order')).identifier,saved.identifier);
 await assert.rejects(issue('ACME',choices[2],'duplicate'),e=>e.code==='ABIQ_NUMBER_TAKEN');
 for(const n of choices.slice(0,2))await issue('ACME',n,'issue-'+n);
 assert.equal((await generatorOptions(db,admin,'ACME')).customerNumbers[0],'1000104');
 assert.equal((await generatorOptions(db,other,'ACME')).recent.length,0);
 const secondCurrency=await issue('ACME',choices[2],'same-customer-gbp','GBP');
 assert.equal(parseAbiqIban(secondCurrency.identifier).customerNumber,choices[2]);
 const ledger=(await query("SELECT ledger_account_id FROM avis_core_v2.abiq_routing_bridge WHERE user_id=1 AND currency_code='EUR' AND participant_code='AVIP'")).rows[0].ledger_account_id;
 const eur=await issue('ACME','1000104','eur','EUR','DE');
 assert.equal(parseAbiqIban(eur.identifier).countryCode,'DE');
 assert.equal(await resolveAbiqAccount(db,{identifier:eur.identifier,currency:'EUR'}),null);
 assert.ok((await availableGeneratorNumbers(db,admin,'EUR','')).numbers.includes(eur.identifier));
 const attach=(actor,identifier,accountId,key)=>assignGeneratorNumber(core,actor,{identifier,accountId},key);
 await assert.rejects(attach(other,eur.identifier,ledger,'foreign-account'),e=>e.code==='ACCOUNT_NOT_FOUND');
 await assert.rejects(attach(admin,saved.identifier,ledger,'wrong-currency'),e=>e.code==='ABIQ_CURRENCY_MISMATCH');
 await attach(admin,eur.identifier,ledger,'assign');
 await attach(admin,eur.identifier,ledger,'assign');
 assert.equal((await resolveAbiqAccount(db,{identifier:eur.identifier,currency:'EUR'})).ledger_account_id,ledger);
 assert.deepEqual((await availableGeneratorNumbers(db,admin,'EUR','')).numbers,[]);
 const systemLedger=async(bucket,currency,network=null)=>{
  return (await query(`INSERT INTO avis_core_v2.ledger_accounts(owner_type,sub_account_code,currency_code,network,account_category)
   VALUES('COMMON_POOL',$1,$2,$3,'LIABILITY') RETURNING account_id`,[bucket,currency,network])).rows[0].account_id;
 };
 const common=await systemLedger('GENERATOR-CHF','CHF');
 await attach(admin,saved.identifier,common,'common');
 assert.equal((await findAbiqAccountIdentifier(db,{identifier:saved.identifier,currency:'CHF'})).ledger_account_id,common);
 assert.equal(await resolveAbiqAccount(db,{identifier:saved.identifier,currency:'CHF'}),null);
 const primary=(await query('SELECT abiq_iban FROM avis_core_v2.abiq_account_identifiers WHERE ledger_account_id=$1',[common])).rows[0].abiq_iban;
 assert.equal(primary.length,26);assert.equal(parseAbiqIban(primary).accountSeries,'00004');
 for(const [curr,net] of [['AG',null],['BTC','BITCOIN'],['CHF','ETHEREUM']]){
  const crypto=await systemLedger('WALLET-'+curr,curr,net);
  assert.equal((await query('SELECT * FROM avis_core_v2.abiq_account_identifiers WHERE ledger_account_id=$1',[crypto])).rows.length,0);
  await assert.rejects(attach(admin,saved.identifier,crypto,'no-crypto-'+curr),e=>e.code==='ACCOUNT_NOT_FOUND');
 }
 const next=(await generatorOptions(db,admin,'AVIP')).customerNumbers[0];const manual=await issue('AVIP',next,'manual');
 await query("INSERT INTO avis_core_v2.sovereign_users(user_id,avis_account_no,full_name,account_type) VALUES(999,'GENERATOR-999','Numbering test','PERSONAL')");
 await query("SELECT avis_core_v2.provision_abiq_accounts(999,'AVIP',ARRAY['CHF'],'actual-opening')");
 const accounts=(await query('SELECT a.wallet_scope,i.abiq_iban FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.abiq_account_identifiers i ON i.ledger_account_id=a.account_id WHERE a.user_id=999')).rows;
 assert.deepEqual(accounts.map(x=>x.wallet_scope).sort(),['CUSTODY','FUNDING','MARGIN']);
 assert.equal(new Set([manual.identifier,...accounts.map(a=>a.abiq_iban)]).size,4);
 for(const account of accounts)assert.equal(parseAbiqIban(account.abiq_iban).accountSeries,account.wallet_scope==='CUSTODY'?'00015':'00004');
 const custody=(await query("SELECT account_id FROM avis_core_v2.ledger_accounts WHERE user_id=999 AND wallet_scope='CUSTODY' AND currency_code='CHF'")).rows[0].account_id;
 const code=await issue('SAFE','1000101','custody-579','579','IT');
 assert.equal(parseAbiqIban(code.identifier).currency,'579');
 assert.ok((await availableGeneratorNumbers(db,admin,'CHF','',custody)).numbers.includes(code.identifier));
 assert.ok(!(await availableGeneratorNumbers(db,admin,'CHF','',common)).numbers.includes(code.identifier));
 await assert.rejects(attach(admin,code.identifier,common,'incorrect-custody-target'),e=>e.code==='ABIQ_CURRENCY_MISMATCH');
 await attach(admin,code.identifier,custody,'assign-custody');
 assert.equal((await findAbiqAccountIdentifier(db,{identifier:code.identifier,currency:'CHF'})).ledger_account_id,custody);
 assert.equal((await findAbiqAccountIdentifier(db,{identifier:code.identifier,currency:'579'})).ledger_account_id,custody);
 assert.equal(await findAbiqAccountIdentifier(db,{identifier:code.identifier,currency:'EUR'}),null);
 assert.equal(await resolveAbiqAccount(db,{identifier:code.identifier,currency:'CHF'}),null);
});
