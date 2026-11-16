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
   // Each crypto currency is entered into the AVISPay PLC internal Treasury ledger.
   // Its offset is a dedicated initial-position register, not a bank or chain.
   let accountId=null,journalId=null;
   if(p.assetClass==='CRYPTO'){
    accountId=await core.system(db,'TREASURY',p.assetCode,'REGISTERED_OPENING','ASSET');
    const openingOffset=await core.system(db,'MIGRATION_OFFSET',p.assetCode,'TREASURY_INITIAL_POSITION','EQUITY');
    journalId=await core.post(db,OPERATOR,TREASURY_REQUEST+':'+p.assetCode,'TREASURY_INITIAL_ASSET',p.sourceReference,[
     {accountId,direction:'DEBIT',amount:p.quantity},
     {accountId:openingOffset,direction:'CREDIT',amount:p.quantity}
    ]);
   }
   const ref=TREASURY_REQUEST+':'+p.assetCode;
   const inserted=(await db.query(`INSERT INTO avis_core_v2.treasury_opening_positions
    (source_system,source_reference,owner_user_id,asset_class,asset_code,asset_name,isin,quantity,destination,ledger_account_id,journal_id,booking_reference,booked_by)
    VALUES('ARGENTARIUS_AVIS_GREENS',$1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (source_system,source_reference,asset_class,asset_code) DO NOTHING RETURNING booking_id`,
    [p.sourceReference,p.assetClass,p.assetCode,p.assetName,p.isin,p.quantity,p.destination,accountId,journalId,ref,OPERATOR.id])).rows[0];
   if(!inserted)fault('TREASURY_SOURCE_ALREADY_BOOKED');
   result.push({bookingId:inserted.booking_id,asset:p.assetCode,quantity:p.quantity,destination:p.destination,accountId,journalId});
  }
  return {requestId:TREASURY_REQUEST,owner:'AVISPay PLC',positions:result};
 });
}
// Move the previously registered AG/AGi inventory into the existing
// AVISPay PLC Ethereum funding wallets. A two-network bridge journal
// preserves the existing source posting and never issues tokens on-chain.
export const TREASURY_WALLET_CONSOLIDATION='avispay-agi-ag-wallet-consolidation-2026-11-16';
export async function consolidateTreasuryCrypto(pool,env=process.env){
 if(env.CONTAINER_APP_NAME!=='genesis-banking-uat'||
    env.CONTAINER_APP_ENV_DNS_SUFFIX!=='orangemushroom-9faae382.italynorth.azurecontainerapps.io'||
    env.PGDATABASE!=='fineract_default')fault('TREASURY_TARGET_MISMATCH');
 const core=new SovereignCore(pool);
 return core.operation(OPERATOR,'TREASURY_CRYPTO_WALLET_CONSOLIDATION',
   {requestId:TREASURY_WALLET_CONSOLIDATION,coins:['AG','AGi'],ownerUserId:'1',network:'ETHEREUM'},
   TREASURY_WALLET_CONSOLIDATION,async db=>{
    const result=[];
    for(const position of TREASURY_POSITIONS.filter(p=>p.assetClass==='CRYPTO')){
     const source=(await db.query(`SELECT p.ledger_account_id AS account_id,a.available_balance::text,a.locked_balance::text
      FROM avis_core_v2.treasury_opening_positions p
      JOIN avis_core_v2.ledger_accounts a ON a.account_id=p.ledger_account_id
      WHERE p.owner_user_id=1 AND p.asset_code=$1 AND p.asset_class='CRYPTO' FOR UPDATE OF a`,[position.assetCode])).rows[0];
     const dest=(await db.query(`SELECT account_id,available_balance::text,locked_balance::text
      FROM avis_core_v2.ledger_accounts
      WHERE owner_type='USER' AND user_id=1 AND currency_code=$1 AND network='ETHEREUM'
       AND wallet_scope='FUNDING' AND account_category='LIABILITY'
      ORDER BY account_id FOR UPDATE`,[position.assetCode])).rows;
     if(!source||dest.length!==1||source.locked_balance!=='0.000000000000000000'
        && Number(source.locked_balance)!==0||Number(source.available_balance)!==Number(position.quantity))
       fault('TREASURY_SOURCE_MISMATCH');
     const originOffset=await core.system(db,'MIGRATION_OFFSET',position.assetCode,'TREASURY_INITIAL_POSITION','EQUITY');
     await db.query(`INSERT INTO avis_core_v2.ledger_accounts(owner_type,sub_account_code,currency_code,network,account_category)
      VALUES('MIGRATION_OFFSET','TREASURY_WALLET_BRIDGE',$1,'ETHEREUM','ASSET') ON CONFLICT DO NOTHING`,[position.assetCode]);
     const bridge=(await db.query(`SELECT account_id FROM avis_core_v2.ledger_accounts WHERE
      owner_type='MIGRATION_OFFSET' AND sub_account_code='TREASURY_WALLET_BRIDGE'
      AND currency_code=$1 AND network='ETHEREUM' AND wallet_scope='FUNDING'`,[position.assetCode])).rows[0].account_id;
     const journalId=await core.post(db,OPERATOR,TREASURY_WALLET_CONSOLIDATION+':'+position.assetCode,
      'TREASURY_CRYPTO_MOVE',position.sourceReference,[
       {accountId:source.account_id,direction:'CREDIT',amount:position.quantity},
       {accountId:originOffset,direction:'DEBIT',amount:position.quantity},
       {accountId:bridge,direction:'DEBIT',amount:position.quantity},
       {accountId:dest[0].account_id,direction:'CREDIT',amount:position.quantity}
      ]);
     result.push({asset:position.assetCode,quantity:position.quantity,accountId:dest[0].account_id,journalId});
    }
    return {requestId:TREASURY_WALLET_CONSOLIDATION,positions:result};
   });
}
export async function readTreasuryOpening(pool){
 return (await pool.query(`SELECT booking_id,source_reference,asset_class,asset_code,asset_name,isin,
 quantity::text,destination,ledger_account_id,journal_id,booking_reference,booked_at FROM avis_core_v2.treasury_opening_positions
 WHERE owner_user_id=1 ORDER BY asset_class,asset_code`)).rows;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const pool=new pg.Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT||5432),database:process.env.PGDATABASE,user:process.env.PGUSER,password:process.env.PGPASSWORD,ssl:{rejectUnauthorized:true},max:1});
 try{const result=await bookTreasuryOpening(pool);const walletMove=await consolidateTreasuryCrypto(pool);const rows=await readTreasuryOpening(pool);
  if(!result.positions.every(p=>rows.some(r=>r.booking_id===p.bookingId&&Number(r.quantity)===Number(p.quantity))))throw Error('TREASURY_READBACK_MISMATCH');
  for(const p of result.positions.filter(p=>p.accountId)){
   const ledger=(await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[p.accountId])).rows[0];
   if(!ledger||Number(ledger.available_balance)!==0)throw Error('TREASURY_LEDGER_READBACK_MISMATCH');
  }
  for(const entry of walletMove.positions){const wallet=(await pool.query('SELECT available_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[entry.accountId])).rows[0];if(!wallet||Number(wallet.available_balance)<Number(entry.quantity))throw Error('TREASURY_WALLET_MOVE_READBACK');}
  // Keep the Azure console receipt on one short line; full booking IDs are read via the authenticated API.
  console.log('AVISPAY_TREASURY_BOOKING_OK '+JSON.stringify({requestId:result.requestId,booked:result.positions.length,consolidated:walletMove.positions.length}));
 }catch(e){console.error('AVISPAY_TREASURY_BOOKING_FAILED '+(e.code||e.message));process.exitCode=1;}finally{await pool.end();}
}
