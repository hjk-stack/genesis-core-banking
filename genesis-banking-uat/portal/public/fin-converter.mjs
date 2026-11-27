// The FinTerminal specification v3 (FinTerminal_Unified_NOSTRO_Crypto_System_v3), Screen B's "Fiat-to-Crypto/Stablecoin Selector"
// and "IVMS101 Verification": each of AVISPay PLC's accounts with the wallet its incoming credits are converted into while ROBOTIC
// STP is active - or the NOSTRO, as a cash wire - the live rates, and the transfers converted with their hash and travel-rule data.
import {balance} from './fin-settlement.mjs';
const LABELS={EURC:'EURC (1:1 MiCA Euro Stablecoin)',USDC:'USDC (USD Coin)',BTC:'BTC (Bitcoin)',ETH:'ETH (Ethereum)',SOL:'SOL (Solana)'};
const LOOK=15000;

export function createFinConverter({root=document,request,view=root.defaultView||globalThis}){
 const routes=root.querySelector('[data-fin-routes]'),rates=root.querySelector('[data-fin-rates]'),done=root.querySelector('[data-fin-conversions]');
 const problem=root.querySelector('[data-fin-convert-problem]');
 if(!routes||!rates||!done)return null;
 let saving=false;
 const make=(tag,text)=>{const node=root.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
 const option=(value,text)=>{const item=make('option',text);item.value=value;return item;};
 function paintRoutes(data){
  const wallets=data.wallets||[];
  routes.replaceChildren(...(data.accounts||[]).map(account=>{
   const item=make('li'),choice=make('select');
   choice.dataset.route=account.accountId;choice.setAttribute('aria-label','Conversion of '+[account.label,account.iban].filter(Boolean).join(' '));
   choice.append(option('','Cash Wire (NOSTRO)'));
   for(const asset of data.assets||[]){
    const own=wallets.filter(wallet=>wallet.currency===asset);if(!own.length)continue;
    const group=make('optgroup');group.label=LABELS[asset]||asset;
    group.append(...own.map(wallet=>option(wallet.accountId,[wallet.currency,wallet.network,wallet.holder].join(' · '))));choice.append(group);
   }
   choice.value=account.tokenWalletId||'';
   item.append(make('span',[account.label,account.iban,account.currency].filter(Boolean).join(' · ')),choice);return item;
  }));
 }
 function paint(data){
  if(!data||typeof data!=='object')return;
  // A choice being made is not painted over.
  if(!saving&&!routes.contains(root.activeElement))paintRoutes(data);
  rates.replaceChildren(...(data.rates||[]).map(rate=>make('li','1 '+rate.currency+' = '+(rate.rate?balance(rate.rate,8)+' '+rate.asset+' · '+rate.source:rate.asset+' · no live rate')+' · '+rate.network)));
  done.replaceChildren(...(data.conversions||[]).map(item=>make('li',[item.at.slice(0,19).replace('T',' ')+' UTC',
   balance(item.amount)+' '+item.currency+' → '+item.quantity+' '+item.asset+' ('+item.network+')','TX:'+item.txHash.slice(0,14)+'...',item.mode,
   (item.ivms101.verified?'IVMS101 ✓ ':'IVMS101 ✗ ')+item.ivms101.originator+' → '+item.ivms101.beneficiary].join(' · '))));
 }
 function say(text){if(problem){problem.textContent=text||'';problem.hidden=!text;}}
 async function refresh(){let data;try{data=await request('GET','/api/fin-terminal/converter');}catch{return;}paint(data);}
 routes.addEventListener('change',event=>{
  const choice=event.target.closest?.('select[data-route]');if(!choice)return;
  saving=true;say('');
  request('POST','/api/fin-terminal/converter',{bookingAccountId:choice.dataset.route,tokenWalletId:choice.value||null})
   .then(data=>{saving=false;choice.blur();paint(data);})
   .catch(error=>{saving=false;say(error?.message||'Not saved.');choice.blur();void refresh();});
 });
 return {start(){void refresh();view.setInterval(()=>void refresh(),LOOK);},refresh};
}
