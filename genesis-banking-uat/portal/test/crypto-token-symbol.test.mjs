import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {CryptoWorkspace} from '../src/crypto-workspace.mjs';

let pool,db,core,cards,positionId,addressId,chosen;
const admin={id:'token-symbol-fixture',admin:true},key=()=>randomUUID();
const codeFor=(cardId,dossier)=>'0x'+createHash('sha256').update(JSON.stringify({cardId,dossier,network:'ETHEREUM'})).digest('hex');
before(async()=>{
 if(process.env.TEST_DATABASE_URL){
  assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
 }else{
  db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release(){}})};
 }
 const connection=await pool.connect();try{await migrate(connection);}finally{connection.release();}
 core=new CryptoWorkspace(pool,{chain:{inspectAsset:async()=>({decimals:18})}});
 for(const assetId of ['avis-green','avis-green-investment'])await core.approveCrypto(admin,{assetId,network:'ETHEREUM',approved:true},key());
 const security=await core.addSecurity(admin,{name:'Registered symbol source',shortName:'SYMBOL',isin:'US0378331005',currency:'CHF',denomination:'1',quoteBasis:'UNIT',kind:'share'},key());
 positionId=(await core.recordPosition(admin,{userId:'1',securityId:security.id,quantity:'1000',issuingPrice:'1',marketPrice:'2',reference:'Isolated token-symbol source'},key())).id;
 addressId=(await pool.query("INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address) VALUES(1,'ETHEREUM',$1) RETURNING address_id",['0x'+'a'.repeat(40)])).rows[0].address_id;
 cards=await core.list(admin,'cryptosecurities');
});
after(async()=>{if(db)await db.close();else await pool.end();});
const input=(card,extra={})=>({cardId:card.card_id,positionId,addressId,network:'ETHEREUM',quantity:'20',tokenQuantity:'40',
 custodyReference:'Original registered source',marginHaircutBps:1500,tradingFeeBps:10,greenHighTechVerified:true,...extra});
async function state(){
 const tables={portfolio_positions:'position_id',crypto_security_cards:'card_id',ledger_accounts:'account_id',ledger_journals:'journal_id',user_deposit_addresses:'address_id',crypto_wallet_keys:'address_id'};
 return Object.fromEntries(await Promise.all(Object.entries(tables).map(async([table,order])=>[table,(await pool.query('SELECT * FROM avis_core_v2.'+table+' ORDER BY '+order)).rows])));
}

test('invalid chosen symbols reject before reserving source quantity or altering a security wallet',async()=>{
 const before=await state();
 for(const tokenSymbol of ['',null,12,'1TOKEN','_TOKEN','TOKEN NAME','TOKEN/CHF','A'.repeat(26),'€TOKEN']){
  await assert.rejects(core.prepareRealSecurity(admin,input(cards[1],{tokenSymbol}),key()),error=>error.code==='INVALID_FIELD'&&error.field==='tokenSymbol');
 }
 assert.deepEqual(await state(),before);
});

test('case-insensitive asset and other-card collisions preserve source reservations and card identity',async()=>{
 const before=await state();
 for(const tokenSymbol of ['ag','AGI','eTh','AAVISP',cards[2].symbol.toLowerCase()]){
  await assert.rejects(core.prepareRealSecurity(admin,input(cards[1],{tokenSymbol}),key()),error=>error.code==='DUPLICATE_RECORD'&&error.field==='tokenSymbol');
 }
 assert.deepEqual(await state(),before);
});

test('conversion retains a security wallet that was already created for the card',async()=>{
 const otherAddress=(await pool.query("INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address,is_primary) VALUES(1,'ETHEREUM',$1,false) RETURNING address_id",['0x'+'b'.repeat(40)])).rows[0].address_id;
 await pool.query("UPDATE avis_core_v2.crypto_security_cards SET user_id=1,network='ETHEREUM',wallet_address_id=$2 WHERE card_id=$1",[cards[6].card_id,addressId]);
 const before=await state();
 await assert.rejects(core.prepareRealSecurity(admin,input(cards[6],{tokenSymbol:'KEEP-WALLET',addressId:otherAddress}),key()),error=>error.code==='CRYPTO_DOSSIER_CHANGED'&&error.field==='addressId');
 assert.deepEqual(await state(),before,'another receiving address must not replace the created security wallet or reserve source units');
 const result=await core.prepareRealSecurity(admin,input(cards[6],{tokenSymbol:'KEEP-WALLET'}),key());
 const saved=(await core.list(admin,'cryptosecurities')).find(row=>row.card_id===cards[6].card_id);
 assert.equal(result.id,cards[6].card_id);assert.equal(String(saved.wallet_address_id),String(addressId));
 assert.equal(String(saved.user_id),'1');assert.equal(saved.network,'ETHEREUM');
});

