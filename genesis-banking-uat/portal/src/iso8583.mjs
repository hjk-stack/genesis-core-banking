import {fault} from './core.mjs';
// AVIS proprietary ASCII profile. External scheme profiles must supply their field dictionary.
const fixed=(length,format='n')=>({length,format}),variable=(prefix,max,format='ans')=>({prefix,max,format});
export const AVIS_ASCII={bitmap:'hex',fields:{2:variable(2,19,'n'),3:fixed(6),4:fixed(12),7:fixed(10),11:fixed(6),12:fixed(6),13:fixed(4),22:fixed(3),24:fixed(3),25:fixed(2),32:variable(2,11,'n'),37:fixed(12,'ans'),38:fixed(6,'ans'),39:fixed(2,'ans'),41:fixed(8,'ans'),42:fixed(15,'ans'),43:fixed(40,'ans'),49:fixed(3),55:variable(3,999,'hex'),60:variable(3,999),62:variable(3,999),64:fixed(16,'hex'),70:fixed(3),90:fixed(42),128:fixed(16,'hex')}};
function valid(value,spec){return typeof value==='string'&&(spec.format==='n'?/^\d+$/.test(value):spec.format==='hex'?/^(?:[0-9A-Fa-f]{2})+$/.test(value):/^[\x20-\x7e]+$/.test(value));}
export function encode8583({mti,fields},profile=AVIS_ASCII){
 if(!/^\d{4}$/.test(mti)||!fields||Array.isArray(fields))fault('INVALID_ISO8583');
 const ids=Object.keys(fields).map(Number).sort((a,b)=>a-b);if(ids.some(id=>!Number.isInteger(id)||id<2||id>128)||!ids.length)fault('INVALID_ISO8583');
 const bitmap=Buffer.alloc(ids.at(-1)>64?16:8);if(bitmap.length===16)bitmap[0]|=128;
 const values=[];
 for(const id of ids){const spec=profile.fields[id],value=fields[id];if(!spec||!valid(value,spec))fault('INVALID_ISO8583_FIELD',String(id));
  const data=Buffer.from(value,'ascii');if(spec.prefix){if(data.length>spec.max||data.length>=10**spec.prefix)fault('INVALID_ISO8583_FIELD',String(id));values.push(Buffer.from(String(data.length).padStart(spec.prefix,'0')));}else if(data.length!==spec.length)fault('INVALID_ISO8583_FIELD',String(id));
  bitmap[Math.floor((id-1)/8)]|=1<<(7-(id-1)%8);values.push(data);
 }
 return Buffer.concat([Buffer.from(mti),profile.bitmap==='binary'?bitmap:Buffer.from(bitmap.toString('hex').toUpperCase()),...values]);
}
export function decode8583(input,profile=AVIS_ASCII){
 const data=Buffer.from(input);let pos=0;
 const take=n=>{if(pos+n>data.length)fault('TRUNCATED_ISO8583');const out=data.subarray(pos,pos+n);pos+=n;return out;};
 const mti=take(4).toString('ascii');if(!/^\d{4}$/.test(mti))fault('INVALID_ISO8583');
 const bitmap=()=>{const raw=take(profile.bitmap==='binary'?8:16);if(profile.bitmap==='binary')return raw;const hex=raw.toString('ascii');if(!/^[0-9a-f]{16}$/i.test(hex))fault('INVALID_ISO8583');return Buffer.from(hex,'hex');};
 let bits=bitmap();if(bits[0]&128)bits=Buffer.concat([bits,bitmap()]);const fields={};
 for(let id=2;id<=bits.length*8;id++)if(bits[Math.floor((id-1)/8)]&(1<<(7-(id-1)%8))){
  const spec=profile.fields[id];if(!spec)fault('UNSUPPORTED_ISO8583_FIELD',String(id));let length=spec.length;
  if(spec.prefix){const raw=take(spec.prefix).toString('ascii');if(!/^\d+$/.test(raw))fault('INVALID_ISO8583_FIELD',String(id));length=Number(raw);if(!length||length>spec.max)fault('INVALID_ISO8583_FIELD',String(id));}
  const value=take(length).toString('ascii');if(!valid(value,spec))fault('INVALID_ISO8583_FIELD',String(id));fields[id]=value;
 }
 if(pos!==data.length)fault('TRAILING_ISO8583_DATA');return {mti,fields};
}
export function verify8583Response(request,response,profile=AVIS_ASCII){
 const sent=decode8583(request,profile),received=decode8583(response,profile),expected={'0100':'0110','0200':'0210','0220':'0230','0400':'0410','0420':'0430','0800':'0810'}[sent.mti];
 if(received.mti!==expected)fault('ISO8583_RESPONSE_MTI');
 for(const id of [11,37,41])if(sent.fields[id]!==undefined&&received.fields[id]!==sent.fields[id])fault('ISO8583_RESPONSE_CORRELATION',String(id));
 if(!received.fields[39])fault('ISO8583_RESPONSE_CODE');
 return {responseCode:received.fields[39],approved:(profile.approvalCodes||['00']).includes(received.fields[39]),message:received};
}
