import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import https from 'node:https';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {JSDOM} from 'jsdom';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {FinPeers} from '../src/fin-peer.mjs';
import {PeerVault,peerLogin} from '../src/peer-vault.mjs';
import {connectorCredentials,sendBankMessage,authenticateMessage,frame} from '../src/payment-transport.mjs';
import {createBankServer} from '../server.mjs';
import {finTerminalOwner} from './helpers/fin-example.mjs';
import {startFinTerminal} from '../public/fin-terminal.mjs';

// Requested by the bank owner: "+IP register must be active for registered senders IP by incoming. The register is in a popup with IP
// and Bank name and login details into the receiver sever. (or for debit into the sender service and first login) the data gets
// stored in a drop down for reuse", the login details stored only in Azure Key Vault - certificate or user name and password, the
// bank owner chose "Both". Azure's token service and Key Vault are played here by their REST answers; the peers are real servers on
// this machine, known by their IP address.
const admin={id:'fin-peer-register-admin',username:'fin-peer-register',admin:true},guest={id:'guest',admin:false};
const NS='urn:iso:std:iso:20022:tech:xsd:',VAULT='https://gbank-peers-example.vault.azure.net',PEER_BIC='SMPLFRPPXXX',OWN_BIC='AVIPTN64XXX';
const VAULT_ENV={AVIS_PEER_VAULT:VAULT+'/',IDENTITY_ENDPOINT:'http://identity.example.test/msi/token',IDENTITY_HEADER:'example-identity-header'};
let pool,db,dir,certs,nostro,plainNostro,noBicNostro,tlsServer,httpsServer,received,secrets,asked,vaultDown,states=new Map(),onLastPage=null;
const refused=(code,field,status)=>error=>error.code===code&&(field===undefined||error.field===field)&&(status===undefined||error.status===status);
// Azure as the bank app reaches it with its own identity: the token service, then the vault's secrets.
async function azure(url,init={}){
 asked.push({url:String(url),method:init.method||'GET',authorization:init.headers?.authorization||null});
 if(vaultDown)return new Response('{}',{status:503});
 const address=new URL(url);
 if(address.origin==='http://identity.example.test'){
  assert.equal(init.headers['x-identity-header'],VAULT_ENV.IDENTITY_HEADER);assert.equal(address.searchParams.get('resource'),'https://vault.azure.net');
  return Response.json({access_token:'example-vault-token',expires_on:String(Math.floor(Date.now()/1000)+3600)});
 }
 assert.equal(address.origin,VAULT);assert.equal(init.headers.authorization,'Bearer example-vault-token');assert.equal(address.searchParams.get('api-version'),'7.4');
 const name=decodeURIComponent(address.pathname.split('/secrets/')[1]||'');
 if(init.method==='PUT'){const body=JSON.parse(init.body);secrets.set(name,body.value);return Response.json({id:VAULT+'/secrets/'+name+'/v1',value:body.value});}
 if(!name){
  // One secret on each page, as Azure pages them, a disabled one marked so; a next link elsewhere is never followed.
  const names=[...secrets.keys(),'other-app-secret'],at=Number(address.searchParams.get('skip')||0),last=at+1>=names.length;
  const page={value:names.slice(at,at+1).map(item=>({id:VAULT+'/secrets/'+item,attributes:{enabled:states.get(item)!=='disabled'}})),
   nextLink:last?'https://elsewhere.example.test/secrets':VAULT+'/secrets?api-version=7.4&skip='+(at+1)};
  // Something written once the last page is read, before the answer arrives.
  if(last&&onLastPage){const then=onLastPage;onLastPage=null;await then();}
  return Response.json(page);
 }
 if(states.has(name))return new Response('{}',{status:403});
 return secrets.has(name)?Response.json({id:VAULT+'/secrets/'+name+'/v1',value:secrets.get(name)}):new Response('{}',{status:404});
}
const vault=()=>new PeerVault({env:VAULT_ENV,fetcher:azure});
const certificate=(name,subject,san,usage)=>{
 execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','1','-subj','/CN='+subject,'-addext','subjectAltName='+san,
  '-addext','extendedKeyUsage='+usage,'-keyout',join(dir,name+'-key.pem'),'-out',join(dir,name+'.pem')],{stdio:'ignore'});
 return Promise.all([readFile(join(dir,name+'.pem'),'utf8'),readFile(join(dir,name+'-key.pem'),'utf8')]).then(([cert,key])=>({cert,key}));
};
// A peer's own acknowledgement of the session message, from its BIC to the bank's.
const acknowledgement=()=>`<?xml version="1.0" encoding="UTF-8"?><Envelope><AppHdr xmlns="${NS}head.001.001.02"><Fr><FIId><FinInstnId><BICFI>${PEER_BIC}</BICFI></FinInstnId></FIId></Fr>`+
 `<To><FIId><FinInstnId><BICFI>${OWN_BIC}</BICFI></FinInstnId></FIId></To><BizMsgIdr>PEERMSG0001</BizMsgIdr><MsgDefIdr>admi.004.001.02</MsgDefIdr><CreDt>2026-11-28T10:06:11Z</CreDt></AppHdr>`+
 `<Document xmlns="${NS}admi.004.001.02"><SysEvtNtfctn><EvtInf><EvtCd>INIT</EvtCd><EvtParam>READY</EvtParam><EvtDesc>WELCOME ACCEPTED</EvtDesc><EvtTm>2026-11-28T10:06:11Z</EvtTm></EvtInf></SysEvtNtfctn></Document></Envelope>`;

