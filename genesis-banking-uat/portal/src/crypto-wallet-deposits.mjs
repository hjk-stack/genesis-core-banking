import {createHash} from 'node:crypto';
import {Interface,formatUnits,getAddress} from 'ethers';
import {EvmWalletTransfers} from './crypto-wallet-transfers.mjs';
import {cryptoLedgerAccount} from './crypto/rolling-ledger.mjs';
import {fault,money,decimal,text} from './core.mjs';

const transferABI=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const transferTopic=transferABI.getEvent('Transfer').topicHash;
const zero='0x0000000000000000000000000000000000000000';
const sameAddress=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validHash=v=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const safeNumber=v=>Number.isSafeInteger(v)&&v>=0;
const binding=s=>[s.account_id,String(s.user_id),String(s.address_id),s.public_address.toLowerCase(),s.asset_id,s.asset_key,s.currency_code,s.wallet_scope,Number(s.decimals)];

function access(actor,userId){
 if(!actor?.admin||!actor.id||(actor.customerUserId&&String(actor.customerUserId)!==String(userId)))fault('FORBIDDEN',null,403);
}
function amount(value,decimals){
 try{return decimal(money(formatUnits(value,decimals)));}catch{fault('CRYPTO_DEPOSIT_EVENT','txHash');}
}
function result(row,confirmations=Number(row.confirmations),alreadyBooked=true){
 return {id:row.deposit_id,status:'CONFIRMED',accountId:row.account_id,addressId:String(row.address_id),txHash:row.tx_hash,
  network:row.network,currency:row.currency_code,amount:row.amount,journalId:row.journal_id,confirmations,finalized:true,alreadyBooked};
}

/**
 * Books an explicit finalized incoming Ethereum receipt. No balance deltas,
 * wallet keys, signing or broadcasts are used by this reconciliation path.
 */
export class EvmWalletDeposits extends EvmWalletTransfers {
 async depositSource(db,actor,input,lock=false){
  const source=(await db.query(`SELECT l.*,d.address_id,d.public_address,a.asset_id,a.source AS asset_source,
   n.contract_address,n.decimals,n.approved,n.verified_at
   FROM avis_core_v2.ledger_accounts l
   JOIN avis_core_v2.user_deposit_addresses d ON d.user_id=l.user_id AND d.network=l.network AND d.address_id=$2
   JOIN avis_core_v2.crypto_assets a ON a.currency_code=l.currency_code
   JOIN avis_core_v2.crypto_asset_networks n ON n.asset_id=a.asset_id AND n.network=l.network
   WHERE l.account_id=$1 AND l.owner_type='USER' AND l.account_category='LIABILITY'
    AND l.sub_account_code='CRYPTO' AND l.wallet_scope IN ('FUNDING','CUSTODY')
   ${lock?'FOR SHARE OF d,a,n':''}`,[input.accountId,input.addressId])).rows[0];
  if(!source)fault('CRYPTO_DEPOSIT_ACCOUNT','accountId');
  access(actor,source.user_id);
  if(source.network!=='ETHEREUM')fault('CRYPTO_NETWORK','network');
  if(!source.approved||!source.verified_at||!Number.isInteger(Number(source.decimals))||source.decimals===null||Number(source.decimals)<0||Number(source.decimals)>18)fault('CRYPTO_APPROVAL_REQUIRED','accountId');
  try{if(getAddress(source.public_address)===zero||source.contract_address&&getAddress(source.contract_address)===zero)throw Error();}catch{fault('CRYPTO_DEPOSIT_ACCOUNT','accountId');}
  source.asset_key=source.contract_address?source.contract_address.toLowerCase():'NATIVE';
  if(!source.contract_address&&(source.currency_code!=='ETH'||Number(source.decimals)!==18))fault('CRYPTO_APPROVAL_REQUIRED','accountId');
  if(source.asset_source==='SECURITY'){
   const registered=(await db.query("SELECT card_id FROM avis_core_v2.crypto_security_cards WHERE symbol=$1 AND network=$2 AND mode='REAL' AND state='BOOKED' AND lower(contract_address)=lower($3)"+(lock?' FOR SHARE':''),[source.currency_code,source.network,source.contract_address])).rows[0];
   if(source.wallet_scope!=='CUSTODY'||!source.contract_address||!registered)fault('CRYPTO_DEPOSIT_ACCOUNT','accountId');
  }else if(source.wallet_scope!=='FUNDING')fault('CRYPTO_DEPOSIT_ACCOUNT','accountId');
  if(source.contract_address&&(await db.query('SELECT 1 FROM avis_core_v2.crypto_asset_networks WHERE network=$1 AND approved AND asset_id<>$2 AND lower(contract_address)=lower($3)',[source.network,source.asset_id,source.contract_address])).rows.length)fault('CRYPTO_APPROVAL_REQUIRED','accountId');
  return source;
 }

