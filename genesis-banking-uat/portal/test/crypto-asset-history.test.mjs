import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {CryptoWorkspace} from '../src/crypto-workspace.mjs';
import {EvmWalletTransfers} from '../src/crypto-wallet-transfers.mjs';
import {assetReceivingWallet,enrichPortfolioHistory} from '../src/crypto-asset-routing.mjs';
let db,pool,core,original,funded,historical;
const admin={id:'asset-history-test',admin:true},key=()=>randomUUID();
const env={AVIS_WALLET_ENCRYPTION_KEY:'isolated-history-test-encryption-key-2026'};
before(async()=>{
 if(process.env.TEST_DATABASE_URL){assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname,'/avispay_ci');pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};}
 const c=await pool.connect();try{await migrate(c);}finally{c.release();}
 core=new CryptoWorkspace(pool,{secretEnv:env,chain:{inspectAsset:async()=>({decimals:18})}});
 for(const assetId of ['avis-green','avis-green-investment'])await core.approveCrypto(admin,{assetId,network:'ETHEREUM',approved:true},key());
 original=await core.activateCrypto(admin,{userId:'1',assetId:'avis-green',network:'ETHEREUM'},key());
 funded=await core.networkAccount(pool,'USER','AG','ETHEREUM','REGISTERED_EXISTING','1');
 // Isolated database fixture: activation must not overwrite or repost this balance.
 await pool.query('UPDATE avis_core_v2.ledger_accounts SET available_balance=10000000000 WHERE account_id=$1',[funded]);
 historical=(await pool.query("INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address,is_primary) VALUES(1,'ETHEREUM',$1,false) RETURNING *",['0x'+'1'.repeat(40)])).rows[0];
 await pool.query("INSERT INTO avis_core_v2.crypto_asset_wallet_routes(user_id,asset_id,network,address_id) VALUES(1,'avis-green','ETHEREUM',$1)",[historical.address_id]);
 await pool.query(`INSERT INTO avis_core_v2.crypto_asset_provenance(user_id,asset_id,network,contract_address,historical_wallet_address,transaction_hash,source_url,source_record)
  SELECT 1,asset_id,network,contract_address,$1,$2,$3,'Isolated historical fixture' FROM avis_core_v2.crypto_asset_networks WHERE asset_id='avis-green' AND network='ETHEREUM'`,
  [historical.public_address,'0x'+'a'.repeat(64),'https://etherscan.io/token/0x713d3a1785219aeb37e52260ff8f96660851842b?a='+historical.public_address+'#transactions']);
});
after(async()=>{if(db)await db.close();else await pool.end();});
test('asset selection reuses the funded Portfolio account and original historical receiver without new bookings',async()=>{
 const before=(await pool.query('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows;
 const keys=(await pool.query('SELECT * FROM avis_core_v2.crypto_wallet_keys ORDER BY address_id')).rows;
 const result=await core.activateCrypto(admin,{userId:'1',assetId:'avis-green',network:'ETHEREUM'},key());
 assert.equal(result.accountId,funded);assert.equal(result.address,historical.public_address);
 assert.equal(String(result.addressId),String(historical.address_id));
 assert.deepEqual((await pool.query('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows,before);
 assert.deepEqual((await pool.query('SELECT * FROM avis_core_v2.crypto_wallet_keys ORDER BY address_id')).rows,keys);
 const wallets=await core.list(admin,'cryptowallets');
 assert.equal(wallets.find(w=>w.account_id===funded).available_balance,'10000000000.000000000000000000');
 assert.equal(wallets.find(w=>w.account_id===funded).wallet_visible,true);
 assert.equal(wallets.find(w=>w.account_id===original.accountId).wallet_visible,false);
 assert.equal(wallets.filter(w=>w.account_id===funded).length,1);
});
test('each asset resolves its own route and a historical address never falls through to a generated signing key',async()=>{
 assert.equal((await assetReceivingWallet(pool,'1','ETHEREUM','avis-green')).public_address,historical.public_address);
 assert.equal((await assetReceivingWallet(pool,'1','ETHEREUM','avis-green-investment')).public_address,original.address);
 const transfers=new EvmWalletTransfers(pool,{secretEnv:env});
 await assert.rejects(transfers.walletSendSource(pool,admin,funded),/CRYPTO_SIGNING_KEY/);
});
test('portfolio history adds exact source fields without changing totals or showing another holders records',async()=>{
 const rows=await core.portfolio(admin),row=rows.find(r=>r.currency_code==='AG');
 assert.equal(row.available_balance,'10000000000.000000000000000000');
 assert.equal(row.historical_wallet_address,historical.public_address);
 assert.equal(row.smart_contract,'0x713d3a1785219aeb37e52260ff8f96660851842b');
 assert.equal(row.historical_proof[0].walletAddress,historical.public_address);
 assert.match(row.historical_proof[0].url,/etherscan\.io\/token\//);
 const other=await enrichPortfolioHistory(pool,{admin:true,customerUserId:'2'},[{currency_code:'AG',network:'ETHEREUM',available_balance:'0'}]);
 assert.equal(other[0].historical_wallet_address,undefined);
});
test('conflicting funded accounts are not consolidated or silently reassigned',async()=>{
 const conflicting=await core.networkAccount(pool,'USER','AG','ETHEREUM','SECOND_SOURCE','1');
 await pool.query('UPDATE avis_core_v2.ledger_accounts SET available_balance=1 WHERE account_id=$1',[conflicting]);
 await assert.rejects(core.activateCrypto(admin,{userId:'1',assetId:'avis-green',network:'ETHEREUM'},key()),/CRYPTO_ACCOUNT_AMBIGUOUS/);
 await pool.query('UPDATE avis_core_v2.ledger_accounts SET available_balance=0 WHERE account_id=$1',[conflicting]);
});
test('security receiving wallets are independent, idempotent and cannot overwrite payment wallet routes',async()=>{
 const cards=await core.list(admin,'cryptosecurities'),card=cards.find(c=>c.symbol==='aAVISP');
 const input={cardId:card.card_id,userId:'1',network:'ETHEREUM'};
 const one=await core.createSecurityWallet(admin,input,key()),two=await core.createSecurityWallet(admin,input,key());
 assert.equal(String(one.address_id),String(two.address_id));
 assert.notEqual(one.public_address,original.address);assert.notEqual(one.public_address,historical.public_address);
 assert.equal((await assetReceivingWallet(pool,'1','ETHEREUM','avis-green')).public_address,historical.public_address);
 assert.equal((await core.cryptoSecurityDetails(admin,{cardId:card.card_id})).wallet_public_address,one.public_address);
 await assert.rejects(core.createSecurityWallet({id:'customer',admin:true,customerUserId:'2'},input,key()),/FORBIDDEN/);
});
