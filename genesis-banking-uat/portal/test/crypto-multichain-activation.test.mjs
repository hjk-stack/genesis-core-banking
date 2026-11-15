import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {CryptoWorkspace} from '../src/crypto-workspace.mjs';
import {CustomerAccess} from '../src/customer-access.mjs';
import {newWallet,validAddress,encryptKey,decryptKey} from '../src/crypto/networks.mjs';
import {cryptoLedgerAccount} from '../src/crypto/rolling-ledger.mjs';

const admin={id:'multichain-activation',admin:true},customer={id:'multichain-owner',admin:false,customerUserId:'2'};
const secretEnv={AVIS_OFFLINE_SIGNING_KEY:'isolated-multichain-activation-secret-never-used-live'};
const alpha='isolated-multichain-alpha',beta='isolated-multichain-beta',networks=['ETHEREUM','SOLANA','TRON'],key=()=>randomUUID();
let pool,db,core,rpcCalls=0;
const noRpc=()=>{rpcCalls++;throw Error('ACTIVATION_MUST_NOT_CONTACT_RPC');};
const options={secretEnv,chain:{check:noRpc,inspectAsset:noRpc,balance:noRpc,provider:noRpc},cryptoFetch:noRpc};
const rows=async(sql,args=[]) => (await pool.query(sql,args)).rows;
const one=async(sql,args=[]) => (await rows(sql,args))[0];
async function count(table){return Number((await one('SELECT count(*)::int AS n FROM avis_core_v2.'+table)).n);}
async function walletState(userId){
 return {
  addresses:await rows('SELECT * FROM avis_core_v2.user_deposit_addresses WHERE user_id=$1 ORDER BY network',[userId]),
  keys:await rows('SELECT k.* FROM avis_core_v2.crypto_wallet_keys k JOIN avis_core_v2.user_deposit_addresses d USING(address_id) WHERE d.user_id=$1 ORDER BY d.network',[userId]),
  accounts:await rows("SELECT * FROM avis_core_v2.ledger_accounts WHERE owner_type='USER' AND user_id=$1 AND network IS NOT NULL ORDER BY account_id",[userId]),
  activations:await rows('SELECT * FROM avis_core_v2.crypto_activations WHERE user_id=$1 ORDER BY asset_id,network',[userId])
 };
}
async function openFixture(name){
 return (await core.openCustomer(admin,{fullName:name,accountType:'PERSONAL',currencies:['EUR']},key())).userId;
}
before(async()=>{
 if(process.env.TEST_DATABASE_URL){
  const target=new URL(process.env.TEST_DATABASE_URL);assert.equal(target.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:target.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
 }else{
  db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release(){}})};
 }
 const client=await pool.connect();try{await migrate(client);}finally{client.release();}
 core=new CryptoWorkspace(pool,options);
 for(const [assetId,currency,ordered] of [[alpha,'MTCA',networks],[beta,'MTCB',[...networks].reverse()]]){
  await pool.query("INSERT INTO avis_core_v2.crypto_assets(asset_id,currency_code,name,source) VALUES($1,$2,$3,'ISOLATED_TEST')",[assetId,currency,currency+' local activation fixture']);
  // Reverse insertion order on the second currency exercises the shared,
  // deterministic lock order when PostgreSQL runs the concurrent batch test.
  for(const network of ordered)await pool.query('INSERT INTO avis_core_v2.crypto_asset_networks(asset_id,network,contract_address,decimals,approved,verified_at) VALUES($1,$2,$3,18,true,now())',[assetId,network,newWallet(network).address]);
 }
 for(const [network,approved,verified] of [['BSC',false,true],['BASE',true,false],['UNREGISTERED_CHAIN',true,true]]){
  await pool.query('INSERT INTO avis_core_v2.crypto_asset_networks(asset_id,network,decimals,approved,verified_at) VALUES($1,$2,18,$3,CASE WHEN $4 THEN now() ELSE NULL END)',[alpha,network,approved,verified]);
 }
});
after(async()=>{assert.equal(rpcCalls,0);if(db)await db.close();else await pool?.end();});

