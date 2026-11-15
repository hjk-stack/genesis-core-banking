import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {CryptoChainActions} from '../src/crypto-chain-actions.mjs';
import {CustomerAccess} from '../src/customer-access.mjs';
import {newWallet,validAddress,encryptKey,decryptKey,ChainAPI,AG,AGI} from '../src/crypto/networks.mjs';
import {createBankServer} from '../server.mjs';
let pool,db,core,server;const admin={id:'crypto-admin',admin:true},customer={id:'crypto-customer',admin:false,customerUserId:'2'},key=()=>randomUUID();
const env={AVIS_OFFLINE_SIGNING_KEY:'crypto-test-key-never-used-outside-isolated-tests'};
before(async()=>{if(process.env.TEST_DATABASE_URL){assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname,'/avispay_ci');pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}else{db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};}const c=await pool.connect();try{await migrate(c);}finally{c.release();}core=new CryptoChainActions(pool,{secretEnv:env,chain:{inspectAsset:async()=>({decimals:18}),check:async()=>({chainId:1})}});});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(db)await db.close();else await pool.end();});
test('metadata has 200 currencies and 10 demo securities without creating financial entries',async()=>{
 assert.equal((await core.list(admin,'cryptocatalogue')).length,200);const cards=await core.list(admin,'cryptosecurities');assert.equal(cards.length,10);assert.equal(cards[0].name,'AVISPay PLC');assert.ok(cards.every(c=>c.mode==='DEMO'));assert.equal((await core.list(admin,'transactions')).length,0);assert.equal((await new CustomerAccess(core).list(customer,'cryptocatalogue')).length,0);
});
test('local generation creates distinct valid addresses and authenticated encrypted keys per supported family',()=>{
 for(const network of ['ETHEREUM','BSC','TRON','XRPL','SOLANA','BITCOIN']){const one=newWallet(network),two=newWallet(network);assert.ok(validAddress(network,one.address));assert.notEqual(one.address,two.address);const sealed=encryptKey(one.key,'wallet:1:'+network,env);assert.deepEqual(decryptKey(sealed,'wallet:1:'+network,env),one.key);assert.throws(()=>decryptKey(sealed,'wallet:2:'+network,env));assert.ok(!JSON.stringify(sealed).includes(Object.values(one.key)[0]));}
 assert.ok(validAddress('ETHEREUM',AG));assert.ok(validAddress('ETHEREUM',AGI));assert.throws(()=>encryptKey({},'wallet:1',{}),/CRYPTO_KEY_CONFIGURATION/);
});
test('administrator approval controls activation and one wallet per user and blockchain is reused for AG and AGi',async()=>{
 const access=new CustomerAccess(core);await assert.rejects(access.invoke(customer,'approveCrypto',{assetId:'avis-green',network:'ETHEREUM',approved:true},key()),/FORBIDDEN/);
 await assert.rejects(core.activateCrypto(admin,{userId:'2',assetId:'avis-green',network:'ETHEREUM'},key()),/CRYPTO_APPROVAL_REQUIRED/);
 for(const assetId of ['avis-green','avis-green-investment'])await core.approveCrypto(admin,{assetId,network:'ETHEREUM',approved:true},key());
 const input={userId:'2',assetId:'avis-green',network:'ETHEREUM'},k=key(),first=await access.invoke(customer,'activateCrypto',input,k),again=await access.invoke(customer,'activateCrypto',input,k);assert.deepEqual(first,again);
 const second=await access.invoke(customer,'activateCrypto',{...input,assetId:'avis-green-investment'},key());assert.equal(first.address,second.address);assert.notEqual(first.accountId,second.accountId);
 const own=await access.invoke(customer,'cryptoWallet',{addressId:first.addressId});assert.match(own.qr,/^data:image\/png;base64,/);assert.ok(!JSON.stringify(own).includes('privateKey'));
 await assert.rejects(access.invoke(customer,'activateCrypto',{...input,userId:'1'},key()),/FORBIDDEN/);
 const treasury=await core.activateCrypto(admin,{...input,userId:'1'},key());assert.notEqual(treasury.address,first.address);await assert.rejects(access.invoke(customer,'cryptoWallet',{addressId:treasury.addressId}),/FORBIDDEN/);
 await core.approveCrypto(admin,{assetId:'avis-green',network:'ETHEREUM',approved:false},key());assert.equal((await access.invoke(customer,'cryptoWallet',{addressId:first.addressId})).public_address,first.address);assert.equal((await core.list(admin,'transactions')).length,0);
});
test('existing deposit address survives activation and no replacement signing key is invented',async()=>{
 await core.approveCrypto(admin,{assetId:'tron',network:'TRON',approved:true},key());const w=newWallet('TRON');await pool.query('INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address) VALUES(2,\'TRON\',$1)',[w.address]);const r=await core.activateCrypto(admin,{userId:'2',assetId:'tron',network:'TRON'},key());assert.equal(r.address,w.address);assert.equal((await pool.query('SELECT * FROM avis_core_v2.crypto_wallet_keys WHERE address_id=$1',[r.addressId])).rows.length,0);
});
test('demo conversion preserves accounts, portfolio and journals and exposes the requested dossier',async()=>{
 const before=await core.list(admin,'ledger'),cards=await core.list(admin,'cryptosecurities');const input={cardId:cards[0].card_id},k=key(),r=await core.convertDemoSecurity(admin,input,k);assert.deepEqual(await core.convertDemoSecurity(admin,input,k),r);assert.equal(r.quantity,'100000000');assert.equal(r.mode,'DEMO');const d=await core.cryptoSecurityDetails(admin,input);assert.equal(d.state,'CONVERTED');assert.equal(d.dossier.currency,'CHF');assert.equal(d.dossier.assetType,'STOCK');assert.equal(d.contract,'AVISGreenRollingSecurityToken');assert.deepEqual(await core.list(admin,'ledger'),before);assert.equal((await core.list(admin,'transactions')).length,0);
 await assert.rejects(new CustomerAccess(core).invoke(customer,'convertDemoSecurity',input,key()),/FORBIDDEN/);
});
test('real conversion reserves actual institution inventory and takes valuation from the registered security',async()=>{
 const s=await core.addSecurity(admin,{name:'AVISPay PLC test stock',shortName:'AVISP',currency:'CHF',denomination:'1',quoteBasis:'UNIT',kind:'share',isin:'US0378331005'},key());await core.recordPosition(admin,{userId:'1',securityId:s.id,quantity:'100',issuingPrice:'1',marketPrice:'2',reference:'Isolated custody fixture'},key());
 const p=(await core.list(admin,'securitypositions')).find(p=>p.security_id===s.id),w=(await core.list(admin,'cryptowallets')).find(w=>String(w.user_id)==='1'),card=(await core.list(admin,'cryptosecurities'))[0];
 const input={cardId:card.card_id,positionId:p.position_id,addressId:w.address_id,network:'ETHEREUM',quantity:'50',tokenQuantity:'100',custodyReference:'TEST-CUSTODY-001',marginHaircutBps:1500,tradingFeeBps:10,greenHighTechVerified:true};
 await assert.rejects(core.prepareRealSecurity(admin,{...input,quantity:'101'},key()),/CRYPTO_SOURCE_REQUIRED/);const r=await core.prepareRealSecurity(admin,input,key());assert.equal(r.dossier.faceValue,'1.000000000000000000');assert.equal(r.dossier.assetValue,'100.000000000000000000');assert.equal(r.dossier.sourceQuantity,'50.000000000000000000');assert.equal(Number((await core.list(admin,'securitypositions')).find(p=>p.security_id===s.id).reserved_quantity),50);await assert.rejects(core.prepareRealSecurity(admin,input,key()),/CRYPTO_DOSSIER_CHANGED/);assert.equal((await core.list(admin,'transactions')).length,0);
 await assert.rejects(new CustomerAccess(core).invoke(customer,'cryptoSecurityDetails',{cardId:card.card_id}),/FORBIDDEN/);
});
test('HTTP enforces customer scope and customer cannot enumerate admin catalogue or read key material',async()=>{
 await core.bindCustomerLogin(admin,{fineractUserId:'203',userId:'2'},key());server=createBankServer({pool,secureCookies:false,transferOptions:{secretEnv:env},authenticate:async()=>({id:'fineract:203',username:'crypto-fixture',admin:false})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'fixture',password:'fixture'})}),session=await login.json(),headers={origin:base,cookie:login.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':session.csrf,'idempotency-key':key()};
 const rows=await(await fetch(base+'/api/views/cryptowallets',{headers})).json();assert.ok(rows.rows.every(w=>String(w.user_id)==='2'));assert.ok(!JSON.stringify(rows).includes('encrypted_key'));const catalog=await(await fetch(base+'/api/views/cryptocatalogue',{headers})).json();assert.ok(catalog.rows.every(a=>a.networks.every(n=>n.approved)));
 assert.equal((await fetch(base+'/api/crypto/actions/review',{method:'POST',headers,body:'{}'})).status,403);assert.equal((await fetch(base+'/api/crypto/approve',{method:'POST',headers,body:'{}'})).status,403);
});
test('blockchain connector rejects wrong chain and malformed tokens and handles new XRPL addresses',async()=>{
 let method;const chain=new ChainAPI({fetcher:async(u,o)=>{method=JSON.parse(o.body).method;return new Response(JSON.stringify({result:method==='eth_chainId'?'0x38':'0x'}));}});await assert.rejects(chain.check('ETHEREUM'),/CRYPTO_WRONG_CHAIN/);
 const xrp=new ChainAPI({fetcher:async()=>new Response(JSON.stringify({result:{error:'actNotFound'}}))});assert.equal((await xrp.balance('XRPL',newWallet('XRPL').address)).balance,'0.0');
});
