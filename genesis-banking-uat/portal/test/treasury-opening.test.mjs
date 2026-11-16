import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {bookTreasuryOpening,readTreasuryOpening,TREASURY_POSITIONS} from '../src/treasury-opening.mjs';

let db,pool;
const env={CONTAINER_APP_NAME:'genesis-banking-uat',CONTAINER_APP_ENV_DNS_SUFFIX:'orangemushroom-9faae382.italynorth.azurecontainerapps.io',PGDATABASE:'fineract_default'};
before(async()=>{db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:s=>db.exec(s),release(){}})};const c=await pool.connect();await migrate(c);c.release();});
after(async()=>{await db.close();});
test('wrong UAT target cannot write positions',async()=>{
 await assert.rejects(bookTreasuryOpening(pool,{...env,PGDATABASE:'other'}),/TREASURY_TARGET_MISMATCH/);
 assert.equal((await readTreasuryOpening(pool)).length,0);
});
test('same owner gets exactly the four instructed opening positions once',async()=>{
 const receipt=await bookTreasuryOpening(pool,env);
 assert.equal(receipt.positions.length,4);
 const rows=await readTreasuryOpening(pool);
 for(const position of TREASURY_POSITIONS){
  const found=rows.find(r=>r.asset_code===position.assetCode);
  assert.ok(found);assert.equal(Number(found.quantity),Number(position.quantity));
  assert.equal(found.destination,position.destination);
 }
 assert.deepEqual(await bookTreasuryOpening(pool,env),receipt);
 assert.equal((await readTreasuryOpening(pool)).length,4);
});
test('records preserve existing asset quantities and no new issuance is invented',()=>{
 assert.deepEqual(TREASURY_POSITIONS.map(x=>x.quantity),['500000','100000000','10000000000','10000000000']);
 assert.ok(!TREASURY_POSITIONS.some(x=>x.quantity==='4500000'));
});