test('one omitted-network activation provisions every approved, verified supported chain without RPC or journals',async()=>{
 const before=await count('ledger_journals'),request={userId:'02',assetId:alpha},idempotency=key();
 const result=await core.activateCrypto(admin,request,idempotency);
 assert.equal(result.userId,'2');assert.equal(result.assetId,alpha);assert.equal(result.currency,'MTCA');
 assert.deepEqual(result.wallets.map(w=>w.network),networks);
 for(const wallet of result.wallets){
  assert.equal(wallet.assetId,alpha);assert.equal(typeof wallet.addressId,'string');assert.ok(validAddress(wallet.network,wallet.address));
  const account=await one('SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[wallet.accountId]);
  assert.equal(String(account.user_id),'2');assert.equal(account.currency_code,'MTCA');assert.equal(account.network,wallet.network);
  assert.equal(account.wallet_scope,'FUNDING');assert.equal(Number(account.available_balance),0);assert.equal(Number(account.locked_balance),0);
  const stored=(await one('SELECT encrypted_key FROM avis_core_v2.crypto_wallet_keys WHERE address_id=$1',[wallet.addressId])).encrypted_key;
  assert.ok(Object.keys(decryptKey(stored,'wallet:2:'+wallet.network,secretEnv)).length);
  assert.throws(()=>decryptKey(stored,'wallet:02:'+wallet.network,secretEnv));
 }
 assert.equal(await count('ledger_journals'),before);assert.equal(rpcCalls,0);
 assert.equal(JSON.stringify(result).includes('privateKey'),false);assert.equal(JSON.stringify(result).includes('encrypted_key'),false);
 const state=await walletState('2');
 assert.equal(state.addresses.length,3);assert.equal(state.keys.length,3);assert.equal(state.accounts.length,3);assert.equal(state.activations.length,3);
 assert.deepEqual(await core.activateCrypto(admin,request,idempotency),result);
 assert.deepEqual(await walletState('2'),state);
 await assert.rejects(core.activateCrypto(admin,{...request,assetId:beta},idempotency),/IDEMPOTENCY_CONFLICT/);
});

test('another currency reuses each holder/network address and key while maintaining distinct asset accounts',async()=>{
 const access=new CustomerAccess(core),first=await access.invoke(customer,'activateCrypto',{userId:'2',assetId:alpha},key()),before=await walletState('2'),journals=await count('ledger_journals');
 const second=await access.invoke(customer,'activateCrypto',{userId:'2',assetId:beta},key());
 assert.equal(second.currency,'MTCB');assert.deepEqual(second.wallets.map(w=>w.network),networks);
 for(const wallet of second.wallets){
  const existing=first.wallets.find(w=>w.network===wallet.network);
  assert.equal(wallet.addressId,existing.addressId);assert.equal(wallet.address,existing.address);assert.notEqual(wallet.accountId,existing.accountId);
 }
 const after=await walletState('2');
 assert.deepEqual(after.addresses,before.addresses);assert.deepEqual(after.keys,before.keys);assert.equal(after.accounts.length,6);assert.equal(after.activations.length,6);
 assert.equal(await count('ledger_journals'),journals);
 const repeat=await access.invoke(customer,'activateCrypto',{userId:'2',assetId:beta},key());
 assert.deepEqual(repeat,second);assert.deepEqual(await walletState('2'),after);
});

test('existing encrypted keys, imported addresses without keys, balances and pledged amounts survive bulk activation',async()=>{
 const managed=newWallet('ETHEREUM'),imported=newWallet('TRON');
 const existingAddress=(await one("INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address) VALUES(1,'ETHEREUM',$1) RETURNING address_id",[managed.address])).address_id;
 const encrypted=encryptKey(managed.key,'wallet:1:ETHEREUM',secretEnv);
 await pool.query('INSERT INTO avis_core_v2.crypto_wallet_keys(address_id,encrypted_key) VALUES($1,$2)',[existingAddress,JSON.stringify(encrypted)]);
 const importedAddress=(await one("INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address) VALUES(1,'TRON',$1) RETURNING address_id",[imported.address])).address_id;
 const accountId=await core.networkAccount(pool,'USER','MTCA','ETHEREUM','CRYPTO','1');
 await core.operation(admin,'ISOLATED_MULTICHAIN_BALANCE',{},key(),async(db,k)=>{
  const backing=await cryptoLedgerAccount(db,{owner:'HOT_WALLET',currency:'MTCA',network:'ETHEREUM',bucket:'CHAIN_CUSTODY',category:'ASSET'});
  const journalId=await core.post(db,admin,k,'TEST_CHAIN_DEPOSIT','Isolated preservation fixture',[
   {accountId,direction:'CREDIT',amount:'25'},{accountId:backing,direction:'DEBIT',amount:'25'}
  ]);
  await db.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=3 WHERE account_id=$1',[accountId]);
  return {journalId};
 });
 const old=await walletState('1'),oldAccount=await one('SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[accountId]),journals=await count('ledger_journals');
 const result=await core.activateCrypto(admin,{userId:'1',assetId:alpha},key()),current=await walletState('1');
 assert.equal(result.wallets.find(w=>w.network==='ETHEREUM').address,managed.address);
 assert.equal(result.wallets.find(w=>w.network==='ETHEREUM').accountId,accountId);
 assert.equal(result.wallets.find(w=>w.network==='TRON').address,imported.address);
 for(const address of old.addresses)assert.deepEqual(current.addresses.find(a=>String(a.address_id)===String(address.address_id)),address);
 assert.deepEqual(await one('SELECT * FROM avis_core_v2.crypto_wallet_keys WHERE address_id=$1',[existingAddress]),old.keys[0]);
 assert.equal((await rows('SELECT * FROM avis_core_v2.crypto_wallet_keys WHERE address_id=$1',[importedAddress])).length,0);
 assert.deepEqual(await one('SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[accountId]),oldAccount);
 assert.equal(await count('ledger_journals'),journals);
 // Reusing all addresses requires no new encryption key or RPC credentials.
 const reuse=new CryptoWorkspace(pool,{...options,secretEnv:{}});
 assert.deepEqual(await reuse.activateCrypto(admin,{userId:'1',assetId:alpha},key()),result);
 assert.deepEqual(await walletState('1'),current);
});

test('single-network callers retain their exact response and disabled networks do not remove existing holdings',async()=>{
 const bulk=await core.activateCrypto(admin,{userId:'2',assetId:alpha},key());
 const legacy=await core.activateCrypto(admin,{userId:'2',assetId:alpha,network:'SOLANA'},key());
 assert.deepEqual(legacy,bulk.wallets.find(w=>w.network==='SOLANA'));assert.equal(legacy.wallets,undefined);
 assert.deepEqual(Object.keys(legacy).sort(),['accountId','address','addressId','assetId','network'].sort());
 await assert.rejects(core.activateCrypto(admin,{userId:'2',assetId:alpha,network:'BSC'},key()),/CRYPTO_APPROVAL_REQUIRED/);
 await assert.rejects(core.activateCrypto(admin,{userId:'2',assetId:alpha,network:null},key()),/CRYPTO_NETWORK/);
 const before=await walletState('2');
 await pool.query("UPDATE avis_core_v2.crypto_asset_networks SET approved=false WHERE asset_id=$1 AND network='TRON'",[alpha]);
 try{
  const result=await core.activateCrypto(admin,{userId:'2',assetId:alpha},key());
  assert.deepEqual(result.wallets.map(w=>w.network),['ETHEREUM','SOLANA']);
  assert.deepEqual(await walletState('2'),before);
 }finally{await pool.query("UPDATE avis_core_v2.crypto_asset_networks SET approved=true WHERE asset_id=$1 AND network='TRON'",[alpha]);}
});

test('ownership and an empty eligible network set reject the entire currency activation',async()=>{
 const before=await walletState('1'),access=new CustomerAccess(core);
 await assert.rejects(access.invoke(customer,'activateCrypto',{userId:'1',assetId:alpha},key()),/FORBIDDEN/);
 await assert.rejects(core.activateCrypto({...admin,customerUserId:'2'},{userId:'1',assetId:alpha},key()),/FORBIDDEN/);
 await assert.rejects(core.activateCrypto(admin,{userId:'2',assetId:'missing-asset'},key()),/CRYPTO_APPROVAL_REQUIRED/);
 await assert.rejects(core.activateCrypto(admin,{userId:'999999999',assetId:alpha},key()),/ABIQ_CUSTOMER_NOT_FOUND/);
 assert.deepEqual(await walletState('1'),before);
});

test('a later network failure rolls back every new address, key, account and activation and permits a clean retry',async()=>{
 const userId=await openFixture('Atomic multichain fixture'),before=await walletState(userId),requests=await count('operation_requests'),journals=await count('ledger_journals');
 class FailingActivation extends CryptoWorkspace {
  calls=0;
  async networkAccount(...args){
   const account=await super.networkAccount(...args);
   if(++this.calls===2)throw Error('ISOLATED_SECOND_NETWORK_FAILURE');
   return account;
  }
 }
 const failing=new FailingActivation(pool,options),request={userId,assetId:alpha},idempotency=key();
 await assert.rejects(failing.activateCrypto(admin,request,idempotency),/ISOLATED_SECOND_NETWORK_FAILURE/);
 assert.deepEqual(await walletState(userId),before);assert.equal(await count('operation_requests'),requests);assert.equal(await count('ledger_journals'),journals);
 const result=await core.activateCrypto(admin,request,idempotency);
 assert.deepEqual(result.wallets.map(w=>w.network),networks);assert.equal((await walletState(userId)).keys.length,3);
 assert.equal(await count('ledger_journals'),journals);
});

test('PostgreSQL overlapping currency batches and a legacy single-network call share one address/key per network',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const userId=await openFixture('Concurrent multichain fixture'),request={userId,assetId:alpha},idempotency=key(),journals=await count('ledger_journals');
 const [first,second,legacy,replay]=await Promise.all([
  core.activateCrypto(admin,request,idempotency),
  core.activateCrypto(admin,{userId,assetId:beta},key()),
  core.activateCrypto(admin,{...request,network:'ETHEREUM'},key()),
  core.activateCrypto(admin,request,idempotency)
 ]);
 assert.deepEqual(first.wallets.map(w=>w.network),networks);assert.deepEqual(second.wallets.map(w=>w.network),networks);
 assert.deepEqual(replay,first);assert.deepEqual(legacy,first.wallets.find(w=>w.network==='ETHEREUM'));
 for(const wallet of first.wallets){
  const shared=second.wallets.find(w=>w.network===wallet.network);
  assert.equal(wallet.addressId,shared.addressId);assert.equal(wallet.address,shared.address);assert.notEqual(wallet.accountId,shared.accountId);
 }
 const state=await walletState(userId);
 assert.equal(state.addresses.length,3);assert.equal(state.keys.length,3);assert.equal(state.accounts.length,6);assert.equal(state.activations.length,6);
 assert.equal(await count('ledger_journals'),journals);assert.equal(rpcCalls,0);
});
