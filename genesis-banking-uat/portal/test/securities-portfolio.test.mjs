import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {SecuritiesPortfolio,securityValue,securityMetadata,greenBondCatalogue} from '../src/securities-portfolio.mjs';
import {CustomerAccess} from '../src/customer-access.mjs';
import {createBankServer} from '../server.mjs';
let pool,db,core,securityId,accounts,server;
const admin={id:'fixture:admin',admin:true},customer={id:'fixture:customer',admin:false,customerUserId:'2'},key=()=>randomUUID();
const meta={name:'Regression bond',shortName:'REG 2036',currency:'EUR',denomination:'1000',quoteBasis:'PERCENT',kind:'bond',isin:'US0378331005',cusip:'037833100'};
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const u=new URL(process.env.TEST_DATABASE_URL);assert.equal(u.pathname,'/avispay_ci');pool=new pg.Pool({connectionString:u.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};}
 const c=await pool.connect();try{await migrate(c);}finally{c.release();}core=new SecuritiesPortfolio(pool,{readCatalogue:async()=>[{...securityMetadata(meta),symbol:'REGRESSION',referencePrice:'98'}]});
 accounts=await core.list(admin,'accountsummaries');
 await core.operation(admin,'FIXTURE_FUNDING',{},key(),async(d,k)=>{
  const offset=await core.system(d,'TREASURY','EUR','SECURITIES_FIXTURE','ASSET');return {journalId:await core.post(d,admin,k,'FIXTURE','Isolated securities regression',accounts.filter(a=>a.currency_code==='EUR').flatMap(a=>[{accountId:offset,direction:'DEBIT',amount:'20000'},{accountId:a.account_id,direction:'CREDIT',amount:'20000'}]))};
 });
});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(db)await db.close();else await pool.end();});
const source=user=>accounts.find(a=>String(a.user_id)===String(user)&&a.currency_code==='EUR');
const body=(side,user,extra={})=>({securityId,side,accountId:source(user).account_id,paymentMethod:'ACCOUNT',quantity:'1',denomination:'1000',price:'98',total:'980',reference:'Regression '+side,...extra});
const review=(side,user,extra={})=>core.reviewSecurityOrder(admin,body(side,user,extra),key());
const submit=r=>core.submitSecurityOrder(admin,{orderId:r.id,reviewHash:r.reviewHash},key());
const cancel=id=>core.cancelSecurityOrder(admin,{orderId:id},key());
const balance=async id=>(await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[id])).rows[0].available_balance;
const position=async user=>(await core.list({...admin,customerUserId:String(user)},'securitypositions')).find(p=>p.security_id===securityId);

