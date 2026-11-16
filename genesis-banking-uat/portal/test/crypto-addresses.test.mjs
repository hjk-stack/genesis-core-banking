import {test} from 'node:test';
import assert from 'node:assert/strict';
import {address as bitcoinAddress} from 'bitcoinjs-lib';
import {ChainAPI,newWallet,validAddress} from '../src/crypto/networks.mjs';

test('Bitcoin address validation accepts legacy, script, SegWit and Taproot receiving formats',()=>{
 for(const address of [
  '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
  '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
  newWallet('BITCOIN').address,
  bitcoinAddress.toBech32(Buffer.alloc(32,1),0,'bc'),
  bitcoinAddress.toBech32(Buffer.alloc(32,2),1,'bc'),
 ])assert.equal(validAddress('BITCOIN',address),true,address);
});

test('Bitcoin address validation rejects checksum failures, other networks and non-address text',()=>{
 for(const address of [
  '1BoatSLRHtKNngkdXEeobR76b53LETtpyU',
  bitcoinAddress.toBech32(Buffer.alloc(20,1),0,'tb'),
  bitcoinAddress.toBech32(Buffer.alloc(32,2),1,'bcrt'),
  '0x1234567890123456789012345678901234567890',
  '',
 ])assert.equal(validAddress('BITCOIN',address),false,address);
});

test('CoinAPI market data credentials never override the public Ethereum RPC',()=>{
 const api=new ChainAPI({env:{COINAPI_API_KEY:'market-key',APIBRICKS_COINAPI_KEY:'other-market-key'}});
 const config=api.connection('ETHEREUM');
 assert.equal(config.provider,'Public RPC');
 assert.equal(config.url,'https://ethereum-rpc.publicnode.com');
 assert.equal(config.headers['X-CoinAPI-Key'],undefined);
});
test('a dedicated CoinAPI node key selects Node-as-a-Service and sends only its node credential',()=>{
 const api=new ChainAPI({env:{COINAPI_API_KEY:'market-key',COINAPI_NAAS_API_KEY:'node-key'}});
 const config=api.connection('ETHEREUM');
 assert.equal(config.provider,'CoinAPI NaaS');
 assert.equal(config.headers['X-CoinAPI-Key'],'node-key');
});
test('explicit chain RPC overrides provider discovery without leaking unrelated credentials',()=>{
 const api=new ChainAPI({env:{COINAPI_NAAS_API_KEY:'node-key',ALCHEMY_API_KEY:'alchemy-key',AVIS_RPC_ETHEREUM:'https://custom.node.example/rpc'}});
 const config=api.connection('ETHEREUM');
 assert.equal(config.provider,'Configured RPC');
 assert.equal(config.url,'https://custom.node.example/rpc');
 assert.deepEqual(config.headers,{'content-type':'application/json'});
 assert.equal(api.connection('TRON').provider,'Public RPC');
});
test('Alchemy is selected only for Ethereum and not for unrelated blockchains',()=>{
 const api=new ChainAPI({env:{ALCHEMY_API_KEY:'alchemy-token'}});
 assert.equal(api.connection('ETHEREUM').provider,'Alchemy');
 assert.equal(api.connection('TRON').provider,'Public RPC');
 assert.equal(api.connection('XRPL').provider,'Public RPC');
});

test('Bitcoin network probe accepts the public plaintext block-height response',async()=>{
 const seen=[],api=new ChainAPI({env:{},fetcher:async(url,options)=>{seen.push({url,method:options.method});return new Response('935471\n',{status:200,headers:{'content-type':'text/plain'}});}});
 const probe=await api.check('BITCOIN');
 assert.equal(probe.block,935471);
 assert.equal(seen.length,1);
 assert.match(seen[0].url,/\/blocks\/tip\/height$/);
 assert.equal(seen[0].method,'GET');
});
test('Bitcoin network probe rejects a non-numeric block height',async()=>{
 const api=new ChainAPI({env:{},fetcher:async()=>new Response('<html>upstream error</html>',{status:200})});
 await assert.rejects(api.check('BITCOIN'),/CRYPTO_CONNECTOR/);
});
test('Bitcoin balance endpoint keeps JSON parsing independent of the height probe',async()=>{
 const wallet=newWallet('BITCOIN').address;
 const api=new ChainAPI({env:{},fetcher:async(url)=>new Response(JSON.stringify({chain_stats:{funded_txo_sum:1200,spent_txo_sum:200}}),{status:200})});
 assert.deepEqual(await api.balance('BITCOIN',wallet),{balance:'0.00001'});
});
