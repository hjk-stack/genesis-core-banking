import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {StripeWebPos} from '../src/stripe-pos.mjs';
import {SovereignCore,money,decimal} from '../src/core.mjs';
import {ABIQ_PARTITIONS,parseAbiqIban} from '../src/avispay-core-accounts.mjs';
import {createBankServer,authenticateFineract} from '../server.mjs';
let db,pool,core,buyer,seller,seller2,server,base;let next=0;
const actor={id:'test-operator',username:'operator',admin:true},key=()=>`case-${++next}`;
const customer=(name,type='PERSONAL',currencies=['EUR'])=>core.openCustomer(actor,{fullName:name,accountType:type,currencies},key());
const eur=c=>c.accounts.find(a=>a.currency==='EUR');
async function balance(id){return (await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[id])).rows[0].available_balance;}
async function count(table){return Number((await pool.query(`SELECT count(*) AS n FROM avis_core_v2.${table}`)).rows[0].n);}
async function fund(c,amount='1000.00'){
 const client=await pool.connect();try{await client.query('BEGIN');const nostro=await core.system(client,'CORRESPONDENT_NOSTRO','EUR','FIXTURE','ASSET');
 await core.post(client,actor,key(),'FIXTURE_CASH','isolated automated test',[{accountId:nostro,direction:'DEBIT',amount},{accountId:eur(c).accountId,direction:'CREDIT',amount}]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci','Only the dedicated CI database is accepted');pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release(){}})};}
 const client=await pool.connect();try{await migrate(client);await migrate(client);}finally{client.release();}
 core=new SovereignCore(pool);
});
after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(db)await db.close();else await pool.end();});
test('exact decimals reject floating point, exponent and overprecision',()=>{assert.equal(decimal(money('9007199254740993.000000000000000001')),'9007199254740993.000000000000000001');for(const v of [1.2,'1e6','-1','0','0.0000000000000000001'])assert.throws(()=>money(v));});
test('sovereign signup opens all 14 ABIQ accounts with 3 scopes and no external dependency',async()=>{
 await pool.query("INSERT INTO avis_core_v2.platform_connectors(connector_code,display_name,is_enabled,auto_provision,endpoint_url) VALUES('CORE_BANK_IBAN','Account bridge',true,true,'https://unused.invalid')");
 buyer=await customer('Buyer','PERSONAL',Object.keys(ABIQ_PARTITIONS));assert.equal(buyer.accounts.length,14);
 for(const a of buyer.accounts){assert.equal(parseAbiqIban(a.abiqIban).accountNumber,a.accountNumber);assert.equal(parseAbiqIban(a.abiqIban).currency,a.currency);assert.equal(await balance(a.accountId),'0.000000000000000000');}
 assert.equal(Number((await pool.query('SELECT count(*) AS n FROM avis_core_v2.ledger_accounts WHERE user_id=$1',[buyer.userId])).rows[0].n),42);
 assert.equal(await count('connector_outbox'),1);seller=await customer('First Shop Ltd','BUSINESS');seller2=await customer('Second Shop Ltd','BUSINESS');
});
test('signup retry returns same account suite and conflicting request rolls back',async()=>{
 const input={fullName:'Idempotent User',accountType:'PERSONAL',currencies:['EUR']},k=key(),before=await count('sovereign_users');
 const a=await core.openCustomer(actor,input,k),b=await core.openCustomer(actor,input,k);assert.deepEqual(a,b);assert.equal(await count('sovereign_users'),before+1);
 await assert.rejects(core.openCustomer(actor,{...input,fullName:'Changed'},k),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(core.openCustomer(actor,{...input,participantCode:'NONE'},key()),/ABIQ_PARTICIPANT_NOT_ACTIVE/);assert.equal(await count('sovereign_users'),before+1);
});
test('internal transfer settles exact values once and rejects insufficient funds atomically',async()=>{
 await fund(buyer);const input={from:eur(buyer).abiqIban,to:eur(seller).abiqIban,currency:'EUR',amount:'100.000000000000000001',reference:'Invoice A'},k=key();
 const r=await core.transfer(actor,input,k);assert.deepEqual(await core.transfer(actor,input,k),r);assert.equal(await balance(eur(buyer).accountId),'899.999999999999999999');assert.equal(await balance(eur(seller).accountId),input.amount);
 const before=await count('ledger_journals');await assert.rejects(core.transfer(actor,{...input,amount:'900.00'},key()),/INSUFFICIENT_FUNDS/);assert.equal(await count('ledger_journals'),before);
 await assert.rejects(core.transfer(actor,{...input,currency:'USD'},key()),/ABIQ_CURRENCY_MISMATCH/);
 await assert.rejects(core.transfer({...actor,admin:false},input,key()),/FORBIDDEN/);
});
test('journal rejects cross-currency balancing and preserves append-only history',async()=>{
 const rows=buyer.accounts,client=await pool.connect();try{
 await assert.rejects(core.post(client,actor,key(),'INVALID','x',[{accountId:eur(buyer).accountId,direction:'DEBIT',amount:'10'},{accountId:rows.find(a=>a.currency==='USD').accountId,direction:'CREDIT',amount:'10'}]),/UNBALANCED_JOURNAL/);
 await assert.rejects(client.query("UPDATE avis_core_v2.ledger_entries SET amount=1"),/APPEND_ONLY_RECORD/);
 await assert.rejects(client.query("DELETE FROM avis_core_v2.ledger_journals"),/APPEND_ONLY_RECORD/);
 }finally{client.release();}
});
test('merchant registration requires a business owner, independent of external acquiring',async()=>{
 await assert.rejects(core.registerShop(actor,{merchantId:'bad',shopName:'Wrong owner',ownerUserId:buyer.userId,commissionBps:500},key()),/BUSINESS_ACCOUNT_REQUIRED/);
 await core.registerShop(actor,{merchantId:'shop-a',shopName:'First shop',ownerUserId:seller.userId,commissionBps:500},key());
 await core.registerShop(actor,{merchantId:'shop-b',shopName:'Second shop',ownerUserId:seller2.userId,commissionBps:0},key());assert.equal(await count('marketplace_merchants'),2);
});
test('multi-shop capture holds escrow, partial delivery releases only its split, and replay is safe',async()=>{
 const input={orderReference:'CART-1',buyerAccount:eur(buyer).abiqIban,paymentRail:'AVIS_BANK_EUR',splits:[{merchantId:'shop-a',amount:'100.00'},{merchantId:'shop-b',amount:'50.00'}]},k=key();
 const capture=await core.captureCheckout(actor,input,k);assert.deepEqual(await core.captureCheckout(actor,input,k),capture);assert.equal(capture.status,'ESCROW_HELD');assert.equal(await balance(eur(seller2).accountId),'0.000000000000000000');
 const split=(await pool.query('SELECT split_id FROM avis_core_v2.checkout_split_lines WHERE checkout_id=$1 AND merchant_id=$2',[capture.id,'shop-b'])).rows[0].split_id;
 const part=await core.releaseCheckout(actor,{checkoutId:capture.id,splitId:split},key());assert.equal(part.status,'PARTIALLY_SETTLED');assert.equal(await balance(eur(seller2).accountId),'50.000000000000000000');
 const kr=key(),rest=await core.releaseCheckout(actor,{checkoutId:capture.id},kr);assert.equal(rest.status,'SETTLED');assert.deepEqual(await core.releaseCheckout(actor,{checkoutId:capture.id},kr),rest);
 assert.equal(await balance(eur(seller).accountId),'195.000000000000000001');await assert.rejects(core.releaseCheckout(actor,{checkoutId:capture.id},key()),/CHECKOUT_ALREADY_CLOSED/);
});
test('refund returns held funds and failed duplicate orders leave no extra journal',async()=>{
 const input={orderReference:'CART-REFUND',buyerAccount:eur(buyer).abiqIban,paymentRail:'AVIS_BANK_EUR',splits:[{merchantId:'shop-a',amount:'25.00'}]},before=await balance(eur(buyer).accountId);
 const c=await core.captureCheckout(actor,input,key());const journals=await count('ledger_journals');await assert.rejects(core.captureCheckout(actor,input,key()),/duplicate key/);assert.equal(await count('ledger_journals'),journals);
 const r=await core.refundCheckout(actor,{checkoutId:c.id},key());assert.equal(r.status,'REFUNDED');assert.equal(await balance(eur(buyer).accountId),before);
 await assert.rejects(core.releaseCheckout(actor,{checkoutId:c.id},key()),/CHECKOUT_ALREADY_CLOSED/);
});
test('AVIS card authorization reserves funds; capture settles merchant and fee only once',async()=>{
 await core.registerCard(actor,{cardReference:'av-token-1',lastFour:'1234',railMode:'AVIS_PROPRIETARY_ONLY',fundingAccount:eur(buyer).abiqIban,currency:'EUR'},key());
 await core.registerTerminal(actor,{terminalId:'TERM-A',merchantId:'shop-a',terminalType:'WEB_POS'},key());
 const before=await balance(eur(seller).accountId),auth=await core.authorizeCard(actor,{cardReference:'av-token-1',terminalId:'TERM-A',networkReference:'AUTH-1',currency:'EUR',amount:'20.00'},key());assert.equal(auth.status,'AUTHORIZED');assert.equal(await balance(eur(seller).accountId),before);
 const k=key(),captured=await core.settleCard(actor,{authorizationId:auth.id},k);assert.equal(captured.status,'CAPTURED');assert.deepEqual(await core.settleCard(actor,{authorizationId:auth.id},k),captured);assert.equal(await balance(eur(seller).accountId),'214.000000000000000001');
 await assert.rejects(core.settleCard(actor,{authorizationId:auth.id},key(),true),/AUTHORIZATION_ALREADY_CLOSED/);
});
test('card reversal restores customer and never creates a merchant credit',async()=>{
 const before=await balance(eur(buyer).accountId),auth=await core.authorizeCard(actor,{cardReference:'av-token-1',terminalId:'TERM-A',networkReference:'AUTH-2',currency:'EUR',amount:'30'},key());
 assert.equal((await core.settleCard(actor,{authorizationId:auth.id},key(),true)).status,'REVERSED');assert.equal(await balance(eur(buyer).accountId),before);
});
test('all journal groups balance by asset and all customer balances remain nonnegative',async()=>{
 const bad=await pool.query(`SELECT j.journal_id,a.currency_code,a.network FROM avis_core_v2.ledger_journals j JOIN avis_core_v2.ledger_entries e USING(journal_id) JOIN avis_core_v2.ledger_accounts a USING(account_id)
 GROUP BY j.journal_id,a.currency_code,a.network HAVING sum(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END)<>0`);assert.equal(bad.rows.length,0);
 assert.equal((await pool.query("SELECT * FROM avis_core_v2.ledger_accounts WHERE owner_type='USER' AND available_balance<0")).rows.length,0);
});
test('PostgreSQL concurrent transfers cannot overdraw a balance', {skip:!process.env.TEST_DATABASE_URL},async()=>{
 const sender=await customer('Concurrent sender');await fund(sender,'10');const input={from:eur(sender).abiqIban,to:eur(seller).abiqIban,currency:'EUR',amount:'7',reference:'race'};
 const results=await Promise.allSettled([core.transfer(actor,input,key()),core.transfer(actor,input,key())]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(await balance(eur(sender).accountId),'3.000000000000000000');
});
test('HTTP authentication, origin, CSRF and persisted session enforce operator access',async()=>{
 server=createBankServer({pool,authenticate:async(u,p)=>{if(u!=='operator'||p!=='fixture-password')throw Object.assign(new Error('SIGN_IN_FAILED'),{code:'SIGN_IN_FAILED',status:401});return actor;},secureCookies:false});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(base+'/api/views/accounts')).status,401);
 assert.equal((await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'operator',password:'fixture-password'})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0],session=await login.json();
 assert.equal((await fetch(base+'/api/views/accounts',{headers:{cookie}})).status,200);
 const body=JSON.stringify({fullName:'HTTP Account',accountType:'PERSONAL',currencies:['EUR']});
 assert.equal((await fetch(base+'/api/customers',{method:'POST',headers:{cookie,origin:base,'content-type':'application/json','idempotency-key':'http-account'},body})).status,403);
 const result=await fetch(base+'/api/customers',{method:'POST',headers:{cookie,origin:base,'content-type':'application/json','x-csrf-token':session.csrf,'idempotency-key':'http-account'},body});assert.equal(result.status,200);assert.equal((await result.json()).accounts.length,1);
});
test('administrator session restore in another tab preserves active forms',async()=>{
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'operator',password:'fixture-password'})});
 const cookie=login.headers.get('set-cookie').split(';')[0],initial=await login.json();
 const restored=await Promise.all([1,2].map(async()=>{
  const response=await fetch(base+'/api/session',{headers:{cookie}});assert.equal(response.status,200);return response.json();
 }));
 for(const session of restored)assert.equal(session.csrf,initial.csrf,'opening a second tab must not invalidate the first tab');
 const response=await fetch(base+'/api/customers',{method:'POST',headers:{cookie,origin:base,'content-type':'application/json','x-csrf-token':initial.csrf,'idempotency-key':'multi-tab-account'},body:JSON.stringify({fullName:'Multiple tab account',accountType:'PERSONAL',currencies:['EUR']})});
 assert.equal(response.status,200);assert.equal((await response.json()).accounts.length,1);
 const logout=await fetch(base+'/api/logout',{method:'POST',headers:{cookie,origin:base,'content-type':'application/json','x-csrf-token':restored[1].csrf},body:'{}'});assert.equal(logout.status,200);
 assert.equal((await fetch(base+'/api/session',{headers:{cookie}})).status,401);
});
test('existing identity service requires authenticated administrator permission',async()=>{
 await assert.rejects(authenticateFineract('a','b','https://bank.invalid',async()=>({ok:true,json:async()=>({authenticated:true,permissions:['READ_CLIENT']})})),/OPERATOR_ACCESS_REQUIRED/);
 // Fineract's published authentication response uses authenticated, not isAuthenticated.
 const operator=await authenticateFineract('a','b','http://genesis-fineract-uat',async()=>({ok:true,json:async()=>({authenticated:true,userId:42,permissions:['ALL_FUNCTIONS']})}));assert.equal(operator.id,'fineract:42');
 for(const data of [{authenticated:false},{isAuthenticated:true},{authenticated:true,isTwoFactorAuthenticationRequired:true}])await assert.rejects(authenticateFineract('a','b','https://bank.invalid',async()=>({ok:true,json:async()=>({...data,permissions:['ALL_FUNCTIONS']})})),/OPERATOR_ACCESS_REQUIRED/);
});
test('operational UI has no integration placeholders and dialogs have close controls',async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8'),js=await readFile(new URL('../public/app.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(html+js,/External integrations not connected|integration pending|onboarding pending|no transactions|UAT ONLY|sandbox|simulator/i);
 assert.match(html,/<dialog/);assert.match(html,/aria-label="Close"/);assert.match(js,/api\('views\/'/);assert.match(js,/ABIQ/);
});

