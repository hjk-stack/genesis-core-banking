import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
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
import {SovereignCore} from '../src/core.mjs';
import {cryptoLedgerAccount} from '../src/crypto/rolling-ledger.mjs';
import {FinTerminal} from '../src/fin-terminal.mjs';
import {FinPeers} from '../src/fin-peer.mjs';
import {createBankServer} from '../server.mjs';
import {startFinTerminal} from '../public/fin-terminal.mjs';
import {uptime,balance} from '../public/fin-settlement.mjs';
import {newUetr} from '../public/fin-message.mjs';
import {exampleForm} from './helpers/fin-example.mjs';

// The FinTerminal specification v3 (FinTerminal_Unified_NOSTRO_Crypto_System_v3): the top bar's ROBOTIC STP / MANUAL
// INTERVENTION switch and the listening port's running time, and Screen B's "Final Settlement Ledgers" - the core banking cash,
// the NOSTRO correspondent and the bank's own wallets on the chains, each with its balance.
const admin={id:'fin-ledgers-admin',username:'fin-ledgers',admin:true},guest={id:'guest',admin:false};
let pool,db,dir,fin,server,base,cookie,csrf,suspense,nostro;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 fin=new FinTerminal(pool);const bank=new AccountManagement(pool,{directory:{env:{}}});
 suspense=(await bank.openAccount(admin,{accountType:'SUSPENSE',fullName:'AVISPay PLC',currencies:['EUR']},randomUUID())).managedAccounts[0];
 nostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:'EXMPDEFFXXX',accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 // An incoming transfer booked on both, and tokens in the bank's custody on a chain.
 const account=(await fin.accounts(admin)).bookingAccounts.find(item=>item.accountId===suspense.id);
 await fin.register(admin,{form:{...exampleForm(),uetr:newUetr(),senderBic:'EXMPDEFFXXX',receiverBic:account.bic,settlement:'INGA',settlementAccount:'NOSTRO-EXAMPLE-1',
  creditorName:account.institution,creditorIban:account.iban,creditorAgentBic:account.bic},selection:{bookingAccountId:suspense.id,nostroAccountId:nostro.id}});
 const holder=(await bank.openCustomer(admin,{fullName:'Example Holder',accountType:'PERSONAL',currencies:['EUR']},randomUUID())).userId;
 const custody=await cryptoLedgerAccount(pool,{owner:'HOT_WALLET',currency:'USDC',network:'ETHEREUM',bucket:'CHAIN_CUSTODY',category:'ASSET'});
 const wallet=await cryptoLedgerAccount(pool,{userId:holder,currency:'USDC',network:'ETHEREUM'});
 await new SovereignCore(pool).post(pool,admin,'example-deposit:'+randomUUID(),'CRYPTO_WALLET_DEPOSIT','0xexample',
  [{accountId:custody,direction:'DEBIT',amount:'2500.123456'},{accountId:wallet,direction:'CREDIT',amount:'2500.123456'}]);
 // The bank's listening port with its own certificate (made here for this test), and a peer whitelisted for it.
 dir=await mkdtemp(join(tmpdir(),'avis-fin-ledgers-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1',
  '-keyout',join(dir,'bank.key'),'-out',join(dir,'bank.pem')],{stdio:'ignore'});
 const own={cert:await readFile(join(dir,'bank.pem'),'utf8'),key:await readFile(join(dir,'bank.key'),'utf8')};
 await bank.registerBankConnector(admin,{profileId:'EXAMPLE_PEER',name:'EXAMPLE-GW',cashAccountId:nostro.id,protocol:'IP_TO_IP',localBic:'EXMPGB2LXXX',peerBic:'EXMPDEFFXXX',
  endpoint:'tls://localhost:1',credentialReference:'AVIS_CONNECTOR_PEER'},randomUUID());
 await new FinPeers(pool).addAddress(admin,'EXAMPLE_PEER',{address:'127.0.0.1'});
 server=createBankServer({pool,authenticate:async()=>admin,secureCookies:false,
  transferOptions:{finListener:{env:{AVIS_CONNECTOR_LISTENER:JSON.stringify(own)},port:0,host:'127.0.0.1',poll:3600000}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
 assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));if(dir)await rm(dir,{recursive:true,force:true});if(db)await db.close();else await pool.end();});

test('the mode starts manual and only a bank administrator switches it',async()=>{
 assert.equal((await fin.telemetry(admin)).roboticStp,false);
 assert.deepEqual(await fin.mode(admin,{roboticStp:true}),{roboticStp:true});
 assert.equal((await fin.telemetry(admin)).roboticStp,true);
 assert.deepEqual(await fin.mode(admin,{roboticStp:false}),{roboticStp:false});
 for(const value of [undefined,'true',1,null])await assert.rejects(fin.mode(admin,{roboticStp:value}),e=>e.code==='INVALID_FIELD'&&e.field==='roboticStp');
 await assert.rejects(fin.mode(guest,{roboticStp:true}),e=>e.code==='FORBIDDEN'&&e.status===403);
 await assert.rejects(fin.telemetry(guest),e=>e.code==='FORBIDDEN');
 assert.equal((await pool.query('SELECT changed_by FROM avis_core_v2.fin_terminal_mode WHERE mode_id=1')).rows[0].changed_by,admin.id);
});

