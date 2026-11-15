import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createBankServer} from '../server.mjs';

test('original AG and AGi artwork is served as PNG without exposing other filesystem paths',async()=>{
 const server=createBankServer({pool:{query:async()=>{throw new Error('Static artwork must not query account data');}},authenticate:async()=>null});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  // Original Git blobs from hjk-stack/genesis-outlook-automation/src/crypto-icons.
  for(const [name,sha] of [['ag','8f4996cab0e4ac497a677987b7b8baa371e02c64'],['agi','e219ab05b46b62d4061bf8e6ba1b373611078e66']]){
   const response=await fetch(base+'/crypto-icons/'+name+'.png');
   assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
   assert.equal(response.headers.get('x-content-type-options'),'nosniff');
   const bytes=Buffer.from(await response.arrayBuffer());
   assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
   assert.equal(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'),sha,'artwork must remain byte-for-byte identical to the original');
  }
  for(const path of ['/crypto-icons/other.png','/crypto-icons/../server.mjs','/crypto-icons/%2e%2e%2fserver.mjs'])assert.equal((await fetch(base+path)).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
