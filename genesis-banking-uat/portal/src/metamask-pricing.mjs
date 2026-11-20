import {money,decimal,fault} from './core.mjs';
import {NETWORKS} from './crypto/networks.mjs';
const U=10n**18n;
const networks={
 BITCOIN:['bip122:000000000019d6689c085ae165831e93','slip44:0'],
 SOLANA:['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','slip44:501'],
 TRON:['tron:0x2b6653dc','slip44:195'],XRPL:['xrpl:0','slip44:144']
};
const spotUrl='https://price.api.cx.metamask.io/v3/spot-prices';
export function metaAsset(network,contract){
 const n=NETWORKS[network];if(!n)return null;
 if(n.kind==='EVM')return 'eip155:'+n.chainId+'/'+(contract&&/^0x[0-9a-f]{40}$/i.test(contract)?'erc20:'+contract.toLowerCase():contract? '': 'slip44:60');
 const pair=networks[network];if(!pair)return null;if(!contract)return pair.join('/');
 if(network==='SOLANA')return pair[0]+'/token:'+contract;if(network==='TRON')return pair[0]+'/trc20:'+contract;return null;
}
const positive=value=>{const s=typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('en-US',{useGrouping:false,maximumFractionDigits:18}):String(value??'');try{return decimal(money(s));}catch{return null;}};
const cents=s=>{const n=positive(s);if(n)return (money(n)*100n+U-1n)/U;if(Number(s)===0&&s!==null&&s!==undefined&&s!=='')return 0n;return null;};
export class MetaMaskPricing {
 constructor({fetcher=fetch,env=process.env,now=Date.now}={}){this.fetcher=fetcher;this.env=env;this.now=now;this.cache=new Map();}
 async read(url,headers={}){
  let response;try{response=await this.fetcher(url,{headers:{accept:'application/json',...headers},redirect:'error',signal:AbortSignal.timeout(6500)});if(!response.ok)throw Error('quote service');return await response.json();}catch{fault('METAMASK_PRICE','asset',503);}
 }
 async spot(descriptor,fiat){
  const assetId=metaAsset(descriptor.network,descriptor.contract_address);if(!assetId)fault('METAMASK_PRICE','asset',422);
  const currency=fiat.toLowerCase(),key=assetId+'|'+currency,saved=this.cache.get(key);
  if(saved&&this.now()-saved.observedAt<10000)return saved;
  const url=new URL(spotUrl);url.search=new URLSearchParams({assetIds:assetId,vsCurrency:currency,includeMarketData:'false'}).toString();
  const body=await this.read(url,{'X-Client-Id':'avispay-checkout'}),rate=positive(body[assetId]?.price);
  if(!rate)fault('METAMASK_PRICE','asset',503);
  const value={assetId,rate,observedAt:this.now(),source:'MetaMask'};if(this.cache.size>512)this.cache.clear();this.cache.set(key,value);return value;
 }
 async networkGas(network){
  const chain=NETWORKS[network];if(chain?.kind!=='EVM')return null;
  const key='gas:'+chain.chainId,prior=this.cache.get(key);if(prior&&this.now()-prior.observedAt<10000)return prior;
  const result=await this.read(new URL('https://gas.api.cx.metamask.io/networks/'+chain.chainId+'/suggestedGasFees'),{'X-Client-Id':'avispay-checkout'});
  const maxGwei=positive(result.medium?.suggestedMaxFeePerGas),baseGwei=positive(result.estimatedBaseFee);
  if(!maxGwei)return null;const value={maxGwei,baseGwei,unit:'gwei',observedAt:this.now()};this.cache.set(key,value);return value;
 }
 async acquisition({assetId,fiat,budget,address}){
  if(!this.env.AVIS_METAMASK_RAMPS_REGION||!address||!this.env.AVIS_METAMASK_RAMPS_PAYMENT_METHOD)return null;
  const url=new URL('https://on-ramp.api.cx.metamask.io/v2/quotes');
  url.search=new URLSearchParams({action:'buy',context:'avispay-checkout',region:this.env.AVIS_METAMASK_RAMPS_REGION,fiat:fiat.toLowerCase(),crypto:assetId,amount:budget,walletAddress:address,payments:this.env.AVIS_METAMASK_RAMPS_PAYMENT_METHOD}).toString();
  const data=await this.read(url,this.env.AVIS_METAMASK_RAMPS_TOKEN?{authorization:'Bearer '+this.env.AVIS_METAMASK_RAMPS_TOKEN}:{});
  const quotes=(data.success||[]).map(r=>({provider:r.provider,quantity:positive(r.quote?.amountOut),gross:cents(r.quote?.amountIn),gas:cents(r.quote?.networkFee),fees:cents(r.quote?.totalFees)}))
   .filter(r=>r.quantity&&r.gross>0n&&r.gas!==null&&r.fees!==null&&r.gas<=r.fees&&r.fees<r.gross);
  quotes.sort((a,b)=>{const l=a.gross*money(b.quantity),r=b.gross*money(a.quantity);return l===r?0:l<r?-1:1;});
  const best=quotes[0];return best?{provider:best.provider,quantity:best.quantity,totalMinor:String(best.gross),gasMinor:String(best.gas),feeMinor:String(best.fees),observedAt:this.now()}:null;
 }
}
export function valuedTender(totalMinor,rate,decimals){
 const price=money(rate),quantum=10n**BigInt(18-decimals),den=100n*price*quantum;
 return decimal(((BigInt(totalMinor)*U*U+den-1n)/den)*quantum);
}
