import {Wallet,getAddress,SigningKey,JsonRpcProvider,FetchRequest,Contract,formatUnits,Interface} from 'ethers';
import {Wallet as XrpWallet,isValidClassicAddress} from 'xrpl';
import {Keypair,PublicKey} from '@solana/web3.js';
import {TronWeb} from 'tronweb';
import {payments} from 'bitcoinjs-lib';
import {createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';
import {fault} from '../core.mjs';
export const NETWORKS={
 ETHEREUM:{name:'Ethereum',kind:'EVM',chainId:1,native:'ETH',decimals:18,rpc:'https://ethereum-rpc.publicnode.com',explorer:'https://etherscan.io'},
 BSC:{name:'BNB Smart Chain',kind:'EVM',chainId:56,native:'BNB',decimals:18,rpc:'https://bsc-rpc.publicnode.com',explorer:'https://bscscan.com'},
 POLYGON:{name:'Polygon',kind:'EVM',chainId:137,native:'POL',decimals:18,rpc:'https://polygon-bor-rpc.publicnode.com',explorer:'https://polygonscan.com'},
 ARBITRUM:{name:'Arbitrum',kind:'EVM',chainId:42161,native:'ETH',decimals:18,rpc:'https://arbitrum-one-rpc.publicnode.com',explorer:'https://arbiscan.io'},
 BASE:{name:'Base',kind:'EVM',chainId:8453,native:'ETH',decimals:18,rpc:'https://base-rpc.publicnode.com',explorer:'https://basescan.org'},
 AVALANCHE:{name:'Avalanche',kind:'EVM',chainId:43114,native:'AVAX',decimals:18,rpc:'https://avalanche-c-chain-rpc.publicnode.com',explorer:'https://snowtrace.io'},
 GNOSIS:{name:'Gnosis',kind:'EVM',chainId:100,native:'XDAI',decimals:18,rpc:'https://gnosis-rpc.publicnode.com',explorer:'https://gnosisscan.io'},
 TRON:{name:'TRON',kind:'TRON',native:'TRX',decimals:6,rpc:'https://api.trongrid.io',explorer:'https://tronscan.org'},
 XRPL:{name:'XRP Ledger',kind:'XRPL',native:'XRP',decimals:6,rpc:'https://s1.ripple.com:51234',explorer:'https://xrpscan.com'},
 SOLANA:{name:'Solana',kind:'SOLANA',native:'SOL',decimals:9,rpc:'https://api.mainnet-beta.solana.com',explorer:'https://solscan.io'},
 BITCOIN:{name:'Bitcoin',kind:'BITCOIN',native:'BTC',decimals:8,rpc:'https://blockstream.info/api',explorer:'https://blockstream.info'}
};
export const PLATFORM_NETWORKS={ethereum:'ETHEREUM','binance-smart-chain':'BSC','polygon-pos':'POLYGON','arbitrum-one':'ARBITRUM',base:'BASE',avalanche:'AVALANCHE',xdai:'GNOSIS',tron:'TRON',solana:'SOLANA'};
export const NATIVE_ASSETS={ethereum:'ETHEREUM',bitcoin:'BITCOIN',ripple:'XRPL',tron:'TRON',solana:'SOLANA',binancecoin:'BSC','polygon-ecosystem-token':'POLYGON','avalanche-2':'AVALANCHE'};
export const AG='0x713d3a1785219aeb37e52260ff8f96660851842b',AGI='0x0482213c1e5a9fefdee36d9b01c044938403a9af';
export function networkInfo(network){const n=NETWORKS[network];if(!n)fault('CRYPTO_NETWORK','network');return n;}
export function validAddress(network,address){try{const n=networkInfo(network);if(n.kind==='EVM')return getAddress(address)!=='0x0000000000000000000000000000000000000000';if(n.kind==='TRON')return TronWeb.isAddress(address);if(n.kind==='XRPL')return isValidClassicAddress(address);if(n.kind==='SOLANA')return new PublicKey(address).toBase58()===address;if(n.kind==='BITCOIN'){payments.p2wpkh({address});return true;}}catch{}return false;}
export function newWallet(network){const n=networkInfo(network);if(n.kind==='XRPL'){const w=XrpWallet.generate();return {address:w.classicAddress,key:{seed:w.seed}};}if(n.kind==='SOLANA'){const w=Keypair.generate();return {address:w.publicKey.toBase58(),key:{secretKey:Buffer.from(w.secretKey).toString('base64')}};}const w=Wallet.createRandom();if(n.kind==='TRON')return {address:TronWeb.address.fromPrivateKey(w.privateKey.slice(2)),key:{privateKey:w.privateKey}};if(n.kind==='BITCOIN')return {address:payments.p2wpkh({pubkey:Buffer.from(SigningKey.computePublicKey(w.privateKey,true).slice(2),'hex')}).address,key:{privateKey:w.privateKey}};return {address:w.address,key:{privateKey:w.privateKey}};}
function encryptionKey(env){const source=env.AVIS_WALLET_ENCRYPTION_KEY||env.AVIS_TRANSFER_ENCRYPTION_KEY||env.AVIS_OFFLINE_SIGNING_KEY;if(typeof source!=='string'||Buffer.byteLength(source)<32)fault('CRYPTO_KEY_CONFIGURATION','network');return Buffer.from(hkdfSync('sha256',source,'AVISPay independent wallet keys','wallet-at-rest:v1',32));}
export function encryptKey(secret,binding,env=process.env){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',encryptionKey(env),iv);c.setAAD(Buffer.from(binding));return {version:1,iv:iv.toString('base64'),ciphertext:Buffer.concat([c.update(JSON.stringify(secret),'utf8'),c.final()]).toString('base64'),tag:c.getAuthTag().toString('base64')};}
export function decryptKey(secret,binding,env=process.env){const c=createDecipheriv('aes-256-gcm',encryptionKey(env),Buffer.from(secret.iv,'base64'));c.setAAD(Buffer.from(binding));c.setAuthTag(Buffer.from(secret.tag,'base64'));return JSON.parse(Buffer.concat([c.update(Buffer.from(secret.ciphertext,'base64')),c.final()]).toString());}
export class ChainAPI {
 constructor({env=process.env,fetcher=fetch}={}){this.env=env;this.fetcher=fetcher;}
 connection(network){const n=networkInfo(network),env=this.env,key=env.COINAPI_NAAS_API_KEY||env.COINAPI_API_KEY||env.APIBRICKS_COINAPI_KEY;
  const selected=env['AVIS_RPC_'+network]||env['CRYPTO_RPC_'+network]||(network==='ETHEREUM'?(env.ALCHEMY_API_KEY?'https://eth-mainnet.g.alchemy.com/v2/'+env.ALCHEMY_API_KEY:key?'https://ethereum-mainnet.node.coinapi.io':n.rpc):n.rpc);
  let u;try{u=new URL(selected);}catch{fault('CRYPTO_CONNECTOR','network');}if(u.protocol!=='https:'||u.username||u.password)fault('CRYPTO_CONNECTOR','network');
  const headers={'content-type':'application/json'};if(u.origin==='https://ethereum-mainnet.node.coinapi.io'){if(!key||/[\r\n]/.test(key))fault('CRYPTO_CONNECTOR','network');headers['X-CoinAPI-Key']=key;}
  return {url:u.href.replace(/\/$/,''),headers,provider:u.hostname.endsWith('.alchemy.com')?'Alchemy':u.hostname==='ethereum-mainnet.node.coinapi.io'?'CoinAPI NaaS':env['AVIS_RPC_'+network]||env['CRYPTO_RPC_'+network]?'Configured RPC':'Public RPC'};
 }
 endpoint(network){return this.connection(network).url;}
 async request(network,method,params=[]){const n=networkInfo(network),url=this.endpoint(network);try{
  const body=n.kind==='XRPL'?{method,params:[params]}:{jsonrpc:'2.0',id:1,method,params};
  const response=await this.fetcher(url,{method:'POST',headers:this.connection(network).headers,body:JSON.stringify(body),signal:AbortSignal.timeout(12000),redirect:'error'});if(!response.ok)throw Error('HTTP');const r=await response.json();if(n.kind==='XRPL'&&method==='account_info'&&r.result?.error==='actNotFound')return {account_data:{Balance:'0'},exists:false};if(r.error||r.result?.error)throw Error('RPC');return r.result;
 }catch{fault('CRYPTO_CONNECTOR','network',502);}}
 provider(network){const n=networkInfo(network);if(n.kind!=='EVM')fault('CRYPTO_EVM_REQUIRED','network');const config=this.connection(network),request=new FetchRequest(config.url);request.allowInsecureAuthentication=false;request.timeout=12000;request.preflightFunc=async r=>{if(r.url!==config.url)fault('CRYPTO_CONNECTOR','network');return r;};for(const [key,value]of Object.entries(config.headers))request.setHeader(key,value);return new JsonRpcProvider(request,undefined,{batchMaxCount:1});}
 async check(network){const n=networkInfo(network);if(n.kind==='EVM'){const actual=Number(await this.request(network,'eth_chainId'));if(actual!==n.chainId)fault('CRYPTO_WRONG_CHAIN','network');return {network,chainId:actual};}if(n.kind==='SOLANA')return {network,slot:await this.request(network,'getSlot',[{commitment:'finalized'}])};if(n.kind==='XRPL')return {network,ledger:(await this.request(network,'server_info',{})).info.validated_ledger.seq};if(n.kind==='TRON'){const r=await this.http(network,'/walletsolidity/getnowblock',{});return {network,block:r.block_header?.raw_data?.number};}const r=await this.http(network,'/blocks/tip/height');return {network,block:Number(r)};}
 async http(network,path,body){try{const r=await this.fetcher(this.endpoint(network)+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(network==='TRON'&&this.env.TRONGRID_API_KEY?{'TRON-PRO-API-KEY':this.env.TRONGRID_API_KEY}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(12000),redirect:'error'});if(!r.ok)throw Error('HTTP');const data=await r.json();if(data.Error||data.error)throw Error('API');return data;}catch{fault('CRYPTO_CONNECTOR','network',502);}}
 async inspectAsset(network,address){const n=networkInfo(network);await this.check(network);if(!address)return {decimals:n.decimals};if(!validAddress(network,address))fault('INVALID_CRYPTO_ADDRESS','contractAddress');
  if(n.kind==='EVM'){const code=await this.request(network,'eth_getCode',[address,'latest']);if(!code||code==='0x')fault('CRYPTO_CONTRACT_CODE','contractAddress');const raw=await this.request(network,'eth_call',[{to:address,data:'0x313ce567'},'latest']);const decimals=Number(BigInt(raw));if(!Number.isInteger(decimals)||decimals<0||decimals>18)fault('CRYPTO_DECIMALS','contractAddress');return {decimals};}
  if(n.kind==='SOLANA'){const r=await this.request(network,'getAccountInfo',[address,{encoding:'jsonParsed',commitment:'finalized'}]);const decimals=r?.value?.data?.parsed?.info?.decimals;if(!Number.isInteger(decimals)||decimals>18)fault('CRYPTO_CONTRACT_CODE','contractAddress');return {decimals};}
  if(n.kind==='TRON'){const r=await this.http(network,'/wallet/triggerconstantcontract',{owner_address:address,contract_address:address,function_selector:'decimals()',visible:true});if(r.result?.result!==true||!r.constant_result?.[0])fault('CRYPTO_CONTRACT_CODE','contractAddress');const decimals=Number(BigInt('0x'+r.constant_result[0]));if(decimals>18)fault('CRYPTO_DECIMALS','contractAddress');return {decimals};}
  fault('CRYPTO_CONTRACT_CODE','contractAddress');
 }
 async balance(network,address,contractAddress=null,decimals=18){const n=networkInfo(network);if(!validAddress(network,address))fault('INVALID_CRYPTO_ADDRESS','address');
  if(n.kind==='EVM'){await this.check(network);const raw=contractAddress?await this.request(network,'eth_call',[{to:contractAddress,data:new Interface(['function balanceOf(address) view returns(uint256)']).encodeFunctionData('balanceOf',[address])},'finalized']):await this.request(network,'eth_getBalance',[address,'finalized']);return {balance:formatUnits(BigInt(raw),contractAddress?decimals:n.decimals)};}
  if(n.kind==='TRON'){if(contractAddress){const r=await this.http(network,'/wallet/triggerconstantcontract',{owner_address:address,contract_address:contractAddress,function_selector:'balanceOf(address)',parameter:TronWeb.address.toHex(address).slice(2).padStart(64,'0'),visible:true});if(!r.constant_result?.[0])fault('CRYPTO_CONNECTOR','network');return {balance:formatUnits(BigInt('0x'+r.constant_result[0]),decimals)};}const r=await this.http(network,'/walletsolidity/getaccount',{address,visible:true});return {balance:formatUnits(BigInt(r.balance||0),6)};}
  if(n.kind==='XRPL'){try{const r=await this.request(network,'account_info',{account:address,ledger_index:'validated'});return {balance:formatUnits(BigInt(r.account_data.Balance),6)};}catch(e){throw e;}}
  if(n.kind==='SOLANA'){if(contractAddress){const r=await this.request(network,'getTokenAccountsByOwner',[address,{mint:contractAddress},{encoding:'jsonParsed',commitment:'finalized'}]);const v=r.value.reduce((s,a)=>s+BigInt(a.account.data.parsed.info.tokenAmount.amount),0n);return {balance:formatUnits(v,decimals)};}const r=await this.request(network,'getBalance',[address,{commitment:'finalized'}]);return {balance:formatUnits(BigInt(r.value),9)};}
  const r=await this.http(network,'/address/'+encodeURIComponent(address));return {balance:formatUnits(BigInt(r.chain_stats.funded_txo_sum)-BigInt(r.chain_stats.spent_txo_sum),8)};
 }
}
