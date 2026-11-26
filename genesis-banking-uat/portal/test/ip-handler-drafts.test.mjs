import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {migrate} from '../src/migrate.mjs';
import {TransferMethods} from '../src/transfer-methods.mjs';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {registerHandlerDraft,handlerDraftPdf} from '../src/ip-handler-drafts.mjs';

test('Payment Register keeps one versioned draft and returns its PDF only to an administrator',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await migrate(db);
 const handler={ipHandlerService:true,id:'handler'},admin={admin:true,id:'admin'};
 const bytes=Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
 const input={transferId:randomUUID(),registerNumber:'IP-00000001',revision:1,savedAt:new Date().toISOString(),
  beneficiary:'',account:'',amount:'',currency:'',pdf:bytes.toString('base64')};
 await assert.rejects(registerHandlerDraft(db,admin,input),e=>e.code==='FORBIDDEN');
 const first=await registerHandlerDraft(db,handler,input);
 assert.deepEqual(await registerHandlerDraft(db,handler,input),first);
 await assert.rejects(registerHandlerDraft(db,handler,{...input,currency:'EUR'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 const updated={...input,revision:2,beneficiary:'Supplier',amount:'10.'};
 await registerHandlerDraft(db,handler,updated);
 assert.equal((await registerHandlerDraft(db,handler,input)).revision,2);
 const rows=(await db.query('SELECT register_number,beneficiary,amount_text FROM avis_core_v2.ip_handler_drafts')).rows;
 assert.deepEqual(rows,[{register_number:input.registerNumber,beneficiary:'Supplier',amount_text:'10.'}]);
 const register=new TransferMethods(db);
 const listed=(await register.list(admin,'paymentregister')).filter(r=>r.request_id===input.transferId);
 assert.equal(listed.length,1);assert.equal(listed[0].payment_reference,input.registerNumber);
 assert.equal(listed[0].record_type,'IP_HANDLER_DRAFT');assert.equal(listed[0].amount,'10.');
 assert.equal((await register.list(admin,'transferrequests')).some(r=>r.request_id===input.transferId),false);
 await assert.rejects(handlerDraftPdf(db,handler,input.transferId),e=>e.code==='FORBIDDEN');
 assert.deepEqual((await handlerDraftPdf(db,admin,input.transferId)).bytes,bytes);
});