test('precise valuation, metadata check digits and public Green Bond mapping',async()=>{
 assert.equal(securityValue('10','1000','98','PERCENT','EUR'),'9800.000000000000000000');
 assert.equal(securityValue('0.125','1','112.35','UNIT','EUR'),'14.040000000000000000');
 assert.equal(securityValue('3','1','120.5','UNIT','JPY'),'362.000000000000000000');
 assert.equal(securityValue('100000','1000','100','PERCENT','USD'),'100000000.000000000000000000');
 assert.throws(()=>securityMetadata({...meta,isin:'US0378331004'}),/INVALID_FIELD/);
 assert.throws(()=>securityMetadata({...meta,cusip:'037833101'}),/INVALID_FIELD/);
 const fixture={markets:[{symbol:'REG',name:meta.name,shortName:meta.shortName,kind:'bond',currency:'EUR',status:'listed',nominal:'1000',last:'98',isin:meta.isin,cusip:meta.cusip},{symbol:'PRIVATE',kind:'note',status:'draft'}]};
 const feed=await greenBondCatalogue(async(url,options)=>{assert.equal(url,'https://avis.land/api/xchg/markets');assert.equal(options.redirect,'error');return new Response(JSON.stringify(fixture));});assert.equal(feed.length,1);assert.equal(feed[0].quoteBasis,'PERCENT');assert.equal(feed[0].cusip,meta.cusip);
 await assert.rejects(greenBondCatalogue(async()=>new Response('{}')),/SECURITY_CATALOGUE_READ/);
});
test('catalogue import is idempotent and does not rewrite existing account data or book nominal supply',async()=>{
 const before=await core.list(admin,'accountsummaries'),journal=(await core.list(admin,'transactions')).length,k=key();
 assert.equal((await core.syncSecurities(admin,{},k)).imported,1);
 const read=core.readCatalogue;core.readCatalogue=async()=>{throw Error('FEED_UNAVAILABLE_AFTER_COMMIT');};
 assert.equal((await core.syncSecurities(admin,{},k)).imported,1);
 await assert.rejects(core.syncSecurities(admin,{},key()),/FEED_UNAVAILABLE_AFTER_COMMIT/);core.readCatalogue=read;
 const rows=await core.list(admin,'securities');assert.equal(rows.length,1);securityId=rows[0].security_id;assert.equal(rows[0].source,'GREEN_BOND');
 assert.deepEqual(await core.list(admin,'accountsummaries'),before);assert.equal((await core.list(admin,'transactions')).length,journal);assert.deepEqual(await core.list(admin,'securitypositions'),[]);
 const added=await core.addSecurity(admin,{name:'Manual fund',shortName:'MANUAL',currency:'CHF',denomination:'1',quoteBasis:'UNIT',kind:'fund'},key());assert.ok(added.id);
 await assert.rejects(core.addSecurity({...admin,customerUserId:'2'},meta,key()),/FORBIDDEN/);
});
test('manual position quantity and prices produce a portfolio value with version and ownership enforcement',async()=>{
 const input={userId:'1',securityId,quantity:'12',issuingPrice:'100',marketPrice:'98',reference:'Opening custody regression'},k=key();const r=await core.recordPosition(admin,input,k);assert.deepEqual(await core.recordPosition(admin,input,k),r);
 let p=await position('1');assert.equal(p.portfolio_value,'11760.000000000000000000');assert.equal(p.issuing_price,'100.000000000000000000');
 await assert.rejects(core.recordPosition(admin,{...input,quantity:'15',version:0},key()),/POSITION_CHANGED/);
 assert.equal((await new CustomerAccess(core).list(customer,'securitypositions')).length,0);
 await assert.rejects(new CustomerAccess(core).invoke(customer,'recordPosition',input,key()),/FORBIDDEN/);
 await assert.rejects(pool.query('DELETE FROM avis_core_v2.portfolio_movements'),/APPEND_ONLY_RECORD/);
});
test('buy review enforces server total, debit balance and account currency',async()=>{
 await assert.rejects(review('BUY','2',{quantity:'0.1',total:'98'}),/SECURITY_QUANTITY_PRECISION/);
 await assert.rejects(core.recordPosition(admin,{userId:'2',securityId,quantity:'0.1',issuingPrice:'100',marketPrice:'98',reference:'Invalid fractional lot'},key()),/SECURITY_QUANTITY_PRECISION/);
 await assert.rejects(review('BUY','2',{total:'1'}),/ORDER_TOTAL_CHANGED/);
 await assert.rejects(review('BUY','2',{denomination:'10'}),/SECURITY_TERMS_CHANGED/);
 await assert.rejects(review('BUY','2',{quantity:'100',total:'98000'}),/INSUFFICIENT_FUNDS/);
 await assert.rejects(review('SELL','2'),/INSUFFICIENT_SECURITIES/);
 await assert.rejects(new CustomerAccess(core).invoke(customer,'reviewSecurityOrder',body('BUY','1'),key()),/FORBIDDEN/);
 const r=await new CustomerAccess(core).invoke(customer,'reviewSecurityOrder',body('BUY','2'),key());assert.equal(r.instruction.userId,'2');
 await assert.rejects(core.submitSecurityOrder(admin,{orderId:r.id,reviewHash:'altered'},key()),/ORDER_REVIEW_CHANGED/);
 await pool.query("UPDATE avis_core_v2.securities_orders SET expires_at=now()-interval '1 second' WHERE order_id=$1",[r.id]);await assert.rejects(submit(r),/ORDER_REVIEW_CHANGED/);
});
test('an unmatched order reserves actual funds and cancellation refunds exactly once',async()=>{
 const before=await balance(source('2').account_id),r=await review('BUY','2'),input={orderId:r.id,reviewHash:r.reviewHash},k=key();
 const result=await core.submitSecurityOrder(admin,input,k);assert.equal(result.status,'OPEN');assert.deepEqual(await core.submitSecurityOrder(admin,input,k),result);assert.equal(Number(await balance(source('2').account_id)),Number(before)-980);
 const reg=await new CustomerAccess(core).list(customer,'securityorders');assert.ok(reg.some(o=>o.order_id===r.id&&o.status==='OPEN'));
 await cancel(r.id);await cancel(r.id);assert.equal(await balance(source('2').account_id),before);assert.equal((await core.list(admin,'exchangebook')).length,0);
});
test('matching account-funded BUY and SELL orders transfer securities and money atomically',async()=>{
 const seller=await review('SELL','1'),buyer=await review('BUY','2'),before1=Number(await balance(source('1').account_id)),before2=Number(await balance(source('2').account_id));
 assert.equal((await submit(seller)).status,'OPEN');assert.equal(Number((await position('1')).reserved_quantity),1);
 const filled=await submit(buyer);assert.equal(filled.status,'FILLED');assert.ok(filled.journalId);assert.ok(filled.executionReference);
 assert.equal(Number(await balance(source('1').account_id)),before1+980);assert.equal(Number(await balance(source('2').account_id)),before2-980);
 assert.equal(Number((await position('1')).quantity),11);assert.equal(Number((await position('1')).reserved_quantity),0);assert.equal(Number((await position('2')).quantity),1);
 assert.equal((await core.securityOrderDetails(admin,{orderId:seller.id})).status,'FILLED');await assert.rejects(cancel(seller.id),/ORDER_ALREADY_FILLED/);
 const entries=(await pool.query('SELECT direction,sum(amount)::text AS amount FROM avis_core_v2.ledger_entries WHERE journal_id=$1 GROUP BY direction',[filled.journalId])).rows;assert.equal(entries[0].amount,entries[1].amount);
});
test('card payment uses the owned card purse, checks block/expiry and refunds to that purse',async()=>{
 const c=await core.issueManagedCard(admin,{from:source('2').abiq_iban,currency:'EUR',product:'VIRTUAL'},key());await core.loadManagedCard(admin,{from:source('2').abiq_iban,currency:'EUR',cardId:c.id,amount:'1500',reference:'Card fixture'},key());
 const r=await review('BUY','2',{paymentMethod:'CARD',accountId:c.accountId,cardId:c.id});
 await core.setCardStatus(admin,{cardId:c.id,status:'BLOCKED'},key());await assert.rejects(submit(r),/SELECT_AVIS_CARD/);assert.equal(Number(await balance(c.accountId)),1500);
 await core.setCardStatus(admin,{cardId:c.id,status:'ACTIVE'},key());assert.equal((await submit(r)).status,'OPEN');assert.equal(Number(await balance(c.accountId)),520);await cancel(r.id);assert.equal(Number(await balance(c.accountId)),1500);
 const sell=await review('SELL','1'),buy=await review('BUY','2',{paymentMethod:'CARD',accountId:c.accountId,cardId:c.id});await submit(sell);assert.equal((await submit(buy)).status,'FILLED');assert.equal(Number(await balance(c.accountId)),520);
});
test('crypto-funded orders reserve actual holdings and dealer fiat, releasing both on cancellation',async()=>{
 const stock=await core.networkAccount(pool,'USER','AG','ETHEREUM','CRYPTO','1'),own=await core.networkAccount(pool,'USER','AG','ETHEREUM','CRYPTO','2');
 await core.operation(admin,'CRYPTO_FIXTURE',{},key(),async(d,k)=>{const offset=(await d.query("INSERT INTO avis_core_v2.ledger_accounts(owner_type,sub_account_code,currency_code,network,account_category) VALUES('HOT_WALLET','SECURITIES_FIXTURE','AG','ETHEREUM','ASSET') RETURNING account_id")).rows[0].account_id;return {journalId:await core.post(d,admin,k,'FIXTURE','Crypto fixture',[{accountId:offset,direction:'DEBIT',amount:'2000'},{accountId:stock,direction:'CREDIT',amount:'1000'},{accountId:own,direction:'CREDIT',amount:'1000'}])};});
 const offer=await core.registerCryptoOffer(admin,{stockAccountId:stock,proceedsAccount:source('1').abiq_iban,fiatCurrency:'EUR',unitPrice:'2'},key()),extra={paymentMethod:'CRYPTO',accountId:own,offerId:offer.id};
 const r=await review('BUY','2',extra),before=await balance(source('1').account_id);assert.equal(Number(r.instruction.cryptoAmount),490);await submit(r);assert.equal(Number(await balance(own)),510);assert.equal(Number(await balance(source('1').account_id)),Number(before)-980);await cancel(r.id);assert.equal(Number(await balance(own)),1000);assert.equal(await balance(source('1').account_id),before);
 const seller=await review('SELL','1'),buyer=await review('BUY','2',extra);await submit(seller);assert.equal((await submit(buyer)).status,'FILLED');assert.equal(Number(await balance(own)),510);assert.equal(Number(await balance(stock)),1490);assert.equal(await balance(source('1').account_id),before);
 // Receive proceeds into crypto: stock is reserved before matching and released on cancel.
 const sell=await review('SELL','2',extra);await submit(sell);assert.equal(Number(await balance(stock)),1000);await cancel(sell.id);assert.equal(Number(await balance(stock)),1490);
 const sell2=await review('SELL','2',extra),buy2=await review('BUY','1');await submit(sell2);assert.equal((await submit(buy2)).status,'FILLED');assert.equal(Number(await balance(own)),1000);assert.equal(Number(await balance(stock)),1000);
});
test('reserved securities cannot be overwritten and a changed crypto quote cannot silently execute',async()=>{
 const s=await review('SELL','1');await submit(s);const p=await position('1');await assert.rejects(core.recordPosition(admin,{userId:'1',securityId,quantity:'0',issuingPrice:'100',marketPrice:'98',version:p.version,reference:'Bad overwrite'},key()),/SECURITY_QUANTITY_RESERVED/);await cancel(s.id);
 const own=(await pool.query("SELECT account_id FROM avis_core_v2.ledger_accounts WHERE user_id=2 AND currency_code='AG' AND network='ETHEREUM'")).rows[0].account_id,offer=(await core.list(admin,'cryptooffers'))[0];
 const r=await review('BUY','2',{paymentMethod:'CRYPTO',accountId:own,offerId:offer.offer_id});await pool.query('UPDATE avis_core_v2.crypto_sale_offers SET unit_price=3 WHERE offer_id=$1',[offer.offer_id]);await assert.rejects(submit(r),/CRYPTO_PRICE_CHANGED/);
});
test('customer HTTP boundary permits own orders and denies other holdings, catalogue edits and other order details',async()=>{
 await core.bindCustomerLogin(admin,{fineractUserId:'101',userId:'2'},key());server=createBankServer({pool,secureCookies:false,authenticate:async()=>({id:'fineract:101',username:'fixture',admin:false})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const response=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'fixture',password:'fixture'})}),session=await response.json(),headers={cookie:response.headers.get('set-cookie').split(';')[0],origin:base,'content-type':'application/json','x-csrf-token':session.csrf};
 const call=async(path,body)=>{const r=await fetch(base+'/api/'+path,{headers:{...headers,'idempotency-key':key()},method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
 for(const path of ['portfolio/securities','portfolio/positions','portfolio/catalogue/sync'])assert.equal((await call(path,{})).status,403);
 assert.ok((await call('views/securitypositions')).body.rows.every(p=>String(p.user_id)==='2'));assert.ok((await call('views/securityorders')).body.rows.every(p=>String(p.user_id)==='2'));
 const other=await review('SELL','1');assert.equal((await call('portfolio/orders/'+other.id)).status,403);assert.equal((await call('portfolio/orders/cancel',{orderId:other.id})).status,403);
 const own=await call('portfolio/orders/review',body('BUY','2'));assert.equal(own.status,200);assert.equal((await call('portfolio/orders/submit',{orderId:own.body.id,reviewHash:own.body.reviewHash})).status,200);assert.equal((await call('portfolio/orders/cancel',{orderId:own.body.id})).status,200);
});
test('PostgreSQL concurrent submissions cannot sell the same units or debit a replay twice',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const seller=await review('SELL','1'),buyer=await review('BUY','2');await submit(seller);
 const before=Number(await balance(source('2').account_id)),payload={orderId:buyer.id,reviewHash:buyer.reviewHash};
 const results=await Promise.all([core.submitSecurityOrder(admin,payload,key()),core.submitSecurityOrder(admin,payload,key())]);
 assert.ok(results.every(r=>r.status==='FILLED'));assert.equal(Number(await balance(source('2').account_id)),before-980);
 assert.equal((await pool.query('SELECT count(*)::int AS count FROM avis_core_v2.portfolio_movements WHERE order_id=$1',[buyer.id])).rows[0].count,1);
});
