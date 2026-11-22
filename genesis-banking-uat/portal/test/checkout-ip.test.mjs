import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {PaymentServer} from '../src/payments.mjs';
import {CheckoutIpControl} from '../src/checkout-ip.mjs';
import {checkoutIpRegister,ipState} from '../public/checkout-ip.mjs';
let pool,db,ip,accounts,nostro,intermediaryId;
const admin={id:'ip-test-admin',admin:true},guest={id:'ip-guest',admin:false},service={id:'service:avis-land-checkout',posService:true};
const id=()=>randomUUID(),request=()=>({requestId:id(),checkoutKind:'MILESTONE',checkoutReference:'AVIS-TN-2026-01',title:'Tunisia milestone',
 source:'industrial',amount:'150.00',currency:'EUR',bankName:'Sending Bank',ip:'192.0.2.14',authorized:'Operator Smith',
 account:'SENDER-ACCT-123',accountName:'Sender Holdings Limited',documents:['authority.pdf']});
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};}
 const conn=await pool.connect();try{await migrate(conn)}finally{conn.release()}
 ip=new CheckoutIpControl(pool);const c=new AccountManagement(pool);
 const a=await c.openAccount(admin,{accountType:'COMMON',fullName:'NOSTRO common',currencies:['EUR']},id());
 const b=await c.openAccount(admin,{accountType:'SUSPENSE',fullName:'NOSTRO suspense',currencies:['EUR']},id());
 accounts={common:a.id,suspense:b.id};
 const p=new PaymentServer(pool);
 nostro=await p.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Registered NOSTRO',
  bic:'CHASUS33XXX',accountNumber:'NOSTRO-123',currency:'EUR',bankAddress:'London, UK',
  accountName:'AVISPay PLC',reference:'BANK-1',intermediary:{bankName:'Receiving Intermediary',
   bankAddress:'London, UK',accountName:'AVISPay PLC transit',reference:'INT-1'}},id());
 intermediaryId=nostro.intermediaryId;
});
after(async()=>{if(db)await db.close();else await pool.end()});
test('checkout IP request remains request-only, idempotent and scoped to one checkout',async()=>{
 const payload=request(),ledger=(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries')).rows[0].n;
 await assert.rejects(ip.register(guest,payload),e=>e.code==='FORBIDDEN');
 const first=await ip.register(service,payload);
 assert.equal(first.status,'REQUESTED');assert.ok(first.requestedAt);
 assert.equal(new Date(first.expiresAt).getTime()-new Date(first.requestedAt).getTime(),3600000);
 assert.deepEqual(await ip.register(service,payload),first);
 await assert.rejects(ip.register(service,{...payload,amount:'200.00'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.checkout_ip_events')).rows[0].n,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries')).rows[0].n,ledger);
 const status=await ip.status(service,{requestId:payload.requestId});
 assert.equal(status.status,'REQUESTED');assert.equal(status.receivingAccountId,undefined);
 const admins=await ip.accounts(admin);
 assert.equal(admins.length,2);assert.deepEqual(new Set(admins.map(x=>x.owner_type)),new Set(['COMMON_POOL','SUSPENSE_INBOUND']));
 assert.match(checkoutIpRegister(await ip.list(admin),admins,[]),/Liquid Glass access/);
 assert.equal(ipState(status),'REQUESTED');
 await assert.rejects(ip.list(guest),e=>e.code==='FORBIDDEN');
});
test('admin matches ABIQ Common/Suspense, NOSTRO and actual linked intermediary with no ledger movement',async()=>{
 const payload=request();await ip.register(service,payload);
 const before=(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries')).rows[0].n;
 await assert.rejects(ip.setActive(guest,{requestId:payload.requestId,active:true,receivingAccountId:accounts.common}),e=>e.code==='FORBIDDEN');
 await assert.rejects(ip.setActive(admin,{requestId:payload.requestId,active:true,receivingAccountId:id()}),e=>e.code==='CHECKOUT_IP_ACCOUNT');
 await assert.rejects(ip.setActive(admin,{requestId:payload.requestId,active:true,receivingAccountId:accounts.common,
  nostroCashAccountId:nostro.id,intermediaryId:id()}),e=>e.code==='CHECKOUT_IP_ACCOUNT');
 const approved=await ip.setActive(admin,{requestId:payload.requestId,active:true,receivingAccountId:accounts.common,
  nostroCashAccountId:nostro.id,intermediaryId});
 assert.equal(approved.status,'ACTIVE');assert.ok(approved.approvedAt);
 assert.equal(approved.receivingAccountId,accounts.common);
 assert.equal(approved.intermediaryId,intermediaryId);
 assert.equal((await ip.status(service,{requestId:payload.requestId})).status,'ACTIVE');
 await assert.rejects(ip.setActive(admin,{requestId:payload.requestId,active:true,receivingAccountId:accounts.suspense}),
  e=>e.code==='CHECKOUT_IP_STATE');
 const closed=await ip.setActive(admin,{requestId:payload.requestId,active:false});
 assert.equal(closed.status,'CLOSED');assert.equal((await ip.status(service,{requestId:payload.requestId})).status,'CLOSED');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries')).rows[0].n,before);
 assert.deepEqual((await pool.query('SELECT event_type FROM avis_core_v2.checkout_ip_events WHERE request_id=$1 ORDER BY event_id',[payload.requestId])).rows.map(x=>x.event_type),['REQUEST','APPROVE','CLOSE']);
});
test('unapproved request expires at 60 minutes with immutable audit and cannot be activated',async()=>{
 const payload=request();await ip.register(service,payload);
 await pool.query("UPDATE avis_core_v2.checkout_ip_requests SET expires_at=now()-interval '1 minute' WHERE request_id=$1",[payload.requestId]);
 assert.equal((await ip.status(service,{requestId:payload.requestId})).status,'CLOSED');
 assert.equal(await ip.expire(),0);
 await assert.rejects(ip.setActive(admin,{requestId:payload.requestId,active:true,receivingAccountId:accounts.common}),e=>e.code==='CHECKOUT_IP_STATE');
 assert.deepEqual((await pool.query('SELECT event_type FROM avis_core_v2.checkout_ip_events WHERE request_id=$1 ORDER BY event_id',[payload.requestId])).rows.map(x=>x.event_type),['REQUEST','EXPIRE']);
 await assert.rejects(pool.query('DELETE FROM avis_core_v2.checkout_ip_events WHERE request_id=$1',[payload.requestId]),/APPEND_ONLY_RECORD/);
});
