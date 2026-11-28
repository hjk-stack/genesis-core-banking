import tls from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {fault} from './core.mjs';
import {frame} from './payment-transport.mjs';
import {plainAddress,diagnostic,underConnectorLock} from './fin-peer.mjs';

// FinTerminal step 5, the connector's listening port. Requested by the bank owner: "the connecter must be ready for connect to real
// servers and banks in listening with an time selector keeping port open for white listed IPs or I can connect to servers that
// have our IP white listed", and "The listening port should be same just not both working at the same time". The port (8443, as
// in the owner's specification) opens for a chosen time and closes by itself at its end. Only the IP addresses whitelisted for a
// peer bank get through, over TLS 1.3 with a certificate from that peer's own issuer (kept with the connector's credentials in
// Azure); a peer's session message is answered (src/fin-peer.mjs). While the port is open the terminal does not connect out.
export const LISTEN_PORT=8443,LISTEN_MINUTES=Object.freeze([15,60,480]);
// The bank's own certificate on the port, kept in Azure (Key Vault) like the connectors' own - a certificate and its key that make
// a TLS context together (review finding: a broken one must not leave the port open and silent).
export function listenerCredentials(env=process.env){
 let credentials;try{credentials=JSON.parse(env.AVIS_CONNECTOR_LISTENER);}catch{fault('LISTENER_CONFIGURATION',null,503);}
 if(typeof credentials?.cert!=='string'||typeof credentials?.key!=='string')fault('LISTENER_CONFIGURATION',null,503);
 try{tls.createSecureContext({cert:credentials.cert,key:credentials.key});}catch{fault('LISTENER_CONFIGURATION',null,503);}
 return credentials;
}
// The whitelisted addresses of the bank's connectors to peer banks (src/fin-peer.mjs, PEER_PROTOCOLS), enabled and on an active
// clearing account.
const PEER_ADDRESSES=`SELECT host(w.address) AS address,p.profile_id,c.credential_reference
 FROM avis_core_v2.fin_terminal_peer_addresses w JOIN avis_core_v2.bank_connector_profiles p USING(profile_id)
 JOIN avis_core_v2.platform_connectors c ON c.connector_code=p.profile_id JOIN avis_core_v2.external_cash_accounts a USING(cash_account_id)
 WHERE p.protocol IN ('IP_TO_IP','BANK_API','SWIFT_ISO20022') AND c.is_enabled AND a.is_active`;
const WINDOW='SELECT now() AS now,l.open_until,l.changed_at FROM (SELECT 1) one LEFT JOIN avis_core_v2.fin_terminal_listener l ON l.listener_id=1';
// A session message on its way out (finished within the transport's 15 seconds; one older never finished).
const SENDING=`SELECT 1 FROM avis_core_v2.fin_terminal_peer_messages WHERE direction='OUT' AND answer_to IS NULL AND status='SENDING'
 AND updated_at>=now()-interval '1 minute' LIMIT 1`;
const certificates=bundle=>(String(bundle||'').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)||[])
 .filter(pem=>{try{new X509Certificate(pem);return true;}catch{return false;}});
// The certificate a peer showed comes from that peer's own issuer: a certificate of its chain is one the peer's credentials name,
// or is signed by one.
function issuedBy(socket,bundle){
 const issuers=certificates(bundle).flatMap(pem=>{try{return [new X509Certificate(pem)];}catch{return [];}}),chain=[];
 for(let cert=socket.getPeerCertificate(true),seen=new Set();cert?.raw&&!seen.has(cert.fingerprint256);cert=cert.issuerCertificate){seen.add(cert.fingerprint256);chain.push(new X509Certificate(cert.raw));}
 return chain.some(cert=>issuers.some(issuer=>cert.fingerprint256===issuer.fingerprint256||(cert.checkIssued(issuer)&&cert.verify(issuer.publicKey))));
}

