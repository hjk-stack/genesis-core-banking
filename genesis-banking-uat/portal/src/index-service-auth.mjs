import {createHash,createPublicKey,timingSafeEqual,verify} from 'node:crypto';
import {fault} from './core.mjs';

export const INDEX_SERVICE_ISSUER='https://avis.land/press';
export const INDEX_SERVICE_AUDIENCE='AVIS_BANK_INDEX_V1';
export const INDEX_SERVICE_JWKS='https://avis.land/press/api/index-service/jwks';
const digest=value=>createHash('sha256').update(value).digest();
const reject=()=>fault('INDEX_SERVICE_AUTH',null,401);
const actor=method=>({id:'service:avis-press-index',admin:true,indexService:true,indexAuthMethod:method});
const paths=new Map([['/api/services/press-index/policy','GET'],['/api/services/press-index/candidates','POST']]);
const decode=part=>{if(!/^[A-Za-z0-9_-]+$/.test(part))reject();const bytes=Buffer.from(part,'base64url');if(bytes.toString('base64url')!==part)reject();return bytes;};
const json=part=>{try{const value=JSON.parse(decode(part).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))reject();return value;}catch{reject();}};

export class IndexServiceAuthenticator {
 constructor(pool,{env=process.env,fetcher=fetch,now=()=>Date.now()}={}){this.pool=pool;this.env=env;this.fetcher=fetcher;this.now=now;this.keys=new Map();this.loadedAt=0;this.attemptedAt=-Infinity;this.pending=null;}
 async loadKeys(){
  if(this.pending)return this.pending;
  if(this.now()-this.attemptedAt<5000)reject();this.attemptedAt=this.now();
  this.pending=(async()=>{const response=await this.fetcher(INDEX_SERVICE_JWKS,{headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok||response.redirected)reject();
   const parts=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>8192)reject();parts.push(chunk);}
   const data=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!Array.isArray(data.keys)||data.keys.length<1||data.keys.length>3)reject();const keys=new Map();
   for(const jwk of data.keys){if(jwk.kty!=='OKP'||jwk.crv!=='Ed25519'||jwk.alg!=='Ed25519'||jwk.use!=='sig'||typeof jwk.kid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(jwk.kid)||typeof jwk.x!=='string'||decode(jwk.x).length!==32||Object.hasOwn(jwk,'d')||keys.has(jwk.kid))reject();const key=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:jwk.x},format:'jwk'});if(key.asymmetricKeyType!=='ed25519')reject();keys.set(jwk.kid,key);}
   this.keys=keys;this.loadedAt=this.now();
  })();try{await this.pending;}catch{reject();}finally{this.pending=null;}
 }
 async authenticate(request,raw=Buffer.alloc(0)){
  const value=request.headers.authorization||'';
  if(value.startsWith('Bearer ')){
   const configured=this.env.AVIS_INDEX_SERVICE_TOKEN,received=/^Bearer ([^\s]+)$/.exec(value)?.[1];
   if(typeof configured!=='string'||Buffer.byteLength(configured)<32||typeof received!=='string'||received.length>512||!timingSafeEqual(digest(configured),digest(received)))reject();
   return actor('BEARER');
  }
  if(value.length>4096)reject();const token=/^Index-JWS ([A-Za-z0-9_.-]+)$/.exec(value)?.[1];if(!token)reject();const parts=token.split('.');if(parts.length!==3)reject();const [header,payload]=parts.slice(0,2).map(json),now=Math.floor(this.now()/1000);
  if(Object.keys(header).some(k=>!['alg','typ','kid'].includes(k))||header.alg!=='Ed25519'||header.typ!=='AVIS-INDEX-REQUEST+JWT'||typeof header.kid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(header.kid))reject();
  if(Object.keys(payload).some(k=>!['iss','aud','method','path','body_sha256','iat','exp','jti'].includes(k))||payload.iss!==INDEX_SERVICE_ISSUER||payload.aud!==INDEX_SERVICE_AUDIENCE||paths.get(payload.path)!==request.method||payload.method!==request.method||payload.path!==request.url||payload.body_sha256!==digest(raw).toString('hex')||!Number.isSafeInteger(payload.iat)||!Number.isSafeInteger(payload.exp)||payload.iat>now+10||payload.exp<=now||payload.exp<=payload.iat||payload.exp-payload.iat>60||!/^[a-f0-9]{64}$/.test(payload.jti||''))reject();
  if(this.now()-this.loadedAt>=300000||!this.keys.has(header.kid))await this.loadKeys();const key=this.keys.get(header.kid),signature=decode(parts[2]);if(!key||signature.length!==64||!verify(null,Buffer.from(parts[0]+'.'+parts[1]),key,signature))reject();
  // Every retry uses a new signed nonce. Accepted candidate bodies retain their
  // own durable batch idempotency and can be replayed safely with that new nonce.
  const used=await this.pool.query(`WITH expired AS (DELETE FROM avis_core_v2.index_service_nonces WHERE expires_at<now()) INSERT INTO avis_core_v2.index_service_nonces(issuer,nonce,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING nonce`,[payload.iss,payload.jti,new Date((payload.exp+10)*1000)]);if(!used.rows.length)reject();return actor('ED25519_JWS');
 }
}
