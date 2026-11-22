import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {parseAbiqIban} from '../src/avispay-core-accounts.mjs';

test('cleanup classifies generic accounts by cash, reservations and securities and audits deletions',async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db);
 const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
 async function legacy(name,scope,balance){
  await db.query('BEGIN');
  const {account_id:id}=await one(`INSERT INTO avis_core_v2.ledger_accounts
   (user_id,owner_type,sub_account_code,currency_code,wallet_scope,account_category,locked_balance)
   VALUES(2,'USER',$1,'EUR',$2,'LIABILITY',$3) RETURNING account_id`,[name,scope,balance]);
  await db.query('SELECT avis_core_v2.ensure_ledger_abiq_serial($1)',[id]);await db.query('COMMIT');return id;
 }
 const empty=await legacy('EMPTY','MARGIN',0),reserved=await legacy('RESERVED','MARGIN',4),custody=await legacy('SECURITIES','CUSTODY',0);
 async function position(name,kind){
  const {security_id:id}=await one(`INSERT INTO avis_core_v2.portfolio_securities
   (name,short_name,currency_code,denomination,quote_basis,kind,source,created_by)
   VALUES($1,$1,'EUR',1,'UNIT',$2,'MANUAL','fixture') RETURNING security_id`,[name,kind]);
  await db.query('INSERT INTO avis_core_v2.portfolio_positions(user_id,security_id,quantity,issuing_price,market_price) VALUES(2,$1,3,1,1)',[id]);
 }
 await position('Token fixture','token');
 assert.equal(await one('SELECT identifier FROM avis_core_v2.portfolio_abiq_accounts WHERE user_id=2'),undefined);
 await position('Stock fixture','share');await position('Bond fixture','bond');
 const identifiers=await db.query('SELECT identifier FROM avis_core_v2.portfolio_abiq_accounts WHERE user_id=2');
 assert.equal(identifiers.rows.length,1);assert.equal(parseAbiqIban(identifiers.rows[0].identifier).currency,'579');
 const action=async id=>(await one('SELECT action FROM avis_core_v2.legacy_account_review WHERE account_id=$1',[id])).action;
 assert.equal(await action(empty),'DELETE');assert.equal(await action(reserved),'RENUMBER');assert.equal(await action(custody),'RENUMBER');
 const repair=(id,act)=>one("SELECT avis_core_v2.repair_legacy_account($1,$2,'fixture') AS id",[id,act]);
 await assert.rejects(repair(reserved,'DELETE'),/ACCOUNT_REVIEW_CHANGED/);
 assert.equal(parseAbiqIban((await repair(reserved,'RENUMBER')).id).currency,'EUR');
 assert.equal(parseAbiqIban((await repair(custody,'RENUMBER')).id).currency,'579');
 assert.equal(Number((await one('SELECT locked_balance FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[reserved])).locked_balance),4);
 await repair(empty,'DELETE');
 assert.equal(await one('SELECT account_id FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[empty]),undefined);
 const archive=await one('SELECT ledger_snapshot,registry_snapshot FROM avis_core_v2.legacy_account_cleanup WHERE account_id=$1',[empty]);
 assert.equal(archive.ledger_snapshot.account_id,empty);assert.equal(archive.registry_snapshot.ledger_account_id,empty);
 await assert.rejects(repair(empty,'DELETE'),/ACCOUNT_REVIEW_CHANGED/);
});
