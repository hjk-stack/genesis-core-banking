import {fault} from './core.mjs';

// The login details of the peer banks' servers registered in the FinTerminal (src/fin-peer.mjs, register), kept only in Azure Key
// Vault: the bank owner, "the register is in a popup with IP and Bank name and login details into the receiver sever. (or for
// debit into the sender service and first login)", stored "only in Azure Key Vault". One secret for each peer server, written and
// read by the bank app with its own Azure identity (azure/move-uat-network.py, vault: the vault's address is AVIS_PEER_VAULT) and
// kept in the bank's memory for its connections (src/payment-transport.mjs). Never written anywhere else, shown or logged.
export const PEER_SECRET=/^fin-peer-[a-z0-9-]{1,100}$/;
export const VAULT_REFERENCE=/^KEYVAULT:(fin-peer-[a-z0-9-]{1,100})$/;
const API='7.4',RESOURCE='https://vault.azure.net',VAULT=/^https:\/\/[a-z][a-z0-9-]{1,22}[a-z0-9]\.vault\.azure\.net\/?$/;
// Each login with the write it came from: one written here while a load was under way is newer than what that load read.
const logins=new Map();let writes=0;
export const peerLogin=name=>logins.get(name)?.login;

export class PeerVault{
 constructor({env=process.env,fetcher=globalThis.fetch,clock=()=>Date.now()}={}){
  const vault=String(env.AVIS_PEER_VAULT||'');
  this.url=VAULT.test(vault)?vault.replace(/\/$/,''):null;
  // Azure gives an app with its own identity the address and key of its token service (Container Apps' managed identity).
  this.identity=env.IDENTITY_ENDPOINT&&env.IDENTITY_HEADER?{endpoint:env.IDENTITY_ENDPOINT,header:env.IDENTITY_HEADER}:null;
  this.fetcher=fetcher;this.clock=clock;this.token=null;
 }
 get ready(){return Boolean(this.url&&this.identity);}
 async #bearer(){
  if(this.token&&this.token.until>this.clock()+300000)return this.token.value;
  let body;
  try{
   const response=await this.fetcher(this.identity.endpoint+'?resource='+encodeURIComponent(RESOURCE)+'&api-version=2019-08-01',{headers:{'x-identity-header':this.identity.header}});
   body=response.ok?await response.json():null;
  }catch{body=null;}
  if(typeof body?.access_token!=='string')fault('PEER_VAULT',null,503);
  this.token={value:body.access_token,until:Number(body.expires_on)*1000||this.clock()+600000};
  return this.token.value;
 }
 // Only the vault's own address is ever given the token. A secret that is gone or disabled (403, 404) is answered as none where asked.
 async #call(method,url,body,{absent=false}={}){
  if(!this.ready||!url.startsWith(this.url+'/'))fault('PEER_VAULT',null,503);
  const headers={authorization:'Bearer '+await this.#bearer(),...(body?{'content-type':'application/json'}:{})};
  let response;
  try{response=await this.fetcher(url,{method,headers,...(body?{body:JSON.stringify(body)}:{})});}catch{fault('PEER_VAULT',null,503);}
  if(absent&&[403,404].includes(response.status))return null;
  if(!response.ok)fault('PEER_VAULT',null,503);
  return response.json();
 }
 async put(name,login){
  if(!PEER_SECRET.test(name))fault('PEER_VAULT',null,503);
  await this.#call('PUT',this.url+'/secrets/'+name+'?api-version='+API,{value:JSON.stringify(login),contentType:'application/json'});
  logins.set(name,{login,write:++writes});
 }
 // Every peer server's login read again into memory: at the bank's start and every few minutes after, as another instance of the
 // bank may have registered one. A load read to its end is what the bank holds from then: a login gone from the vault, disabled or
 // no longer readable goes from the bank too - its connector is refused and its issuer no longer trusted (review finding); a load
 // that fails changes nothing, and a login written here while it ran stays as written.
 async load(){
  if(!this.ready)return 0;
  const since=writes,names=[],fresh=new Map();
  for(let next=this.url+'/secrets?maxresults=25&api-version='+API;next;){
   const page=await this.#call('GET',next);
   for(const item of Array.isArray(page?.value)?page.value:[]){
    const name=/\/secrets\/([^/?]+)/.exec(String(item?.id||''))?.[1];if(name&&PEER_SECRET.test(name)&&item?.attributes?.enabled!==false)names.push(name);
   }
   next=typeof page?.nextLink==='string'&&page.nextLink.startsWith(this.url+'/')?page.nextLink:null;
  }
  for(const name of names){
   const secret=await this.#call('GET',this.url+'/secrets/'+name+'?api-version='+API,undefined,{absent:true});
   try{const login=secret&&JSON.parse(secret.value);if(login&&typeof login==='object')fresh.set(name,login);}catch{}
  }
  for(const [name,held] of logins)if(held.write<=since&&!fresh.has(name))logins.delete(name);
  for(const [name,login] of fresh)if(!(logins.get(name)?.write>since))logins.set(name,{login,write:since});
  return fresh.size;
 }
 watch(onLoad=()=>{},every=300000){
  if(!this.ready)return this;
  const look=()=>this.load().then(onLoad,()=>{});
  void look();this.timer=setInterval(look,every);this.timer.unref?.();
  return this;
 }
}
