import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {bookTreasuryOpening,readTreasuryOpening,consolidateTreasuryCrypto,verifyTreasuryOpening,TREASURY_POSITIONS} from '../src/treasury-opening.mjs';
import {CryptoWorkspace} from '../src/crypto-workspace.mjs';

let db,pool;
const env={CONTAINER_APP_NAME:'genesis-banking-uat',CONTAINER_APP_ENV_DNS_SUFFIX:'purplepebble-81c147aa.italynorth.azurecontainerapps.io',PGDATABASE:'fineract_default'};
before(async()=>{db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:s=>db.exec(s),release(){}})};const c=await pool.connect();await migrate(c);c.release();});
after(async()=>{await db.close();});
test('wrong UAT target cannot write positions',async()=>{
 await assert.rejects(bookTreasuryOpening(pool,{...env,PGDATABASE:'other'}),/TREASURY_TARGET_MISMATCH/);
 assert.equal((await readTreasuryOpening(pool)).length,0);
});
test('same owner gets exactly the four instructed opening positions once',async()=>{
 const receipt=await bookTreasuryOpening(pool,env);
 assert.equal(receipt.positions.length,4);
 const rows=await readTreasuryOpening(pool);
 for(const position of TREASURY_POSITIONS){
  const found=rows.find(r=>r.asset_code===position.assetCode);
  assert.ok(found);assert.equal(Number(found.quantity),Number(position.quantity));
  assert.equal(found.destination,position.destination);
 }
 assert.deepEqual(await bookTreasuryOpening(pool,env),receipt);
 assert.equal((await readTreasuryOpening(pool)).length,4);
 for(const code of ['AG','AGi']){
  const position=receipt.positions.find(p=>p.asset===code);
  assert.ok(position.accountId);
  assert.ok(position.journalId);
  const account=(await pool.query('SELECT owner_type,currency_code,available_balance::text,account_category FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[position.accountId])).rows[0];
  assert.equal(account.owner_type,'TREASURY');
  assert.equal(account.currency_code,code);
  assert.equal(account.account_category,'ASSET');
  assert.equal(Number(account.available_balance),10000000000);
  const entries=(await pool.query('SELECT count(*)::int n FROM avis_core_v2.ledger_entries WHERE journal_id=$1',[position.journalId])).rows[0];
  assert.equal(entries.n,2);
 }

});
test('records preserve existing asset quantities and no new issuance is invented',()=>{
 assert.deepEqual(TREASURY_POSITIONS.map(x=>x.quantity),['500000','100000000','10000000000','10000000000']);
 assert.ok(!TREASURY_POSITIONS.some(x=>x.quantity==='4500000'));
});

test('Treasury admin readback exposes saved AG/AGi ledger journal and account identifiers',async()=>{
 const service=new CryptoWorkspace(pool);
 const positions=await service.list({id:'admin',admin:true},'treasurypositions');
 assert.equal(positions.length,4);
 for(const code of ['AG','AGi']){
  const asset=positions.find(x=>x.asset_code===code);
  assert.ok(asset?.journal_id);
  assert.ok(asset?.ledger_account_id);
  const account=(await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[asset.ledger_account_id])).rows[0];
  assert.equal(Number(account.available_balance),10000000000);
 }
});

test('AG and AGi initial positions are moved once from duplicate Treasury balances into the real AVISPay PLC Ethereum wallets',async()=>{
 const core=new CryptoWorkspace(pool),opening=await readTreasuryOpening(pool),accounts={};
 for(const code of ['AG','AGi'])accounts[code]=await core.networkAccount(pool,'USER',code,'ETHEREUM','CRYPTO','1');
 const before=(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_journals')).rows[0].n;
 const receipt=await consolidateTreasuryCrypto(pool,env);
 assert.equal(receipt.positions.length,2);
 assert.deepEqual(await consolidateTreasuryCrypto(pool,env),receipt);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_journals')).rows[0].n,before+2);
 for(const code of ['AG','AGi']){
  const original=opening.find(p=>p.asset_code===code),target=receipt.positions.find(p=>p.asset===code);
  assert.equal(target.accountId,accounts[code]);
  const source=(await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[original.ledger_account_id])).rows[0];
  const destination=(await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[accounts[code]])).rows[0];
  assert.equal(Number(source.available_balance),0);
  assert.equal(Number(destination.available_balance),10000000000);
  const entries=(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries WHERE journal_id=$1',[target.journalId])).rows[0];
  assert.equal(entries.n,4);
  assert.equal((await readTreasuryOpening(pool)).find(p=>p.asset_code===code).quantity,'10000000000.000000000000000000');
 }
});

test('releases verify the Treasury journal after a later wallet debit without reposting or replenishing inventory',async()=>{
 const core=new CryptoWorkspace(pool),opening=await bookTreasuryOpening(pool,env),move=await consolidateTreasuryCrypto(pool,env);
 const ag=move.positions.find(p=>p.asset==='AG');
 const customer=await core.networkAccount(pool,'USER','AG','ETHEREUM','CRYPTO','2');
 const balance=async()=>(await pool.query('SELECT available_balance::text AS amount FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[ag.accountId])).rows[0].amount;
 await core.post(pool,{id:'regression'},'test:wallet-debit-after-opening','WALLET_TRANSFER','Regression payment',[
  {accountId:ag.accountId,direction:'DEBIT',amount:'1.000000000000000001'},
  {accountId:customer,direction:'CREDIT',amount:'1.000000000000000001'}
 ]);
 const journals=async()=>(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_journals')).rows[0].n;
 const count=await journals();
 await verifyTreasuryOpening(pool,await bookTreasuryOpening(pool,env),await consolidateTreasuryCrypto(pool,env));
 assert.equal(await balance(),'9999999998.999999999999999999');assert.equal(await journals(),count);
 for(const altered of [{accountId:customer},{journalId:opening.positions.find(p=>p.asset==='AG').journalId},{quantity:'10000000000.000000000000000001'}]){
  const other=structuredClone(move);Object.assign(other.positions.find(p=>p.asset==='AG'),altered);
  await assert.rejects(verifyTreasuryOpening(pool,opening,other),{code:'TREASURY_WALLET_MOVE_READBACK'});
 }
});
