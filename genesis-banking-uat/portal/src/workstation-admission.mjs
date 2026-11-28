import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {fault} from './core.mjs';

export const WORKSTATION_BANK_ORIGIN='https://bank.avispay.online';
export const WORKSTATION_FRONT_CONNECT='https://avis.land/bank/workstations/connect';
export const WORKSTATION_FRONT_STATUS='https://avis.land/bank/workstations/admission-status';
export const WORKSTATION_PENDING_COOKIE='__Host-avis_bank_pending';
export const WORKSTATION_ADMISSION_COOKIE='__Host-avis_bank_admission';
export const WORKSTATION_HANDOFF_SECONDS=120;
export const WORKSTATION_ADMISSION_SECONDS=3600;
const opaque=/^[A-Za-z0-9_-]{43}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=value=>createHash('sha256').update(value).digest('hex');
const challenge=value=>createHash('sha256').update(value).digest('base64url');
const random=()=>randomBytes(32).toString('base64url');
const deny=()=>fault('BANK_WORKSTATION_REQUIRED',null,403);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const identifier=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x20\x7f]/.test(value);
const bindFields=['principal','deviceId','approvalId','generation'];
const sameBinding=(a,b)=>object(a)&&object(b)&&bindFields.every(key=>a[key]===b[key]);
// The person avis.land knows behind an admission, for the FinTerminal (src/fin-access.mjs): their name, whether they are the owner,
// whether the owner gave them FinTerminal access in avis.land's User access management, and everyone who has it, by name.
// A name is a name only with something in it besides spaces (review finding).
const nameOf=value=>{const name=typeof value==='string'?value.trim():'';return name&&[...name].length<=80&&!/[\x00-\x1f\x7f]/.test(name)?name:'';};
function person(current,grant){
 const administrators=(Array.isArray(current.finTerminalAdministrators)?current.finTerminalAdministrators:[])
  .filter(entry=>object(entry)&&nameOf(entry.name)).slice(0,40).map(entry=>({name:nameOf(entry.name),owner:entry.owner===true}));
 const name=nameOf(current.name);
 return {principal:grant.principal,name,owner:current.owner===true,finTerminal:current.finTerminal===true&&Boolean(name),administrators};
}

// Reject duplicate cookies instead of allowing parser order to select authority.
function cookie(req,name){
 const values=String(req.headers.cookie||'').split(';').map(part=>part.trim()).filter(part=>part.startsWith(name+'='));
 if(!values.length)return null;
 if(values.length!==1)deny();
 const value=values[0].slice(name.length+1);if(!opaque.test(value))deny();return value;
}
const attributes='; HttpOnly; Secure; Path=/';
export const clearWorkstationPendingCookie=()=>WORKSTATION_PENDING_COOKIE+'='+attributes+'; SameSite=Lax; Max-Age=0';
export const clearWorkstationAdmissionCookie=()=>WORKSTATION_ADMISSION_COOKIE+'='+attributes+'; SameSite=Strict; Max-Age=0';

export class WorkstationAdmission {
 constructor(pool,{fetcher=fetch,now=()=>Date.now()}={}){this.pool=pool;this.fetcher=fetcher;this.now=now;this.starts=new Map();}

