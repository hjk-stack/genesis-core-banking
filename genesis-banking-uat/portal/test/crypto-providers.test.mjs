import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChainAPI} from '../src/crypto/networks.mjs';
import {TradingRobotCore} from '../src/trading-robot.mjs';
const actor={id:'provider-test',admin:true};
test('existing RPC settings keep CoinAPI keys on the CoinAPI origin for reads and signing transport',async()=>{
 const calls=[],env={COINAPI_NAAS_API_KEY:'fixture-node-key'},api=new ChainAPI({env,fetcher:async(url,o)=>{calls.push({url,o});return new Response('{"result":"0x1"}');}});
 await api.check('ETHEREUM');assert.equal(calls[0].o.headers['X-CoinAPI-Key'],env.COINAPI_NAAS_API_KEY);const provider=api.provider('ETHEREUM');assert.equal(provider._getConnection().getHeader('X-CoinAPI-Key'),env.COINAPI_NAAS_API_KEY);provider.destroy();
 env.CRYPTO_RPC_ETHEREUM='https://eth-mainnet.g.alchemy.com/v2/fixture';await api.check('ETHEREUM');assert.equal(calls[1].o.headers['X-CoinAPI-Key'],undefined);assert.equal(api.connection('ETHEREUM').provider,'Alchemy');env.CRYPTO_RPC_ETHEREUM='https://name:password@example.com';assert.throws(()=>api.endpoint('ETHEREUM'),/CRYPTO_CONNECTOR/);
});
test('provider validation performs only balances and chain reads and does not expose credentials',async()=>{
 const calls=[],env={COINAPI_EMS_API_KEY:'fixture-ems-key',COINAPI_NAAS_API_KEY:'fixture-node-key',ALCHEMY_API_KEY:'fixture-alchemy-key'};
 const core=new TradingRobotCore(null,{secretEnv:env,cryptoFetch:async(url,o)=>{calls.push({url,o});return new Response(JSON.stringify(url.includes('.ems.')?[{exchange_id:'KRAKEN/TREASURY'}]:{result:JSON.parse(o.body).method==='eth_chainId'?'0x1':'0x1234'}));}});
 const result=await core.validateRobotProviders(actor);assert.equal(result.providers.length,3);assert.ok(result.providers.every(p=>p.verified));assert.deepEqual(result.providers[0].accounts,['KRAKEN/TREASURY']);assert.ok(calls.every(c=>c.url.includes('/v1/balances')||['eth_chainId','eth_blockNumber'].includes(JSON.parse(c.o.body).method)));assert.ok(!JSON.stringify(result).includes('fixture-'));await assert.rejects(core.validateRobotProviders({...actor,customerUserId:'2'}),/FORBIDDEN/);
 const missing=await new TradingRobotCore(null,{secretEnv:{}}).validateRobotProviders(actor);assert.ok(missing.providers.every(p=>!p.configured&&!p.verified));
});
