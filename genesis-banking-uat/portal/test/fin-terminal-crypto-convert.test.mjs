import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
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
import {cryptoLedgerAccount} from '../src/crypto/rolling-ledger.mjs';
import {FinTerminal,convertedQuantity,transferHash} from '../src/fin-terminal.mjs';
import {FinPeers} from '../src/fin-peer.mjs';
import {FinListener} from '../src/fin-listener.mjs';
import {connectorCredentials,frame} from '../src/payment-transport.mjs';
import {createBankServer} from '../server.mjs';
import {startFinTerminal} from '../public/fin-terminal.mjs';
import {buildFinMessage,normalizeForm,newUetr,newMessageId} from '../public/fin-message.mjs';
import {exampleForm} from './helpers/fin-example.mjs';

// The FinTerminal specification v3 (FinTerminal_Unified_NOSTRO_Crypto_System_v3), its Direct Crypto Converter: while ROBOTIC STP
// is active, an incoming transfer to an account routed into a wallet ("Auto-routes configured IBAN credits into 1:1 MiCA
// stablecoins or spot crypto") is converted - amount x live rate x 0.9995 to four decimals, its hash the SHA-256 of its UETR -
// and loaded into that wallet and the bank's custody instead of the NOSTRO (the bank owner: "when the crypto converter is active
// then nothing will arrive at the NOSTRO instead will be the wallet loaded"); by hand, with a "+" wallet chosen in the composer.
const admin={id:'fin-convert-admin',username:'fin-convert',admin:true},guest={id:'guest',admin:false};
const BANK='EXMPDEFFXXX',PEER='SMPLFRPPXXX',BTC_EUR='54900';
let pool,db,dir,certs,peers,listener,fin,suspense,nostro,account,eurc,btc,usdt,holder,server,base,cookie,csrf,priced=true;
// The live market price (MetaMask) as the converter reads it: BTC at EUR 54,900 here.
const pricing={spot:async(descriptor,fiat)=>{
 if(!priced||descriptor?.network!=='BITCOIN'||fiat!=='EUR')throw Object.assign(new Error('quote service'),{code:'METAMASK_PRICE'});
 return {rate:BTC_EUR+'.000000000000000000',observedAt:Date.now(),source:'MetaMask'};
}};
const certificate=async(name,san)=>{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN='+name,...(san?['-addext','subjectAltName='+san]:[]),
  '-addext','extendedKeyUsage=serverAuth,clientAuth','-keyout',join(dir,name+'.key'),'-out',join(dir,name+'.pem')],{stdio:'ignore'});
 return {cert:await readFile(join(dir,name+'.pem'),'utf8'),key:await readFile(join(dir,name+'.key'),'utf8')};
};
function exchange(messages){
 return new Promise(resolve=>{
  const answers=[];let data=Buffer.alloc(0),next=0;
  const socket=tls.connect({host:'127.0.0.1',port:listener.boundPort(),servername:'localhost',ca:certs.bank.cert,cert:certs.peer.cert,key:certs.peer.key,localAddress:'127.0.0.1'});
  const send=()=>{if(next<messages.length)socket.write(frame(messages[next++]));else socket.end();};
  socket.on('secureConnect',send);
  socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);while(data.length>=2&&data.length>=2+data.readUInt16BE()){const size=data.readUInt16BE();answers.push(data.subarray(2,2+size).toString());data=data.subarray(2+size);send();}});
  socket.on('error',()=>{});socket.on('close',()=>resolve(answers));socket.setTimeout(5000,()=>socket.destroy());
 });
}
const value=(xml,name)=>new RegExp('<'+name+'>([^<]*)</'+name+'>').exec(xml)?.[1];
const rows=async()=>(await pool.query("SELECT * FROM avis_core_v2.fin_terminal_peer_messages WHERE profile_id='EXAMPLE_PEER' ORDER BY sequence")).rows;
const until=async(ready,what,wait=5000)=>{const end=Date.now()+wait;while(!(await ready())){if(Date.now()>end)assert.fail('waited for '+what);await new Promise(resolve=>setTimeout(resolve,25));}};
const delivered=()=>until(async()=>(await rows()).every(row=>row.status!=='SENDING'),'the answers delivered');
const balance=async accountId=>(await pool.query('SELECT available_balance::numeric(38,4)::text AS b FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[accountId])).rows[0]?.b;
const custody=async(currency,network)=>(await pool.query(`SELECT sum(available_balance)::numeric(38,4)::text AS b FROM avis_core_v2.ledger_accounts
 WHERE owner_type='HOT_WALLET' AND sub_account_code='CHAIN_CUSTODY' AND currency_code=$1 AND network=$2`,[currency,network])).rows[0].b||'0.0000';
const transfer=(overrides={})=>normalizeForm({...exampleForm(),uetr:newUetr(),businessMessageId:newMessageId(),senderBic:PEER,receiverBic:account.bic,amount:'250000.00',
 settlement:'INGA',settlementAccount:'NOSTRO-EXAMPLE-1',debtorAgentBic:PEER,creditorName:'AVISPay PLC',creditorIban:account.iban,creditorAgentBic:account.bic,...overrides});
const robotic=on=>pool.query('UPDATE avis_core_v2.fin_terminal_mode SET robotic_stp=$1 WHERE mode_id=1',[on]);

before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 dir=await mkdtemp(join(tmpdir(),'avis-fin-convert-'));
 certs={bank:await certificate('localhost','DNS:localhost,IP:127.0.0.1'),peer:await certificate('peer','DNS:localhost,IP:127.0.0.1')};
 const env={AVIS_CONNECTOR_LISTENER:JSON.stringify({cert:certs.bank.cert,key:certs.bank.key}),
  AVIS_CONNECTOR_PEER:JSON.stringify({cert:certs.bank.cert,key:certs.bank.key,ca:certs.peer.cert,hmacSecret:'isolated-fin-convert-secret-32bytes'})};
 const bank=new AccountManagement(pool,{directory:{env:{}}});
 suspense=(await bank.openAccount(admin,{accountType:'SUSPENSE',fullName:'AVISPay PLC',currencies:['EUR']},randomUUID())).managedAccounts[0];
 const cash=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example Peer Bank',bic:PEER,accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 nostro={id:cash.id,ledger:(await pool.query('SELECT ledger_account_id FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1',[cash.id])).rows[0].ledger_account_id};
 await bank.registerBankConnector(admin,{profileId:'EXAMPLE_PEER',name:'EXAMPLE-GW',cashAccountId:cash.id,protocol:'IP_TO_IP',localBic:BANK,peerBic:PEER,
  endpoint:'tls://localhost:1',credentialReference:'AVIS_CONNECTOR_PEER'},randomUUID());
 // The wallet holder's "+" wallets: EURC on Solana (with its deposit address), BTC, and USDT, which the converter does not offer.
 holder=(await bank.openCustomer(admin,{fullName:'Example Treasury Holder',accountType:'PERSONAL',currencies:['EUR']},randomUUID())).userId;
 eurc=await cryptoLedgerAccount(pool,{userId:holder,currency:'EURC',network:'SOLANA'});btc=await cryptoLedgerAccount(pool,{userId:holder,currency:'BTC',network:'BITCOIN'});
 usdt=await cryptoLedgerAccount(pool,{userId:holder,currency:'USDT',network:'ETHEREUM'});
 await pool.query("INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address) VALUES($1,'SOLANA','ExampleSolanaTreasuryAddress1111111111111')",[holder]);
 fin=new FinTerminal(pool,{pricing});account=(await fin.accounts(admin)).bookingAccounts.find(item=>item.accountId===suspense.id);
 peers=new FinPeers(pool,{credentials:reference=>connectorCredentials(reference,env),terminal:fin});
 listener=new FinListener(pool,peers,{env,port:0,host:'127.0.0.1'});
 await peers.addAddress(admin,'EXAMPLE_PEER',{address:'127.0.0.1'});await listener.open(admin,{minutes:15});
 server=createBankServer({pool,authenticate:async()=>admin,secureCookies:false,transferOptions:{finPricing:pricing}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
 assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
});
after(async()=>{
 await listener?.close(admin).catch(()=>{});await listener?.stop();await new Promise(resolve=>server?server.close(resolve):resolve());
 if(dir)await rm(dir,{recursive:true,force:true});if(db)await db.close();else await pool?.end();
});

test('the quantity is amount x rate x 0.9995 to four decimals, as the specification\'s backend; the hash is the SHA-256 of the UETR',()=>{
 assert.deepEqual([convertedQuantity('250000.00','1'),convertedQuantity('250000.00','1.097'),convertedQuantity('250000.00','0.00001821'),convertedQuantity('1','0.00005')],
  ['249875.0000','274112.8750','4.5502','0.0000']);
 assert.equal(transferHash('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'),'0x5c28b2022dca14affa8ab4a2e66765100f31a990e159022e7a498542c605c3da');
});

test('a bank administrator routes an account\'s credits into a wallet in one of the five assets, or back to the NOSTRO',async()=>{
 await assert.rejects(fin.route(guest,{bookingAccountId:suspense.id,tokenWalletId:eurc}),e=>e.code==='FORBIDDEN');
 await assert.rejects(fin.converter(guest),e=>e.code==='FORBIDDEN');
 await assert.rejects(fin.route(admin,{bookingAccountId:suspense.id,tokenWalletId:usdt}),e=>e.code==='FIN_TOKEN_WALLET');
 await assert.rejects(fin.route(admin,{bookingAccountId:eurc,tokenWalletId:eurc}),e=>e.code==='FIN_BOOKING_ACCOUNT');
 const routed=await fin.route(admin,{bookingAccountId:suspense.id,tokenWalletId:eurc});
 assert.deepEqual(routed.assets,['EURC','USDC','BTC','ETH','SOL']);
 assert.equal(routed.accounts.find(item=>item.accountId===suspense.id).tokenWalletId,eurc);
 assert.deepEqual(routed.wallets.map(item=>[item.currency,item.network,item.holder]),[['BTC','BITCOIN','Example Treasury Holder'],['EURC','SOLANA','Example Treasury Holder']]);
 // The live rates: EURC 1:1 for euros (MiCA), BTC at its market price.
 assert.deepEqual(routed.rates.map(item=>[item.currency,item.asset,item.network,item.source,item.rate&&Number(item.rate).toPrecision(6)]),
  [['EUR','BTC','BITCOIN','MetaMask',(1/Number(BTC_EUR)).toPrecision(6)],['EUR','EURC','SOLANA','MiCA 1:1','1.00000']]);
 assert.equal((await fin.route(admin,{bookingAccountId:suspense.id,tokenWalletId:null})).accounts.find(item=>item.accountId===suspense.id).tokenWalletId,null);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.fin_terminal_crypto_routes')).rows[0].n,0);
});

test('over IP with ROBOTIC STP active, a transfer to a routed account is loaded into its wallet and the custody, not the NOSTRO: ACSC AUTO_CRYPTO',async()=>{
 await fin.route(admin,{bookingAccountId:suspense.id,tokenWalletId:eurc});await robotic(true);
 const form=transfer(),hash=transferHash(form.uetr),before=[await balance(nostro.ledger),await balance(suspense.id)];
 const [answer]=await exchange([buildFinMessage(form)]);
 assert.deepEqual([value(answer,'TxSts'),value(answer,'OrgnlUETR')],['ACSC',form.uetr]);
 // Nothing arrives at the NOSTRO or the core banking account; the wallet and the bank's custody on Solana are loaded.
 assert.deepEqual([await balance(nostro.ledger),await balance(suspense.id)],before);
 assert.deepEqual([await balance(eurc),await custody('EURC','SOLANA')],['249875.0000','249875.0000']);
 await delivered();const [kept,sent]=(await rows()).slice(-2);
 const settled='AUTO_CRYPTO:249875.0000 EURC (TX:'+hash.slice(0,14)+'...)';
 assert.deepEqual([kept.event_text,sent.event_code,sent.event_text],['RECEIVED 250000.00 EUR -> '+settled,'ACSC',settled]);
 // Kept with its rate, hash and IVMS101 travel-rule data, verified.
 const kept101=(await pool.query('SELECT mode,asset,network,rate::text AS rate,rate_source,quantity::numeric(38,4)::text AS quantity,tx_hash,ivms101,created_by FROM avis_core_v2.fin_terminal_conversions WHERE uetr=$1',[form.uetr])).rows[0];
 assert.deepEqual([kept101.mode,kept101.asset,kept101.network,Number(kept101.rate),kept101.rate_source,kept101.quantity,kept101.tx_hash,kept101.created_by],
  ['ROBOTIC','EURC','SOLANA',1,'MiCA 1:1','249875.0000',hash,'listener:EXAMPLE_PEER']);
 assert.deepEqual([kept101.ivms101.verified,kept101.ivms101.originator.accountNumber,kept101.ivms101.beneficiary.accountNumber,
  kept101.ivms101.beneficiary.beneficiaryPersons[0].legalPerson.name.nameIdentifier[0].legalPersonName],
  [true,[form.debtorIban],['ExampleSolanaTreasuryAddress1111111111111'],'Example Treasury Holder']);
 const journal=(await pool.query("SELECT event_type FROM avis_core_v2.ledger_journals WHERE idempotency_key=$1",['fin-incoming:'+form.uetr])).rows[0];
 assert.equal(journal.event_type,'FIN_INCOMING_CONVERTED');
 const draft=(await fin.drafts(admin)).find(item=>item.uetr===form.uetr);
 assert.deepEqual([draft.registered,draft.conversion],[true,{asset:'EURC',quantity:'249875.0000',txHash:hash}]);
 // Again: answered as before, loaded once.
 const [again]=await exchange([buildFinMessage(form)]);
 assert.equal(value(again,'TxSts'),'ACSC');assert.equal(await balance(eurc),'249875.0000');
 await delivered();assert.equal((await rows()).at(-1).event_text,settled);
});

test('with MANUAL INTERVENTION the routed account\'s transfer arrives at the NOSTRO; a rate that cannot be read is answered RJCT and nothing is booked',async()=>{
 await fin.route(admin,{bookingAccountId:suspense.id,tokenWalletId:eurc});await robotic(false);
 const cash=transfer(),nostroBefore=await balance(nostro.ledger),walletBefore=await balance(eurc);
 const [answer]=await exchange([buildFinMessage(cash)]);
 assert.equal(value(answer,'TxSts'),'ACSC');
 assert.deepEqual([Number(await balance(nostro.ledger))-Number(nostroBefore),await balance(eurc)],[250000,walletBefore]);
 await delivered();assert.equal((await rows()).at(-1).event_text,'CORE_BANKING_&_NOSTRO:+250000.00 EUR');
 // Routed into BTC with no live price: refused, nothing booked.
 await fin.route(admin,{bookingAccountId:suspense.id,tokenWalletId:btc});await robotic(true);priced=false;
 try{
  const refused=transfer(),[rejected]=await exchange([buildFinMessage(refused)]);
  assert.deepEqual([value(rejected,'TxSts'),value(rejected,'Cd')],['RJCT','NARR']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.fin_terminal_drafts WHERE uetr=$1',[refused.uetr])).rows[0].n,0);
  assert.equal(await balance(btc),'0.0000');
 }finally{priced=true;await robotic(false);await fin.route(admin,{bookingAccountId:suspense.id,tokenWalletId:null});await delivered();}
});

test('registered by hand with a "+" wallet chosen, an incoming transfer is converted at the live rate (BTC): the wallet and the custody loaded, the NOSTRO untouched',async()=>{
 const form=transfer({senderBic:PEER}),nostroBefore=await balance(nostro.ledger);
 const draft=await fin.register(admin,{form,selection:{bookingAccountId:suspense.id,nostroAccountId:nostro.id,tokenWalletId:btc}});
 const quantity=convertedQuantity('250000.00',(await pool.query('SELECT rate::text AS rate FROM avis_core_v2.fin_terminal_conversions WHERE uetr=$1',[form.uetr])).rows[0].rate);
 assert.equal(quantity,'4.5515');
 assert.deepEqual([draft.registered,draft.conversion],[true,{asset:'BTC',quantity,txHash:transferHash(form.uetr)}]);
 assert.deepEqual([await balance(nostro.ledger),await balance(btc),await custody('BTC','BITCOIN')],[nostroBefore,quantity,quantity]);
 const kept=(await pool.query('SELECT mode,rate_source,created_by FROM avis_core_v2.fin_terminal_conversions WHERE uetr=$1',[form.uetr])).rows[0];
 assert.deepEqual(kept,{mode:'MANUAL',rate_source:'MetaMask',created_by:admin.id});
 // No live price: the registration is refused and nothing is kept.
 priced=false;
 try{
  const refused=transfer();
  await assert.rejects(fin.register(admin,{form:refused,selection:{bookingAccountId:suspense.id,nostroAccountId:nostro.id,tokenWalletId:btc}}),e=>e.code==='FIN_CONVERT_RATE'&&e.status===503);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.fin_terminal_drafts WHERE uetr=$1',[refused.uetr])).rows[0].n,0);
 }finally{priced=true;}
});

test('Screen B\'s Fiat-to-Crypto/Stablecoin Selector: each account\'s choice, the live rates and IVMS101 verification; a choice is kept',async()=>{
 const html=await readFile(new URL('../public/fin-terminal.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:base+'/fin-terminal'}),doc=dom.window.document;
 try{
  const fetcher=(path,init={})=>fetch(base+path,{...init,headers:{...init.headers,cookie,origin:base}});
  await startFinTerminal({root:doc,fetcher,windowApi:{BroadcastChannel:class{close(){}},addEventListener(){},close(){}}});
  const routes=doc.querySelector('[data-fin-routes]'),lines=name=>[...doc.querySelectorAll('[data-fin-'+name+'] li')].map(item=>item.textContent);
  const until=async(ready,what)=>{const end=Date.now()+8000;while(!ready()){if(Date.now()>end)assert.fail('waited for '+what);await new Promise(resolve=>setTimeout(resolve,20));}};
  await until(()=>routes.querySelector('select')&&lines('conversions').length>0,'the converter');
  const choice=routes.querySelector('select[data-route="'+suspense.id+'"]');
  assert.deepEqual([...choice.options].map(option=>option.textContent),['Cash Wire (NOSTRO)','EURC · SOLANA · Example Treasury Holder','BTC · BITCOIN · Example Treasury Holder']);
  assert.deepEqual([...choice.querySelectorAll('optgroup')].map(group=>group.label),['EURC (1:1 MiCA Euro Stablecoin)','BTC (Bitcoin)']);
  assert.equal(choice.value,'');
  assert.ok(lines('rates').includes('1 EUR = 1 EURC · MiCA 1:1 · SOLANA'),lines('rates').join('|'));
  assert.ok(lines('rates').some(line=>/^1 EUR = 0\.0000182\d* BTC · MetaMask · BITCOIN$/.test(line)),lines('rates').join('|'));
  assert.ok(lines('conversions').some(line=>/ · 250,000\.00 EUR → 249875\.0000 EURC \(SOLANA\) · TX:0x[0-9a-f]{12}\.\.\. · ROBOTIC · IVMS101 ✓ Example Debtor GmbH → Example Treasury Holder$/.test(line)),
   lines('conversions').join('|'));
  // A choice is kept.
  choice.value=eurc;choice.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  const end=Date.now()+5000;while((await pool.query('SELECT token_wallet_account_id FROM avis_core_v2.fin_terminal_crypto_routes WHERE booking_account_id=$1',[suspense.id])).rows[0]?.token_wallet_account_id!==eurc){
   if(Date.now()>end)assert.fail('the choice kept');await new Promise(resolve=>setTimeout(resolve,20));}
 }finally{dom.window.close();}
 // Over HTTP, a choice needs the session's CSRF token.
 const post=token=>fetch(base+'/api/fin-terminal/converter',{method:'POST',headers:{origin:base,cookie,'content-type':'application/json',...(token?{'x-csrf-token':token}:{})},
  body:JSON.stringify({bookingAccountId:suspense.id,tokenWalletId:null})});
 assert.equal((await post(null)).status,403);
 const kept=await (await post(csrf)).json();assert.equal(kept.accounts.find(item=>item.accountId===suspense.id).tokenWalletId,null);
});
