import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet} from 'ethers';
import {newWallet,validAddress,encryptKey,decryptKey} from '../src/crypto/networks.mjs';

const env={AVIS_WALLET_ENCRYPTION_KEY:'avispay-unit-test-32-byte-master-secret-2026'};
test('AVISPay creates valid wallet addresses for five blockchain families without HSM or external wallet services',()=>{
 for(const network of ['ETHEREUM','TRON','XRPL','SOLANA','BITCOIN']){
  const wallet=newWallet(network);
  assert.equal(validAddress(network,wallet.address),true,network);
  assert.ok(Object.keys(wallet.key).length===1);
  assert.notEqual(wallet.address,'');
 }
});
test('Ethereum private key produces the registered receiving account without HSM',()=>{
 const {address,key}=newWallet('ETHEREUM');
 assert.equal(Wallet.fromPrivateKey(key.privateKey).address.toLowerCase(),address.toLowerCase());
 assert.equal(validAddress('ETHEREUM',address),true);
});
test('software wallet secrets are AES-GCM sealed with account and network associated data',()=>{
 const wallet=newWallet('ETHEREUM'),binding='holder-1:ETHEREUM';
 const sealed=encryptKey(wallet.key,binding,env);
 assert.equal(sealed.version,1);
 assert.ok(!JSON.stringify(sealed).includes(wallet.key.privateKey));
 assert.deepEqual(decryptKey(sealed,binding,env),wallet.key);
 assert.throws(()=>decryptKey(sealed,'holder-2:ETHEREUM',env));
 assert.throws(()=>decryptKey(sealed,'holder-1:POLYGON',env));
 assert.throws(()=>decryptKey(sealed,binding,{AVIS_WALLET_ENCRYPTION_KEY:'different-avispay-unit-test-master-secret-2026'}));
});
test('an unrelated old HSM environment variable cannot change wallet generation or encryption',()=>{
 const oldHsm={...env,AVIS_WALLET_HSM_URL:'https://legacy.managedhsm.azure.net'};
 const wallet=newWallet('ETHEREUM');
 const binding='holder-1:ETHEREUM';
 const a=encryptKey(wallet.key,binding,env),b=encryptKey(wallet.key,binding,oldHsm);
 assert.deepEqual(decryptKey(a,binding,oldHsm),wallet.key);
 assert.deepEqual(decryptKey(b,binding,env),wallet.key);
 assert.notEqual(a.iv,b.iv);
});
