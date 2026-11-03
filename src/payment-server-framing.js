'use strict';
const {Transform}=require('node:stream');

// Length-prefixed binary framing for explicitly configured correspondent hosts.
// A transport frame is not a signed/verified FIN or ISO 20022 message.
const MAX_FRAME=65535;
function encodeFrame(payload){
 if(!Buffer.isBuffer(payload)||payload.length<1||payload.length>MAX_FRAME)throw Error('INVALID_FRAME_PAYLOAD');
 const result=Buffer.allocUnsafe(payload.length+2);
 result.writeUInt16BE(payload.length,0);
 payload.copy(result,2);
 return result;
}
class LengthPrefixedFrames extends Transform {
 constructor({maxFrame=MAX_FRAME}={}){
  super({readableObjectMode:true});
  if(!Number.isInteger(maxFrame)||maxFrame<1||maxFrame>MAX_FRAME)throw Error('INVALID_FRAME_LIMIT');
  this.maxFrame=maxFrame;this.pending=Buffer.alloc(0);
 }
 _transform(chunk,encoding,callback){
  try{
   if(!Buffer.isBuffer(chunk))throw Error('INVALID_BINARY_CHUNK');
   if(this.pending.length+chunk.length>this.maxFrame+2+65536)throw Error('FRAME_BUFFER_EXCEEDED');
   this.pending=Buffer.concat([this.pending,chunk]);
   while(this.pending.length>=2){
    const len=this.pending.readUInt16BE(0);
    if(len===0||len>this.maxFrame)throw Error('INVALID_FRAME_LENGTH');
    if(this.pending.length<len+2)break;
    this.push(Buffer.from(this.pending.subarray(2,len+2)));
    this.pending=this.pending.subarray(len+2);
   }
   callback();
  }catch(e){callback(e);}
 }
 _flush(callback){
  callback(this.pending.length?Error('INCOMPLETE_FRAME'):null);
 }
}
module.exports={MAX_FRAME,encodeFrame,LengthPrefixedFrames};
