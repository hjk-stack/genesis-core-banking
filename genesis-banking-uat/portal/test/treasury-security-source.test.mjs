import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {CryptoWorkspace} from '../src/crypto-workspace.mjs';
import {CustomerAccess} from '../src/customer-access.mjs';
import {createBankServer} from '../server.mjs';

let db,pool,core,server,first;
const admin={id:'treasury-source-fixture',admin:true};
const env={AVIS_WALLET_ENCRYPTION_KEY:'isolated-treasury-source-wallet-key-2026'};
const key=()=>randomUUID();
before(async()=>{
 if(process.env.TEST_DATABASE_URL){
  assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
 }else{
  db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release(){}})};
 }
 const connection=await pool.connect();try{await migrate(connection);}finally{connection.release();}
 core=new CryptoWorkspace(pool,{secretEnv:env,chain:{inspectAsset:async()=>({decimals:18})}});
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));if(db)await db.close();else await pool.end();});

async function source(extra={}){
 const row={owner:'1',assetClass:'SECURITY',assetCode:'SOURCE-'+key(),name:'Recorded institution security',isin:null,
  quantity:'100',destination:'TREASURY_PORTFOLIO',reference:'source-'+key(),...extra};
 return (await pool.query(`INSERT INTO avis_core_v2.treasury_opening_positions
  (source_system,source_reference,owner_user_id,asset_class,asset_code,asset_name,isin,quantity,destination,booking_reference,booked_by)
  VALUES('ISOLATED_SOURCE_FIXTURE',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
  [row.reference,row.owner,row.assetClass,row.assetCode,row.name,row.isin,row.quantity,row.destination,key(),admin.id])).rows[0];
}
async function security(extra={}){
 return core.addSecurity(admin,{name:'Registered source '+key(),shortName:'SOURCE',currency:'CHF',denomination:'1',quoteBasis:'UNIT',kind:'share',...extra},key());
}
const register=(booking,securityId,extra={},idempotencyKey=key())=>core.registerTreasurySecuritySource(admin,
 {bookingId:booking.booking_id,securityId,issuingPrice:'1.5',marketPrice:'2.5',...extra},idempotencyKey);
const position=async id=>(await pool.query('SELECT * FROM avis_core_v2.portfolio_positions WHERE position_id=$1',[id])).rows[0];
async function financialState(){
 const tables={ledger_accounts:'account_id',ledger_journals:'journal_id',ledger_entries:'entry_id',user_deposit_addresses:'address_id',crypto_wallet_keys:'address_id'};
 return Object.fromEntries(await Promise.all(Object.entries(tables).map(async([table,order])=>[table,(await pool.query('SELECT * FROM avis_core_v2.'+table+' ORDER BY '+order)).rows])));
}

test('source-link migration creates no inventory or Treasury entries',async()=>{
 assert.equal((await pool.query('SELECT * FROM avis_core_v2.portfolio_positions')).rows.length,0);
 assert.equal((await pool.query('SELECT * FROM avis_core_v2.treasury_opening_positions')).rows.length,0);
});

test('registering recorded Treasury inventory once preserves the original source and all wallet and ledger data',async()=>{
 const booking=await source({reference:'original-source-'+key()}),registered=await security();
 const before=await financialState(),requestKey=key();
 const result=await register(booking,registered.id,{quantity:'999',userId:'2'},requestKey);
 assert.equal(result.created,true);assert.equal(result.id,result.positionId);
 assert.equal(result.bookingId,booking.booking_id);assert.equal(result.securityId,registered.id);
 assert.equal(result.quantity,'100.000000000000000000');
 assert.equal(result.sourceReference,booking.source_reference);
 const row=await position(result.id);
 assert.equal(String(row.user_id),'1');assert.equal(row.treasury_booking_id,booking.booking_id);
 assert.equal(row.issuing_price,'1.500000000000000000');assert.equal(row.market_price,'2.500000000000000000');
 assert.equal(row.reserved_quantity,'0.000000000000000000');
 assert.deepEqual(await register(booking,registered.id,{quantity:'999',userId:'2'},requestKey),result);
 const repeated=await register(booking,registered.id,{issuingPrice:'90',marketPrice:'99'});
 assert.equal(repeated.id,result.id);assert.equal(repeated.created,false);
 assert.deepEqual(await position(result.id),row,'a new request key cannot reset the linked position');
 const movements=(await pool.query('SELECT * FROM avis_core_v2.portfolio_movements WHERE position_id=$1',[result.id])).rows;
 assert.equal(movements.length,1);assert.equal(movements[0].reference,booking.source_reference);
 assert.equal(movements[0].quantity_delta,'100.000000000000000000');
 assert.deepEqual((await pool.query('SELECT * FROM avis_core_v2.treasury_opening_positions WHERE booking_id=$1',[booking.booking_id])).rows[0],booking);
 assert.deepEqual(await financialState(),before);
 const view=(await core.list(admin,'treasurypositions')).find(row=>row.booking_id===booking.booking_id);
 assert.equal(view.position_id,result.id);assert.equal(view.security_id,registered.id);
 first={booking,securityId:registered.id,positionId:result.id};
});

test('an existing matching Portfolio holding is linked without replacing its prices, reserves or quantity',async()=>{
 const booking=await source({quantity:'80'}),registered=await security();
 const existing=await core.recordPosition(admin,{userId:'1',securityId:registered.id,quantity:'80',issuingPrice:'3',marketPrice:'4',reference:'Existing registered position'},key());
 await pool.query('UPDATE avis_core_v2.portfolio_positions SET reserved_quantity=12 WHERE position_id=$1',[existing.id]);
 const before=await position(existing.id),wallets=await financialState();
 const result=await register(booking,registered.id,{issuingPrice:'900',marketPrice:'999'});
 const after=await position(existing.id);
 assert.equal(result.id,existing.id);assert.equal(result.created,false);
 for(const field of ['user_id','security_id','quantity','reserved_quantity','issuing_price','market_price'])assert.equal(after[field],before[field],field);
 assert.equal(after.treasury_booking_id,booking.booking_id);
 const movements=(await pool.query('SELECT * FROM avis_core_v2.portfolio_movements WHERE position_id=$1 ORDER BY movement_id',[existing.id])).rows;
 assert.equal(movements.length,2);assert.equal(movements[1].quantity_delta,'0.000000000000000000');
 assert.equal(movements[1].reference,booking.source_reference);
 assert.deepEqual(await financialState(),wallets);
});

test('reopening an already-linked source preserves subsequent changes to the current holding',async()=>{
 await pool.query('UPDATE avis_core_v2.portfolio_positions SET quantity=70,reserved_quantity=20,issuing_price=5,market_price=7 WHERE position_id=$1',[first.positionId]);
 const before=await position(first.positionId);
 const movements=(await pool.query('SELECT * FROM avis_core_v2.portfolio_movements ORDER BY movement_id')).rows;
 const result=await core.registerTreasurySecuritySource(admin,{bookingId:first.booking.booking_id,securityId:first.securityId},key());
 assert.equal(result.quantity,'70.000000000000000000');assert.equal(result.created,false);
 assert.deepEqual(await position(first.positionId),before);
 assert.deepEqual((await pool.query('SELECT * FROM avis_core_v2.portfolio_movements ORDER BY movement_id')).rows,movements);
});

test('quantity mismatch, another source link and a different selected security cannot replace existing inventory',async()=>{
 const registered=await security(),booking=await source({quantity:'80'});
 const existing=await core.recordPosition(admin,{userId:'1',securityId:registered.id,quantity:'79',issuingPrice:'1',marketPrice:'2',reference:'Separate recorded quantity'},key());
 const before=await position(existing.id);
 await assert.rejects(register(booking,registered.id),/TREASURY_SECURITY_QUANTITY/);
 assert.deepEqual(await position(existing.id),before);
 await assert.rejects(register(first.booking,registered.id),/TREASURY_SECURITY_IDENTITY/);
 const otherSource=await source({quantity:'70'});
 await assert.rejects(register(otherSource,first.securityId),/TREASURY_SECURITY_LINKED/);
 assert.equal((await core.list(admin,'treasurypositions')).find(row=>row.booking_id===otherSource.booking_id).position_id,null);
});

test('registered source ISIN is enforced and missing metadata cannot be inferred from the converter example',async()=>{
 const booking=await source({isin:'US0378331005'}),withoutIsin=await security(),wrong=await security({isin:'US5949181045'}),matching=await security({isin:'US0378331005'});
 await assert.rejects(register(booking,withoutIsin.id),/TREASURY_SECURITY_IDENTITY/);
 await assert.rejects(register(booking,wrong.id),/TREASURY_SECURITY_IDENTITY/);
 await assert.rejects(register(booking,matching.id,{issuingPrice:undefined}),error=>error.code==='INVALID_AMOUNT'&&error.field==='issuingPrice');
 await assert.rejects(register(booking,matching.id,{marketPrice:undefined}),error=>error.code==='INVALID_AMOUNT'&&error.field==='marketPrice');
 assert.equal((await core.list(admin,'treasurypositions')).find(row=>row.booking_id===booking.booking_id).position_id,null);
 const result=await register(booking,matching.id);
 assert.equal((await core.list(admin,'securitypositions')).find(row=>row.position_id===result.id).isin,booking.isin);
});

test('customer actions, crypto openings and sources with the wrong owner are rejected without changes',async()=>{
 const registered=await security(),crypto=await source({assetClass:'CRYPTO',destination:'TREASURY_WALLET'}),customer=await source({owner:'2'});
 const before=await financialState(),positions=(await core.list(admin,'securitypositions'));
 await assert.rejects(register(crypto,registered.id),/TREASURY_SECURITY_SOURCE/);
 await assert.rejects(register(customer,registered.id),/TREASURY_SECURITY_SOURCE/);
 const input={bookingId:first.booking.booking_id,securityId:first.securityId,issuingPrice:'1',marketPrice:'2'};
 await assert.rejects(core.registerTreasurySecuritySource({id:'customer',admin:false,customerUserId:'2'},input,key()),/FORBIDDEN/);
 await assert.rejects(core.registerTreasurySecuritySource({id:'customer',admin:true,customerUserId:'2'},input,key()),/FORBIDDEN/);
 await assert.rejects(new CustomerAccess(core).invoke({id:'customer',admin:false,customerUserId:'2'},'registerTreasurySecuritySource',input,key()),/FORBIDDEN/);
 assert.deepEqual(await financialState(),before);assert.deepEqual(await core.list(admin,'securitypositions'),positions);
 const misowned=await source(),foreign=await core.recordPosition(admin,{userId:'2',securityId:registered.id,quantity:'100',issuingPrice:'1',marketPrice:'2',reference:'Foreign owner fixture'},key());
 await pool.query('UPDATE avis_core_v2.portfolio_positions SET treasury_booking_id=$2 WHERE position_id=$1',[foreign.id,misowned.booking_id]);
 const original=await position(foreign.id);
 await assert.rejects(register(misowned,registered.id),/TREASURY_SECURITY_IDENTITY/);
 assert.deepEqual(await position(foreign.id),original);
});


test('Treasury portfolio revision updates units, prices and security identity atomically with movement audit',async()=>{
 const booking=await source({name:'Registered corporate stock',quantity:'80'});
 const registered=await security({name:'Registered corporate stock',shortName:'CORP'});
 const opened=await register(booking,registered.id,{issuingPrice:'2',marketPrice:'3'});
 const originalBooking=(await pool.query('SELECT * FROM avis_core_v2.treasury_opening_positions WHERE booking_id=$1',[booking.booking_id])).rows[0];
 const before=await financialState(),version=(await position(opened.positionId)).version;
 const edit={bookingId:booking.booking_id,securityId:registered.id,version,
  quantity:'75',issuingPrice:'5',marketPrice:'14',name:'Corporate stock corrected',
  shortName:'CORP',isin:'',cusip:'',reference:'Board stock revision'};
 const updated=await core.editTreasurySecuritySource(admin,edit,key());
 assert.equal(updated.positionId,opened.positionId);assert.equal(updated.quantity,'75.000000000000000000');
 const p=await position(opened.positionId);assert.equal(p.issuing_price,'5.000000000000000000');
 assert.equal(p.market_price,'14.000000000000000000');assert.equal(p.version,version+1);
 const metadata=(await core.list(admin,'securities')).find(s=>s.security_id===registered.id);
 assert.equal(metadata.name,'Corporate stock corrected');
 const movement=(await pool.query('SELECT * FROM avis_core_v2.portfolio_movements WHERE position_id=$1 ORDER BY movement_id DESC LIMIT 1',[opened.positionId])).rows[0];
 assert.equal(movement.quantity_delta,'-5.000000000000000000');
 assert.equal(movement.reference,'Board stock revision');
 assert.deepEqual((await pool.query('SELECT * FROM avis_core_v2.treasury_opening_positions WHERE booking_id=$1',[booking.booking_id])).rows[0],originalBooking);
 assert.deepEqual(await financialState(),before,'securities registration never posts an unrelated cash or wallet ledger');
 await assert.rejects(core.editTreasurySecuritySource(admin,edit,key()),e=>e.code==='POSITION_CHANGED');
 await pool.query('UPDATE avis_core_v2.portfolio_positions SET reserved_quantity=50 WHERE position_id=$1',[opened.positionId]);
 await assert.rejects(core.editTreasurySecuritySource(admin,{...edit,version:p.version,quantity:'49'},key()),e=>e.code==='SECURITY_QUANTITY_RESERVED');
 assert.equal((await position(opened.positionId)).quantity,'75.000000000000000000');
});

test('long original source references remain intact in the immutable source and operation receipt',async()=>{
 const reference='ORIGINAL-'.repeat(17),booking=await source({reference}),registered=await security(),result=await register(booking,registered.id);
 assert.equal(result.sourceReference,reference);
 const receipt=(await pool.query("SELECT response FROM avis_core_v2.operation_requests WHERE operation='REGISTER_TREASURY_SECURITY_SOURCE' AND response->>'id'=$1",[result.id])).rows[0].response;
 assert.equal(receipt.sourceReference,reference);
 assert.equal((await pool.query('SELECT reference FROM avis_core_v2.portfolio_movements WHERE position_id=$1',[result.id])).rows[0].reference,'TREASURY:'+booking.booking_id);
});

test('the exact registered Treasury source becomes selectable for normal conversion without another booking',async()=>{
 const booking=await source({assetCode:'AVISPAY-PLC-SHARES',name:'AVISPay PLC shares',quantity:'120'});
 const registered=await security({name:'Owner-selected registered share',isin:'US9311421039'});
 const wrongKind=await security({kind:'fund'});
 await assert.rejects(register(booking,wrongKind.id),error=>error.code==='TREASURY_SECURITY_IDENTITY'&&error.field==='securityId');
 const card=(await core.list(admin,'cryptosecurities')).find(row=>row.symbol==='aAVISP');
 const fallback=await core.cryptoSecurityDetails(admin,{cardId:card.card_id});
 assert.equal(fallback.sourceHolding.bookingId,booking.booking_id);assert.equal(fallback.sourceHolding.positionId,null);
 const competing=await security({name:'AVISPay PLC'});
 await core.recordPosition(admin,{userId:'1',securityId:competing.id,quantity:'999',issuingPrice:'1',marketPrice:'10',reference:'Separate same-name security'},key());
 const result=await register(booking,registered.id);
 const details=await core.cryptoSecurityDetails(admin,{cardId:card.card_id});
 assert.equal(details.sourceHolding.positionId,result.id);assert.equal(details.sourceHolding.securityId,registered.id);
 assert.equal(details.sourceHolding.bookingId,booking.booking_id);assert.equal(details.sourceHolding.reference,booking.source_reference);
 assert.equal(details.sourceHolding.name,'Owner-selected registered share');assert.equal(details.sourceHolding.quantity,'120.000000000000000000');
 for(const assetId of ['avis-green','avis-green-investment'])await core.approveCrypto(admin,{assetId,network:'ETHEREUM',approved:true},key());
 const wallet=await core.createSecurityWallet(admin,{cardId:card.card_id,userId:'1',network:'ETHEREUM'},key());
 const before=await financialState();
 const converted=await core.prepareRealSecurity(admin,{cardId:card.card_id,positionId:result.id,addressId:wallet.address_id,network:'ETHEREUM',
  quantity:'40',tokenQuantity:'80',custodyReference:booking.source_reference,marginHaircutBps:1500,tradingFeeBps:10,greenHighTechVerified:true},key());
 assert.equal(converted.dossier.assetValue,'100.000000000000000000');assert.equal(converted.dossier.faceValue,'1.250000000000000000');
 const current=await position(result.id);
 assert.equal(current.quantity,'120.000000000000000000');assert.equal(current.reserved_quantity,'40.000000000000000000');
 assert.equal(current.treasury_booking_id,booking.booking_id);
 assert.deepEqual(await financialState(),before);
 assert.deepEqual((await pool.query('SELECT * FROM avis_core_v2.treasury_opening_positions WHERE booking_id=$1',[booking.booking_id])).rows[0],booking);
 const again=await register(booking,registered.id);
 assert.equal(again.id,result.id);assert.deepEqual(await position(result.id),current);
});

test('HTTP source registration is administrator-only and returns field-specific source errors',async()=>{
 await core.bindCustomerLogin(admin,{fineractUserId:'384',userId:'2'},key());
 server=createBankServer({pool,secureCookies:false,transferOptions:{secretEnv:env},
  authenticate:async username=>username==='operator'?{id:'source-http-admin',username,admin:true}:{id:'fineract:384',username,admin:false}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const login=async username=>{
  const response=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username,password:'fixture'})});
  assert.equal(response.status,200);const session=await response.json();
  return {origin:base,cookie:response.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':session.csrf,'idempotency-key':key()};
 };
 const body={bookingId:first.booking.booking_id,securityId:first.securityId,issuingPrice:'1',marketPrice:'2'};
 const customerHeaders=await login('customer');
 assert.equal((await fetch(base+'/api/portfolio/treasury-source',{method:'POST',headers:customerHeaders,body:JSON.stringify(body)})).status,403);
 const headers=await login('operator'),response=await fetch(base+'/api/portfolio/treasury-source',{method:'POST',headers,body:JSON.stringify(body)});
 assert.equal(response.status,200);assert.equal((await response.json()).positionId,first.positionId);
 const invalid=await fetch(base+'/api/portfolio/treasury-source',{method:'POST',headers:{...headers,'idempotency-key':key()},body:JSON.stringify({...body,bookingId:key()})});
 assert.equal(invalid.status,422);const issue=await invalid.json();assert.equal(issue.code,'TREASURY_SECURITY_SOURCE');assert.equal(issue.field,'bookingId');
});

test('PostgreSQL concurrent source requests create one linked holding and one source movement',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const booking=await source(),registered=await security();
 const results=await Promise.all([register(booking,registered.id),register(booking,registered.id)]);
 assert.equal(results[0].id,results[1].id);
 assert.equal(results.filter(result=>result.created).length,1);
 const rows=(await pool.query('SELECT * FROM avis_core_v2.portfolio_positions WHERE treasury_booking_id=$1',[booking.booking_id])).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].quantity,'100.000000000000000000');
 assert.equal((await pool.query('SELECT * FROM avis_core_v2.portfolio_movements WHERE position_id=$1',[rows[0].position_id])).rows.length,1);
});

test('Treasury booking registers a documented manual holding once, atomically, without cash or chain postings',async()=>{
 const registered=await security(),before=await financialState(),reference='Manual-custody-'+key();
 const input={sourceMode:'MANUAL',securityId:registered.id,userId:'1',quantity:'80',issuingPrice:'1.5',marketPrice:'2.5',reference};
 const requestKey=key(),result=await core.bookTreasurySecurity(admin,input,requestKey);
 const row=await position(result.positionId);
 assert.equal(row.treasury_booking_id,result.bookingId);assert.equal(row.quantity,'80.000000000000000000');
 assert.equal((await core.list(admin,'treasurypositions')).find(t=>t.booking_id===result.bookingId).source_system,'MANUAL_TREASURY');
 assert.deepEqual(await core.bookTreasurySecurity(admin,input,requestKey),result);
 await assert.rejects(core.bookTreasurySecurity(admin,input,key()),/TREASURY_SOURCE_ALREADY_BOOKED/);
 await assert.rejects(core.bookTreasurySecurity(admin,{...input,reference:'another-'+key()},key()),/TREASURY_SOURCE_ALREADY_BOOKED/);
 assert.deepEqual(await financialState(),before);
});
test('catalogue booking selects the registered instrument, not its issue volume, and existing source links remain immutable',async()=>{
 const registered=await security({kind:'bond',isin:'US5949181045',quoteBasis:'PERCENT',denomination:'1000'});
 await pool.query("UPDATE avis_core_v2.portfolio_securities SET source='GREEN_BOND' WHERE security_id=$1",[registered.id]);
 const before=await financialState(),input={sourceMode:'CATALOGUE',securityId:registered.id,userId:'1',quantity:'3',issuingPrice:'100',marketPrice:'99',reference:'Databank custody '+key()};
 const result=await core.bookTreasurySecurity(admin,input,key());
 assert.equal((await position(result.positionId)).quantity,'3.000000000000000000');
 assert.equal((await core.list(admin,'treasurypositions')).find(t=>t.booking_id===result.bookingId).source_system,'GREEN_BOND_CATALOGUE');
 const manual=await security();
 await assert.rejects(core.bookTreasurySecurity(admin,{...input,securityId:manual.id,reference:key()},key()),/TREASURY_SECURITY_IDENTITY/);
 await assert.rejects(core.bookTreasurySecurity({...admin,customerUserId:'1'},input,key()),/FORBIDDEN/);
 assert.deepEqual(await financialState(),before);
});
