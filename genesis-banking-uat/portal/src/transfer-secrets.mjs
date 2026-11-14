import {createCipheriv,createDecipheriv,createHmac,hkdfSync,randomBytes} from 'node:crypto';
import {fault} from './core.mjs';
function key(env){
 const source=env.AVIS_TRANSFER_ENCRYPTION_KEY||env.AVIS_OFFLINE_SIGNING_KEY;
 if(typeof source!=='string'||Buffer.byteLength(source)<32)fault('CARD_DELIVERY_KEY');
 return Buffer.from(hkdfSync('sha256',source,'AVISPay transfer credentials','at-rest:v1',32));
}
export function fingerprint(value,env=process.env){return createHmac('sha256',key(env)).update(value).digest('hex');}
export function seal(value,purpose,env=process.env){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(env),iv);cipher.setAAD(Buffer.from(purpose));
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
 return {v:1,iv:iv.toString('base64'),data:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
export function unseal(value,purpose,env=process.env){
 const decipher=createDecipheriv('aes-256-gcm',key(env),Buffer.from(value.iv,'base64'));decipher.setAAD(Buffer.from(purpose));decipher.setAuthTag(Buffer.from(value.tag,'base64'));
 return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data,'base64')),decipher.final()]).toString('utf8'));
}