test('migrated PostgreSQL stores Stripe Web POS checkouts and webhook receipts idempotently',async()=>{
 const owner=await customer('Stripe database merchant','BUSINESS');
 await core.registerShop(actor,{merchantId:'stripe-db-shop',shopName:'Stripe database shop',
  ownerUserId:owner.userId,commissionBps:0},key());
 await core.registerTerminal(actor,{terminalId:'STRIPE-DB-POS',merchantId:'stripe-db-shop',terminalType:'WEB_POS'},key());
 const id='cs_test_database1',intent='pi_database1';
 let checkoutCalls=0;
 const service=new StripeWebPos(pool,{
  env:{STRIPE_SECRET_KEY:'rk_test_database',AVIS_STRIPE_RETURN_ORIGIN:'https://bank.example'},
  fetcher:async()=>{
   checkoutCalls++;
   return Response.json({id,url:'https://checkout.stripe.com/c/pay/'+id});
  }
 });
 const input={terminalId:'STRIPE-DB-POS',reference:'database receipt',currency:'EUR',amount:'12.34'};
 const request=key(),created=await service.createCheckout(actor,input,request);
 assert.equal(created.status,'CHECKOUT_CREATED');
 assert.deepEqual(await service.createCheckout(actor,input,request),created);
 assert.equal(checkoutCalls,1);
 const event={id:'evt_database1',type:'checkout.session.completed',data:{object:{
  id,mode:'payment',currency:'eur',amount_total:1234,payment_status:'paid',payment_intent:intent,
  metadata:{source:'AVISPAY_WEB_POS',paymentId:created.id,merchantId:'stripe-db-shop'}
 }}};
 assert.equal((await service.applyEvent(event)).status,'PAID');
 assert.equal((await service.applyEvent(event)).duplicate,true);
 const receipt=await service.status(actor,id);
 assert.equal(receipt.amount,'12.34');
 assert.equal(receipt.status,'PAID');
 assert.ok(receipt.paid_at);
 const rows=await service.list(actor);
 assert.equal(rows.filter(row=>row.payment_id===created.id&&row.payment_intent_id===intent).length,1);
 const events=await pool.query('SELECT stripe_event_id FROM avis_core_v2.stripe_pos_webhook_events WHERE payment_id=$1',[created.id]);
 assert.deepEqual(events.rows,[{stripe_event_id:event.id}]);
});
