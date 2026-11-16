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
 const calls=[],env={COINAPI_API_KEY:'fixture-market-key',COINAPI_EMS_API_KEY:'fixture-ems-key',COINAPI_NAAS_API_KEY:'fixture-node-key',ALCHEMY_API_KEY:'fixture-alchemy-key'};
 const core=new TradingRobotCore(null,{secretEnv:env,cryptoFetch:async(url,o)=>{calls.push({url,o});return new Response(JSON.stringify(url.includes('rest.coinapi.io')?{asset_id_base:'BTC',asset_id_quote:'USD',rate:102000}:url.includes('.ems.')?[{exchange_id:'KRAKEN/TREASURY'}]:{result:JSON.parse(o.body).method==='eth_chainId'?'0x1':'0x1234'}));}});
 const result=await core.validateRobotProviders(actor);assert.equal(result.providers.length,4);assert.ok(result.providers.every(p=>p.verified));assert.deepEqual(result.providers.find(p=>p.provider==='CoinAPI EMS').accounts,['KRAKEN/TREASURY']);assert.ok(calls.every(c=>c.url.includes('/v1/balances')||c.url.includes('/v1/exchangerate/BTC/USD')||['eth_chainId','eth_blockNumber'].includes(JSON.parse(c.o.body).method)));assert.ok(!JSON.stringify(result).includes('fixture-'));await assert.rejects(core.validateRobotProviders({...actor,customerUserId:'2'}),/FORBIDDEN/);
 const missing=await new TradingRobotCore(null,{secretEnv:{}}).validateRobotProviders(actor);assert.ok(missing.providers.every(p=>!p.configured&&!p.verified));
});
for(const setting of ['AVIS_RPC_ETHEREUM','CRYPTO_RPC_ETHEREUM'])test('provider validation uses the configured Alchemy URL from '+setting,async()=>{
 const endpoint='https://eth-mainnet.g.alchemy.com/v2/fixture-url-credential',calls=[];
 const core=new TradingRobotCore(null,{secretEnv:{[setting]:endpoint},cryptoFetch:async(url,o)=>{calls.push({url,o});return new Response(JSON.stringify({result:JSON.parse(o.body).method==='eth_chainId'?'0x1':'0x1234'}));}});
 const result=await core.validateRobotProviders(actor),alchemy=result.providers.find(p=>p.provider==='Alchemy');
 assert.equal(alchemy.configured,true);assert.equal(alchemy.verified,true);assert.equal(alchemy.blockNumber,4660);
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.url===endpoint&&!c.o.headers['X-CoinAPI-Key']));
 assert.ok(!JSON.stringify(result).includes('fixture-url-credential'));
});
test('provider validation respects operational endpoint precedence and rejects a wrong chain without exposing the URL',async()=>{
 const endpoint='https://eth-mainnet.g.alchemy.com/v2/fixture-current',calls=[];
 const core=new TradingRobotCore(null,{secretEnv:{AVIS_RPC_ETHEREUM:endpoint,CRYPTO_RPC_ETHEREUM:'https://eth-mainnet.g.alchemy.com/v2/fixture-old',ALCHEMY_API_KEY:'fixture-fallback'},cryptoFetch:async(url,o)=>{calls.push(url);return new Response(JSON.stringify({result:JSON.parse(o.body).method==='eth_chainId'?'0x38':'0x1234'}));}});
 const result=await core.validateRobotProviders(actor),alchemy=result.providers.find(p=>p.provider==='Alchemy');
 assert.equal(alchemy.configured,true);assert.equal(alchemy.verified,false);assert.equal(alchemy.code,'RPC_VALIDATION');
 assert.ok(calls.length>0&&calls.every(url=>url===endpoint));assert.ok(!JSON.stringify(result).includes('fixture-'));
});

test('new bank market-data credential validates against CoinAPI without substituting an EMS key',async()=>{
 const calls=[],core=new TradingRobotCore(null,{secretEnv:{COINAPI_API_KEY:'existing-live-test-key'},cryptoFetch:async(url,options)=>{
  calls.push({url,options});return new Response(JSON.stringify({asset_id_base:'BTC',asset_id_quote:'USD',rate:98000}));
 }});
 const result=await core.validateRobotProviders(actor),market=result.providers.find(p=>p.provider==='CoinAPI Market Data');
 assert.equal(market.configured,true);assert.equal(market.verified,true);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://rest.coinapi.io/v1/exchangerate/BTC/USD');
 assert.equal(calls[0].options.headers['X-CoinAPI-Key'],'existing-live-test-key');
 assert.ok(!JSON.stringify(result).includes('existing-live-test-key'));
 assert.equal(result.providers.find(p=>p.provider==='CoinAPI EMS').configured,false);
});
test('CoinAPI market-data probe reports HTTP rejection without treating a configured key as verified',async()=>{
 const core=new TradingRobotCore(null,{secretEnv:{COINAPI_API_KEY:'key'},cryptoFetch:async()=>new Response('denied',{status:401})});
 const market=(await core.validateRobotProviders(actor)).providers.find(p=>p.provider==='CoinAPI Market Data');
 assert.equal(market.configured,true);assert.equal(market.verified,false);assert.equal(market.code,'MARKET_HTTP_401');
});
