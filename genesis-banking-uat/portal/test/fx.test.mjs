import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {FxBankingServer,fetchEcbRates} from '../src/fx.mjs';
let db,pool,core,user,treasury,seq=0;
const actor={id:'fx-tests',admin:true},key=()=>'fx-'+(++seq),eur=()=>user.accounts.find(a=>a.currency==='EUR'),usd=()=>user.accounts.find(a=>a.currency==='USD');
const balance=async id=>(await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[id])).rows[0].available_balance;
const quote=(amount='10')=>core.quoteFx(actor,{from:eur().abiqIban,to:usd().abiqIban,fromCurrency:'EUR',toCurrency:'USD',amount,commissionBps:100},key());
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else {db=new PGlite();pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),exec:s=>db.exec(s),release(){}})};}
 const c=await pool.connect();try{await migrate(c);}finally{c.release();}core=new FxBankingServer(pool);
 user=await core.openCustomer(actor,{fullName:'FX Customer',accountType:'PERSONAL',currencies:['EUR','USD']},key());
 treasury=await core.system(pool,'TREASURY','USD');
 for(const [currency,id,amount]of [['EUR',eur().accountId,'100'],['USD',treasury,'1000']]){
  const cash=await core.system(pool,'CORRESPONDENT_NOSTRO',currency,'FX_FIXTURE','ASSET');
  await core.post(pool,actor,key(),'FIXTURE_CASH','isolated test',[{accountId:cash,direction:'DEBIT',amount},{accountId:id,direction:'CREDIT',amount}]);
 }
 await pool.query("INSERT INTO avis_core_v2.fx_reference_rates(currency_code,units_per_eur,source,source_date) VALUES('EUR',1,'Isolated rate fixture',current_date),('USD',1.1,'Isolated rate fixture',current_date)");
});
after(async()=>{if(db)await db.close();else await pool.end();});
test('ECB adapter preserves decimal strings and source publication date',async()=>{
 const date=new Date().toISOString().slice(0,10),xml='<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01"><Cube><Cube time="'+date+'"><Cube currency="USD" rate="1.123456789012345678"/></Cube></Cube></gesmes:Envelope>';
 const r=await fetchEcbRates(async()=>({ok:true,text:async()=>xml}));assert.equal(r.rates[1].rate,'1.123456789012345678');assert.equal(r.date,date);
 await assert.rejects(fetchEcbRates(async()=>({ok:true,text:async()=>xml.replace(date,'2000-01-01')})),/FX_SOURCE_DATE/);
 await assert.rejects(fetchEcbRates(async()=>({ok:true,text:async()=>xml.replace('1.123456789012345678','-1')})),/INVALID_AMOUNT/);
});
test('quote reserves treasury liquidity; execution posts customer conversion and fees exactly once',async()=>{
 const q=await quote();assert.equal(q.to_amount,'10.890000');assert.equal(q.fee_amount,'0.100000');assert.equal(await balance(treasury),'989.110000000000000000');assert.equal(await balance(eur().accountId),'100.000000000000000000');
 const k=key(),r=await core.executeFx(actor,{quoteId:q.id},k);assert.equal(r.status,'EXECUTED');assert.deepEqual(await core.executeFx(actor,{quoteId:q.id},k),r);
 assert.equal(await balance(eur().accountId),'90.000000000000000000');assert.equal(await balance(usd().accountId),'10.890000000000000000');
 await assert.rejects(core.executeFx(actor,{quoteId:q.id},key()),/FX_QUOTE_CLOSED/);
});
test('expired and cancelled quotes return treasury funds once',async()=>{
 const before=await balance(treasury),q=await quote('20');await core.cancelFx(actor,{quoteId:q.id},key());assert.equal(await balance(treasury),before);
 const expired=await quote('20');await pool.query("UPDATE avis_core_v2.fx_quotes SET expires_at=now()-interval '1 second' WHERE quote_id=$1",[expired.id]);
 assert.equal((await core.executeFx(actor,{quoteId:expired.id},key())).status,'EXPIRED');assert.equal(await balance(treasury),before);assert.equal(await balance(eur().accountId),'90.000000000000000000');
});
test('insufficient source balance rolls back both currencies and permits reservation cancellation',async()=>{
 const q=await quote('100'),before=await balance(usd().accountId);await assert.rejects(core.executeFx(actor,{quoteId:q.id},key()),/INSUFFICIENT_FUNDS/);assert.equal(await balance(usd().accountId),before);await core.cancelFx(actor,{quoteId:q.id},key());
 await assert.rejects(quote('1000'),/FX_LIQUIDITY_REQUIRED/);
});
test('FX journals balance separately in each currency and fees remain exact',async()=>{
 const bad=(await pool.query("SELECT e.journal_id,a.currency_code FROM avis_core_v2.ledger_entries e JOIN avis_core_v2.ledger_accounts a USING(account_id) GROUP BY e.journal_id,a.currency_code HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END)<>0")).rows;assert.equal(bad.length,0);
 const fees=(await pool.query("SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE owner_type='REVENUE' AND sub_account_code='FX_FEES'")).rows[0];assert.equal(fees.available_balance,'0.100000000000000000');
});
test('PostgreSQL concurrent quotes cannot reserve treasury inventory twice',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const results=await Promise.allSettled([quote('700'),quote('700')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 for(const r of results)if(r.status==='fulfilled')await core.cancelFx(actor,{quoteId:r.value.id},key());
});
