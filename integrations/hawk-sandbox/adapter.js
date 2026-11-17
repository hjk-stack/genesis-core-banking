'use strict';
// Explicitly synthetic-only Hawk API test adapter. No payments, ledger or bond access.
function mapSynthetic(event) {
  if (!event || event.synthetic !== true) throw Error('SYNTHETIC_ONLY');
  if (typeof event.transactionId!=='string'||!/^SYN-[A-Za-z0-9_-]{8,64}$/.test(event.transactionId)) throw Error('INVALID_TEST_ID');
  if (!['EUR','USD','GBP','CHF'].includes(event.currency)) throw Error('INVALID_CURRENCY');
  if (typeof event.amountMinor!=='string'|| !/^[1-9][0-9]{0,11}$/.test(event.amountMinor)) throw Error('INVALID_AMOUNT');
  if (['customer','customerId','name','iban','accountNumber','cardNumber'].some(k=>Object.hasOwn(event,k))) throw Error('REAL_CUSTOMER_DATA_NOT_PERMITTED');
  // Demonstration assumes 2-decimal currency; production requires official ISO exponents.
  return {tenantTransactionId:event.transactionId,settledAmount:Number(BigInt(event.amountMinor))/100,settledCurrency:event.currency};
}
function getConfiguration(env) {
  if (env.HAWK_ENVIRONMENT!=='sandbox'||env.HAWK_ALLOW_SANDBOX_CALLS!=='YES') throw Error('HAWK_DISABLED');
  if (typeof env.HAWK_SANDBOX_URL!=='string') throw Error('HAWK_URL_MISSING');
  let url;try{url=new URL(env.HAWK_SANDBOX_URL)}catch{throw Error('INVALID_HAWK_URL')}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port||url.pathname!=='/'||!url.hostname.includes('.')||/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname))throw Error('INVALID_HAWK_URL');
  if(typeof env.HAWK_SANDBOX_API_KEY!=='string'||env.HAWK_SANDBOX_API_KEY.length<12)throw Error('HAWK_KEY_MISSING');
  return {url,key:env.HAWK_SANDBOX_API_KEY};
}
async function checkSynthetic(event,{env=process.env,fetchImpl=globalThis.fetch}={}) {
  const data=mapSynthetic(event),config=getConfiguration(env);
  let response;try{
    response=await fetchImpl(new URL('/v1/transaction-checks?dryRun=True',config.url),{
      method:'POST',headers:{'api-key':config.key,'content-type':'application/json','accept':'application/json'},
      body:JSON.stringify(data),signal:AbortSignal.timeout(5000)});
  }catch{throw Error('HAWK_TEST_UNAVAILABLE')}
  if(!response||!response.ok)throw Error('HAWK_TEST_REJECTED');
  return {submitted:true,mode:'sandbox',dryRun:true,transactionId:event.transactionId};
}
module.exports={mapSynthetic,getConfiguration,checkSynthetic};
