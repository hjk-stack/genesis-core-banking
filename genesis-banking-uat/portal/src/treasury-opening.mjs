import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {SovereignCore,fault} from './core.mjs';

// Internal initial-position registration. Does not initiate a security trade,
// external custody instruction, blockchain transfer, or payment.
export const TREASURY_REQUEST='avispay-treasury-registered-inventory-2026-11-16';
export const TREASURY_POSITIONS=Object.freeze([
 {assetClass:'SECURITY',assetCode:'USU3712QAA05',assetName:'GENESIS Green Bond',isin:'USU3712QAA05',quantity:'500000',destination:'TREASURY_PORTFOLIO',sourceReference:'GENESIS-EXISTING-500000'},
 {assetClass:'SECURITY',assetCode:'AVISPAY-PLC-SHARES',assetName:'AVISPay PLC shares',isin:null,quantity:'100000000',destination:'TREASURY_PORTFOLIO',sourceReference:'AVISPAY-PLC-EXISTING-SHARES'},
 {assetClass:'CRYPTO',assetCode:'AG',assetName:'AVIS Green',isin:null,quantity:'10000000000',destination:'TREASURY_WALLET',sourceReference:'AVIS-GREENS-AG-REGISTERED'},
 {assetClass:'CRYPTO',assetCode:'AGi',assetName:'AVIS Green Investment',isin:null,quantity:'10000000000',destination:'TREASURY_WALLET',sourceReference:'AVIS-GREENS-AGI-REGISTERED'}
]);
const OPERATOR={id:'owner-instruction:helmut:treasury-opening-54',admin:true};
export async function bookTreasuryOpening(pool,env=process.env){
 if(env.CONTAINER_APP_NAME!=='genesis-banking-uat'||
    env.CONTAINER_APP_ENV_DNS_SUFFIX!=='orangemushroom-9faae382.italynorth.azurecontainerapps.io'||
    env.PGDATABASE!=='fineract_default')fault('TREASURY_TARGET_MISMATCH');
 const core=new SovereignCore(pool),input={requestId:TREASURY_REQUEST,ownerUserId:'1',positions:TREASURY_POSITIONS};
 return core.operation(OPERATOR,'TREASURY_OPENING_POSITIONS',input,TREASURY_REQUEST,async db=>{
  const owner=(await db.query('SELECT user_id,full_name,account_role FROM avis_core_v2.sovereign_users WHERE user_id=$1 FOR SHARE',[1])).rows[0];
  if(!owner||owner.full_name!=='AVISPay PLC'||owner.account_role!=='INSTITUTION')fault('TREASURY_OWNER_MISMATCH');
  const result=[];
  for(const p of TREASURY_POSITIONS){
   const ref=TREASURY_REQUEST+':'+p.assetCode;
   const inserted=(await db.query(`INSERT INTO avis_core_v2.treasury_opening_positions
    (source_system,source_reference,owner_user_id,asset_class,asset_code,asset_name,isin,quantity,destination,booking_reference,booked_by)
    VALUES('ARGENTARIUS_AVIS_GREENS',$1,1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (source_system,source_reference,asset_class,asset_code) DO NOTHING RETURNING booking_id`,
    [p.sourceReference,p.assetClass,p.assetCode,p.assetName,p.isin,p.quantity,p.destination,ref,OPERATOR.id])).rows[0];
   if(!inserted)fault('TREASURY_SOURCE_ALREADY_BOOKED');
   result.push({bookingId:inserted.booking_id,asset:p.assetCode,quantity:p.quantity,destination:p.destination});
  }
  return {requestId:TREASURY_REQUEST,owner:'AVISPay PLC',positions:result};
 });
}
export async function readTreasuryOpening(pool){
 return (await pool.query(`SELECT booking_id,source_reference,asset_class,asset_code,asset_name,isin,
 quantity::text,destination,booking_reference,booked_at FROM avis_core_v2.treasury_opening_positions
 WHERE owner_user_id=1 ORDER BY asset_class,asset_code`)).rows;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const pool=new pg.Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT||5432),database:process.env.PGDATABASE,user:process.env.PGUSER,password:process.env.PGPASSWORD,ssl:{rejectUnauthorized:true},max:1});
 try{const result=await bookTreasuryOpening(pool);const rows=await readTreasuryOpening(pool);
  if(!result.positions.every(p=>rows.some(r=>r.booking_id===p.bookingId&&Number(r.quantity)===Number(p.quantity))))throw Error('TREASURY_READBACK_MISMATCH');
  console.log('AVISPAY_TREASURY_BOOKING_OK '+JSON.stringify(result));
 }catch(e){console.error('AVISPAY_TREASURY_BOOKING_FAILED '+(e.code||e.message));process.exitCode=1;}finally{await pool.end();}
}
