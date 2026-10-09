'use strict';
// Draft-only crypto transfer registration. NEVER signs, stores keys, or broadcasts.
const {randomUUID}=require('node:crypto');
const {amount,accountId,reference}=require('./markets');
function validateAsset(t){
 if(!t||!/^[a-z][a-z0-9_-]{1,31}$/.test(t.network||'')||!/^[A-Z0-9]{2,16}$/.test(t.symbol||'')||!Number.isInteger(t.decimals)||t.decimals<0||t.decimals>30)throw Error('INVALID_ASSET');
 return true;
}
function validateTransfer(t){
 validateAsset(t);accountId(t.custodyAccountId);amount(t.amountAtomic);reference(t.idempotencyKey);
 if(typeof t.address!=='string'||t.address.length<4||t.address.length>256||/\s/.test(t.address))throw Error('INVALID_ADDRESS');
 // A dedicated, independently approved chain adapter must validate real addresses.
 return true;
}
async function draftTransfer(db,a,t){
 if(!a||a.authorized!==true||a.role!=='custody_operator'||!a.id)throw Error('UNAUTHORIZED');
 validateTransfer(t);
 const r=await db.query("INSERT INTO banking.crypto_transfer_drafts(id,custody_account_id,network,symbol,amount_atomic,destination_address,idempotency_key,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8) ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id,status",[randomUUID(),t.custodyAccountId,t.network,t.symbol,t.amountAtomic,t.address,t.idempotencyKey,a.id]);
 return r.rows[0];
}
module.exports={validateAsset,validateTransfer,draftTransfer};