before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 dir=await mkdtemp(join(tmpdir(),'avis-fin-register-'));
 // The peer's server certificate for its IP address, and the certificate the bank shows to it - made here for this test.
 certs={peer:await certificate('peer','peer.example.test','IP:127.0.0.1','serverAuth'),bank:await certificate('bank','bank.example.test','DNS:bank.example.test','clientAuth')};
 secrets=new Map();asked=[];received=[];vaultDown=false;
 // A peer over framed TLS that takes the bank's certificate only, and one over HTTPS that takes its user name and password.
 tlsServer=tls.createServer({...certs.peer,ca:certs.bank.cert,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'},socket=>{
  let data=Buffer.alloc(0);
  socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length<2||data.length!==2+data.readUInt16BE())return;
   received.push({peer:'TLS',xml:data.subarray(2).toString(),authorized:socket.authorized});socket.end(frame(acknowledgement()));});
 });
 httpsServer=https.createServer({...certs.peer},async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  received.push({peer:'HTTPS',xml:Buffer.concat(chunks).toString(),authorization:req.headers.authorization||null,signature:req.headers['x-avis-signature']||null});
  if(req.headers.authorization!=='Basic '+Buffer.from('example-user:example-first-login').toString('base64')){res.writeHead(401);return res.end();}
  res.end(acknowledgement());
 });
 await new Promise(resolve=>tlsServer.listen(0,'127.0.0.1',resolve));await new Promise(resolve=>httpsServer.listen(0,'127.0.0.1',resolve));
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 nostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:PEER_BIC,accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 // A NOSTRO account closed in the register is offered no more.
 plainNostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example closed NOSTRO',bic:'EXMPCHZZXXX',accountNumber:'NOSTRO-EXAMPLE-2',currency:'EUR'},randomUUID());
 await pool.query('UPDATE avis_core_v2.external_cash_accounts SET is_active=false WHERE cash_account_id=$1',[plainNostro.id]);
 // One kept from before without its bank's BIC: the peer's BIC is the NOSTRO bank's, so it is not offered either.
 noBicNostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO without BIC',bic:'EXMPGB2LXXX',accountNumber:'NOSTRO-EXAMPLE-3',currency:'EUR'},randomUUID());
 await pool.query('UPDATE avis_core_v2.external_cash_accounts SET bic_code=NULL WHERE cash_account_id=$1',[noBicNostro.id]);
});
after(async()=>{
 await new Promise(resolve=>tlsServer?.close(resolve));if(httpsServer){httpsServer.closeAllConnections();await new Promise(resolve=>httpsServer.close(resolve));}
 if(dir)await rm(dir,{recursive:true,force:true});if(db)await db.close();else await pool?.end();
});
const certificateLogin=()=>({kind:'certificate',ca:certs.peer.cert,cert:certs.bank.cert,key:certs.bank.key});
const counts=async()=>Object.fromEntries(await Promise.all(['platform_connectors','bank_connector_profiles','fin_terminal_peer_addresses'].map(async table=>
 [table,(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.'+table)).rows[0].n])));

test('a peer server registered with its certificate login: its login only in Key Vault, its IP address whitelisted, offered for reuse and reached at once',async()=>{
 const peers=new FinPeers(pool,{vault:vault()});asked.length=0;received.length=0;
 const result=await peers.register(admin,{name:'Example Peer Bank',protocol:'IP_TO_IP',address:'127.0.0.1:'+tlsServer.address().port,cashAccountId:nostro.id,login:certificateLogin()});
 assert.match(result.profileId,/^FIN_EXAMPLE_PEER_BANK_[0-9A-F]{6}$/);
 const peer=result.peers.find(item=>item.profileId===result.profileId);
 assert.deepEqual(peer,{profileId:result.profileId,name:'Example Peer Bank',protocol:'IP_TO_IP',address:'127.0.0.1:'+tlsServer.address().port,transport:'TLS',
  localBic:OWN_BIC,peerBic:PEER_BIC,currency:'EUR',addresses:['127.0.0.1']});
 // The login went to Key Vault with the bank app's own identity - and nowhere else: the database names it only.
 const secret='fin-peer-'+result.profileId.toLowerCase().replaceAll('_','-');
 assert.deepEqual(JSON.parse(secrets.get(secret)),{kind:'certificate',ca:certs.peer.cert.trim(),cert:certs.bank.cert.trim(),key:certs.bank.key.trim()});
 assert.deepEqual(asked.map(call=>[call.method,call.url.split('?')[0]]),[['GET','http://identity.example.test/msi/token'],['PUT',VAULT+'/secrets/'+secret]]);
 const connector=(await pool.query('SELECT * FROM avis_core_v2.platform_connectors WHERE connector_code=$1',[result.profileId])).rows[0];
 assert.deepEqual([connector.credential_reference,connector.endpoint_url,connector.is_enabled],['KEYVAULT:'+secret,'tls://127.0.0.1:'+tlsServer.address().port,true]);
 const stored=JSON.stringify((await pool.query('SELECT * FROM avis_core_v2.platform_connectors')).rows)+JSON.stringify((await pool.query('SELECT * FROM avis_core_v2.bank_connector_profiles')).rows);
 assert.ok(!stored.includes('PRIVATE KEY')&&!stored.includes('BEGIN CERTIFICATE'));
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM avis_core_v2.operation_audit WHERE operation='FIN_PEER_REGISTERED' AND resource_id=$1",[result.profileId])).rows[0].n,1);
 // Chosen in the selector, it is reached with that login: the session message over TLS 1.3 with the bank's certificate.
 const sent=await peers.send(admin,result.profileId,{event:'INIT',text:'HELLO'});
 assert.deepEqual(received.map(item=>[item.peer,item.authorized]),[['TLS',true]]);assert.equal(sent.link.state,'READY');
 // Another instance of the bank reads the logins back from Key Vault: only the peer servers' own secrets.
 assert.equal(await vault().load(),1);assert.deepEqual(peerLogin(secret),JSON.parse(secrets.get(secret)));
 assert.ok(asked.every(call=>!call.url.startsWith('https://elsewhere.example.test')));
});

test('a peer server over HTTPS with the user name and password its bank gave: sent with them (HTTP Basic), never over IP-to-IP',async()=>{
 const peers=new FinPeers(pool,{vault:vault()});received.length=0;
 const login={kind:'password',user:'example-user',password:'example-first-login',ca:certs.peer.cert};
 const result=await peers.register(admin,{name:'Example API Bank',protocol:'BANK_API',address:'127.0.0.1:'+httpsServer.address().port+'/iso20022/session',cashAccountId:nostro.id,login});
 const peer=result.peers.find(item=>item.profileId===result.profileId);
 assert.deepEqual([peer.protocol,peer.transport,peer.addresses],['BANK_API','HTTPS',['127.0.0.1']]);
 const sent=await peers.send(admin,result.profileId,{event:'INIT',text:'HELLO'});
 assert.equal(sent.link.state,'READY');
 // The user name and password went as HTTP Basic authentication, and no signature without a shared secret.
 assert.deepEqual(received.map(item=>[item.peer,item.authorization,item.signature]),[['HTTPS','Basic '+Buffer.from('example-user:example-first-login').toString('base64'),null]]);
 // Over TLS the bank shows its certificate: a user name and password are refused there, and nothing is kept.
 const before=await counts(),stored=secrets.size;
 await assert.rejects(peers.register(admin,{name:'Example Peer Bank',protocol:'IP_TO_IP',address:'127.0.0.1:'+tlsServer.address().port,cashAccountId:nostro.id,login}),refused('FIN_REGISTER_LOGIN','login'));
 assert.deepEqual([await counts(),secrets.size],[before,stored]);
});

test('nothing is registered or kept with a field wrong, a NOSTRO account not active, or Key Vault out of reach - and only for a bank administrator',async()=>{
 const peers=new FinPeers(pool,{vault:vault()});
 const body=(changes={})=>({name:'Example Peer Bank',protocol:'IP_TO_IP',address:'127.0.0.1:8443',cashAccountId:nostro.id,login:certificateLogin(),...changes});
 const before=await counts(),stored=secrets.size;
 for(const [changes,code,field] of [[{name:' '},'INVALID_FIELD','name'],[{name:'x'.repeat(101)},'INVALID_FIELD','name'],[{protocol:'SFTP'},'INVALID_FIELD','protocol'],
  [{address:'bank.example.test:8443'},'INVALID_FIELD','address'],[{address:'127.0.0.1'},'INVALID_FIELD','address'],[{address:'127.0.0.1:70000'},'INVALID_FIELD','address'],
  [{address:'127.0.0.1:8443/path'},'INVALID_FIELD','address'],[{address:'999.1.1.1:8443'},'INVALID_FIELD','address'],
  [{cashAccountId:plainNostro.id},'FIN_REGISTER_NOSTRO','cashAccountId'],[{cashAccountId:noBicNostro.id},'FIN_REGISTER_NOSTRO','cashAccountId'],[{cashAccountId:randomUUID()},'FIN_REGISTER_NOSTRO','cashAccountId'],
  [{login:{...certificateLogin(),ca:'not a certificate'}},'INVALID_FIELD','ca'],[{login:{...certificateLogin(),ca:''}},'INVALID_FIELD','ca'],
  [{login:{...certificateLogin(),key:certs.peer.key}},'INVALID_FIELD','cert'],[{login:{...certificateLogin(),secret:'short'}},'INVALID_FIELD','secret'],
  [{protocol:'BANK_API',login:{kind:'password',user:'example:user',password:'x'}},'INVALID_FIELD','user'],[{protocol:'BANK_API',login:{kind:'password',user:'example-user',password:''}},'INVALID_FIELD','password'],
  [{login:{kind:'token'}},'INVALID_FIELD','login']])
  await assert.rejects(peers.register(admin,body(changes)),refused(code,field),code+' '+JSON.stringify(changes).slice(0,80));
 await assert.rejects(peers.register(guest,body()),refused('FORBIDDEN',undefined,403));
 // Key Vault out of reach: nothing is registered without its login.
 vaultDown=true;
 try{await assert.rejects(new FinPeers(pool,{vault:vault()}).register(admin,body()),refused('PEER_VAULT',undefined,503));}finally{vaultDown=false;}
 // Without its vault the bank app registers nothing either.
 await assert.rejects(new FinPeers(pool,{vault:new PeerVault({env:{},fetcher:azure})}).register(admin,body()),refused('PEER_VAULT',undefined,503));
 assert.deepEqual([await counts(),secrets.size],[before,stored]);
});

test('a login in Key Vault is a connector\'s credentials: a certificate or a user name and password, nothing else; a missing one is not configured',async()=>{
 const peers=new FinPeers(pool,{vault:vault()});
 const {profileId}=await peers.register(admin,{name:'Example Secret Bank',protocol:'SWIFT_ISO20022',address:'127.0.0.1:443',cashAccountId:nostro.id,
  login:{...certificateLogin(),secret:'example-shared-secret-of-32-bytes-at-least'}});
 const reference='KEYVAULT:fin-peer-'+profileId.toLowerCase().replaceAll('_','-');
 assert.equal(connectorCredentials(reference).hmacSecret,'example-shared-secret-of-32-bytes-at-least');
 for(const missing of ['KEYVAULT:fin-peer-unknown','KEYVAULT:other-app-secret','KEYVAULT:'])assert.throws(()=>connectorCredentials(missing),refused('CONNECTOR_CONFIGURATION',undefined,503));
 // A connector without a shared secret signs nothing: a message signed to the bank in its name is not taken.
 await assert.rejects(authenticateMessage(pool,'EXAMPLE',"POST",'/network/EXAMPLE/iso20022','<x/>',{},undefined),refused('MESSAGE_AUTHENTICATION',undefined,401));
 // Over TLS a user name and password never go.
 await assert.rejects(sendBankMessage({endpoint_url:'tls://127.0.0.1:'+tlsServer.address().port},'<x/>',{kind:'password',user:'u',password:'p'}),refused('CONNECTOR_CONFIGURATION'));
});

test('a refresh read to its end is what the bank holds: a login deleted, disabled, unreadable or broken in Key Vault goes; a failed refresh or a login written meanwhile changes nothing (review finding)',async()=>{
 const peers=new FinPeers(pool,{vault:vault()}),secretOf=profileId=>'fin-peer-'+profileId.toLowerCase().replaceAll('_','-');
 const register=async name=>secretOf((await peers.register(admin,{name,protocol:'SWIFT_ISO20022',address:'127.0.0.1:443',cashAccountId:nostro.id,login:certificateLogin()})).profileId);
 const known=name=>{try{connectorCredentials('KEYVAULT:'+name);return true;}catch{return false;}};
 const kept=await register('Example Kept Bank'),deleted=await register('Example Deleted Bank'),disabled=await register('Example Disabled Bank');
 const forbidden=await register('Example Forbidden Bank'),broken=await register('Example Broken Bank');
 assert.ok([kept,deleted,disabled,forbidden,broken].every(known));
 // A refresh that fails changes nothing.
 secrets.delete(deleted);vaultDown=true;
 try{await assert.rejects(vault().load(),refused('PEER_VAULT',undefined,503));}finally{vaultDown=false;}
 assert.equal(known(deleted),true);
 // Read to its end: what is gone from the vault, disabled, no longer readable or no login goes; its connector is refused.
 states.set(disabled,'disabled');states.set(forbidden,'forbidden');secrets.set(broken,'not a login');
 try{await vault().load();}finally{states.clear();}
 assert.deepEqual([kept,deleted,disabled,forbidden,broken].map(known),[true,false,false,false,false]);
 // A login written while a refresh was reading the vault stays as written.
 let racing;onLastPage=async()=>{racing=await register('Example Racing Bank');};
 await vault().load();
 assert.ok(racing&&known(racing)&&known(kept));
});

test('over HTTP: a signed-in bank administrator with FinTerminal access registers with the CSRF token, and the listening port knows the new IP address',async()=>{
 const server=createBankServer({pool,authenticate:async()=>admin,finTerminalAccess:async()=>finTerminalOwner,secureCookies:false,transferOptions:{transport:{vault:vault()}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
  const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  const post=(body,headers={})=>fetch(base+'/api/fin-terminal/peers',{method:'POST',headers:{origin:base,cookie,'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const body={name:'Example Desk Bank',protocol:'IP_TO_IP',address:'127.0.0.2:8443',cashAccountId:nostro.id,login:certificateLogin()};
  assert.equal((await post(body)).status,403);
  const made=await post(body,{'x-csrf-token':csrf});assert.equal(made.status,200);
  const {profileId,peers}=await made.json();
  assert.deepEqual(peers.find(item=>item.profileId===profileId).addresses,['127.0.0.2']);
  const refusedLogin=await post({...body,login:{kind:'password',user:'example-user',password:'example'}},{'x-csrf-token':csrf});
  assert.equal(refusedLogin.status,422);assert.deepEqual(await refusedLogin.json().then(item=>[item.code,item.message,item.field]),['FIN_REGISTER_LOGIN','IP-to-IP takes the certificate login.','login']);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

const until=async(ready,what,wait=8000)=>{const end=Date.now()+wait;while(!ready()){if(Date.now()>end)assert.fail('waited for '+what);await new Promise(resolve=>setTimeout(resolve,20));}};

test('the register\'s popup: "+" beside the Peer Server opens it; registered, the server is chosen on Screen A and offered on Screen B; nothing written stays',async()=>{
 const server=createBankServer({pool,authenticate:async()=>admin,finTerminalAccess:async()=>finTerminalOwner,secureCookies:false,transferOptions:{transport:{vault:vault()}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const dom=new JSDOM(await readFile(new URL('../public/fin-terminal.html',import.meta.url),'utf8'),{url:base+'/fin-terminal'}),doc=dom.window.document;
 // The window's own modal dialog, as a browser has it (jsdom has the element without its two methods).
 Object.assign(dom.window.HTMLDialogElement.prototype,{showModal(){this.setAttribute('open','');},close(){if(!this.hasAttribute('open'))return;this.removeAttribute('open');this.dispatchEvent(new dom.window.Event('close'));}});
 const posted=[];
 const fetcher=async(path,init={})=>{if(init.method==='POST'&&path==='/api/fin-terminal/peers')posted.push(JSON.parse(init.body));return fetch(base+path,{...init,headers:{...init.headers,cookie,origin:base}});};
 try{
  await startFinTerminal({root:doc,fetcher,windowApi:{BroadcastChannel:class{close(){}},addEventListener(){},close(){}}});
  const $=selector=>doc.querySelector(selector),dialog=$('[data-fin-peer-register]'),field=name=>dialog.querySelector('[data-fin-peer-register-field="'+name+'"]');
  const type=(name,value)=>{const input=field(name);input.value=value;input.dispatchEvent(new dom.window.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));};
  const known=()=>[...doc.querySelectorAll('[data-fin-peer-server] option')].filter(option=>!option.disabled).map(option=>option.value);
  await until(()=>doc.querySelectorAll('[data-fin-peer-server] optgroup').length===3,'the peers');
  const before=known();
  // The popup is a part of its own: the composer's "Register incoming" stays the composer's only.
  assert.deepEqual([...doc.querySelectorAll('[data-fin-register]')].map(item=>item.textContent),['Register incoming']);
  // The "+" beside the Peer Server, never in an upper corner: it opens the popup, the NOSTRO accounts offered being the active ones.
  assert.equal($('[data-fin-peer-register-open]').closest('label').querySelector('span').textContent,'Peer Server');
  assert.equal(dialog.hasAttribute('open'),false);$('[data-fin-peer-register-open]').click();assert.equal(dialog.hasAttribute('open'),true);
  await until(()=>field('cashAccountId').options.length&&field('cashAccountId').options[0].value,'the NOSTRO accounts');
  assert.deepEqual([...field('cashAccountId').options].map(option=>option.textContent),['Example NOSTRO · SMPLFRPPXXX · NOSTRO-EXAMPLE-1 · EUR']);
  assert.deepEqual([...field('protocol').options].map(option=>option.textContent),['IP-to-IP','API','ISO 20022']);
  // The login as the peer bank gave it: its certificate login, or its user name and password.
  assert.deepEqual([...dialog.querySelectorAll('[data-fin-peer-register-login]')].map(part=>part.hidden),[false,true]);
  type('kind','password');assert.deepEqual([...dialog.querySelectorAll('[data-fin-peer-register-login]')].map(part=>part.hidden),[true,false]);
  type('kind','certificate');
  // Refused: the reason in the popup, its field marked, what was written kept for the correction.
  type('name','Example Popup Bank');type('address','127.0.0.3');type('ca',certs.peer.cert);type('cert',certs.bank.cert);type('key',certs.bank.key);
  dialog.querySelector('[data-fin-peer-register-save]').click();
  await until(()=>!dialog.querySelector('[data-fin-peer-register-problem]').hidden,'the refusal');
  assert.equal(dialog.querySelector('[data-fin-peer-register-problem]').textContent,'Check this field.');
  assert.equal(field('address').getAttribute('aria-invalid'),'true');assert.equal(field('name').value,'Example Popup Bank');assert.equal(dialog.hasAttribute('open'),true);
  // Registered: the popup closes and is emptied, the new server is chosen with its whitelisted IP address, and Screen B offers it.
  type('address','127.0.0.3:8443');dialog.querySelector('[data-fin-peer-register-save]').click();
  await until(()=>!dialog.hasAttribute('open'),'the register');
  assert.deepEqual(posted.at(-1),{name:'Example Popup Bank',protocol:'IP_TO_IP',address:'127.0.0.3:8443',cashAccountId:nostro.id,
   login:{kind:'certificate',ca:certs.peer.cert,cert:certs.bank.cert,key:certs.bank.key,secret:''}});
  const added=known().find(value=>!before.includes(value));
  assert.match(added,/^FIN_EXAMPLE_POPUP_BANK_[0-9A-F]{6}$/);assert.equal($('[data-fin-peer-server]').value,added);
  assert.equal($('[data-fin-peer-node]').textContent,'Example Popup Bank');
  assert.deepEqual([...doc.querySelectorAll('[data-fin-peer-addresses] li .fin-code')].map(item=>item.textContent),['127.0.0.3']);
  assert.ok([...doc.querySelectorAll('[data-fin-wire-peer] option')].some(option=>option.value===added));
  assert.ok(['name','address','ca','cert','key','secret','user','password'].every(name=>field(name).value===''));
  // Opened and left with Cancel, nothing written stays.
  $('[data-fin-peer-register-open]').click();type('password','example-left-behind');dialog.querySelector('[data-fin-peer-register-cancel]').click();
  assert.equal(dialog.hasAttribute('open'),false);assert.equal(field('password').value,'');
 }finally{dom.window.close();await new Promise(resolve=>server.close(resolve));}
});
