import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {CardPaymentServer,signedBytes} from '../src/offline-cards.mjs';
import {encode8583,decode8583,verify8583Response,AVIS_ASCII} from '../src/iso8583.mjs';
import {processAvis8583,sendIso8583Message} from '../src/pos-switch.mjs';
let db,pool,core,buyer,seller,grant,seq=0;
const actor={id:'offline-tests',admin:true},key=()=>`offline-${++seq}`,cardToken='OFFLINE-TOKEN',terminalId='OFFLINE1';
const issuer=generateKeyPairSync('ed25519'),card=generateKeyPairSync('ed25519'),terminal=generateKeyPairSync('ed25519');
const pem=key=>key.export({type:'spki',format:'pem'}),signature=(payload,pair)=>sign(null,signedBytes(payload),pair.privateKey).toString('base64');
const transaction=(atc,amount,extra={})=>{const payload={cardToken,terminalId,grantId:grant.id,atc,amount,currency:'EUR',timestamp:new Date().toISOString(),nonce:randomUUID(),...extra};return {...payload,signature:signature(payload,card)};};
const batch=transactions=>{const payload={batchId:randomUUID(),terminalId,transactions};return {...payload,terminalSignature:signature(payload,terminal)};};
const balance=async id=>(await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[id])).rows[0].available_balance;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else {db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};}
 const c=await pool.connect();try{await migrate(c);}finally{c.release();}
 core=new CardPaymentServer(pool,{signAllowance:payload=>({payload,signature:signature(payload,issuer),publicKey:pem(issuer.publicKey)})});
 buyer=await core.openCustomer(actor,{fullName:'Offline Buyer',accountType:'PERSONAL',currencies:['EUR']},key());seller=await core.openCustomer(actor,{fullName:'Offline Shop',accountType:'BUSINESS',currencies:['EUR']},key());
 const reserve=await core.system(pool,'CORRESPONDENT_NOSTRO','EUR','OFFLINE_FIXTURE','ASSET');
 await core.post(pool,actor,key(),'FIXTURE_CASH','isolated test',[{accountId:reserve,direction:'DEBIT',amount:'100'},{accountId:buyer.accounts[0].accountId,direction:'CREDIT',amount:'100'}]);
 await core.registerShop(actor,{merchantId:'offline-shop',shopName:'Offline shop',ownerUserId:seller.userId,commissionBps:100},key());
 await core.registerTerminal(actor,{terminalId,merchantId:'offline-shop',terminalType:'SMART_POS'},key());
 await core.registerCard(actor,{cardReference:cardToken,lastFour:'4567',railMode:'AVIS_PROPRIETARY_ONLY',fundingAccount:buyer.accounts[0].abiqIban,currency:'EUR'},key());
});
after(async()=>{if(db)await db.close();else await pool.end();});
test('ISO 8583 codec handles secondary bitmap, variable fields and strict framing',()=>{
 const packet={mti:'0220',fields:{3:'000000',4:'000000001250',11:'123456',37:'123456789012',41:terminalId,49:'978',55:'9F36020001',70:'001'}};
 assert.deepEqual(decode8583(encode8583(packet)),packet);assert.deepEqual(decode8583(encode8583(packet,{...AVIS_ASCII,bitmap:'binary'}),{...AVIS_ASCII,bitmap:'binary'}),packet);
 assert.throws(()=>decode8583(encode8583(packet).subarray(0,-1)),/TRUNCATED_ISO8583/);
 assert.throws(()=>decode8583(Buffer.concat([encode8583(packet),Buffer.from('x')])),/TRAILING_ISO8583_DATA/);
 assert.throws(()=>encode8583({...packet,fields:{4:'12.50'}}),/INVALID_ISO8583_FIELD/);
});
test('8583 advice response must match MTI, STAN, RRN and terminal, and decline stays declined',async()=>{
 const request=encode8583({mti:'0220',fields:{4:'000000001250',11:'123456',37:'123456789012',41:terminalId,49:'978'}}),reply=code=>encode8583({mti:'0230',fields:{11:'123456',37:'123456789012',39:code,41:terminalId}});
 assert.equal(verify8583Response(request,reply('05')).approved,false);assert.equal(verify8583Response(request,reply('00')).approved,true);
 const changed=decode8583(reply('00'));changed.fields[11]='654321';assert.throws(()=>verify8583Response(request,encode8583(changed)),/ISO8583_RESPONSE_CORRELATION/);
 const result=await sendIso8583Message({endpoint_url:'tls://localhost:8000'},request,{}, {send:async()=>reply('05')});assert.equal(result.responseCode,'05');
});
test('ISO 8583 switch performs real authorization, capture and duplicate-safe ledger posting',async()=>{
 const fields={4:'000000001000',11:'000001',37:'000000000001',41:terminalId,49:'978',62:cardToken};
 const auth=decode8583(await processAvis8583(core,actor,encode8583({mti:'0100',fields}),{allowedTerminals:[terminalId]}));assert.equal(auth.fields[39],'00');assert.equal(await balance(buyer.accounts[0].accountId),'90.000000000000000000');
 const packet=encode8583({mti:'0200',fields:{...fields,60:auth.fields[60]}}),capture=await processAvis8583(core,actor,packet,{allowedTerminals:[terminalId]});assert.equal(decode8583(capture).fields[39],'00');await processAvis8583(core,actor,packet,{allowedTerminals:[terminalId]});assert.equal(await balance(seller.accounts[0].accountId),'9.900000000000000000');
 const declined=decode8583(await processAvis8583(core,actor,encode8583({mti:'0100',fields:{...fields,11:'000002',4:'000000999999'}}),{allowedTerminals:[terminalId]}));assert.equal(declined.fields[39],'51');
});
test('offline allowance is issuer-signed, reserved from funding, and cannot be duplicated',async()=>{
 await core.configureOffline(actor,{kind:'CARD',reference:cardToken,publicKey:pem(card.publicKey)},key());
 await core.configureOffline(actor,{kind:'TERMINAL',reference:terminalId,publicKey:pem(terminal.publicKey),floorLimit:'25',batchCap:'100'},key());
 grant=await core.issueOfflineAllowance(actor,{cardReference:cardToken,amount:'50',maxTransactions:5,expiresAt:new Date(Date.now()+3600000).toISOString()},key());assert.equal(grant.allowance.payload.protocol,'AVIS_OFFLINE_V1');assert.equal(await balance(buyer.accounts[0].accountId),'40.000000000000000000');
 await assert.rejects(core.issueOfflineAllowance(actor,{cardReference:cardToken,amount:'10',maxTransactions:5,expiresAt:new Date(Date.now()+3600000).toISOString()},key()),/duplicate key/);assert.equal(await balance(buyer.accounts[0].accountId),'40.000000000000000000');
 await assert.rejects(core.configureOffline(actor,{kind:'CARD',reference:cardToken,publicKey:pem(issuer.publicKey)},key()),/OFFLINE_KEY_NOT_UPDATED/);
 const rows=await core.list(actor,'offlinegrants');assert.equal(rows.length,1);assert.equal(rows[0].grant_id,grant.id);assert.equal(rows[0].last_four_digits,'4567');assert.equal(rows[0].status,'ACTIVE');
});
test('valid signed offline batch settles fees once; repeated ATC requires identical transaction',async()=>{
 const tx=transaction(1,'10'),input=batch([tx]),k=key();const r=await core.settleOfflineBatch(actor,input,k);assert.equal(r.settled,1);assert.deepEqual(await core.settleOfflineBatch(actor,input,k),r);assert.equal((await core.settleOfflineBatch(actor,batch([tx]),key())).duplicates,1);
 assert.equal(await balance(seller.accounts[0].accountId),'19.800000000000000000');
 await assert.rejects(core.settleOfflineBatch(actor,batch([transaction(1,'11')]),key()),/OFFLINE_COUNTER_CONFLICT/);
});
test('invalid card signature or allowance overrun rolls back every earlier item in batch',async()=>{
 const before=await balance(seller.accounts[0].accountId),valid=transaction(2,'20'),invalid={...transaction(3,'20'),signature:'AAAA'};
 await assert.rejects(core.settleOfflineBatch(actor,batch([valid,invalid]),key()),/INVALID_CARD_SIGNATURE/);assert.equal(await balance(seller.accounts[0].accountId),before);
 await assert.rejects(core.settleOfflineBatch(actor,batch([transaction(2,'25'),transaction(3,'25')]),key()),/OFFLINE_LIMIT_EXCEEDED/);assert.equal(await balance(seller.accounts[0].accountId),before);
 const result=await core.settleOfflineBatch(actor,batch([valid]),key());assert.equal(result.settled,1);assert.equal(await balance(seller.accounts[0].accountId),'39.600000000000000000');
});
test('terminal tampering, cross-terminal replay and early allowance release are rejected',async()=>{
 const signed=batch([transaction(3,'5')]);signed.transactions[0].amount='6';await assert.rejects(core.settleOfflineBatch(actor,signed,key()),/INVALID_TERMINAL_SIGNATURE/);
 await assert.rejects(core.settleOfflineBatch(actor,batch([transaction(3,'5',{terminalId:'OTHERPOS'})]),key()),/INVALID_OFFLINE_TRANSACTION/);
 await assert.rejects(core.closeOfflineAllowance(actor,{grantId:grant.id},key()),/OFFLINE_SETTLEMENT_WINDOW/);
});
