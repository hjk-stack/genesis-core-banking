import {randomUUID} from 'node:crypto';
import {Interface,zeroPadValue} from 'ethers';

// Ethereum is the only network supported by the existing finalized-receipt
// ledger posting path. Other chains are not scanned or credited here.
const NETWORK='ETHEREUM';
const transferTopic=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']).getEvent('Transfer').topicHash;
const systemActor={id:'system:ethereum-deposits',admin:true};
const permanent=new Set(['CRYPTO_DEPOSIT_EVENT','CRYPTO_DEPOSIT_MANAGED_SOURCE','CRYPTO_TX_FAILED']);
const errorCode=e=>e?.code||e?.message||'CRYPTO_DEPOSIT_SCAN';

export async function scanFinalizedEthereumDeposits(core,{lookback=16,maxBlocks=4}={}){
 const db=core.pool;
 const client=await db.connect();
 let locked=false,provider;
 const report={network:NETWORK,blocks:0,candidates:0,booked:0,alreadyBooked:0};
 try{
  locked=Boolean((await client.query("SELECT pg_try_advisory_lock(hashtextextended('avispay:ethereum-deposits',0)) AS locked")).rows[0]?.locked);
  if(!locked)return {...report,skipped:'concurrent-worker'};
  await core.chain.check(NETWORK);
  provider=core.chain.provider(NETWORK);
  const finalized=await provider.getBlock('finalized');
  if(!finalized||!Number.isSafeInteger(finalized.number))throw Error('DEPOSIT_FINALIZED_HEIGHT');
  // Start a small bounded lookback on the initial run, without inventing a
  // deposit from the account balance or changing any existing wallet records.
  await client.query(`INSERT INTO avis_core_v2.crypto_deposit_scan_cursor(network,next_block)
   VALUES($1,$2) ON CONFLICT(network) DO NOTHING`,[NETWORK,Math.max(0,finalized.number-lookback)]);
  const cursor=(await client.query('SELECT next_block FROM avis_core_v2.crypto_deposit_scan_cursor WHERE network=$1',[NETWORK])).rows[0];
  const start=Number(cursor.next_block);
  if(!Number.isSafeInteger(start)||start>finalized.number)return report;
  const wallets=(await client.query(`SELECT l.account_id,d.address_id,lower(d.public_address) AS public_address,
   lower(n.contract_address) AS contract_address,l.currency_code
   FROM avis_core_v2.ledger_accounts l
   JOIN avis_core_v2.user_deposit_addresses d ON d.user_id=l.user_id AND d.network=l.network
   JOIN avis_core_v2.crypto_assets a ON a.currency_code=l.currency_code
   JOIN avis_core_v2.crypto_asset_networks n ON n.asset_id=a.asset_id AND n.network=l.network
   WHERE l.network=$1 AND l.owner_type='USER' AND l.account_category='LIABILITY'
    AND l.sub_account_code='CRYPTO' AND l.wallet_scope IN ('FUNDING','CUSTODY')
    AND n.approved AND n.verified_at IS NOT NULL
   ORDER BY l.account_id,d.address_id`,[NETWORK])).rows;
  const destinations=new Map();
  for(const w of wallets){
   const address=w.public_address.toLowerCase();
   const rows=destinations.get(address)||[];
   rows.push(w);destinations.set(address,rows);
  }
  const destinationsList=[...destinations.keys()];
  const native=new Set(destinationsList.filter(a=>destinations.get(a).some(w=>!w.contract_address&&w.currency_code==='ETH')));
  const end=Math.min(finalized.number,start+maxBlocks-1);
  for(let height=start;height<=end;height++){
   const block=await provider.getBlock(height,true);
   if(!block||!Array.isArray(block.transactions)||block.number!==height)throw Error('DEPOSIT_BLOCK_UNAVAILABLE');
   const found=new Map();
   const add=(w,txHash)=>{
    const k=w.account_id+':'+w.address_id+':'+txHash.toLowerCase();
    found.set(k,{accountId:w.account_id,addressId:String(w.address_id),txHash:txHash.toLowerCase()});
   };
   if(native.size)for(const txHash of block.transactions){
    const tx=block.getPrefetchedTransaction?(()=>{try{return block.getPrefetchedTransaction(txHash);}catch{return null;}})():null;
    const transaction=tx||await provider.getTransaction(txHash);
    if(!transaction||!transaction.to||!native.has(transaction.to.toLowerCase())||transaction.value<=0n)continue;
    for(const w of destinations.get(transaction.to.toLowerCase()))if(!w.contract_address&&w.currency_code==='ETH')add(w,txHash);
   }
   // Partition indexed receiving addresses to keep requests within RPC limits.
   for(let offset=0;offset<destinationsList.length;offset+=32){
    const part=destinationsList.slice(offset,offset+32);
    const logs=await provider.getLogs({fromBlock:height,toBlock:height,topics:[transferTopic,null,part.map(a=>zeroPadValue(a,32))]});
    for(const log of logs){
     if(log.removed||!log.transactionHash)continue;
     const to='0x'+String(log.topics?.[2]||'').slice(-40).toLowerCase();
     for(const w of destinations.get(to)||[])if(w.contract_address===log.address.toLowerCase())add(w,log.transactionHash);
    }
   }
   for(const input of found.values()){
    report.candidates++;
    try{
     const r=await core.reconcileCryptoDeposit(systemActor,input,'auto-deposit:'+input.accountId+':'+input.addressId+':'+input.txHash);
     if(r.status==='CONFIRMED'){if(r.alreadyBooked)report.alreadyBooked++;else report.booked++;}
     else if(r.status!=='MANAGED')throw Error('DEPOSIT_NOT_FINALIZED');
    }catch(e){
     if(permanent.has(errorCode(e)))continue;
     throw e; // Leave this block's cursor in place so it can be retried.
    }
   }
   // Move only after processing every candidate in the block. Existing journals
   // are idempotent and remain correct if a retry follows a partial failure.
   await client.query('UPDATE avis_core_v2.crypto_deposit_scan_cursor SET next_block=$2,updated_at=now() WHERE network=$1',[NETWORK,height+1]);
   report.blocks++;
  }
  return report;
 }finally{
  if(provider)provider.destroy();
  if(locked)await client.query("SELECT pg_advisory_unlock(hashtextextended('avispay:ethereum-deposits',0))");
  client.release();
 }
}
