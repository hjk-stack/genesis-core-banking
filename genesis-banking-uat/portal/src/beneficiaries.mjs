import {fault,text} from './core.mjs';
import {normalizeIban} from './avispay-correspondent-mapping.mjs';
import {isAbiqIdentifier,parseAbiqIban,resolveAbiqAccount,ABIQ_ISSUER} from './avispay-core-accounts.mjs';

export function receivingBic(value){
 const bic=text(value,'receiverBic',11).toUpperCase();
 if(!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic))fault('INVALID_RECEIVER_BIC','receiverBic');
 return bic.length===8?bic+'XXX':bic;
}
export function receivingAccount(value){
 const raw=text(value,'receiverAccount',40).replace(/\s/g,'').toUpperCase();
 try{
  if(isAbiqIdentifier(raw))return {number:parseAbiqIban(raw).identifier,type:'ABIQ'};
  if(/^\d{1,34}$/.test(raw))return {number:raw,type:'LOCAL'};
  return {number:normalizeIban(raw),type:'IBAN'};
 }catch{fault('INVALID_RECEIVER_ACCOUNT','receiverAccount');}
}
export function postalAddress(input){
 if(!input||typeof input!=='object'||Array.isArray(input))fault('INVALID_FIELD','street');
 const address={street:text(input.street,'street',70),city:text(input.city,'city',35),
  postalCode:input.postalCode?text(input.postalCode,'postalCode',16):'',country:text(input.country,'country',2).toUpperCase()};
 if(!/^[A-Z]{2}$/.test(address.country))fault('INVALID_FIELD','country');
 return address;
}

// SwiftRef validates bank/account identifiers. Beneficiary names and residential
// addresses come from the actor's saved payees or the bank's own holder records.
export async function checkBeneficiary(db,actor,input,{env=process.env,fetcher=fetch}={}){
 if(!actor?.admin)fault('FORBIDDEN',null,403);
 const account=receivingAccount(input.receiverAccount);
 let source='FORMAT',holder=null,expectedBic=ABIQ_ISSUER.abiqCode;
 // The 12-digit domestic account is accepted as well as the complete ABIQ identifier.
 if(account.type==='LOCAL'&&/^\d{12}$/.test(account.number)&&(!input.receiverBic||receivingBic(input.receiverBic)===expectedBic)){
  const local=(await db.query(`SELECT b.abiq_iban FROM avis_core_v2.abiq_routing_bridge b WHERE right(b.abiq_iban,12)=$1 AND b.participant_code='AVIP' AND length(b.abiq_iban)=26 AND b.status='ACTIVE'`,[account.number])).rows[0];
  if(local){account.number=local.abiq_iban;account.type='ABIQ';}
 }
 if(account.type==='IBAN'){
  holder=await resolveAbiqAccount(db,{identifier:account.number,currency:input.currency});
  if(holder)expectedBic=(await db.query('SELECT bank_bic FROM avis_core_v2.abiq_bank_routes WHERE bridge_id=$1',[holder.bridge_id])).rows[0].bank_bic;
 }
 const bic=receivingBic(input.receiverBic||((account.type==='ABIQ'||holder)?expectedBic:''));
 if(account.type==='ABIQ'){
  if(bic!==expectedBic)fault('RECEIVER_BIC_MISMATCH','receiverBic');
  holder=await resolveAbiqAccount(db,{identifier:account.number,currency:input.currency});
  if(!holder)fault('ACCOUNT_NOT_FOUND','receiverAccount',404);
  source='AVISPAY';
 }else if(holder){
  if(bic!==receivingBic(expectedBic))fault('RECEIVER_BIC_MISMATCH','receiverBic');
  source='AVISPAY';
 }else if(env.AVIS_SWIFTREF_TOKEN){
  try{
   const response=await fetcher('https://api.swift.com/swiftrefdata/v5/account_numbers/validity',{
    method:'POST',headers:{authorization:'Bearer '+env.AVIS_SWIFTREF_TOKEN,'content-type':'application/json'},
    body:JSON.stringify({account_number:account.number,country_code:account.type==='IBAN'?account.number.slice(0,2):bic.slice(4,6),is_iban:account.type==='IBAN',usage:'retail',bic}),
    signal:AbortSignal.timeout(8000),redirect:'error'});
   if([400,404].includes(response.status))fault('RECEIVER_BANK_VALIDATION','receiverAccount');
   if(response.ok)source='SWIFTREF';
   else console.error(JSON.stringify({operation:'BENEFICIARY_DIRECTORY',code:'DIRECTORY_RESPONSE',status:response.status}));
  }catch(e){
   if(e.code==='RECEIVER_BANK_VALIDATION')throw e;
   console.error(JSON.stringify({operation:'BENEFICIARY_DIRECTORY',code:'DIRECTORY_LOOKUP_FAILED'}));
  }
 }
 const saved=(await db.query('SELECT bic,full_name,postal_address FROM avis_core_v2.payment_beneficiaries WHERE actor_id=$1 AND account_number=$2',[actor.id,account.number])).rows[0];
 if(saved&&receivingBic(saved.bic)!==bic)fault('RECEIVER_BIC_MISMATCH','receiverBic');
 const owner=holder?(await db.query('SELECT full_name,postal_address FROM avis_core_v2.holder_identities WHERE record_user_id=$1',[holder.user_id])).rows[0]:null;
 const name=owner?.full_name||saved?.full_name||'';
 return {account:account.number,accountType:account.type,bic,validationSource:source,
  receiverName:name,address:owner?.postal_address||saved?.postal_address||null,addressSource:owner?.postal_address?'REGISTERED':saved?.postal_address?'SAVED':null,receiverBridgeId:holder?.bridge_id||null};
}
