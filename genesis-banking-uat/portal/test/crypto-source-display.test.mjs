import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {JSDOM} from 'jsdom';
import {migrate} from '../src/migrate.mjs';
import {CryptoWorkspace} from '../src/crypto-workspace.mjs';
import {createCryptoWorkspace} from '../public/crypto-workspace.mjs';

let db,pool,core;
const admin={id:'crypto-source-display-test',admin:true};
const fixtures=[];

before(async()=>{
 if(process.env.TEST_DATABASE_URL){
  assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
 }else{
  db=new PGlite();
  pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release(){}})};
 }
 const connection=await pool.connect();
 try{await migrate(connection);}finally{connection.release();}
 core=new CryptoWorkspace(pool);
 const cards=await core.list(admin,'cryptosecurities');
 for(const [index,kind] of ['share','bond','fund'].entries()){
  const security=await core.addSecurity(admin,{
   name:'Registered '+kind+' source',shortName:kind.toUpperCase(),currency:'CHF',
   denomination:kind==='bond'?'1000':'1',quoteBasis:kind==='bond'?'PERCENT':'UNIT',kind
  },randomUUID());
  const position=await core.recordPosition(admin,{
   userId:'1',securityId:security.id,quantity:String(10+index),issuingPrice:'1',
   marketPrice:kind==='bond'?'100':'2',reference:'Isolated '+kind+' source fixture'
  },randomUUID());
  const assetType=kind==='share'?'STOCK':kind.toUpperCase();
  await pool.query(`UPDATE avis_core_v2.crypto_security_cards SET mode='REAL',
   security_id=$2,position_id=$3,user_id=1,dossier=dossier||$4::jsonb WHERE card_id=$1`,
   [cards[index].card_id,security.id,position.id,JSON.stringify({assetType})]);
  fixtures.push({kind,assetType,securityId:security.id,positionId:position.id,cardId:cards[index].card_id});
 }
});
after(async()=>{if(db)await db.close();else await pool.end();});

async function renderSource(card){
 const dom=new JSDOM('<!doctype html><body><main><div id="view"></div></main></body>',{url:'https://bank.invalid'});
 const oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
 let workspace;
 try{
  globalThis.document=dom.window.document;
  workspace=createCryptoWorkspace({
   api:async path=>{
    if(path==='views/cryptosecurities')return {rows:[card]};
    if(path.startsWith('views/'))return {rows:[]};
    if(path==='crypto/securities/'+card.card_id)return card;
    throw new Error('Unexpected read: '+path);
   },
   identity:()=>({admin:false,customerUserId:'1'}),purchase(){},sell(){},send(){},notice(){}
  });
  await workspace.mount(document.querySelector('#view'));
  const source=document.querySelector('.security-conversion > div');
  const values=Object.fromEntries([...source.querySelectorAll('dt')].map(label=>[label.textContent,label.nextElementSibling.textContent]));
  assert.equal(document.querySelector('[data-crypto-error]').textContent,'');
  return values;
 }finally{
  workspace?.close();dom.window.close();
  if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else delete globalThis.document;
 }
}

for(const kind of ['share','bond','fund'])test('converter preserves registered '+kind+' classification from Portfolio through the displayed source',async()=>{
 const fixture=fixtures.find(row=>row.kind===kind);
 const positionsBefore=await core.list(admin,'securitypositions');
 const journalsBefore=(await pool.query('SELECT * FROM avis_core_v2.ledger_journals ORDER BY journal_id')).rows;
 const position=positionsBefore.find(row=>row.position_id===fixture.positionId);
 assert.equal(position.kind,kind);
 assert.equal(position.account_role,'INSTITUTION');
 const card=await core.cryptoSecurityDetails(admin,{cardId:fixture.cardId});
 assert.equal(card.sourceHolding.positionId,fixture.positionId);
 assert.equal(card.sourceHolding.assetType,fixture.assetType);
 assert.equal(card.dossier.assetType,fixture.assetType);
 const visible=await renderSource(card);
 assert.equal(visible.Security,fixture.assetType);
 assert.equal(visible['Asset name'],position.name);
 assert.deepEqual(await core.list(admin,'securitypositions'),positionsBefore,'reading and rendering do not alter source holdings');
 assert.deepEqual((await pool.query('SELECT * FROM avis_core_v2.ledger_journals ORDER BY journal_id')).rows,journalsBefore);
});

test('a linked source position retains its identity when a second registered security has the same name',async()=>{
 const fixture=fixtures.find(row=>row.kind==='bond');
 const security=await core.addSecurity(admin,{
  name:'Registered bond source',shortName:'OTHER-SHARE',currency:'CHF',
  denomination:'1',quoteBasis:'UNIT',kind:'share'
 },randomUUID());
 await core.recordPosition(admin,{
  userId:'1',securityId:security.id,quantity:'999',issuingPrice:'1',marketPrice:'3',reference:'Separate same-name fixture'
 },randomUUID());
 const result=await core.cryptoSecurityDetails(admin,{cardId:fixture.cardId});
 assert.equal(result.sourceHolding.positionId,fixture.positionId);
 assert.equal(result.sourceHolding.assetType,'BOND');
 assert.equal(result.sourceHolding.quantity,'11.000000000000000000');
});