 async start(req){
  // Use the actual transport peer, never a caller-supplied forwarding header.
  // This is a bounded bootstrap throttle, not a physical-device identifier.
  const peer=String(req?.socket?.remoteAddress||'unknown'),now=this.now(),previous=this.starts.get(peer);
  if(previous&&now-previous.since<60000&&previous.count>=60)fault('TOO_MANY_ATTEMPTS',null,429);
  if(this.starts.size>=1000)for(const [key,value] of this.starts)if(now-value.since>=60000)this.starts.delete(key);
  if(this.starts.size>=1000&&!previous)fault('TOO_MANY_ATTEMPTS',null,429);
  this.starts.set(peer,previous&&now-previous.since<60000?{since:previous.since,count:previous.count+1}:{since:now,count:1});
  const state=random(),verifier=random(),codeChallenge=challenge(verifier);
  // A public bootstrap carries no authority. Bound its lifetime and retained
  // rows, and keep the verifier exclusively in the bank host's HttpOnly cookie.
  const result=await this.pool.query(`WITH expired AS (
   DELETE FROM avis_core_v2.workstation_device_handoffs WHERE expires_at<=now()
  ) INSERT INTO avis_core_v2.workstation_device_handoffs(state_hash,code_challenge,expires_at)
  SELECT $1,$2,now()+interval '120 seconds'
  WHERE (SELECT count(*) FROM avis_core_v2.workstation_device_handoffs WHERE expires_at>now())<1000
  RETURNING state_hash`,[digest(state),codeChallenge]);
  if(result.rows.length!==1)deny();
  const location=new URL(WORKSTATION_FRONT_CONNECT);
  location.searchParams.set('state',state);location.searchParams.set('code_challenge',codeChallenge);location.searchParams.set('code_challenge_method','S256');
  return {location:location.href,cookie:WORKSTATION_PENDING_COOKIE+'='+verifier+attributes+'; SameSite=Lax; Max-Age='+WORKSTATION_HANDOFF_SECONDS};
 }

