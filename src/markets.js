'use strict';
const {randomUUID}=require('node:crypto');
const MAX=9223372036854775807n;
function amount(v){if(typeof v!=='string'||!/^[1-9][0-9]*$/.test(v)||BigInt(v)>MAX)throw Error('INVALID_AMOUNT');return BigInt(v)}
function reference(v){if(typeof v!=='string'||!/^[A-Za-z0-9_.:-]{2,80}$/.test(v))throw Error('INVALID_REFERENCE');return v}
function accountId(v){if(typeof v!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))throw Error('INVALID_ACCOUNT');return v}
function actor(a,role){if(!a||a.authorized!==true||a.role!==role||!a.id)throw Error('UNAUTHORIZED')}
function validateOrder(o,policy){
 if(!o||!['equity','bond','future','option'].includes(o.assetClass)||!['buy','sell'].includes(o.side)||o.type!=='limit')throw Error('INVALID_ORDER');
 accountId(o.custodyAccountId);reference(o.instrument);reference(o.venue);reference(o.clientOrderId);
 const q=amount(o.quantityAtomic),p=amount(o.priceAtomic),cap=amount(policy?.maxNotionalAtomic);
 if(q*p>cap)throw Error('RISK_NOTIONAL_LIMIT');
 if(!policy.venueApproved||!policy.instrumentApproved||!policy.customerApproved)throw Error('RISK_POLICY_DENIED');
 if(['future','option'].includes(o.assetClass)&&policy.derivativesAuthorized!==true)throw Error('DERIVATIVES_NOT_AUTHORIZED');
 return true;
}
function validateDerivative(d){
 if(!d||!['future','option','forward','swap'].includes(d.kind))throw Error('INVALID_DERIVATIVE');
 accountId(d.custodyAccountId);reference(d.underlying);reference(d.contractReference);reference(d.settlementAsset);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(d.expiryDate)||Number.isNaN(Date.parse(d.expiryDate+'T00:00:00Z')))throw Error('INVALID_EXPIRY');
 if(d.kind==='option'?!['call','put'].includes(d.optionRight):d.optionRight!=null)throw Error('INVALID_OPTION_RIGHT');
 return true;
}
async function draftOrder(db,a,o,policy){
 actor(a,'trader');validateOrder(o,policy);
 const result=await db.query("INSERT INTO banking.market_orders(id,custody_account_id,asset_class,venue,instrument,side,quantity_atomic,price_atomic,client_order_id,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10) ON CONFLICT(client_order_id) DO UPDATE SET client_order_id=EXCLUDED.client_order_id RETURNING id,status",[randomUUID(),o.custodyAccountId,o.assetClass,o.venue,o.instrument,o.side,o.quantityAtomic,o.priceAtomic,o.clientOrderId,a.id]);
 return result.rows[0];
}
async function requestCustody(db,a,input){
 actor(a,'custody_operator');accountId(input.customerId);reference(input.provider);reference(input.externalReference);
 const result=await db.query("INSERT INTO banking.custody_accounts(id,customer_id,provider,external_reference,status,created_by) VALUES($1,$2,$3,$4,'pending_review',$5) ON CONFLICT(provider,external_reference) DO UPDATE SET external_reference=EXCLUDED.external_reference RETURNING id,status",[randomUUID(),input.customerId,input.provider,input.externalReference,a.id]);
 return result.rows[0];
}
module.exports={amount,reference,accountId,validateOrder,validateDerivative,draftOrder,requestCustody};
