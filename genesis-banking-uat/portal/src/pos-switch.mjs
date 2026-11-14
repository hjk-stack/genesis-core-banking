import {decode8583,encode8583,AVIS_ASCII,verify8583Response} from './iso8583.mjs';
import {fault,decimal} from './core.mjs';
import {sendBankMessage} from './payment-transport.mjs';
export async function sendIso8583Message(profile,packet,credentials,{send=sendBankMessage,dictionary=AVIS_ASCII}={}){
 if(new URL(profile.endpoint_url).protocol!=='tls:')fault('ISO8583_TLS_ENDPOINT');
 decode8583(packet,dictionary);const reply=await send(profile,packet,credentials);
 return verify8583Response(packet,Buffer.from(reply),dictionary);
}
export async function processAvis8583(core,actor,packet,{allowedTerminals}={}){
 const request=decode8583(packet),f=request.fields,terminalId=f[41]?.trim(),responses={'0100':'0110','0200':'0210','0400':'0410','0420':'0430'};
 if(!responses[request.mti])fault('UNSUPPORTED_ISO8583_MTI');
 if(!allowedTerminals?.includes(terminalId))fault('TERMINAL_NOT_FOUND','terminalId');
 if(!f[11]||!f[37]||!f[4]||!f[49])fault('INVALID_ISO8583');
 const currencies={'978':['EUR',2],'840':['USD',2],'826':['GBP',2],'756':['CHF',2],'392':['JPY',0],'784':['AED',2],'702':['SGD',2],'752':['SEK',2],'578':['NOK',2],'208':['DKK',2],'985':['PLN',2],'203':['CZK',2],'348':['HUF',2],'946':['RON',2]},currency=currencies[f[49]];
 if(!currency)fault('CURRENCY_MISMATCH','currency');
 const amount=currency[1]===0?BigInt(f[4]).toString():decimal(BigInt(f[4]),currency[1]),reference=[terminalId,f[37],f[11]].join(':'),fields={11:f[11],37:f[37],39:'00',41:f[41]};
 try{
  let result;
  if(request.mti==='0100'){
   if(!f[62])fault('SELECT_AVIS_CARD','cardReference');
   result=await core.authorizeCard(actor,{terminalId,cardReference:f[62],currency:currency[0],amount,networkReference:reference},reference);
  }else{
   if(!f[60])fault('AUTHORIZATION_ALREADY_CLOSED','authorizationId');
   const auth=(await core.pool.query('SELECT * FROM avis_core_v2.card_authorizations WHERE authorization_id=$1',[f[60]])).rows[0];
   const {money}=await import('./core.mjs');
   if(!auth||auth.terminal_id!==terminalId||auth.currency_code!==currency[0]||money(auth.amount)!==money(amount))fault('ISO8583_RESPONSE_CORRELATION');
   result=await core.settleCard(actor,{authorizationId:auth.authorization_id},reference,request.mti!=='0200');
  }
  fields[60]=result.id;
 }catch(e){
  const mapping={INSUFFICIENT_FUNDS:'51',SELECT_AVIS_CARD:'14',CURRENCY_MISMATCH:'13',INVALID_AMOUNT:'13',AUTHORIZATION_ALREADY_CLOSED:'25',ISO8583_RESPONSE_CORRELATION:'25',IDEMPOTENCY_CONFLICT:'94'};
  const code=mapping[e.code]||mapping[e.message];if(!code)throw e;fields[39]=code;
 }
 return encode8583({mti:responses[request.mti],fields});
}
