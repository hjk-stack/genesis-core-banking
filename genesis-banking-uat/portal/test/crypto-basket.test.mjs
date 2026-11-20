import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {TransferMethods} from '../src/transfer-methods.mjs';
import {CryptoBasket,priceBasket} from '../src/crypto-basket.mjs';

let engine,db,core,buyer,other,stock,proceeds,offer,address,deposit;
const admin={id:'basket-test-admin',admin:true},key=()=>randomUUID(),entry=(accountId,direction,amount)=>({accountId,direction,amount});
let form,session,issuer;
const stripe={env:{STRIPE_WEBHOOK_SECRET:'whsec_ExampleOnly'},secretKey:()=>'rk_test_ExampleOnly',async fetcher(url,options){
 assert.match(url,/^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions/);form=new URLSearchParams(options.body);
 session={id:'cs_test_Basket123',livemode:false,client_reference_id:form.get('client_reference_id'),metadata:{source:'AVISPAY_CRYPTO_BASKET',order_id:form.get('metadata[order_id]')},mode:'payment',currency:'eur',amount_total:Number(form.get('line_items[0][price_data][unit_amount]')),status:'open',url:'https://checkout.stripe.com/c/pay/cs_test_Basket123'};
 return {ok:true,json:async()=>session};}};
const order=(token,method='ACCOUNT',quantity='0.2')=>engine.quote(token,{requestKey:key(),asset:'ETH',network:'ETHEREUM',quantity,fiat:'EUR',method});
before(async()=>{
 db=new PGlite();const pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:s=>db.exec(s),release(){}})};
 await migrate(await pool.connect());core=new TransferMethods(pool);engine=new CryptoBasket(core,stripe);
 issuer={userId:'1',accounts:[{accountId:await core.userFunding(db,'1','EUR')}]};
 const customer=await core.openCustomer(admin,{fullName:'Basket buyer',accountType:'PERSONAL',currencies:['EUR']},key());
 buyer={id:'customer-basket',customerUserId:customer.userId};other={id:'other',customerUserId:issuer.userId};
 stock=await core.networkAccount(db,'USER','ETH','ETHEREUM','CRYPTO',issuer.userId);proceeds=issuer.accounts[0].accountId;
 await db.query("INSERT INTO avis_core_v2.crypto_assets(asset_id,currency_code,name,source) VALUES('basket-eth','ETH','Ethereum','TEST') ON CONFLICT(currency_code) DO NOTHING");
 const asset=(await db.query("SELECT asset_id FROM avis_core_v2.crypto_assets WHERE currency_code='ETH'")).rows[0].asset_id;
 await db.query("INSERT INTO avis_core_v2.crypto_asset_networks(asset_id,network,decimals,approved,verified_at) VALUES($1,'ETHEREUM',18,true,now()) ON CONFLICT(asset_id,network) DO UPDATE SET approved=true,verified_at=now(),decimals=18",[asset]);
 await core.post(db,admin,key(),'FIXTURE_CASH','test',[entry(await core.system(db,'CORRESPONDENT_NOSTRO','EUR','TEST','ASSET'),'DEBIT','500'),entry(customer.accounts[0].accountId,'CREDIT','500')]);
 const backing=await core.networkAccount(db,'HOT_WALLET','ETH','ETHEREUM','TEST');
 deposit=await core.post(db,admin,key(),'WALLET_DEPOSIT','confirmed test receipt',[entry(backing,'DEBIT','1'),entry(stock,'CREDIT','1')]);
 await db.query("INSERT INTO avis_core_v2.crypto_sale_offers(offer_id,stock_account_id,proceeds_account_id,unit_price) VALUES($1,$2,$3,100)",[key(),stock,proceeds]);
 const result=await db.query("INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address,is_primary) VALUES($1,'ETHEREUM',$2,false) RETURNING address_id",[issuer.userId,'0x'+'a'.repeat(40)]);
 address=result.rows[0].address_id;
 const tx='0x'+'a'.repeat(64),hash='0x'+'b'.repeat(64);
 await db.query("INSERT INTO avis_core_v2.onchain_transactions(user_id,journal_id,tx_type,network,tx_hash,event_index,from_address,to_address,currency_code,amount,status,block_timestamp) VALUES($1,$2,'WALLET_DEPOSIT','ETHEREUM',$3,0,'sender','receiver','ETH',1,'CONFIRMED',now())",[issuer.userId,deposit,tx]);
 await db.query(`INSERT INTO avis_core_v2.crypto_wallet_deposits(user_id,account_id,address_id,asset_id,network,tx_hash,asset_key,currency_code,wallet_scope,decimals,amount,block_number,block_hash,finalized_block_number,finalized_block_hash,confirmations,receipt_digest,event_proofs,journal_id)
 VALUES($1,$2,$3,$4,'ETHEREUM',$5,'NATIVE','ETH','FUNDING',18,1,1,$6,20,$6,20,$7,'[{}]'::jsonb,$8)`,[issuer.userId,stock,address,asset,tx,hash,'a'.repeat(64),deposit]);
});
after(async()=>{await db?.close();});
test('exact acquisition cost and markup round up to the settlement cent',()=>{
 assert.deepEqual(priceBasket({quantity:'0.35',lotQuantity:'1',lotCost:'10000',markup:500,cardBps:200,fixedMinor:30}),{costMinor:'3500',markupMinor:'175',collectionCostMinor:'106',totalMinor:'3781',total:'37.81'});
});
test('unpriced external inventory and incomplete receipts produce no payable quote; only admins may configure cost',async()=>{
 const {token}=await engine.start(buyer);const inquiry=await order(token);assert.equal(inquiry.status,'SOURCING');
 await assert.rejects(order(token,'WIRE'),/BASKET_METHOD/);
 await assert.rejects(engine.registerLot(buyer,{},key()),/FORBIDDEN/);
 await assert.rejects(engine.setPolicy(buyer,{markupBps:9000,participationBps:9000},key()),/FORBIDDEN/);
 await assert.rejects(engine.registerLot(admin,{journalId:key(),fiat:'EUR',cost:'100.00',providerReference:'test'},key()),/BASKET_COST/);
 await assert.rejects(order(token,'CARD'),/BASKET_CARD/);
 const result=await engine.registerLot(admin,{journalId:deposit,fiat:'EUR',cost:'100.00',providerReference:'provider-order-1'},key());offer=result.id;
 await engine.setPolicy(admin,{markupBps:500,participationBps:2500},key());
 const quote=await engine.quote(token,{requestKey:inquiry.requestKey,asset:'ETH',network:'ETHEREUM',quantity:'0.2',fiat:'EUR',method:'ACCOUNT'});assert.equal(quote.id,inquiry.id);assert.equal(quote.total,'21.00');assert.equal(quote.markupBps,undefined);
 await assert.rejects(engine.confirmAccount(other,{id:quote.id,total:'21.00'}),/BASKET_ORDER/);
 const paid=await engine.confirmAccount(buyer,{id:quote.id,total:'21.00'});assert.equal(paid.status,'PAID');
 assert.equal((await engine.confirmAccount(buyer,{id:quote.id,total:'21.00'})).journalId,paid.journalId);
 assert.equal(Number((await db.query('SELECT remaining FROM avis_core_v2.crypto_basket_lots WHERE offer_id=$1',[offer])).rows[0].remaining),0.8);
 assert.equal((await order(token,'ACCOUNT','0.9')).status,'SOURCING');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM avis_core_v2.wallet_trading_delegations')).rows[0].n,0);
});
test('card funds a reserved wallet delivery exactly once, independent of a browser return',async()=>{
 await engine.setCard(admin,{fiat:'EUR',approvalReference:'test-only approved merchant',feeBps:100,fixedMinor:0},key());
 const {token}=await engine.start(buyer),r=await order(token,'CARD');
 await assert.rejects(engine.card((await engine.start(other)).token,r.id),/BASKET_ORDER/);
 assert.match((await engine.card(token,r.id)).checkoutUrl,/checkout\.stripe\.com/);
 const read=async()=>(await db.query('SELECT * FROM avis_core_v2.crypto_basket_orders WHERE order_id=$1',[r.id])).rows[0];
 assert.equal((await read()).settlement_journal,null);
 const event={id:'evt_cardbasket1',type:'checkout.session.completed',livemode:false,data:{object:{...session,payment_status:'paid',payment_intent:'pi_basket1'}}};
 await assert.rejects(engine.event({...event,data:{object:{...event.data.object,amount_total:1}}}),/STRIPE_EVENT_MISMATCH/);
 await engine.event(event);assert.equal((await read()).status,'PAID');const journal=(await read()).settlement_journal;
 assert.equal((await engine.event(event)).duplicate,true);assert.equal((await read()).settlement_journal,journal);
 await engine.event({id:'evt_dispute1',type:'charge.dispute.created',livemode:false,data:{object:{payment_intent:'pi_basket1'}}});assert.equal((await read()).status,'REVIEW');
});

test('an expired Stripe session releases only its reserved quantity and permits another sale',async()=>{
 const {token}=await engine.start(buyer),r=await order(token,'CARD','0.1');
 const original=stripe.fetcher;stripe.fetcher=async(url,options)=>{const response=await original(url,options);session.id='cs_test_Expired456';return response;};
 try{await engine.card(token,r.id);const before=(await db.query('SELECT remaining FROM avis_core_v2.crypto_basket_lots WHERE offer_id=$1',[offer])).rows[0].remaining;
  const expired={id:'evt_closed456',type:'checkout.session.expired',livemode:false,data:{object:{...session,payment_status:'unpaid'}}};
  await engine.event(expired);await engine.event(expired);
  const after=(await db.query('SELECT remaining FROM avis_core_v2.crypto_basket_lots WHERE offer_id=$1',[offer])).rows[0].remaining;
  assert.equal((Number(after)-Number(before)).toFixed(1),'0.1');assert.equal((await engine.orderForBuyer(buyer,r.id)).status,'EXPIRED');
 }finally{stripe.fetcher=original;}
});