 grant(value){
  const allowed=['state','codeChallenge','principal','deviceId','approvalId','generation','expiresAt','statusCapability'];
  if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key))||!opaque.test(value.state||'')||!opaque.test(value.codeChallenge||'')||
   !identifier(value.principal,300)||!identifier(value.deviceId,200)||!uuid.test(value.approvalId||'')||!uuid.test(value.generation||'')||
   typeof value.statusCapability!=='string'||value.statusCapability.length>4096||!/^[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+$/.test(value.statusCapability))deny();
  const expiresAt=Date.parse(value.expiresAt),now=this.now();
  if(typeof value.expiresAt!=='string'||!Number.isFinite(expiresAt)||expiresAt<=now||expiresAt>now+WORKSTATION_ADMISSION_SECONDS*1000)deny();
  return Object.fromEntries([...bindFields,'expiresAt','statusCapability'].map(key=>[key,value[key]]));
 }

 async handoff(service,input){
  if(service?.workstationService!==true||service.admin!==false)deny();
  const grant=this.grant(input),code=random();
  const saved=await this.pool.query(`UPDATE avis_core_v2.workstation_device_handoffs
   SET code_hash=$3,admission_grant=$4::jsonb
   WHERE state_hash=$1 AND code_challenge=$2 AND code_hash IS NULL AND used_at IS NULL AND expires_at>now()
   RETURNING state_hash`,[digest(input.state),input.codeChallenge,digest(code),JSON.stringify(grant)]);
  if(saved.rows.length!==1)deny();
  // Only the authenticated signed caller receives the code. There is no public
  // polling endpoint from which a copied state/challenge can obtain it.
  const redirect=new URL('/access/complete',WORKSTATION_BANK_ORIGIN);
  redirect.searchParams.set('state',input.state);redirect.searchParams.set('code',code);
  return {redirectUrl:redirect.href};
 }

 async active(grant){
  if(!object(grant)||Date.parse(grant.expiresAt)<=this.now())deny();
  try{
   const response=await this.fetcher(WORKSTATION_FRONT_STATUS,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({capability:grant.statusCapability})});
   if(!response?.ok||response.redirected)deny();
   if(Number(response.headers?.get('content-length'))>8192)deny();
   const chunks=[];let size=0;
   for await(const part of response.body){size+=part.length;if(size>8192)deny();chunks.push(Buffer.from(part));}
   const current=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!object(current)||current.active!==true||!sameBinding(current,grant)||Date.parse(current.expiresAt)!==Date.parse(grant.expiresAt)||Date.parse(current.expiresAt)<=this.now())deny();
   return person(current,grant);
  }catch{deny();}
 }

 async complete(req,url){
  if(url.searchParams.size!==2||url.searchParams.getAll('state').length!==1||url.searchParams.getAll('code').length!==1)deny();
  const state=url.searchParams.get('state'),code=url.searchParams.get('code'),verifier=cookie(req,WORKSTATION_PENDING_COOKIE);
  if(!opaque.test(state||'')||!opaque.test(code||'')||!verifier)deny();
  const parameters=[digest(state),challenge(verifier),digest(code)];
  const pending=(await this.pool.query(`SELECT admission_grant FROM avis_core_v2.workstation_device_handoffs
   WHERE state_hash=$1 AND code_challenge=$2 AND code_hash=$3 AND used_at IS NULL AND expires_at>now()`,parameters)).rows[0];
  if(!pending)deny();await this.active(pending.admission_grant);
  const token=random(),id=randomUUID();
  // The consume and issuance are one PostgreSQL statement. Two callbacks can
  // never exchange the same code for two admission cookies.
  const result=await this.pool.query(`WITH consumed AS (
   UPDATE avis_core_v2.workstation_device_handoffs SET used_at=now()
   WHERE state_hash=$1 AND code_challenge=$2 AND code_hash=$3 AND used_at IS NULL AND expires_at>now()
    AND (admission_grant->>'expiresAt')::timestamptz>now()
   RETURNING admission_grant
  ) INSERT INTO avis_core_v2.workstation_device_admissions(admission_id,token_hash,admission_grant,expires_at)
  SELECT $4::uuid,$5,admission_grant,(admission_grant->>'expiresAt')::timestamptz FROM consumed RETURNING admission_id,expires_at`,
   [...parameters,id,digest(token)]);
  if(result.rows.length!==1)deny();
  const life=Math.min(WORKSTATION_ADMISSION_SECONDS,Math.floor((Date.parse(result.rows[0].expires_at)-this.now())/1000));
  if(life<=0)deny();
  return {cookies:[WORKSTATION_ADMISSION_COOKIE+'='+token+attributes+'; SameSite=Strict; Max-Age='+life,clearWorkstationPendingCookie()]};
 }

 async fromRequest(req){
  const token=cookie(req,WORKSTATION_ADMISSION_COOKIE);if(!token)return null;
  const row=(await this.pool.query(`SELECT admission_id,admission_grant,expires_at FROM avis_core_v2.workstation_device_admissions
   WHERE token_hash=$1 AND expires_at>now()`,[digest(token)])).rows[0];
  if(!row)deny();
  // No positive-status cache: owner revocation, lost-device locking, sign-out,
  // and recognition eviction are checked by the existing front authority.
  const who=await this.active(row.admission_grant);
  return {id:row.admission_id,grant:row.admission_grant,person:who};
 }

 async matchesSession(id,current){
  if(!current||!uuid.test(String(id||'')))return false;
  if(id===current.id)return true;
  const prior=(await this.pool.query('SELECT admission_grant FROM avis_core_v2.workstation_device_admissions WHERE admission_id=$1',[id])).rows[0];
  // Reopening this same approved device in a second tab may renew admission;
  // it must not invalidate the bank password session already held by that tab.
  return Boolean(prior&&sameBinding(prior.admission_grant,current.grant));
 }
}

const completionScript="const key='avisFinTerminalAfterAdmission';const next=sessionStorage.getItem(key);sessionStorage.removeItem(key);location.replace(next==='/fin-terminal'?next:'/');";
const completionHash=createHash('sha256').update(completionScript).digest('base64');
export function sendWorkstationCompletion(res){
 res.setHeader('Cache-Control','private, no-store');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'sha256-"+completionHash+"'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
 // Commit a bank-origin document before navigating, so Strict bank cookies are
 // sent on the next request after the cross-site GET callback.
 res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open bank</title><script>'+completionScript+'</script><noscript><a href="/">Open bank</a></noscript></html>');
}