export class FinListener{
 // Without a host the port listens on IPv6 and IPv4 alike, or on IPv4 alone where the machine has no IPv6 (review finding: a
 // peer whitelisted by its IPv6 address must get through).
 constructor(pool,peers,{env=process.env,port=Number(env.AVIS_FIN_LISTENER_PORT)||LISTEN_PORT,host=null,credentials=peers.credentials,poll=15000}={}){
  Object.assign(this,{pool,peers,env,port,host,credentials,poll});
  this.server=null;this.sockets=new Set();this.allowed=new Set();this.issuers=[];this.failure=null;this.queue=Promise.resolve();this.timer=null;this.watcher=null;this.stopped=false;
 }
 #administrator(actor){if(!actor?.admin)fault('FORBIDDEN',null,403);}
 async #window(){const row=(await this.pool.query(WINDOW)).rows[0];return {now:new Date(row.now),until:row.open_until?new Date(row.open_until):null,since:row.changed_at?new Date(row.changed_at):null,open:Boolean(row.open_until)&&new Date(row.open_until)>new Date(row.now)};}
 async status(actor){
  this.#administrator(actor);
  const window=await this.#window();
  return {open:window.open,until:window.open?window.until.toISOString():null,since:window.open&&window.since?window.since.toISOString():null,now:window.now.toISOString(),port:this.port,
   listening:window.open&&this.server!==null,error:window.open&&!this.server?this.failure:null};
 }
 // Opened for a chosen time by a bank administrator, with the bank's certificate in place and a peer's address whitelisted.
 async open(actor,body){
  this.#administrator(actor);
  if(!LISTEN_MINUTES.includes(body?.minutes))fault('INVALID_FIELD','minutes');
  listenerCredentials(this.env);
  if(!(await this.pool.query(PEER_ADDRESSES+' LIMIT 1')).rows.length)fault('FIN_LISTENER_NO_PEER','address',409);
  // Never both: a session message on its way keeps the port closed until it has its answer (src/fin-peer.mjs).
  await underConnectorLock(this.pool,async db=>{
   if((await db.query(SENDING)).rows.length)fault('FIN_SENDING',null,409);
   await db.query(`INSERT INTO avis_core_v2.fin_terminal_listener(listener_id,open_until,changed_by) VALUES(1,now()+make_interval(mins=>$1),$2)
    ON CONFLICT(listener_id) DO UPDATE SET open_until=EXCLUDED.open_until,changed_by=EXCLUDED.changed_by,changed_at=now()`,[body.minutes,String(actor.id)]);
  });
  await this.reconcile();
  return this.status(actor);
 }
 async close(actor){
  this.#administrator(actor);
  await this.pool.query(`INSERT INTO avis_core_v2.fin_terminal_listener(listener_id,open_until,changed_by) VALUES(1,NULL,$1)
   ON CONFLICT(listener_id) DO UPDATE SET open_until=NULL,changed_by=EXCLUDED.changed_by,changed_at=now()`,[String(actor.id)]);
  await this.reconcile();
  return this.status(actor);
 }
 // The port follows the window the database keeps, on each of the bank's servers: it opens with the window, and closes when the
 // window is closed or at its end - by itself, at that moment.
 watch(){
  if(!this.watcher){this.watcher=setInterval(()=>void this.reconcile(),this.poll);this.watcher.unref?.();void this.reconcile();}
  return this;
 }
 reconcile(){return this.queue=this.queue.then(()=>this.#reconcile()).catch(()=>{});}
 async #reconcile(){
  if(this.stopped)return;
  const window=await this.#window();
  clearTimeout(this.timer);this.timer=null;
  if(!window.open){if(this.server)await this.#stop();return;}
  await this.#refresh();
  if(!this.server)await this.#start();
  this.timer=setTimeout(()=>void this.reconcile(),Math.min(window.until-window.now+50,2**31-1));this.timer.unref?.();
 }
 // A whitelist changed: who may connect, and with which issuers, is read again; a connection from an address no longer whitelisted
 // ends.
 refresh(){return this.queue=this.queue.then(()=>this.server&&!this.stopped&&this.#refresh()).catch(()=>{});}
 async #refresh(){
  const rows=(await this.pool.query(PEER_ADDRESSES)).rows;
  this.allowed=new Set(rows.map(row=>plainAddress(row.address)));
  this.issuers=[...new Set(rows.flatMap(row=>{try{return certificates(this.credentials(row.credential_reference).ca);}catch{return [];}}))];
  if(this.server){const own=listenerCredentials(this.env);this.server.setSecureContext({cert:own.cert,key:own.key,ca:this.issuers});}
  for(const socket of this.sockets)if(!this.allowed.has(plainAddress(socket.remoteAddress)))socket.destroy();
 }
 async #start(){
  let own,server;
  try{own=listenerCredentials(this.env);server=tls.createServer({cert:own.cert,key:own.key,ca:this.issuers,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'});}
  catch{this.failure='LISTENER_CONFIGURATION';return;}
  // An address not whitelisted is let go before its TLS handshake.
  server.on('connection',socket=>{
   if(!this.allowed.has(plainAddress(socket.remoteAddress)))return socket.destroy();
   this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));socket.on('error',()=>{});
  });
  server.on('secureConnection',socket=>this.#serve(socket));
  server.on('tlsClientError',(error,socket)=>socket.destroy());
  let failure=null;
  for(const host of this.host?[this.host]:['::','0.0.0.0']){
   try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(this.port,host,()=>{server.off('error',reject);resolve();});});failure=null;break;}
   catch(error){failure=error;if(!['EAFNOSUPPORT','EADDRNOTAVAIL'].includes(error.code))break;}
  }
  if(failure){this.failure=diagnostic(failure);return;}
  server.on('error',()=>{});
  this.server=server;this.failure=null;
 }
 async #stop(){
  const server=this.server;this.server=null;
  for(const socket of this.sockets)socket.destroy();
  this.sockets.clear();
  await new Promise(resolve=>server.close(()=>resolve()));
 }
 // Each connection is the peer whose whitelisted address it comes from and whose issuer signed its certificate; its messages come
 // framed as the payment server's own (two bytes of length, then the message) and each gets the bank's answer in a frame.
 #serve(socket){
  this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));socket.on('error',()=>{});
  socket.setTimeout(120000,()=>socket.destroy());
  let data=Buffer.alloc(0),work=Promise.resolve(),peer=null;
  socket.on('data',chunk=>{
   data=Buffer.concat([data,chunk]);
   while(data.length>=2){
    const size=data.readUInt16BE();if(!size)return socket.destroy();
    if(data.length<size+2)return;
    const message=data.subarray(2,size+2).toString('utf8');data=data.subarray(size+2);
    work=work.then(async()=>{
     peer??=await this.#identify(socket);if(!peer)return socket.destroy();
     const {answer,delivered}=await this.peers.receive(peer.profile_id,message);
     if(socket.destroyed)return void await delivered(Object.assign(new Error('PEER_DISCONNECTED'),{code:'PEER_DISCONNECTED'}));
     socket.write(frame(answer),error=>void delivered(error).catch(()=>{}));
    }).catch(()=>socket.destroy());
   }
  });
 }
 async #identify(socket){
  const address=plainAddress(socket.remoteAddress);if(!this.allowed.has(address))return null;
  const rows=(await this.pool.query(PEER_ADDRESSES+' AND host(w.address)=$1 ORDER BY p.profile_id',[address])).rows;
  for(const row of rows){let ca;try{ca=this.credentials(row.credential_reference).ca;}catch{continue;}if(issuedBy(socket,ca))return row;}
  return null;
 }
 // The port the listener is bound to (a test asks for any free one).
 boundPort(){return this.server?.address()?.port??null;}
 async stop(){
  this.stopped=true;clearInterval(this.watcher);this.watcher=null;clearTimeout(this.timer);this.timer=null;
  await (this.queue=this.queue.then(()=>this.server&&this.#stop()).catch(()=>{}));
 }
}
