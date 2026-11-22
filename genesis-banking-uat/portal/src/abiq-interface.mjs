import {randomUUID} from 'node:crypto';
import {fault,text} from './core.mjs';
import {ABIQ_ISSUER,ABIQ_PARTITIONS,parseAbiqIban,provisionHolderAccounts,findAbiqAccountIdentifier} from './avispay-core-accounts.mjs';

// fit.INTELECT v1 message adapter for this core's configured issuer.
// userId is local ownership context, outside the vendor's fitREQUEST envelope.
// ORDER numberIBANS=1 is the documented account-opening operation (§5.2).
function response(header,code,message,extra={}) {
 return {fitRESPONSE:{HEADER:header,RESPONSE_INFO:{datePROCESSED:new Date().toISOString().slice(0,19).replace('T',' ').replaceAll('-','/'),
  responseID:randomUUID().replaceAll('-',''),responseCODE:code,responseMESSAGE:message},...extra}};
}
export async function processAbiqRequest(core,actor,input) {
 if(!actor?.admin||!actor.id)fault('FORBIDDEN',null,403);
 const request=input.fitREQUEST,header=request?.HEADER;
 if(!header||typeof header.function!=='string')fault('INVALID_FIELD','fitREQUEST.HEADER');
 const requestID=text(header.requestID,'fitREQUEST.HEADER.requestID',33);
 if(requestID.length<6)fault('INVALID_FIELD','fitREQUEST.HEADER.requestID');
 const h={requestID,function:header.function};
 if(!['ORDER','SEARCH','IBANCHECK'].includes(h.function))return response(h,'12','Invalid function');
 if(h.function==='IBANCHECK'){
  try {
   const parsed=parseAbiqIban(request.ABIQ_INFO?.abiqIBAN);
   const account=await findAbiqAccountIdentifier(core.pool,{identifier:parsed.identifier,currency:parsed.currency});
   const portfolio=!account && parsed.currency==='579' && (await core.pool.query(
    'SELECT 1 FROM avis_core_v2.portfolio_abiq_accounts WHERE identifier=$1 AND ($2::bigint IS NULL OR user_id=$2)',
    [parsed.identifier,actor.customerUserId||null])).rowCount>0;
   const found=Boolean(account||portfolio);
   return response(h,found?'00':'34',found?'Request processed successfully':'Invalid account');
  } catch(e) {if(e.code?.startsWith('ABIQ_'))return response(h,'34','Invalid account');throw e;}
 }
 const code=h.function==='ORDER'?request.ORDER_INFO?.abiqCODE:request.ABIQ_INFO?.abiqCODE;
 const issuer=(await core.pool.query(`SELECT i.*,p.institution_name FROM avis_core_v2.abiq_issuers i
  JOIN avis_core_v2.abiq_network_participants p USING(participant_code)
  WHERE i.abiq_code=$1 AND p.abiq_bic=i.abiq_code AND p.is_active`,[code])).rows[0];
 if(!issuer)return response(h,'52','ABIQ code not found');
 if(h.function==='SEARCH')return response(h,'00','Request processed successfully',{BUSINESS_INFO:{abiqCODE:issuer.abiq_code,
  businessNAME:issuer.institution_name,businessBRANCH:issuer.abiq_code.slice(8),businessCOUNTRY:issuer.country_code,
  businessTYPE:issuer.abiq_code.slice(6,8),businessCURRENCY:Object.keys(ABIQ_PARTITIONS)}});
 const order=request.ORDER_INFO;
 const currency=Object.keys(ABIQ_PARTITIONS).find(c=>ABIQ_PARTITIONS[c].slice(1)===order.abiqCURRENCY);
 if(!currency)fault('ABIQ_UNSUPPORTED_CURRENCY','fitREQUEST.ORDER_INFO.abiqCURRENCY');
 if(![1,'1'].includes(order.numberIBANS))fault('ABIQ_ACCOUNT_ORDER_COUNT','fitREQUEST.ORDER_INFO.numberIBANS');
 return core.operation(actor,'ABIQ_ORDER',input,requestID,async(db,key)=>{
  const accounts=await provisionHolderAccounts(db,{userId:input.userId,participantCode:ABIQ_ISSUER.participantCode,currencies:[currency],idempotencyKey:key});
  const account=accounts[0];
  return response(h,'00','Request processed successfully',{ABIQ_INFO:{abiqCODE:account.abiqCode,
   IBAN001:{abiqIBAN:account.abiqIban,abiqACCOUNT:account.accountNumber}}});
 });
}
