// Narrow server-to-server authority for the banking administrator's converter.
// No browser receives this key. A distinct derived key separates the converter
// from the existing internal desk channel; a dedicated secret may override it.
import {createHash,createHmac,hkdfSync,timingSafeEqual,randomUUID} from "node:crypto";
export const CONVERTER_BANK_ORIGIN = "https://bank.avispay.online";
export const CONVERTER_WEB_ORIGIN = "https://avis.land";
export const CONVERTER_ADMIN_PREFIX = "/exchange/converter/admin";
const AUD = "AVIS_ROLLING_CONVERTER_ADMIN_V1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
export function converterAdminRoute(method,path){
  const suffix=String(path).startsWith(CONVERTER_ADMIN_PREFIX+"/")?path.slice(CONVERTER_ADMIN_PREFIX.length):"";
  return method==="GET" && (suffix==="/assets" || /^\/records\/AVRT-\d{8}-[0-9A-F]{6}\/nautilus\.json$/.test(suffix))
    || method==="POST" && (suffix==="/records" || /^\/records\/AVRT-\d{8}-[0-9A-F]{6}\/loop$/.test(suffix));
}
export function converterBody(method,body){
  if(method==="GET")return "";
  if(!body || typeof body!=="object" || Array.isArray(body))throw Error("Converter request body");
  return JSON.stringify(body);
}
const hash=value=>createHash("sha256").update(value).digest("hex");
function key(env){
  const secret=env.AVIS_ROLLING_CONVERTER_SECRET||env.BANK_DESK_CHANNEL_SECRET;
  if(typeof secret!=="string"||Buffer.byteLength(secret)<32)throw Error("Converter service credentials");
  return Buffer.from(hkdfSync("sha256",secret,"AVISPay rolling converter channel","admin-request:v1",32));
}
function signature(payload,env){return createHmac("sha256",key(env)).update(payload).digest();}
export function signConverterRequest({method,path,body,actor,nonce=randomUUID(),now=Date.now(),env=process.env}){
  if(!converterAdminRoute(method,path)||typeof actor!=="string"||!actor||!UUID.test(nonce))throw Error("Converter request scope");
  const raw=converterBody(method,body);
  if(Buffer.byteLength(raw)>16384)throw Error("Converter request size");
  const payload=Buffer.from(JSON.stringify({v:1,iss:CONVERTER_BANK_ORIGIN,aud:AUD,method,path,bodySha256:hash(raw),actor:hash(actor),nonce,iat:now})).toString("base64url");
  return "RollingConverter "+payload+"."+signature(payload,env).toString("base64url");
}
export function verifyConverterRequest({authorization,method,path,body,now=Date.now(),env=process.env}){
  try{
    if(!converterAdminRoute(method,path)||typeof authorization!=="string"||authorization.length>2048)return null;
    const match=/^RollingConverter ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(authorization);
    if(!match)return null;
    const supplied=Buffer.from(match[2],"base64url"),expected=signature(match[1],env);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return null;
    const p=JSON.parse(Buffer.from(match[1],"base64url").toString("utf8"));
    if(p.v!==1||p.iss!==CONVERTER_BANK_ORIGIN||p.aud!==AUD||p.method!==method||p.path!==path||!HASH.test(p.actor)||!UUID.test(p.nonce)
       ||!Number.isSafeInteger(p.iat)||Math.abs(now-p.iat)>60000||p.bodySha256!==hash(converterBody(method,body)))return null;
    return {actor:p.actor,nonce:p.nonce.toLowerCase(),iat:p.iat,bodySha256:p.bodySha256};
  }catch{return null;}
}