test('chosen symbol replaces the neutral slot on preparation and is bound to the conversion dossier and replay',async()=>{
 const before=await state(),tokenSymbol='AVIS-Stock_2026.1',request=input(cards[1],{tokenSymbol}),requestKey=key();
 const result=await core.prepareRealSecurity(admin,request,requestKey);
 assert.equal(result.id,cards[1].card_id);assert.equal(result.symbol,tokenSymbol);assert.equal(result.dossier.tokenSymbol,tokenSymbol);
 assert.equal(result.conversionCode,codeFor(cards[1].card_id,result.dossier));
 assert.notEqual(result.conversionCode,codeFor(cards[1].card_id,{...result.dossier,tokenSymbol:'OTHER'}));
 const card=(await core.list(admin,'cryptosecurities')).find(row=>row.card_id===cards[1].card_id);
 assert.equal(card.symbol,tokenSymbol);assert.equal(card.mode,'REAL');assert.equal(card.state,'DRAFT');
 assert.equal(card.position_id,positionId);assert.equal(String(card.wallet_address_id),String(addressId));
 const position=(await core.list(admin,'securitypositions')).find(row=>row.position_id===positionId);
 assert.equal(position.quantity,'1000.000000000000000000');assert.equal(Number(position.reserved_quantity)-Number(before.portfolio_positions.find(row=>row.position_id===positionId).reserved_quantity),20);
 const after=await state();
 for(const name of ['ledger_accounts','ledger_journals','user_deposit_addresses','crypto_wallet_keys'])assert.deepEqual(after[name],before[name],name);
 assert.deepEqual(await core.prepareRealSecurity(admin,request,requestKey),result);
 assert.deepEqual(await state(),after,'replay must not rename, reserve again, or alter the selected wallet');
 chosen={symbol:tokenSymbol,card};
});

test('prepared and booked cards cannot be renamed, and their symbols remain reserved case-insensitively',async()=>{
 const before=await state();
 await assert.rejects(core.prepareRealSecurity(admin,input(cards[1],{tokenSymbol:'RENAMED'}),key()),/CRYPTO_DOSSIER_CHANGED/);
 await assert.rejects(core.prepareRealSecurity(admin,input(cards[2],{tokenSymbol:chosen.symbol.toUpperCase()}),key()),/DUPLICATE_RECORD/);
 assert.deepEqual(await state(),before);
 await pool.query("UPDATE avis_core_v2.crypto_security_cards SET state='BOOKED' WHERE card_id=$1",[cards[3].card_id]);
 const booked=await state();
 await assert.rejects(core.prepareRealSecurity(admin,input(cards[3],{tokenSymbol:'BOOKED-RENAME'}),key()),/CRYPTO_DOSSIER_CHANGED/);
 assert.deepEqual(await state(),booked);
});

test('omitting tokenSymbol preserves the established aAVISP symbol for existing callers',async()=>{
 const result=await core.prepareRealSecurity(admin,input(cards[0]),key());
 assert.equal(result.symbol,'aAVISP');assert.equal(result.dossier.tokenSymbol,'aAVISP');
 assert.equal((await core.list(admin,'cryptosecurities')).find(row=>row.card_id===cards[0].card_id).symbol,'aAVISP');
});

test('PostgreSQL concurrent preparations cannot claim the same symbol twice',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const before=(await core.list(admin,'securitypositions')).find(row=>row.position_id===positionId);
 const results=await Promise.allSettled([
  core.prepareRealSecurity(admin,input(cards[4],{tokenSymbol:'UNIQUE-SYMBOL'}),key()),
  core.prepareRealSecurity(admin,input(cards[5],{tokenSymbol:'unique-symbol'}),key())
 ]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 const rejected=results.find(result=>result.status==='rejected');assert.equal(rejected.reason.code,'DUPLICATE_RECORD');
 const after=(await core.list(admin,'securitypositions')).find(row=>row.position_id===positionId);
 assert.equal(Number(after.reserved_quantity)-Number(before.reserved_quantity),20);
 assert.equal((await pool.query("SELECT card_id FROM avis_core_v2.crypto_security_cards WHERE upper(symbol)='UNIQUE-SYMBOL'")).rows.length,1);
});
