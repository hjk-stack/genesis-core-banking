import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {CardManagement} from '../src/card-management.mjs';
import {CustomerAccess} from '../src/customer-access.mjs';
import {money,decimal} from '../src/core.mjs';
import {createBankServer,authenticateFineract} from '../server.mjs';
let pool,db,core,access,alice,bob,aCard,bCard,aliceAg,stock,offer,server,base;
const admin={id:'fineract:999',username:'admin-fixture',admin:true},key=()=>randomUUID(),secretEnv={AVIS_OFFLINE_SIGNING_KEY:'isolated-card-workspace-key-'.repeat(3)};
const balance=async id=>(await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[id])).rows[0].available_balance;
const address={street:'1 Fixture Street',city:'London',country:'GB',postalCode:'SW1A'};
const reviewBody=extra=>({method:'CARD',sourceCardId:aCard.id,currency:'EUR',amount:'10',receiverAccount:bob.abiqIban,receiverName:'Bob fixture',address,reference:'Card payment fixture',...extra});
const confirm=r=>core.confirmPayment(admin,{requestId:r.id,messageHash:r.messageHash},key());
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const u=new URL(process.env.TEST_DATABASE_URL);assert.equal(u.pathname,'/avispay_ci');pool=new pg.Pool({connectionString:u.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};}
 const c=await pool.connect();try{await migrate(c);}finally{c.release();}core=new CardManagement(pool,{secretEnv});access=new CustomerAccess(core);
 const open=async name=>{const r=await core.openCustomer(admin,{fullName:name,accountType:'PERSONAL',currencies:['EUR','USD']},key());return {...r.accounts[0],userId:r.userId};};
 alice=await open('Alice workspace fixture');bob=await open('Bob workspace fixture');
 stock=await core.networkAccount(pool,'USER','AG','ETHEREUM','CRYPTO','1');aliceAg=await core.networkAccount(pool,'USER','AG','ETHEREUM','CRYPTO',alice.userId);
 await core.operation(admin,'WORKSPACE_FIXTURE',{},key(),async(db,k)=>{
  const fiat=await core.system(db,'TREASURY','EUR','WORKSPACE_FIXTURE','ASSET');
  const asset=(await db.query("INSERT INTO avis_core_v2.ledger_accounts(owner_type,sub_account_code,currency_code,network,account_category) VALUES('TREASURY','WORKSPACE_FIXTURE','AG','ETHEREUM','ASSET') RETURNING account_id")).rows[0].account_id;
  return {journalId:await core.post(db,admin,k,'WORKSPACE_FIXTURE','Isolated fixture',[{accountId:fiat,direction:'DEBIT',amount:'300'},{accountId:alice.accountId,direction:'CREDIT',amount:'200'},{accountId:bob.accountId,direction:'CREDIT',amount:'100'},{accountId:asset,direction:'DEBIT',amount:'50'},{accountId:stock,direction:'CREDIT',amount:'48'},{accountId:aliceAg,direction:'CREDIT',amount:'2'}])};
 });
 aCard=await core.issueManagedCard(admin,{from:alice.abiqIban,currency:'EUR',product:'GOLD_METAL'},key());bCard=await core.issueManagedCard(admin,{from:bob.abiqIban,currency:'EUR',product:'VIRTUAL'},key());
});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(db)await db.close();else await pool.end();});
test('new cards share their holder/currency purse without duplicating value',async()=>{
 const second=await core.issueManagedCard(admin,{from:alice.abiqIban,currency:'EUR',product:'BLACK_VIP'},key());assert.equal(second.accountId,aCard.accountId);
 const before=await balance(alice.accountId),body={from:alice.abiqIban,currency:'EUR',cardId:aCard.id,amount:'100',reference:'Card funding'},k=key();
 await core.loadManagedCard(admin,body,k);await core.loadManagedCard(admin,body,k);
 assert.equal(await balance(alice.accountId),decimal(money(before)-money('100')));assert.equal(await balance(aCard.accountId),'100.000000000000000000');
 const rows=(await core.list(admin,'cardaccounts')).filter(r=>String(r.user_id)===alice.userId);assert.equal(rows.length,1);assert.equal(rows[0].cards.length,2);
 assert.equal(rows[0].cards[0].expires_at!==null,true);assert.equal(rows[0].cards[0].issued_at!==null,true);
});
test('card payment debits the selected card balance, without a bank sender selector',async()=>{
 const bank=await balance(alice.accountId),recipient=await balance(bob.accountId),r=await core.preparePayment(admin,reviewBody(),key());
 assert.equal(await balance(aCard.accountId),'100.000000000000000000');await confirm(r);await confirm(r);
 assert.equal(await balance(aCard.accountId),'90.000000000000000000');assert.equal(await balance(alice.accountId),bank);assert.equal(await balance(bob.accountId),decimal(money(recipient)+money('10')));
 const details=await core.managedCardDetails(admin,{cardId:aCard.id});assert.equal(details.totals.incoming,'100.000000000000000000');assert.equal(details.totals.outgoing,'10.000000000000000000');assert.equal(details.entries.length,2);
});
test('force payment without a code still transfers from the card and checks its balance',async()=>{
 const r=await core.preparePayment(admin,reviewBody({method:'CODED_CARD',offlineDebit:false,amount:'3'}),key());assert.equal(r.instruction.offlineDebit,false);const out=await confirm(r);assert.equal(out.current_status,'COMPLETED');assert.equal(out.hasDelivery,false);
 const bad=await core.preparePayment(admin,reviewBody({amount:'99999'}),key());await assert.rejects(confirm(bad),/INSUFFICIENT_FUNDS/);
});
test('card block and expiry are checked again after review',async()=>{
 const r=await core.preparePayment(admin,reviewBody(),key()),before=await balance(aCard.accountId);
 await core.setCardStatus(admin,{cardId:aCard.id,status:'BLOCKED'},key());await assert.rejects(confirm(r),/SELECT_AVIS_CARD/);assert.equal(await balance(aCard.accountId),before);
 await core.setCardStatus(admin,{cardId:aCard.id,status:'ACTIVE'},key());
 await pool.query("UPDATE avis_core_v2.avis_cards SET expires_at=now()-interval '1 second' WHERE card_id=$1",[aCard.id]);await assert.rejects(confirm(r),/SELECT_AVIS_CARD/);await assert.rejects(core.setCardStatus(admin,{cardId:aCard.id,status:'ACTIVE'},key()),/INVALID_CARD_EXPIRY/);
 await pool.query("UPDATE avis_core_v2.avis_cards SET expires_at=now()+interval '1 year' WHERE card_id=$1",[aCard.id]);
});
test('PIN reset stores a salted hash and never records the PIN in operation payloads',async()=>{
 await core.resetCardPin(admin,{cardId:aCard.id,pin:'438219'},key());const card=(await pool.query('SELECT pin_hash,pin_salt,pin_updated_at FROM avis_core_v2.avis_cards WHERE card_id=$1',[aCard.id])).rows[0];
 assert.equal(card.pin_hash.length,128);assert.equal(card.pin_salt.length,64);assert.ok(card.pin_updated_at);
 const records=(await pool.query("SELECT request,response FROM avis_core_v2.operation_requests WHERE operation='RESET_CARD_PIN'")).rows;assert.equal(JSON.stringify(records).includes('438219'),false);
 await assert.rejects(core.resetCardPin(admin,{cardId:aCard.id,pin:'abc'},key()),/INVALID_CARD_PIN/);
});
test('code-secured debit honors its start time and a maximum 48-hour window',async()=>{
 const start=new Date(Date.now()+3600000).toISOString(),end=new Date(Date.now()+3*3600000).toISOString(),before=await balance(aCard.accountId);
 for(const times of [{codeStart:start,codeEnd:new Date(Date.now()+50*3600000).toISOString()},{codeStart:end,codeEnd:start},{codeStart:'bad',codeEnd:end}])await assert.rejects(core.preparePayment(admin,reviewBody({method:'CODED_CARD',offlineDebit:true,...times}),key()),/INVALID_CODE_WINDOW/);
 const r=await core.preparePayment(admin,reviewBody({method:'CODED_CARD',offlineDebit:true,codeStart:start,codeEnd:end}),key());await confirm(r);const d=await core.cardDelivery(admin,{requestId:r.id});assert.equal(d.validFrom,start);assert.equal(d.expiresAt,end);assert.match(d.code,/^\d{6}$/);
 assert.equal(await balance(aCard.accountId),decimal(money(before)-money('10')));
 const body={token:d.redemptionToken,code:d.code,to:bob.abiqIban,currency:'EUR',reference:'Timed code'};await assert.rejects(core.redeemCode(admin,body,key()),/CARD_CODE_NOT_STARTED/);
 await pool.query("UPDATE avis_core_v2.coded_card_debits SET valid_from=now()-interval '1 second' WHERE request_id=$1",[r.id]);
 await core.setCardStatus(admin,{cardId:aCard.id,status:'BLOCKED'},key());await assert.rejects(core.redeemCode(admin,body,key()),/CARD_CODE_BLOCKED/);await core.setCardStatus(admin,{cardId:aCard.id,status:'ACTIVE'},key());
 await core.redeemCode(admin,body,key());await assert.rejects(core.redeemCode(admin,body,key()),/CARD_CODE_CLOSED/);
});
test('crypto transfers select a wallet holding without a fiat sender account',async()=>{
 const r=await core.preparePayment(admin,{method:'CRYPTO',cryptoAccount:aliceAg,amount:'1',cryptoDestination:'INTERNAL',receiverUserId:bob.userId,reference:'Wallet source'},key());await confirm(r);
 assert.equal(await balance(aliceAg),'1.000000000000000000');assert.equal(r.instruction.network,'ETHEREUM');
});
test('AG purchases and conversion back to fiat exchange existing value once',async()=>{
 offer=await core.registerCryptoOffer(admin,{stockAccountId:stock,proceedsAccount:'TN89AVIP000978000011000101',fiatCurrency:'EUR',unitPrice:'2'},key());const before=await balance(alice.accountId);
 await core.purchaseCrypto(admin,{offerId:offer.id,from:alice.abiqIban,quantity:'2',unitPrice:'2',total:'4',reference:'Buy'},key());
 const body={offerId:offer.id,cryptoAccount:aliceAg,to:alice.abiqIban,quantity:'2',unitPrice:'2',total:'4',reference:'Back to fiat'},k=key();await core.sellCrypto(admin,body,k);await core.sellCrypto(admin,body,k);
 assert.equal(await balance(alice.accountId),before);assert.equal(await balance(aliceAg),'1.000000000000000000');
 await assert.rejects(core.sellCrypto(admin,{...body,total:'5'},key()),/CRYPTO_PRICE_CHANGED/);
});
test('customer boundary rejects other holders, administrative operations and request guessing',async()=>{
 const actor={id:'fineract:101',customerUserId:alice.userId,admin:false};
 const accounts=await access.list(actor,'accounts');assert.equal(accounts.length,2);assert.ok(accounts.every(a=>String(a.user_id)===alice.userId));
 assert.ok((await access.list(actor,'cards')).every(c=>String(c.user_id)===alice.userId));
 await assert.rejects(access.list(actor,'audit'),/FORBIDDEN/);
 await assert.rejects(access.invoke(actor,'moveToSuspense',{from:alice.abiqIban,currency:'EUR',amount:'1',reference:'Not an admin'},key()),/FORBIDDEN/);
 await assert.rejects(access.invoke(actor,'setCardStatus',{cardId:bCard.id,status:'BLOCKED'},key()),/FORBIDDEN/);
 await assert.rejects(access.invoke(actor,'preparePayment',{...reviewBody(),sourceCardId:bCard.id},key()),/FORBIDDEN/);
 await assert.rejects(access.invoke(actor,'preparePayment',{...reviewBody(),from:bob.abiqIban},key()),/FORBIDDEN/);
 const foreign=await core.preparePayment(admin,reviewBody({sourceCardId:bCard.id,receiverAccount:alice.abiqIban}),key());await assert.rejects(access.paymentRequest(actor,foreign.id),/FORBIDDEN/);
});
test('administrator suspense movement remains balanced and unavailable to customers',async()=>{
 const before=await balance(bob.accountId),r=await core.moveToSuspense(admin,{from:bob.abiqIban,currency:'EUR',amount:'2',reference:'Review fixture'},key());assert.ok(r.journalId);assert.equal(await balance(bob.accountId),decimal(money(before)-money('2')));
});
test('authenticated customer sessions and administrator customer workspaces enforce the same ownership boundary',async()=>{
 await core.bindCustomerLogin(admin,{fineractUserId:'101',userId:alice.userId},key());
 await assert.rejects(core.bindCustomerLogin(admin,{fineractUserId:'101',userId:bob.userId},key()),/IDENTITY_ALREADY_BOUND/);
 server=createBankServer({pool,transferOptions:{secretEnv},secureCookies:false,authenticate:async u=>u==='admin'?admin:{id:'fineract:'+u,username:u,admin:false}});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 const login=async username=>{const r=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username,password:'isolated fixture'})});return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],...await r.json()};};
 const user=await login('101');assert.equal(user.status,200);assert.equal(user.admin,false);assert.equal(user.customerUserId,alice.userId);assert.equal((await login('102')).status,403);
 const request=async(session,path,body)=>{const r=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{cookie:session.cookie,origin:base,'content-type':'application/json','x-csrf-token':session.csrf,'idempotency-key':key()},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,...await r.json()};};
 const own=await request(user,'views/accounts');assert.ok(own.rows.every(a=>String(a.user_id)===alice.userId));assert.equal((await request(user,'workspaces')).status,403);assert.equal((await request(user,'workspace',{userId:null})).status,403);
 assert.equal((await request(user,'cards/'+bCard.id)).status,403);assert.equal((await request(user,'cards/status',{cardId:bCard.id,status:'BLOCKED'})).status,403);assert.equal((await request(user,'views/connectors')).status,403);
 const customerReview=await request(user,'payments/review',reviewBody({amount:'1'}));assert.equal(customerReview.status,200);assert.equal((await request(user,'payments/transfer',{requestId:customerReview.id,messageHash:customerReview.messageHash})).status,'COMPLETED');
 const operator=await login('admin');assert.equal(operator.admin,true);const scoped=await request(operator,'workspace',{userId:alice.userId});assert.equal(scoped.admin,false);assert.equal(scoped.canSwitchWorkspace,true);assert.ok((await request(operator,'views/accounts')).rows.every(a=>String(a.user_id)===alice.userId));assert.equal((await request(operator,'views/audit')).status,403);
 assert.equal((await request(operator,'workspace',{userId:null})).admin,true);assert.ok((await request(operator,'views/accounts')).rows.some(a=>String(a.user_id)===bob.userId));
 const authenticated=await authenticateFineract('customer','fixture','https://identity.invalid',async()=>({ok:true,json:async()=>({authenticated:true,userId:101,permissions:['READ_CLIENT']})}));assert.equal(authenticated.admin,false);
});
test('PostgreSQL concurrent issuance shares one card account without duplicate loading',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const results=await Promise.all([core.issueManagedCard(admin,{from:alice.abiqIban,currency:'EUR',product:'GOLD_DIAMOND'},key()),core.issueManagedCard(admin,{from:alice.abiqIban,currency:'EUR',product:'GOLD_STANDARD'},key())]);assert.equal(results[0].accountId,results[1].accountId);assert.equal(results[0].accountId,aCard.accountId);
});
test('every new journal balances by asset and blockchain',async()=>{
 const bad=(await pool.query(`SELECT e.journal_id,a.currency_code,a.network FROM avis_core_v2.ledger_entries e JOIN avis_core_v2.ledger_accounts a USING(account_id) GROUP BY e.journal_id,a.currency_code,a.network HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END)<>0`)).rows;assert.deepEqual(bad,[]);
});