 async managedDeposit(db,source,txHash){
  const action=(await db.query('SELECT action_id,address_id,status,journal_id,instruction FROM avis_core_v2.crypto_chain_actions WHERE network=$1 AND tx_hash=$2',[source.network,txHash])).rows[0];
  if(!action)return null;
  // The sender's existing action also owns the recipient credit. The recipient
  // may inspect its status, but cannot claim a second deposit from the receipt.
  const e=action.instruction?.expected;
  if(String(action.address_id)!==String(source.address_id)&&!(String(e?.recipientUserId)===String(source.user_id)&&sameAddress(e?.recipient,source.public_address)))fault('CRYPTO_DEPOSIT_EVENT','txHash');
  return {status:'MANAGED',txHash,network:source.network,accountId:source.account_id,actionId:action.action_id,actionStatus:action.status,journalId:action.journal_id};
 }

 async depositConflict(actor,record,observed){
  const evidence={expectedBlockHash:record.block_hash,expectedDigest:record.receipt_digest,...observed};
  await this.operation(actor,'CRYPTO_DEPOSIT_REORG',{depositId:record.deposit_id,evidence},'deposit-reorg:'+hash([record.deposit_id,evidence]),async db=>{
   await db.query('UPDATE avis_core_v2.crypto_wallet_deposits SET reorg_detected_at=COALESCE(reorg_detected_at,now()),reorg_evidence=$2 WHERE deposit_id=$1',[record.deposit_id,JSON.stringify(evidence)]);
   return {id:record.deposit_id,status:'REORGED'};
  });
  fault('CRYPTO_DEPOSIT_REORG','txHash');
 }

