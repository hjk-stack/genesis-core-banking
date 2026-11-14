import {test} from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import https from 'node:https';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {sendBankMessage,frame,signRequest} from '../src/payment-transport.mjs';
test('bank transports exchange actual mTLS HTTPS and fragmented length-framed TLS messages',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'avis-transport-'));let tlsServer,httpServer;
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-addext','extendedKeyUsage=serverAuth,clientAuth','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
  const credentials={key:await readFile(join(dir,'key.pem'),'utf8'),cert:await readFile(join(dir,'cert.pem'),'utf8'),hmacSecret:'isolated-transport-fixture-secret-32-bytes'};credentials.ca=credentials.cert;
  const request='transport request',response='transport response';let tlsPeer=false,httpPeer=false;
  tlsServer=tls.createServer({...credentials,requestCert:true,rejectUnauthorized:true},socket=>{tlsPeer=socket.authorized;let data=Buffer.alloc(0);socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length>=2&&data.length===2+data.readUInt16BE()){assert.equal(data.subarray(2).toString(),request);const encoded=frame(response);socket.write(encoded.subarray(0,1));socket.end(encoded.subarray(1));}});});
  await new Promise(resolve=>tlsServer.listen(0,resolve));assert.equal(await sendBankMessage({endpoint_url:`tls://localhost:${tlsServer.address().port}`},request,credentials),response);assert.equal(tlsPeer,true);
  httpServer=https.createServer({...credentials,requestCert:true,rejectUnauthorized:true},async(req,res)=>{httpPeer=req.socket.authorized;const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);assert.equal(body.toString(),request);const expected=signRequest('POST',req.url,body,credentials.hmacSecret,req.headers['x-avis-time'],req.headers['x-avis-nonce']);assert.equal(req.headers['x-avis-signature'],expected['x-avis-signature']);res.end(response);});
  await new Promise(resolve=>httpServer.listen(0,resolve));assert.equal(await sendBankMessage({endpoint_url:`https://localhost:${httpServer.address().port}/payments?channel=iso20022`},request,credentials),response);assert.equal(httpPeer,true);
 }finally{if(tlsServer)await new Promise(resolve=>tlsServer.close(resolve));if(httpServer){httpServer.closeAllConnections();await new Promise(resolve=>httpServer.close(resolve));}await rm(dir,{recursive:true,force:true});}
});