test('the ledgers: AVISPay PLC\'s account, the NOSTRO and the bank\'s own wallets, each with its balance',async()=>{
 const {ledgers}=await fin.telemetry(admin);
 const core=ledgers.coreBanking.find(item=>item.accountId===suspense.id),correspondent=ledgers.nostro.find(item=>item.accountId===nostro.id);
 assert.deepEqual([core.label,core.currency,Number(core.balance)],['AVISPay PLC','EUR',1250000]);
 assert.deepEqual([correspondent.institution,correspondent.bic,correspondent.account,correspondent.active,Number(correspondent.balance)],['Example NOSTRO','EXMPDEFFXXX','NOSTRO-EXAMPLE-1',true,1250000]);
 assert.deepEqual(ledgers.wallets.map(item=>[item.currency,item.network,Number(item.balance)]),[['USDC','ETHEREUM',2500.123456]]);
 assert.deepEqual([balance('1250000.000000000000000000'),balance('2500.123456000000000000',8),balance('0'),balance('-12.5')],['1,250,000.00','2,500.123456','0.00','-12.50']);
 assert.deepEqual([uptime(0),uptime(65),uptime(3600*26+61)],['00:00:00','00:01:05','26:01:01']);
});

test('over HTTP and in the terminal: the switch, the running port time while the port listens, and the ledgers',async()=>{
 const telemetry=await (await fetch(base+'/api/fin-terminal/telemetry',{headers:{cookie}})).json();
 // The listener in this test takes any free port; the terminal shows the bank's 8443.
 assert.deepEqual([telemetry.roboticStp,telemetry.listener.open,telemetry.listener.since,telemetry.listener.port],[false,false,null,0]);
 const post=(body,token=csrf)=>fetch(base+'/api/fin-terminal/mode',{method:'POST',headers:{origin:base,cookie,'content-type':'application/json',...(token?{'x-csrf-token':token}:{})},body:JSON.stringify(body)});
 assert.equal((await post({roboticStp:true},null)).status,403);
 assert.deepEqual(await (await post({roboticStp:true})).json(),{roboticStp:true});
 assert.deepEqual(await (await post({roboticStp:false})).json(),{roboticStp:false});
 // The port opened for a quarter of an hour and listening, 65 seconds ago.
 const listen=open=>fetch(base+'/api/fin-terminal/listener',{method:'POST',headers:{origin:base,cookie,'content-type':'application/json','x-csrf-token':csrf},
  body:JSON.stringify(open?{open:true,minutes:15}:{open:false})}).then(response=>response.json());
 assert.deepEqual([(await listen(true)).listening],[true]);
 await pool.query("UPDATE avis_core_v2.fin_terminal_listener SET changed_at=now()-interval '65 seconds' WHERE listener_id=1");
 const html=await readFile(new URL('../public/fin-terminal.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:base+'/fin-terminal'}),doc=dom.window.document;
 try{
  const fetcher=(path,init={})=>fetch(base+path,{...init,headers:{...init.headers,cookie,origin:base}});
  await startFinTerminal({root:doc,fetcher,windowApi:{BroadcastChannel:class{close(){}},addEventListener(){},close(){}}});
  const stp=doc.querySelector('[data-fin-stp]'),clock=doc.querySelector('[data-fin-uptime]'),list=name=>[...doc.querySelectorAll('[data-fin-ledger="'+name+'"] li')].map(item=>item.textContent);
  const until=async(ready,what)=>{const end=Date.now()+8000;while(!ready()){if(Date.now()>end)assert.fail('waited for '+what);await new Promise(resolve=>setTimeout(resolve,20));}};
  await until(()=>list('nostro').length>0,'the ledgers');
  assert.deepEqual([stp.textContent,stp.dataset.state,stp.getAttribute('aria-pressed')],['MANUAL INTERVENTION: LOCKED','LOCKED','false']);
  assert.match(clock.textContent,/^● AUTO-LISTENING: 00:01:0\d · mTLS 1\.3 · 127\.0\.0\.1:8443$/);assert.equal(clock.dataset.state,'LISTENING');
  assert.ok(list('coreBanking').includes('AVISPay PLC · '+(await fin.accounts(admin)).bookingAccounts.find(item=>item.accountId===suspense.id).iban+'1,250,000.00 EUR'));
  assert.deepEqual(list('nostro'),['Example NOSTRO · EXMPDEFFXXX · NOSTRO-EXAMPLE-11,250,000.00 EUR']);
  assert.deepEqual(list('wallets'),['ETHEREUM2,500.123456 USDC']);
  stp.click();
  await until(()=>stp.dataset.state==='ACTIVE','the switch');
  assert.deepEqual([stp.textContent,stp.getAttribute('aria-pressed'),(await fin.telemetry(admin)).roboticStp],['ROBOTIC STP: ACTIVE','true',true]);
   stp.click();await until(()=>stp.dataset.state==='LOCKED','the switch back');
  // Closed, the port shows so.
  assert.deepEqual([(await listen(false)).open],[false]);
  await until(()=>clock.dataset.state==='CLOSED','the port closed');assert.equal(clock.textContent,'○ Port 8443 closed');
  // A port opened that this server does not listen on is not shown listening (review finding).
  await pool.query("UPDATE avis_core_v2.fin_terminal_listener SET open_until=now()+interval '10 minutes' WHERE listener_id=1");
  try{await until(()=>clock.dataset.state==='FAILED','the port not listening');assert.match(clock.textContent,/^○ Port 8443 not listening/);}
  finally{await pool.query('UPDATE avis_core_v2.fin_terminal_listener SET open_until=NULL WHERE listener_id=1');}
 }finally{dom.window.close();}
 const closed=await (await fetch(base+'/api/fin-terminal/telemetry',{headers:{cookie}})).json();
 assert.deepEqual([closed.listener.open,closed.listener.since],[false,null]);
});
