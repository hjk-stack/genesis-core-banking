import {fault,text} from './core.mjs';

const known=id=>typeof id==='string'&&/^(?:[0-9]{2}[A-Z]{2}CON[A-Z0-9]{2,21}|SH[A-F0-9]{20})$/.test(id)&&id.length<=32;
function context(input){
 const id=input?.terminalId;
 if(!known(id))fault('POS_TERMINAL_ID','terminalId');
 const checkoutKind=id.startsWith('SH')?'SHOP':'MILESTONE';
 const reference=text(input.reference,'reference',120),title=text(input.title,'title',160);
 if(input.checkoutKind!==checkoutKind)fault('POS_TERMINAL_ID','checkoutKind');
 return {id,checkoutKind,reference,title};
}
const rowSql=`SELECT c.terminal_id,c.checkout_kind,c.checkout_reference,c.checkout_title,c.state,
 c.requested_at,c.approved_at,c.updated_at,t.merchant_id,t.terminal_type,t.status AS terminal_status
 FROM avis_core_v2.checkout_pos_controls c
 JOIN avis_core_v2.pos_terminals t USING(terminal_id) WHERE c.terminal_id=$1`;
const project=r=>({
 terminalId:r.terminal_id,checkoutKind:r.checkout_kind,reference:r.checkout_reference,
 title:r.checkout_title,state:r.terminal_status==='ACTIVE'?r.state:'CLOSED',
 requestedAt:r.requested_at,approvedAt:r.approved_at,updatedAt:r.updated_at
});
export class CheckoutPosControl{
 constructor(pool){this.pool=pool;}
 async withTransaction(work){
  const db=await this.pool.connect();
  try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result}
  catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
 }
 async ensure(db,input){
  const c=context(input);
  const merchant=(await db.query("SELECT merchant_id FROM avis_core_v2.marketplace_merchants WHERE merchant_id='AVISPAY-WEB-POS' AND status='ACTIVE'")).rows[0];
  if(!merchant)fault('POS_MERCHANT_REQUIRED',null,409);
  await db.query(`INSERT INTO avis_core_v2.pos_terminals(terminal_id,merchant_id,terminal_type)
    VALUES($1,$2,'WEB_POS') ON CONFLICT DO NOTHING`,[c.id,merchant.merchant_id]);
  const existing=(await db.query('SELECT terminal_type,merchant_id FROM avis_core_v2.pos_terminals WHERE terminal_id=$1 FOR UPDATE',[c.id])).rows[0];
  if(!existing||existing.terminal_type!=='WEB_POS'||existing.merchant_id!==merchant.merchant_id)fault('POS_TERMINAL_CONFLICT',null,409);
  await db.query(`INSERT INTO avis_core_v2.checkout_pos_controls(terminal_id,checkout_kind,checkout_reference,checkout_title)
   VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[c.id,c.checkoutKind,c.reference,c.title]);
  let control=(await db.query(rowSql+' FOR UPDATE OF c',[c.id])).rows[0];
  if(!control)fault('POS_TERMINAL_CONFLICT',null,409);
  // A bank operator may have registered the terminal ID before the first
  // checkout opened. Bind that placeholder once to the authoritative package.
  if(control.checkout_kind==='REGISTERED'&&control.checkout_reference===c.id){
   await db.query(`UPDATE avis_core_v2.checkout_pos_controls SET
    checkout_kind=$2,checkout_reference=$3,checkout_title=$4,updated_at=now() WHERE terminal_id=$1`,
    [c.id,c.checkoutKind,c.reference,c.title]);
  }else{
   if(control.checkout_kind!==c.checkoutKind||control.checkout_reference!==c.reference)fault('POS_TERMINAL_CONFLICT',null,409);
   // Product titles can change without moving the terminal to another invoice.
   if(control.checkout_title!==c.title)await db.query(`UPDATE avis_core_v2.checkout_pos_controls
    SET checkout_title=$2,updated_at=now() WHERE terminal_id=$1`,[c.id,c.title]);
  }
  control=(await db.query(rowSql,[c.id])).rows[0];
  return control;
 }
 async resolve(_actor,input){
  return this.withTransaction(async db=>project(await this.ensure(db,input)));
 }
 async status(_actor,input){
  const id=input?.terminalId;if(!known(id))fault('POS_TERMINAL_ID','terminalId');
  const result=(await this.pool.query(rowSql,[id])).rows[0];
  if(!result)fault('TERMINAL_NOT_FOUND','terminalId',404);
  return project(result);
 }
 async request(actor,input){
  const current=await this.withTransaction(async db=>{
   let row=await this.ensure(db,input);
   if(row.terminal_status!=='ACTIVE')fault('TERMINAL_NOT_FOUND','terminalId',409);
   if(row.state==='CLOSED'){
    await db.query(`UPDATE avis_core_v2.checkout_pos_controls
     SET state='REQUESTED',requested_at=now(),approved_at=NULL,updated_at=now(),changed_by=$2 WHERE terminal_id=$1`,[row.terminal_id,actor.id]);
    await db.query(`INSERT INTO avis_core_v2.checkout_pos_events(terminal_id,event_type,actor_id) VALUES($1,'REQUEST',$2)`,[row.terminal_id,actor.id]);
   }
   row=(await db.query(rowSql,[row.terminal_id])).rows[0];
   return project(row);
  });
  return current;
 }
 async setActive(actor,input){
  if(!actor?.admin||actor.customerUserId)fault('FORBIDDEN',null,403);
  const id=input?.terminalId;if(typeof id!=='string'||id.length>32||!(/^[A-Z0-9-]{3,32}$/).test(id))fault('POS_TERMINAL_ID','terminalId');
  if(typeof input.active!=='boolean')fault('INVALID_FIELD','active');
  return this.withTransaction(async db=>{
   const terminal=(await db.query(`SELECT terminal_id,terminal_type,merchant_id,status FROM avis_core_v2.pos_terminals
    WHERE terminal_id=$1 FOR UPDATE`,[id])).rows[0];
   if(!terminal||terminal.terminal_type!=='WEB_POS'||terminal.status!=='ACTIVE')fault('TERMINAL_NOT_FOUND','terminalId',404);
   await db.query(`INSERT INTO avis_core_v2.checkout_pos_controls
    (terminal_id,checkout_kind,checkout_reference,checkout_title)
    VALUES($1,'REGISTERED',$1,$1) ON CONFLICT DO NOTHING`,[id]);
   let current=(await db.query(rowSql+' FOR UPDATE OF c',[id])).rows[0];
   const target=input.active?'ACTIVE':'CLOSED';
   if(current.state!==target){
    await db.query(`UPDATE avis_core_v2.checkout_pos_controls
      SET state=$2,approved_at=CASE WHEN $2='ACTIVE' THEN now() ELSE NULL END,
      requested_at=CASE WHEN $2='CLOSED' THEN NULL ELSE requested_at END,
      updated_at=now(),changed_by=$3 WHERE terminal_id=$1`,[id,target,actor.id]);
    await db.query(`INSERT INTO avis_core_v2.checkout_pos_events(terminal_id,event_type,actor_id)
      VALUES($1,$2,$3)`,[id,target==='ACTIVE'?'APPROVE':'CLOSE',actor.id]);
   }
   current=(await db.query(rowSql,[id])).rows[0];
   return project(current);
  });
 }
}
