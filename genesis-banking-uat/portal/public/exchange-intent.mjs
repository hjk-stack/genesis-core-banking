// A link carries public order choices only. Login, account selection and the
// final reviewed Buy/Sell remain necessary; a URL can never submit an order.
export function readExchangeIntent(hash){
 if(!String(hash).startsWith('#exchange?'))return null;
 const q=new URLSearchParams(hash.slice(10)),side=q.get('side')?.toUpperCase(),symbol=q.get('symbol')?.toUpperCase();
 if(q.get('view')==='portfolio'&&!side)return {view:'portfolio'};
 if(!['BUY','SELL'].includes(side)||!symbol||!/^[A-Z0-9._-]{1,80}$/.test(symbol))throw Error('Choose a valid exchange security and Buy or Sell.');
 const intent={side,symbol};
 for(const key of ['quantity','price'])if(q.has(key)&&q.get(key)!==''){
  const value=q.get(key);if(!/^[0-9]{1,18}(\.[0-9]{1,18})?$/.test(value)||!/[1-9]/.test(value))throw Error('Enter a positive '+key+'.');intent[key]=value;
 }
 return intent;
}
