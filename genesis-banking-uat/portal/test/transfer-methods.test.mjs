import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {TransferMethods} from '../src/transfer-methods.mjs';
import {money,decimal} from '../src/core.mjs';
import {encryptCardMessage,decryptCardMessage} from '../public/card-message.mjs';
let pool,db,core,alice,bob,institution,agStock,aliceAg,aliceEth,cash,newCard,offer;
const actor={id:'transfer-operator',admin:true},other={id:'second-operator',admin:true},key=()=>randomUUID();
const secretEnv={AVIS_OFFLINE_SIGNING_KEY:'isolated-test-key-material-'.repeat(4)};
const balance=async id=>(await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[id])).rows[0].available_balance;
const request=extra=>({method:'CARD',from:alice.abiqIban,currency:'EUR',amount:'25',cardDestination:'NEW',reference:'Card transfer fixture',...extra});
const confirm=(r,k=key(),who=actor)=>core.confirmPayment(who,{requestId:r.id,messageHash:r.messageHash},k);
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};}
 const c=await pool.connect();try{await migrate(c);}finally{c.release();}core=new TransferMethods(pool,{secretEnv});
 const open=async name=>{const r=await core.openCustomer(actor,{fullName:name,accountType:'PERSONAL',currencies:['EUR','USD']},key());return {...r.accounts[0],userId:r.userId};};
 alice=await open('Alice transfer fixture');bob=await open('Bob transfer fixture');institution=(await core.route(pool,'TN89AVIP000978000011000101','EUR'));
 agStock=await core.networkAccount(pool,'USER','AG','ETHEREUM','CRYPTO','1');aliceAg=await core.networkAccount(pool,'USER','AG','ETHEREUM','CRYPTO',alice.userId);aliceEth=await core.networkAccount(pool,'USER','ETH','ETHEREUM','CRYPTO',alice.userId);
 cash=await core.registerCashAccount(actor,{institutionType:'CORRESPONDENT_BANK',institutionName:'Settlement fixture',bic:'TESTGB2LXXX',accountNumber:'METHODS-CASH',currency:'EUR'},key());
 await core.operation(actor,'METHOD_FIXTURE',{},key(),async(db,k)=>{
  const fiat=await core.system(db,'TREASURY','EUR','METHOD_FIXTURE','ASSET');
  const ag=(await db.query("INSERT INTO avis_core_v2.ledger_accounts(owner_type,sub_account_code,currency_code,network,account_category) VALUES('TREASURY','METHOD_FIXTURE','AG','ETHEREUM','ASSET') RETURNING account_id")).rows[0].account_id;
  const eth=(await db.query("INSERT INTO avis_core_v2.ledger_accounts(owner_type,sub_account_code,currency_code,network,account_category) VALUES('TREASURY','METHOD_FIXTURE','ETH','ETHEREUM','ASSET') RETURNING account_id")).rows[0].account_id;
  return {journalId:await core.post(db,actor,k,'METHOD_FIXTURE','Isolated fixture',[
   {accountId:fiat,direction:'DEBIT',amount:'2000'},{accountId:alice.accountId,direction:'CREDIT',amount:'2000'},
   {accountId:cash.accountId,direction:'DEBIT',amount:'100'},{accountId:bob.accountId,direction:'CREDIT',amount:'100'},
   {accountId:ag,direction:'DEBIT',amount:'50'},{accountId:agStock,direction:'CREDIT',amount:'50'},
   {accountId:eth,direction:'DEBIT',amount:'5'},{accountId:aliceEth,direction:'CREDIT',amount:'5'}])};
 });
});
after(async()=>{if(db)await db.close();else await pool.end();});
test('new card review is read-only; final confirmation loads the card once and preserves the funding account',async()=>{
 const before=await balance(alice.accountId),cards=(await core.list(actor,'cards')).length,r=await core.preparePayment(actor,request(),key());
 assert.equal(await balance(alice.accountId),before);assert.equal((await core.list(actor,'cards')).length,cards);
 await assert.rejects(confirm(r,key(),other),/PAYMENT_REQUEST_NOT_FOUND/);
 await assert.rejects(core.confirmPayment(actor,{requestId:r.id,messageHash:'wrong'},key()),/PAYMENT_REVIEW_CHANGED/);
 const result=await confirm(r);await confirm(r);newCard=result.card_id;
 assert.equal(result.current_status,'COMPLETED');assert.equal(result.hasDelivery,true);assert.equal(result.sealed_delivery,undefined);
 assert.equal(await balance(alice.accountId),decimal(money(before)-money('25')));
 const card=(await core.list(actor,'transfercards')).find(c=>c.card_id===newCard);assert.equal(card.available_balance,'25.000000000000000000');assert.equal(String(card.user_id),alice.userId);
 const delivery=await core.cardDelivery(actor,{requestId:r.id});assert.match(delivery.cardReference,/^AVIS-/);assert.equal(delivery.code,undefined);
 await assert.rejects(core.cardDelivery(other,{requestId:r.id}),/PAYMENT_REQUEST_NOT_FOUND/);
 await assert.rejects(pool.query("UPDATE avis_core_v2.asset_transfer_requests SET amount=1 WHERE request_id=$1",[r.id]),/PAYMENT_REVIEW_IMMUTABLE/);
});
test('existing cards enforce holder ownership; POS authorization and reversal use the loaded card purse',async()=>{
 await assert.rejects(core.preparePayment(actor,request({from:bob.abiqIban,cardDestination:'EXISTING',cardId:newCard}),key()),/SELECT_AVIS_CARD/);
 const r=await core.preparePayment(actor,request({cardDestination:'EXISTING',cardId:newCard,amount:'5'}),key());await confirm(r);
 const card=(await pool.query('SELECT * FROM avis_core_v2.avis_cards WHERE card_id=$1',[newCard])).rows[0];assert.equal(await balance(card.stored_value_account_id),'30.000000000000000000');
 await core.registerShop(actor,{merchantId:'METHOD_SHOP',ownerUserId:'1',shopName:'Fixture',commissionBps:0},key());
 await core.registerTerminal(actor,{terminalId:'METHOD_POS',merchantId:'METHOD_SHOP',terminalType:'WEB_POS'},key());
 const original=await balance(alice.accountId),auth=await core.authorizeCard(actor,{cardReference:card.core_bank_card_ref,terminalId:'METHOD_POS',currency:'EUR',amount:'10',networkReference:key()},key());
 assert.equal(await balance(card.stored_value_account_id),'20.000000000000000000');assert.equal(await balance(alice.accountId),original);
 await core.settleCard(actor,{authorizationId:auth.id},key(),true);assert.equal(await balance(card.stored_value_account_id),'30.000000000000000000');assert.equal(await balance(alice.accountId),original);
});
test('coded debit is encrypted at rest, uses a six-digit code, and redeems once with its high-entropy token',async()=>{
 const r=await core.preparePayment(actor,request({method:'CODED_CARD',amount:'10'}),key());await confirm(r);const delivery=await core.cardDelivery(actor,{requestId:r.id});
 assert.match(delivery.code,/^\d{6}$/);assert.ok(delivery.redemptionToken.length>=43);
 const records=JSON.stringify((await pool.query("SELECT request,response FROM avis_core_v2.operation_requests WHERE operation IN ('REVIEW_ASSET_TRANSFER','CONFIRM_ASSET_TRANSFER')")).rows);assert.equal(records.includes(delivery.redemptionToken),false);
 const stored=(await pool.query('SELECT sealed_delivery FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1',[r.id])).rows[0];assert.equal(JSON.stringify(stored).includes(delivery.redemptionToken),false);
 const bad=delivery.code==='000000'?'999999':'000000';await assert.rejects(core.redeemCode(actor,{token:delivery.redemptionToken,code:bad,to:bob.abiqIban,currency:'EUR',reference:'Code'},key()),/INVALID_CARD_CODE/);
 assert.equal((await pool.query('SELECT attempts FROM avis_core_v2.coded_card_debits WHERE request_id=$1',[r.id])).rows[0].attempts,1);
 const before=await balance(bob.accountId),k=key(),body={token:delivery.redemptionToken,code:delivery.code,to:bob.abiqIban,currency:'EUR',reference:'Redeem fixture'};
 const result=await core.redeemCode(actor,body,k);assert.equal(result.status,'REDEEMED');assert.deepEqual(await core.redeemCode(actor,body,k),result);assert.equal(await balance(bob.accountId),decimal(money(before)+money('10')));
 await assert.rejects(core.redeemCode(actor,body,key()),/CARD_CODE_CLOSED/);await assert.rejects(core.cancelCodedDebit(actor,{requestId:r.id},key()),/CARD_CODE_CLOSED/);
});
test('five wrong codes lock redemption; cancellation returns the reserved amount exactly once',async()=>{
 const before=await balance(alice.accountId),r=await core.preparePayment(actor,request({method:'CODED_CARD',amount:'8'}),key());await confirm(r);const delivery=await core.cardDelivery(actor,{requestId:r.id});
 const bad=delivery.code==='000000'?'999999':'000000';for(let i=0;i<5;i++)await assert.rejects(core.redeemCode(actor,{token:delivery.redemptionToken,code:bad,to:bob.abiqIban,currency:'EUR',reference:'Wrong code'},key()),/INVALID_CARD_CODE/);
 assert.equal((await pool.query('SELECT status FROM avis_core_v2.coded_card_debits WHERE request_id=$1',[r.id])).rows[0].status,'LOCKED');
 await core.cancelCodedDebit(actor,{requestId:r.id},key());await core.cancelCodedDebit(actor,{requestId:r.id},key());assert.equal(await balance(alice.accountId),before);
});
test('insufficient funds roll back card issuance, code creation and every ledger entry',async()=>{
 const before=await balance(alice.accountId),cards=(await core.list(actor,'cards')).length,r=await core.preparePayment(actor,request({method:'CODED_CARD',amount:'999999'}),key());
 await assert.rejects(confirm(r),/INSUFFICIENT_FUNDS/);assert.equal(await balance(alice.accountId),before);assert.equal((await core.list(actor,'cards')).length,cards);
 assert.equal((await pool.query('SELECT * FROM avis_core_v2.coded_card_debits WHERE request_id=$1',[r.id])).rows.length,0);
});
test('expired codes cannot spend reserved value and remain refundable',async()=>{
 const before=await balance(alice.accountId),r=await core.preparePayment(actor,request({method:'CODED_CARD',amount:'4'}),key());await confirm(r);const delivery=await core.cardDelivery(actor,{requestId:r.id});
 await pool.query("UPDATE avis_core_v2.coded_card_debits SET expires_at=now()-interval '1 second' WHERE request_id=$1",[r.id]);
 await assert.rejects(core.redeemCode(actor,{token:delivery.redemptionToken,code:delivery.code,to:bob.abiqIban,currency:'EUR',reference:'Expired'},key()),/CARD_CODE_CLOSED/);
 await core.cancelCodedDebit(actor,{requestId:r.id},key());assert.equal(await balance(alice.accountId),before);
});
test('external card registration never stores PAN in operation records; loading enters the pickup queue',async()=>{
 const body={from:alice.abiqIban,currency:'EUR',cardNumber:'4111111111111111',expiry:'12/2099',holderName:'External fixture'};
 await assert.rejects(core.registerExternalCard(actor,{...body,cardNumber:'4111111111111112'},key()),/INVALID_CARD_NUMBER/);
 const card=await core.registerExternalCard(actor,body,key());assert.equal((await core.registerExternalCard(actor,body,key())).id,card.id);
 const records=JSON.stringify((await pool.query("SELECT request,response FROM avis_core_v2.operation_requests WHERE operation='REGISTER_EXTERNAL_CARD'")).rows);assert.equal(records.includes(body.cardNumber),false);
 const before=await balance(alice.accountId),r=await core.preparePayment(actor,request({cardDestination:'EXTERNAL',externalCardId:card.id,amount:'20'}),key());const result=await confirm(r);assert.equal(result.status,'OUTGOING');assert.equal(result.hasDelivery,false);
 assert.equal((await core.list(actor,'transferalerts')).some(a=>a.request_id===r.id),true);
 await assert.rejects(core.settleManualTransfer(actor,{requestId:r.id,settlementAccountId:cash.accountId,settlementReference:'Fixture bank receipt'},key()),/TRANSFER_PICKUP_REQUIRED/);
 await core.pickupTransfer(actor,{requestId:r.id},key());await assert.rejects(core.pickupTransfer(other,{requestId:r.id},key()),/TRANSFER_ALREADY_CLAIMED/);
 const details=await core.externalCardDetails(actor,{requestId:r.id},key());assert.equal(details.pan,body.cardNumber);await assert.rejects(core.externalCardDetails(other,{requestId:r.id},key()),/TRANSFER_PICKUP_REQUIRED/);
 await core.settleManualTransfer(actor,{requestId:r.id,settlementAccountId:cash.accountId,settlementReference:'Fixture bank receipt'},key());
 assert.equal(await balance(cash.accountId),'80.000000000000000000');assert.equal(await balance(alice.accountId),decimal(money(before)-money('20')));assert.equal((await core.paymentRequest(actor,r.id)).status,'COMPLETED');
 assert.equal((await core.list(actor,'transferalerts')).some(a=>a.request_id===r.id),false);
 await assert.rejects(core.settleManualTransfer(actor,{requestId:r.id,settlementAccountId:cash.accountId,settlementReference:'Again'},key()),/PAYMENT_REQUEST_CLOSED/);
 await assert.rejects(core.preparePayment(actor,request({cardDestination:'EXTERNAL',externalCardId:card.id,offlineDebit:true}),key()),/OFFLINE_INTERNAL_CARD/);
});
test('AG purchase exchanges existing institution stock and fiat atomically before transfer',async()=>{
 await assert.rejects(core.preparePayment(actor,request({method:'CRYPTO',cryptoAccount:aliceAg,cryptoDestination:'INTERNAL',receiverUserId:bob.userId,amount:'1'}),key()),/AG_PURCHASE_REQUIRED/);
 offer=await core.registerCryptoOffer(actor,{stockAccountId:agStock,proceedsAccount:'TN89AVIP000978000011000101',fiatCurrency:'EUR',unitPrice:'2'},key());
 const before=await balance(alice.accountId),buy={offerId:offer.id,from:alice.abiqIban,quantity:'3',unitPrice:'2',total:'6',reference:'Purchase AG fixture'};
 await assert.rejects(core.purchaseCrypto(actor,{...buy,unitPrice:'1'},key()),/CRYPTO_PRICE_CHANGED/);
 const k=key(),purchase=await core.purchaseCrypto(actor,buy,k);assert.deepEqual(await core.purchaseCrypto(actor,buy,k),purchase);
 assert.equal(await balance(aliceAg),'3.000000000000000000');assert.equal(await balance(agStock),'47.000000000000000000');assert.equal(await balance(alice.accountId),decimal(money(before)-money('6')));
 const r=await core.preparePayment(actor,request({method:'CRYPTO',cryptoAccount:aliceAg,cryptoDestination:'INTERNAL',receiverUserId:bob.userId,amount:'1'}),key());assert.equal(r.instruction.receiverName,'Bob transfer fixture');await confirm(r);await confirm(r);
 assert.equal(await balance(aliceAg),'2.000000000000000000');const bobAg=(await core.list(actor,'cryptoholdings')).find(a=>String(a.user_id)===bob.userId&&a.currency_code==='AG');assert.equal(bobAg.available_balance,'1.000000000000000000');
 await assert.rejects(core.preparePayment(actor,request({method:'CRYPTO',cryptoAccount:bobAg.account_id,cryptoDestination:'INTERNAL',receiverUserId:bob.userId,amount:'1'}),key()),/CRYPTO_HOLDING_REQUIRED/);
 const after=await balance(alice.accountId);await assert.rejects(core.purchaseCrypto(actor,{...buy,quantity:'100',total:'200'},key()),/INSUFFICIENT_FUNDS/);assert.equal(await balance(alice.accountId),after);
});
test('external crypto uses its exact asset and network, reserves once, and cancellation restores it',async()=>{
 const body=request({method:'CRYPTO',cryptoAccount:aliceEth,cryptoDestination:'EXTERNAL',cryptoAddress:'0x'+'12'.repeat(20),receiverName:'External crypto fixture',amount:'0.123456789012345678'});
 await assert.rejects(core.preparePayment(actor,{...body,cryptoAddress:'wrong'},key()),/INVALID_CRYPTO_ADDRESS/);
 const before=await balance(aliceEth),r=await core.preparePayment(actor,body,key()),result=await confirm(r);assert.equal(result.status,'OUTGOING');assert.equal(result.currency_code,'ETH');assert.equal(result.network,'ETHEREUM');await confirm(r);
 assert.equal(await balance(aliceEth),decimal(money(before)-money(body.amount)));assert.equal((await pool.query('SELECT count(*)::int n FROM avis_core_v2.onchain_transactions')).rows[0].n,0);
 await core.cancelPayment(actor,{requestId:r.id},key());await core.cancelPayment(actor,{requestId:r.id},key());assert.equal(await balance(aliceEth),before);
});
test('encrypted delivery round-trips without embedding a password and rejects a wrong password or tampering',async()=>{
 const payload={cardReference:'isolated-card',code:'123456'},password='private delivery fixture',encrypted=await encryptCardMessage(payload,password);
 assert.equal(JSON.stringify(encrypted).includes(password),false);assert.equal(JSON.stringify(encrypted).includes(payload.code),false);assert.deepEqual(await decryptCardMessage(encrypted,password),payload);
 await assert.rejects(decryptCardMessage(encrypted,'wrong password fixture'));
 await assert.rejects(decryptCardMessage({...encrypted,data:encrypted.data.slice(0,-4)+'AAAA'},password));
});
test('PostgreSQL concurrent code redemption posts one credit only',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const r=await core.preparePayment(actor,request({method:'CODED_CARD',amount:'3'}),key());await confirm(r);const d=await core.cardDelivery(actor,{requestId:r.id}),before=await balance(bob.accountId);
 const body={token:d.redemptionToken,code:d.code,to:bob.abiqIban,currency:'EUR',reference:'Concurrent code'};
 const results=await Promise.allSettled([core.redeemCode(actor,body,key()),core.redeemCode(actor,body,key())]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(await balance(bob.accountId),decimal(money(before)+money('3')));
});
test('all new journal groups remain balanced by asset and network',async()=>{
 const bad=(await pool.query(`SELECT e.journal_id,a.currency_code,a.network FROM avis_core_v2.ledger_entries e JOIN avis_core_v2.ledger_accounts a USING(account_id)
  GROUP BY e.journal_id,a.currency_code,a.network HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END)<>0`)).rows;assert.deepEqual(bad,[]);
});