 async reconcileCryptoDeposit(actor,input,key){
  access(actor,actor?.customerUserId);
  text(key,'idempotencyKey');
  if(!uuid(input.accountId)||!/^\d+$/.test(String(input.addressId)))fault('CRYPTO_DEPOSIT_ACCOUNT','accountId');
  if(!validHash(input.txHash))fault('CRYPTO_DEPOSIT_HASH','txHash');
  const clean={accountId:input.accountId,addressId:String(input.addressId),txHash:input.txHash.toLowerCase()};
  const source=await this.depositSource(this.pool,actor,clean);
  const managed=await this.managedDeposit(this.pool,source,clean.txHash);if(managed)return managed;
  const identity=[source.network,clean.txHash,String(source.address_id),source.asset_key];
  const saved=(await this.pool.query('SELECT * FROM avis_core_v2.crypto_wallet_deposits WHERE network=$1 AND tx_hash=$2 AND address_id=$3 AND asset_key=$4',identity)).rows[0];
  if(saved?.reorg_detected_at)fault('CRYPTO_DEPOSIT_REORG','txHash');
  if(saved&&(saved.account_id!==source.account_id||saved.asset_id!==source.asset_id||saved.currency_code!==source.currency_code||saved.wallet_scope!==source.wallet_scope||Number(saved.decimals)!==Number(source.decimals)))fault('CRYPTO_DEPOSIT_ACCOUNT','accountId');
  await this.chain.check(source.network);
  const provider=this.chain.provider(source.network);
  const read=async work=>{try{return await work();}catch{fault('CRYPTO_CONNECTOR','txHash',502);}};
  try{
   const [receipt,transaction,height,finalized]=await read(()=>Promise.all([
    provider.getTransactionReceipt(clean.txHash),provider.getTransaction(clean.txHash),provider.getBlockNumber(),provider.getBlock('finalized')
   ]));
   const pending=(confirmations=0)=>({status:'PENDING',txHash:clean.txHash,network:source.network,accountId:source.account_id,confirmations,finalized:false});
   if(!receipt||!transaction){if(saved)fault('CRYPTO_RECEIPT','txHash');return pending();}
   if(receipt.hash?.toLowerCase()!==clean.txHash||transaction.hash?.toLowerCase()!==clean.txHash)fault('CRYPTO_RECEIPT','txHash');
   if(saved&&validHash(receipt.blockHash)&&saved.block_hash!==receipt.blockHash.toLowerCase())return this.depositConflict(actor,saved,{observedBlockHash:receipt.blockHash.toLowerCase(),receiptStatus:receipt.status});
   if(!validHash(receipt.blockHash)||!safeNumber(receipt.blockNumber)||!safeNumber(receipt.index)||!Array.isArray(receipt.logs)||
    receipt.hash?.toLowerCase()!==clean.txHash||transaction.hash?.toLowerCase()!==clean.txHash||transaction.chainId!==1n||
    transaction.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase()||transaction.blockNumber!==receipt.blockNumber||transaction.index!==receipt.index||
    !sameAddress(transaction.from,receipt.from)||!(transaction.to===null&&receipt.to===null)&&!sameAddress(transaction.to,receipt.to))fault('CRYPTO_RECEIPT','txHash');
   if(receipt.status!==1)fault('CRYPTO_TX_FAILED','txHash');
   const block=await read(()=>provider.getBlock(receipt.blockNumber));
   if(!block||block.hash?.toLowerCase()!==receipt.blockHash.toLowerCase()){
    if(saved)return this.depositConflict(actor,saved,{observedBlockHash:block?.hash||null,receiptBlockHash:receipt.blockHash});
    return pending();
   }
   if(block.number!==receipt.blockNumber||!Array.isArray(block.transactions)||block.transactions[receipt.index]?.toLowerCase()!==clean.txHash||!safeNumber(block.timestamp))fault('CRYPTO_RECEIPT','txHash');
   const events=[];let total=0n;
   if(!source.contract_address){
    // Internal ETH calls require trace reconciliation; only a direct payment to
    // the selected ordinary wallet is represented by top-level tx.value.
    if(!sameAddress(transaction.to,source.public_address)||transaction.data!=='0x'||typeof transaction.value!=='bigint'||transaction.value<=0n||receipt.logs.length||
     await read(()=>provider.getCode(source.public_address,receipt.blockNumber))!=='0x')fault('CRYPTO_DEPOSIT_EVENT','txHash');
    total=transaction.value;events.push({ordinal:null,eventIndex:0,direction:'IN',from:transaction.from.toLowerCase(),to:source.public_address.toLowerCase(),rawQuantity:total.toString()});
   }else{
    let previous=-1;
    for(const [ordinal,log]of receipt.logs.entries()){
     if(!safeNumber(log.index)||log.index<=previous||log.removed||log.blockNumber!==receipt.blockNumber||
      log.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase()||log.transactionHash?.toLowerCase()!==clean.txHash||log.transactionIndex!==receipt.index)fault('CRYPTO_RECEIPT','txHash');
     previous=log.index;if(!sameAddress(log.address,source.contract_address))continue;
     if(log.topics?.[0]?.toLowerCase()!==transferTopic.toLowerCase())continue;
     if(log.topics.length!==3||!/^0x[0-9a-f]{64}$/i.test(log.data))fault('CRYPTO_RECEIPT','txHash');
     let event;try{event=transferABI.parseLog(log);}catch{fault('CRYPTO_RECEIPT','txHash');}
     if(event?.name!=='Transfer')fault('CRYPTO_RECEIPT','txHash');
     const incoming=sameAddress(event.args.to,source.public_address),outgoing=sameAddress(event.args.from,source.public_address);
     if(incoming===outgoing||event.args.value===0n)continue;
     if(incoming&&source.asset_source==='SECURITY'&&sameAddress(event.args.from,zero))fault('CRYPTO_DEPOSIT_EVENT','txHash');
     total+=(incoming?1n:-1n)*event.args.value;
     events.push({ordinal,eventIndex:log.index,direction:incoming?'IN':'OUT',from:event.args.from.toLowerCase(),to:event.args.to.toLowerCase(),rawQuantity:event.args.value.toString()});
    }
    if(!events.length)fault('CRYPTO_DEPOSIT_EVENT','txHash');
   }
   const quantity=amount(total,Number(source.decimals));
   const digest=hash({identity,binding:binding(source),blockNumber:receipt.blockNumber,blockHash:receipt.blockHash.toLowerCase(),events});
   const confirmations=safeNumber(height)?Math.max(0,height-receipt.blockNumber+1):0;
   if(saved){
    if(saved.block_hash!==receipt.blockHash.toLowerCase()||saved.receipt_digest!==digest)return this.depositConflict(actor,saved,{observedBlockHash:receipt.blockHash.toLowerCase(),observedDigest:digest});
    return result(saved,Math.max(Number(saved.confirmations),confirmations));
   }
   const senders=[...new Set(events.filter(e=>e.direction==='IN').map(e=>e.from))];
   if((await this.pool.query(`SELECT 1 FROM avis_core_v2.user_deposit_addresses WHERE network=$1 AND lower(public_address)=ANY($2::text[])
    UNION ALL SELECT 1 FROM avis_core_v2.crypto_security_cards WHERE network=$1 AND (lower(contract_address)=ANY($2::text[]) OR lower(hub_address)=ANY($2::text[]))`,[source.network,senders])).rows.length)fault('CRYPTO_DEPOSIT_MANAGED_SOURCE','txHash');
   if(confirmations<12||!finalized||!safeNumber(finalized.number)||!validHash(finalized.hash)||finalized.number<receipt.blockNumber||finalized.number>height)return pending(confirmations);
   return await this.operation(actor,'RECONCILE_CRYPTO_DEPOSIT',clean,key,async db=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['crypto-deposit:'+hash(identity)]);
    const current=await this.depositSource(db,actor,clean,true);
    if(JSON.stringify(binding(current))!==JSON.stringify(binding(source)))fault('CRYPTO_DOSSIER_CHANGED','accountId');
    const managed=await this.managedDeposit(db,current,clean.txHash);if(managed)return managed;
    const existing=(await db.query('SELECT * FROM avis_core_v2.crypto_wallet_deposits WHERE network=$1 AND tx_hash=$2 AND address_id=$3 AND asset_key=$4 FOR UPDATE',identity)).rows[0];
    if(existing){if(existing.reorg_detected_at||existing.receipt_digest!==digest)fault('CRYPTO_DEPOSIT_REORG','txHash');return result(existing,confirmations);}
    // Recheck the canonical finalized block after obtaining the durable claim
    // lock. A changed or incomplete chain view cannot post a journal.
    const [canonical,head]=await read(()=>Promise.all([provider.getBlock(receipt.blockNumber),provider.getBlock('finalized')]));
    if(canonical?.hash?.toLowerCase()!==receipt.blockHash.toLowerCase()||!head||!safeNumber(head.number)||head.number<receipt.blockNumber||!validHash(head.hash))fault('CRYPTO_DEPOSIT_REORG','txHash');
    const old=(await db.query('SELECT 1 FROM avis_core_v2.onchain_transactions WHERE network=$1 AND tx_hash=$2 AND event_index=ANY($3::bigint[])',[source.network,clean.txHash,events.map(e=>e.eventIndex)])).rows;
    if(old.length)fault('CRYPTO_DEPOSIT_EVENT','txHash');
    const backing=await cryptoLedgerAccount(db,{owner:'HOT_WALLET',currency:source.currency_code,network:source.network,bucket:'CHAIN_CUSTODY',category:'ASSET'});
    if(!(await db.query("SELECT 1 FROM avis_core_v2.ledger_accounts WHERE account_id=$1 AND account_category='ASSET' AND wallet_scope='FUNDING'",[backing])).rows.length)fault('CRYPTO_CUSTODY_BALANCE','accountId');
    const journalId=await this.post(db,actor,'crypto-deposit:'+hash(identity),'CRYPTO_WALLET_DEPOSIT',clean.txHash,[
     {accountId:backing,direction:'DEBIT',amount:quantity},{accountId:source.account_id,direction:'CREDIT',amount:quantity}
    ]);
    for(const event of events)await db.query(`INSERT INTO avis_core_v2.onchain_transactions(user_id,journal_id,tx_type,network,tx_hash,event_index,from_address,to_address,currency_code,asset_contract,amount,status,block_timestamp)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CONFIRMED',$12)`,[source.user_id,journalId,event.direction==='IN'?'WALLET_DEPOSIT':'WALLET_DEPOSIT_OUTFLOW',source.network,clean.txHash,event.eventIndex,event.from,event.to,source.currency_code,source.contract_address,amount(BigInt(event.rawQuantity),Number(source.decimals)),new Date(block.timestamp*1000)]);
    const row=(await db.query(`INSERT INTO avis_core_v2.crypto_wallet_deposits(user_id,account_id,address_id,asset_id,network,tx_hash,asset_key,currency_code,wallet_scope,decimals,amount,block_number,block_hash,finalized_block_number,finalized_block_hash,confirmations,receipt_digest,event_proofs,journal_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,[source.user_id,source.account_id,source.address_id,source.asset_id,source.network,clean.txHash,source.asset_key,source.currency_code,source.wallet_scope,source.decimals,quantity,receipt.blockNumber,receipt.blockHash.toLowerCase(),head.number,head.hash.toLowerCase(),confirmations,digest,JSON.stringify(events),journalId])).rows[0];
    return result(row,confirmations,false);
   });
  }finally{provider.destroy();}
 }
}
