import {createHash,createPublicKey,verify} from 'node:crypto';
import {fault} from './core.mjs';

// The existing website Ed25519 key serves separate strict checkout and handler
// audiences. Neither INDEX nor checkout credentials can submit handler reports.
const JWKS='https://avis.land/press/api/index-service/jwks';
const POS={routes:new Set(['/api/services/checkout-pos/resolve','/api/services/checkout-pos/status','/api/services/checkout-pos/request','/api/services/checkout-ip/register','/api/services/checkout-ip/status','/api/services/checkout-ip/cancel']),
 authorization:/^(?:Pos|Index)-JWS ([A-Za-z0-9_.-]+)$/,type:'AVIS-POS-REQUEST+JWT',issuer:'https://avis.land/checkout',audience:'AVIS_BANK_POS_V1',
 code:'POS_SERVICE_AUTH',actor:{id:'service:avis-land-checkout',admin:false,posService:true}};
const IP_HANDLER={routes:new Set(['/api/services/checkout-ip/registerDraft','/api/services/checkout-ip/selectNostroAccount','/api/services/checkout-ip/selectReceivingAccount','/api/services/checkout-ip/receivingAccounts','/api/services/checkout-ip/context','/api/services/checkout-ip/processing','/api/services/checkout-ip/claim']),
 authorization:/^Ip-JWS ([A-Za-z0-9_.-]+)$/,type:'AVIS-IP-HANDLER-REQUEST+JWT',issuer:'https://avis.land/ip-handler',audience:'AVIS_BANK_IP_HANDLER_V1',
 code:'IP_HANDLER_SERVICE_AUTH',actor:{id:'service:avis-land-ip-handler',admin:false,ipHandlerService:true}};
// Device admission has its own purpose and route. A checkout/INDEX signature
// cannot admit a workstation, and admission never grants a bank operator role.
const WORKSTATION={routes:new Set(['/api/services/workstations/handoff']),
 authorization:/^Workstation-JWS ([A-Za-z0-9_.-]+)$/,type:'AVIS-WORKSTATION-REQUEST+JWT',issuer:'https://avis.land/bank/workstations',audience:'AVIS_BANK_WORKSTATION_V1',
 code:'BANK_WORKSTATION_REQUIRED',actor:{id:'service:avis-land-workstations',admin:false,workstationService:true}};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const decode=(value,deny)=>{
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))deny();
 const b=Buffer.from(value,'base64url');if(b.toString('base64url')!==value)deny();return b;
};
const object=(value,deny)=>{let x;try{x=JSON.parse(decode(value,deny).toString('utf8'))}catch{deny()}if(!x||typeof x!=='object'||Array.isArray(x))deny();return x;};
class CheckoutServiceAuthenticator{
 constructor(pool,profile,{fetcher=fetch,now=()=>Date.now()}={}){this.pool=pool;this.profile=profile;this.fetcher=fetcher;this.now=now;this.keys=new Map();this.loadedAt=0;this.pending=null;}
 async refresh(){
  const deny=()=>fault(this.profile.code,null,401);
  if(this.pending)return this.pending;
  this.pending=(async()=>{
   let response;try{response=await this.fetcher(JWKS,{headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(5000)});}catch{deny()}
   if(!response?.ok||response.redirected)deny();
   const chunks=[];let size=0;
   for await(const chunk of response.body){size+=chunk.length;if(size>8192)deny();chunks.push(chunk)}
   let jwks;try{jwks=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{deny()}
   if(!Array.isArray(jwks.keys)||jwks.keys.length<1||jwks.keys.length>3)deny();
   const keys=new Map();
   for(const item of jwks.keys){
    if(item.kty!=='OKP'||item.crv!=='Ed25519'||item.alg!=='Ed25519'||item.use!=='sig'||typeof item.kid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(item.kid)||typeof item.x!=='string'||decode(item.x,deny).length!==32||Object.hasOwn(item,'d')||keys.has(item.kid))deny();
    keys.set(item.kid,createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:item.x},format:'jwk'}));
   }
   this.keys=keys;this.loadedAt=this.now();
  })();
  try{return await this.pending}finally{this.pending=null}
 }
 async authenticate(request,raw){
  const profile=this.profile,deny=()=>fault(profile.code,null,401);
  const authorization=request.headers.authorization||'';
  const match=profile.authorization.exec(authorization);
  if(!match||authorization.length>4096)deny();
  const parts=match[1].split('.');if(parts.length!==3)deny();
  const header=object(parts[0],deny),p=object(parts[1],deny),now=Math.floor(this.now()/1000);
  if(header.alg!=='Ed25519'||header.typ!==profile.type||typeof header.kid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(header.kid)||Object.keys(header).some(k=>!['alg','typ','kid'].includes(k)))deny();
  if(p.iss!==profile.issuer||p.aud!==profile.audience||p.method!=='POST'||p.method!==request.method||!profile.routes.has(p.path)||p.path!==request.url||p.body_sha256!==sha(raw)||!Number.isSafeInteger(p.iat)||!Number.isSafeInteger(p.exp)||p.iat>now+10||p.exp<=now||p.exp-p.iat>60||p.exp<=p.iat||!/^[a-f0-9]{64}$/.test(p.jti||'')||Object.keys(p).some(k=>!['iss','aud','method','path','body_sha256','iat','exp','jti'].includes(k)))deny();
  if(this.now()-this.loadedAt>300000||!this.keys.has(header.kid))await this.refresh();
  const key=this.keys.get(header.kid),signature=decode(parts[2],deny);
  if(!key||signature.length!==64||!verify(null,Buffer.from(parts[0]+'.'+parts[1]),key,signature))deny();
  const saved=await this.pool.query(`WITH expired AS (DELETE FROM avis_core_v2.checkout_pos_service_nonces WHERE expires_at<now())
    INSERT INTO avis_core_v2.checkout_pos_service_nonces(issuer,nonce,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING nonce`,[p.iss,p.jti,new Date((p.exp+10)*1000)]);
  if(saved.rows.length!==1)deny();
  return {...profile.actor};
 }
}
export class CheckoutPosAuthenticator extends CheckoutServiceAuthenticator{
 constructor(pool,options){super(pool,POS,options);}
}
export class CheckoutIpHandlerAuthenticator extends CheckoutServiceAuthenticator{
 constructor(pool,options){super(pool,IP_HANDLER,options);}
}
export class WorkstationAdmissionAuthenticator extends CheckoutServiceAuthenticator{
 constructor(pool,options){super(pool,WORKSTATION,options);}
}
