import {createHash,randomUUID} from 'node:crypto';
import {Interface,Wallet,Transaction,getAddress,parseUnits,formatUnits} from 'ethers';
import {CryptoChainActions} from './crypto-chain-actions.mjs';
import {cryptoLedgerAccount} from './crypto/rolling-ledger.mjs';
import {decryptKey,networkInfo} from './crypto/networks.mjs';
import {fault,text,money,decimal} from './core.mjs';

const tokenABI=new Interface([
 'function transfer(address,uint256) returns(bool)',
 'function balanceOf(address) view returns(uint256)',
 'event Transfer(address indexed from,address indexed to,uint256 value)'
]);
const transferTopic=tokenABI.getEvent('Transfer').topicHash;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(canonical(v))).digest('hex');
const receiptHash=r=>hash({hash:r.hash,blockHash:r.blockHash,blockNumber:r.blockNumber,from:r.from,to:r.to,status:r.status,
 gasUsed:String(r.gasUsed),gasPrice:String(r.gasPrice),logs:r.logs.map(l=>({address:l.address,topics:l.topics,data:l.data,index:l.index}))});
const units=v=>/^0(?:\.0+)?$/.test(String(v))?0n:String(v).startsWith('-')?-money(String(v).slice(1)):money(String(v));
const sameAddress=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v);
const line=(accountId,direction,amount)=>({accountId,direction,amount});
const pending=s=>['SIGNED','SUBMITTED'].includes(s);

function access(actor,userId){
 if(!actor?.admin||!actor.id||(actor.customerUserId&&String(actor.customerUserId)!==String(userId)))fault('FORBIDDEN',null,403);
}
function system(actor){
 if(!actor?.admin||actor.customerUserId)fault('FORBIDDEN',null,403);
}
function address(value,field){
 try{const result=getAddress(value);if(result==='0x0000000000000000000000000000000000000000')throw Error();return result;}
 catch{fault('INVALID_CRYPTO_ADDRESS',field);}
}
function compact(lines){
 const net=new Map();
 for(const l of lines)net.set(l.accountId,(net.get(l.accountId)||0n)+(l.direction==='DEBIT'?1n:-1n)*units(l.amount));
 return [...net].filter(([,v])=>v!==0n).map(([accountId,v])=>line(accountId,v>0n?'DEBIT':'CREDIT',decimal(v>0n?v:-v)));
}
function walletTransfers(receipt,contract){
 const transfers=[];
 for(const log of receipt.logs){
  if(!sameAddress(log.address,contract)||typeof log.topics?.[0]!=='string'||log.topics[0].toLowerCase()!==transferTopic)continue;
  if(!Array.isArray(log.topics)||log.topics.length!==3||!log.topics.slice(1).every(t=>/^0x0{24}[0-9a-f]{40}$/i.test(t))||
   !/^0x[0-9a-f]{64}$/i.test(log.data)||!Number.isInteger(log.index)||log.index<0)fault('CRYPTO_RECEIPT','actionId');
  let event;try{event=tokenABI.parseLog(log);}catch{fault('CRYPTO_RECEIPT','actionId');}
  if(event?.name!=='Transfer')fault('CRYPTO_RECEIPT','actionId');
  transfers.push({event,index:log.index});
 }
 return transfers;
}

/**
 * Standard Ethereum native/ERC20 wallet sends. Existing manual payment rows and
 * non-Ethereum adapters remain on their established path. Signed bytes, ledger
 * reservations and nonce ownership commit together before any broadcast.
 */
export class EvmWalletTransfers extends CryptoChainActions {
 async walletSendSource(db,actor,accountId,lock=false){
  const source=(await db.query("SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id=$1 AND owner_type='USER' AND account_category='LIABILITY' AND wallet_scope IN ('FUNDING','CUSTODY')",[accountId])).rows[0];
  if(!source)fault('CRYPTO_HOLDING_REQUIRED','cryptoAccount');
  access(actor,source.user_id);
  if(source.network!=='ETHEREUM')fault('CRYPTO_NETWORK','network');
  const asset=(await db.query('SELECT a.asset_id,a.source,n.* FROM avis_core_v2.crypto_assets a JOIN avis_core_v2.crypto_asset_networks n USING(asset_id) WHERE a.currency_code=$1 AND n.network=$2 AND n.approved AND n.verified_at IS NOT NULL'+(lock?' FOR SHARE OF a,n':''),[source.currency_code,source.network])).rows[0];
  if(!asset||asset.decimals===null||!Number.isInteger(Number(asset.decimals)))fault('CRYPTO_APPROVAL_REQUIRED','cryptoAccount');
  if(!asset.contract_address&&(source.currency_code!=='ETH'||Number(asset.decimals)!==18))fault('CRYPTO_APPROVAL_REQUIRED','cryptoAccount');
  if(source.wallet_scope==='CUSTODY'){
   const registered=(await db.query("SELECT card_id FROM avis_core_v2.crypto_security_cards WHERE symbol=$1 AND network=$2 AND state='BOOKED' AND mode='REAL' AND lower(contract_address)=lower($3)",[source.currency_code,source.network,asset.contract_address])).rows[0];
   if(asset.source!=='SECURITY'||!registered)fault('CRYPTO_SEND_SCOPE','cryptoAccount');
  }
  const wallet=(await db.query('SELECT d.*,k.encrypted_key FROM avis_core_v2.user_deposit_addresses d JOIN avis_core_v2.crypto_wallet_keys k USING(address_id) WHERE d.user_id=$1 AND d.network=$2'+(lock?' FOR SHARE OF d,k':''),[source.user_id,source.network])).rows[0];
  if(!wallet)fault('CRYPTO_SIGNING_KEY','cryptoAccount');
  return {source,asset,wallet};
 }

 async walletBacking(db,currency,network){
  const row=(await db.query("SELECT * FROM avis_core_v2.ledger_accounts WHERE owner_type='HOT_WALLET' AND user_id IS NULL AND sub_account_code='CHAIN_CUSTODY' AND wallet_scope='FUNDING' AND account_category='ASSET' AND currency_code=$1 AND network=$2",[currency,network])).rows[0];
  if(!row)fault('CRYPTO_CUSTODY_BALANCE','cryptoAccount');
  return row;
 }

 async walletGasAccount(db,userId,network){
  const row=(await db.query("SELECT * FROM avis_core_v2.ledger_accounts WHERE owner_type='USER' AND user_id=$1 AND sub_account_code='CRYPTO' AND wallet_scope='FUNDING' AND account_category='LIABILITY' AND currency_code='ETH' AND network=$2",[userId,network])).rows[0];
  if(!row)fault('CRYPTO_GAS_BALANCE','cryptoAccount');
  return row;
 }

 async assertWalletFunds(db,requirements,lock=false){
  const totals=new Map();
  for(const r of requirements){const old=totals.get(r.id)||{amount:0n,field:r.field,code:r.code};old.amount+=units(r.amount);totals.set(r.id,old);}
  const rows=(await db.query('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=ANY($1::uuid[]) ORDER BY account_id'+(lock?' FOR UPDATE':''),[[...totals.keys()]])).rows;
  for(const [id,r] of totals){const row=rows.find(a=>a.account_id===id);if(!row||units(row.available_balance)-units(row.locked_balance)<r.amount)fault(r.code,r.field);}
 }

 async preparePayment(actor,input,key){
  if(input.method!=='CRYPTO'||!uuid(input.cryptoAccount))return super.preparePayment(actor,input,key);
  const candidate=(await this.pool.query('SELECT network,wallet_scope FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[input.cryptoAccount])).rows[0];
  if(candidate?.network!=='ETHEREUM'||(input.cryptoDestination!=='EXTERNAL'&&candidate.wallet_scope!=='CUSTODY'))return super.preparePayment(actor,input,key);
  const clean=Object.fromEntries(['method','cryptoAccount','cryptoDestination','receiverUserId','cryptoAddress','receiverName','amount','reference','destinationTag'].filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]]));
  const amount=decimal(money(clean.amount)),reference=text(clean.reference,'reference',128);
  if(clean.destinationTag)fault('INVALID_FIELD','destinationTag');
  if(!['EXTERNAL','INTERNAL'].includes(clean.cryptoDestination))fault('INVALID_FIELD','cryptoDestination');
  return this.operation(actor,'REVIEW_WALLET_TRANSFER',clean,key,async db=>{
   const {source,asset,wallet}=await this.walletSendSource(db,actor,clean.cryptoAccount);
   let recipient,recipientUserId=null,receiverName,recipientScope=null;
   if(clean.cryptoDestination==='INTERNAL'){
    const r=(await db.query('SELECT u.user_id,u.full_name,d.public_address FROM avis_core_v2.sovereign_users u JOIN avis_core_v2.user_deposit_addresses d USING(user_id) WHERE u.user_id=$1 AND d.network=$2',[clean.receiverUserId,source.network])).rows[0];
    if(!r)fault('CRYPTO_WALLET_REQUIRED','receiverUserId');
    if(String(r.user_id)===String(source.user_id))fault('SAME_ACCOUNT','receiverUserId');
    recipient=address(r.public_address,'receiverUserId');recipientUserId=String(r.user_id);receiverName=r.full_name;recipientScope='CUSTODY';
   }else{
    recipient=address(text(clean.cryptoAddress,'cryptoAddress',256),'cryptoAddress');receiverName=text(clean.receiverName,'receiverName',140);
    // A managed destination is still an on-chain send, but its confirmed ledger
    // credit belongs here so a later receive import cannot book the same event.
    const managedRows=(await db.query('SELECT user_id FROM avis_core_v2.user_deposit_addresses WHERE network=$1 AND lower(public_address)=lower($2)',[source.network,recipient])).rows;
    if(managedRows.length>1)fault('CRYPTO_WALLET_REQUIRED','cryptoAddress');
    const managed=managedRows[0];
    if(managed){recipientUserId=String(managed.user_id);recipientScope=source.wallet_scope;}
   }
   const from=address(wallet.public_address,'cryptoAccount');
   if(sameAddress(from,recipient))fault('SAME_ACCOUNT','cryptoAddress');
   const decimals=Number(asset.decimals);let quantity;
   try{quantity=parseUnits(amount,decimals);}catch{fault('CRYPTO_AMOUNT_PRECISION','amount');}
   const contract=asset.contract_address?address(asset.contract_address,'cryptoAccount'):null;
   const tx={to:contract||recipient,data:contract?tokenABI.encodeFunctionData('transfer',[recipient,quantity]):'0x',value:contract?0n:quantity};
   await this.chain.check(source.network);
   const provider=this.chain.provider(source.network);let gas,fee,chainBalance,nativeBalance;
   try{
    nativeBalance=await provider.getBalance(from,'pending');
    chainBalance=contract?BigInt(await provider.call({to:contract,data:tokenABI.encodeFunctionData('balanceOf',[from])})):nativeBalance;
    if(chainBalance<quantity)fault('CRYPTO_CHAIN_BALANCE','amount');
    gas=await provider.estimateGas({...tx,from});fee=await provider.getFeeData();
   }catch(e){if(e.code==='CRYPTO_CHAIN_BALANCE')throw e;fault('CRYPTO_GAS','amount');}
   finally{provider.destroy();}
   const maxFee=fee.maxFeePerGas||fee.gasPrice,limit=gas*12n/10n;
   if(!maxFee||limit<=0n)fault('CRYPTO_GAS','amount');
   const gasMaximum=limit*maxFee;
   if(nativeBalance<(contract?0n:quantity)+gasMaximum)fault('CRYPTO_GAS_BALANCE','amount');
   const gasAccount=contract?await this.walletGasAccount(db,source.user_id,source.network):source;
   const backing=await this.walletBacking(db,source.currency_code,source.network),gasBacking=contract?await this.walletBacking(db,'ETH',source.network):backing;
   const requirements=[
    {id:source.account_id,amount,code:'INSUFFICIENT_FUNDS',field:'amount'},
    {id:gasAccount.account_id,amount:formatUnits(gasMaximum,18),code:'CRYPTO_GAS_BALANCE',field:'amount'},
    {id:backing.account_id,amount,code:'CRYPTO_CUSTODY_BALANCE',field:'cryptoAccount'},
    {id:gasBacking.account_id,amount:formatUnits(gasMaximum,18),code:'CRYPTO_CUSTODY_BALANCE',field:'cryptoAccount'}
   ];
   await this.assertWalletFunds(db,requirements);
   const id=randomUUID(),actionId=randomUUID(),createdAt=new Date().toISOString();
   const instruction={
    method:'CRYPTO',from:'Wallet '+source.currency_code+' · '+source.network,sourceUserId:String(source.user_id),
    currency:source.currency_code,network:source.network,amount,receiverName,destinationLabel:recipient,reference,createdAt,
    cryptoDestination:clean.cryptoDestination,receiverUserId:recipientUserId,cryptoAddress:recipient,destinationTag:null,
    fromAddress:from,contractAddress:contract,chainId:networkInfo(source.network).chainId,walletScope:source.wallet_scope,recipientScope,
    networkFeeMaximum:formatUnits(gasMaximum,18),networkFeeCurrency:'ETH',actionId
   };
   const actionInstruction={
    to:tx.to,data:tx.data,value:tx.value.toString(),from,chainId:networkInfo(source.network).chainId,gasLimit:limit.toString(),
    maxFeePerGas:maxFee.toString(),maxPriorityFeePerGas:(fee.maxPriorityFeePerGas||0n).toString(),legacy:!fee.maxFeePerGas,
    expected:{requestId:id,sourceAccountId:source.account_id,sourceScope:source.wallet_scope,assetId:asset.asset_id,
     currency:source.currency_code,contract,decimals,quantity:quantity.toString(),amount,recipient,recipientUserId,recipientScope,
     gasAccountId:gasAccount.account_id,backingAccountId:backing.account_id,gasBackingAccountId:gasBacking.account_id,
     gasMaximum:formatUnits(gasMaximum,18),requirements}
   };
   const message=JSON.stringify({protocol:'AVIS_TRANSFER_V1',requestId:id,...instruction},null,2),messageHash=hash(message);
   await db.query("INSERT INTO avis_core_v2.asset_transfer_requests(request_id,actor_id,payment_method,source_account_id,source_user_id,currency_code,network,amount,instruction,message_content,message_hash,delivery_mode) VALUES($1,$2,'CRYPTO',$3,$4,$5,$6,$7,$8,$9,$10,'BLOCKCHAIN')",[id,actor.id,source.account_id,source.user_id,source.currency_code,source.network,amount,JSON.stringify(instruction),message,messageHash]);
   await db.query("INSERT INTO avis_core_v2.crypto_chain_actions(action_id,request_id,user_id,network,address_id,action_type,instruction,review_hash) VALUES($1,$2,$3,$4,$5,'WALLET_SEND',$6,$7)",[actionId,id,source.user_id,source.network,wallet.address_id,JSON.stringify(actionInstruction),hash(actionInstruction)]);
   return {id,actionId,messageHash,message,format:'AVIS_TRANSFER_V1',mode:'BLOCKCHAIN',instruction};
  });
 }

 async confirmPayment(actor,input,key){
  const request=(await this.pool.query('SELECT request_id,delivery_mode FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1',[input.requestId])).rows[0];
  if(request?.delivery_mode!=='BLOCKCHAIN')return super.confirmPayment(actor,input,key);
  const result=await this.operation(actor,'SIGN_WALLET_TRANSFER',input,key,async db=>{
   const r=(await db.query('SELECT * FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
   access(actor,r.source_user_id);
   if(r.actor_id!==actor.id)fault('PAYMENT_REQUEST_NOT_FOUND','review',404);
   if(input.messageHash!==r.message_hash||hash(r.message_content)!==r.message_hash)fault('PAYMENT_REVIEW_CHANGED','review',409);
   const a=(await db.query('SELECT * FROM avis_core_v2.crypto_chain_actions WHERE request_id=$1 FOR UPDATE',[r.request_id])).rows[0];
   if(!a)fault('CRYPTO_ACTION_REQUIRED','review');
   if(r.status==='CANCELLED'||a.status==='EXPIRED')fault('PAYMENT_REQUEST_CLOSED','review',409);
   if(r.status!=='REVIEW')return {id:r.request_id,actionId:a.action_id};
   if(a.status!=='REVIEW'||new Date(a.expires_at)<=new Date()||hash(a.instruction)!==a.review_hash)fault('CRYPTO_REVIEW_CHANGED','review');
   const {source,asset,wallet}=await this.walletSendSource(db,actor,r.source_account_id,true),i=a.instruction,e=i.expected;
   if(String(source.user_id)!==String(r.source_user_id)||source.network!==r.network||source.wallet_scope!==e.sourceScope||source.currency_code!==e.currency||asset.asset_id!==e.assetId||
    Number(asset.decimals)!==e.decimals||(asset.contract_address||'').toLowerCase()!==(e.contract||'').toLowerCase()||
    String(wallet.address_id)!==String(a.address_id)||!sameAddress(wallet.public_address,i.from))fault('CRYPTO_REVIEW_CHANGED','review');
   const recipients=(await db.query('SELECT user_id FROM avis_core_v2.user_deposit_addresses WHERE network=$1 AND lower(public_address)=lower($2) FOR SHARE',[a.network,e.recipient])).rows;
   if(recipients.length>1||(recipients[0]?String(recipients[0].user_id):null)!==e.recipientUserId)fault('CRYPTO_REVIEW_CHANGED','review');
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['chain-signer:'+a.address_id]);
   if((await db.query("SELECT 1 FROM avis_core_v2.crypto_chain_actions WHERE address_id=$1 AND action_id<>$2 AND status IN ('SIGNED','SUBMITTED')",[a.address_id,a.action_id])).rows.length)fault('CRYPTO_ACTION_ACTIVE','cryptoAccount');
   await this.assertWalletFunds(db,e.requirements,true);
   await this.chain.check(a.network);
   const provider=this.chain.provider(a.network);let nonce,nativeBalance,tokenBalance;
   try{
    nonce=await provider.getTransactionCount(i.from,'pending');
    nativeBalance=await provider.getBalance(i.from,'pending');
    tokenBalance=e.contract?BigInt(await provider.call({to:e.contract,data:tokenABI.encodeFunctionData('balanceOf',[i.from])})):nativeBalance;
   }finally{provider.destroy();}
   if(tokenBalance<BigInt(e.quantity))fault('CRYPTO_CHAIN_BALANCE','amount');
   if(nativeBalance<BigInt(i.value)+units(e.gasMaximum))fault('CRYPTO_GAS_BALANCE','amount');
   const secret=decryptKey(wallet.encrypted_key,'wallet:'+wallet.user_id+':'+wallet.network,this.secretEnv),signer=new Wallet(secret.privateKey);
   if(!sameAddress(signer.address,i.from))fault('CRYPTO_SIGNING_KEY','cryptoAccount');
   const holds=[];
   for(const h of [
    {kind:'PRINCIPAL',currency:e.currency,scope:e.sourceScope,amount:e.amount,source:e.sourceAccountId,backing:e.backingAccountId},
    {kind:'GAS',currency:'ETH',scope:'FUNDING',amount:e.gasMaximum,source:e.gasAccountId,backing:e.gasBackingAccountId}
   ]){
    const bucket=(h.kind==='GAS'?'G:':'P:')+r.request_id;
    h.suspense=await cryptoLedgerAccount(db,{owner:'SUSPENSE_OUTBOUND',currency:h.currency,network:a.network,bucket,scope:h.scope});
    h.reservedAsset=await cryptoLedgerAccount(db,{owner:'HOT_WALLET',currency:h.currency,network:a.network,bucket,category:'ASSET'});
    holds.push(h);
   }
   const lines=holds.flatMap(h=>[line(h.source,'DEBIT',h.amount),line(h.suspense,'CREDIT',h.amount),line(h.backing,'CREDIT',h.amount),line(h.reservedAsset,'DEBIT',h.amount)]);
   const journalId=await this.post(db,actor,'wallet-reserve:'+r.request_id,'CRYPTO_WALLET_RESERVE',r.instruction.reference,compact(lines));
   // Legacy manual settlement can use HOT_WALLET assets. Keep this backing
   // unavailable to that route until this exact signed transaction settles.
   for(const h of holds){
    const reserved=await db.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=$2 WHERE account_id=$1 AND locked_balance=0 AND available_balance=$2 RETURNING account_id',[h.reservedAsset,h.amount]);
    if(!reserved.rows.length)fault('CRYPTO_CUSTODY_BALANCE','cryptoAccount');
   }
   const tx={to:i.to,data:i.data,value:BigInt(i.value),chainId:i.chainId,nonce,gasLimit:BigInt(i.gasLimit),
    ...(i.legacy?{type:0,gasPrice:BigInt(i.maxFeePerGas)}:{type:2,maxFeePerGas:BigInt(i.maxFeePerGas),maxPriorityFeePerGas:BigInt(i.maxPriorityFeePerGas)})};
   const signed=await signer.signTransaction(tx),txHash=Transaction.from(signed).hash;
   await db.query("UPDATE avis_core_v2.crypto_chain_actions SET status='SIGNED',signed_transaction=$2,tx_hash=$3,reservations=$4 WHERE action_id=$1",[a.action_id,signed,txHash,JSON.stringify(holds)]);
   await db.query("UPDATE avis_core_v2.asset_transfer_requests SET status='OUTGOING',reservation_journal_id=$2,submitted_at=now() WHERE request_id=$1",[r.request_id,journalId]);
   return {id:r.request_id,actionId:a.action_id};
  });
  const a=(await this.pool.query('SELECT status FROM avis_core_v2.crypto_chain_actions WHERE action_id=$1',[result.actionId])).rows[0];
  if(a&&pending(a.status)){
   // A lost response is not a failed payment. The committed outbox owns retry.
   try{await this.broadcastWalletAction(actor,{actionId:result.actionId});}catch(e){if(e.code!=='CRYPTO_CONNECTOR')throw e;}
  }
  return this.paymentRequest(actor,result.id);
 }

 async paymentRequest(actor,id){
  const r=await super.paymentRequest(actor,id);
  if(r.delivery_mode!=='BLOCKCHAIN')return r;
  access(actor,r.source_user_id);
  const a=(await this.pool.query('SELECT status,tx_hash,receipt FROM avis_core_v2.crypto_chain_actions WHERE request_id=$1',[id])).rows[0];
  return {...r,chain_status:a?.status||null,tx_hash:a?.tx_hash||null,confirmations:a?.receipt?.confirmations??null,gas_fee:a?.receipt?.gasFee??null};
 }

 async cancelPayment(actor,input,key){
  const row=(await this.pool.query('SELECT delivery_mode FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1',[input.requestId])).rows[0];
  if(row?.delivery_mode!=='BLOCKCHAIN')return super.cancelPayment(actor,input,key);
  return this.operation(actor,'CANCEL_WALLET_REVIEW',input,key,async db=>{
   const r=(await db.query('SELECT * FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];access(actor,r.source_user_id);
   if(r.actor_id!==actor.id)fault('PAYMENT_REQUEST_NOT_FOUND','requestId',404);
   if(r.status==='CANCELLED')return {id:r.request_id,status:'CANCELLED'};
   const a=(await db.query('SELECT * FROM avis_core_v2.crypto_chain_actions WHERE request_id=$1 FOR UPDATE',[r.request_id])).rows[0];
   if(r.status!=='REVIEW'||!a||a.status!=='REVIEW')fault('PAYMENT_REQUEST_CLOSED','requestId',409);
   await db.query("UPDATE avis_core_v2.crypto_chain_actions SET status='EXPIRED' WHERE action_id=$1",[a.action_id]);
   await db.query("UPDATE avis_core_v2.asset_transfer_requests SET status='CANCELLED' WHERE request_id=$1",[r.request_id]);
   return {id:r.request_id,status:'CANCELLED'};
  });
 }

 async broadcastCryptoAction(actor,input){
  const a=(await this.pool.query('SELECT action_type FROM avis_core_v2.crypto_chain_actions WHERE action_id=$1',[input.actionId])).rows[0];
  return a?.action_type==='WALLET_SEND'?this.broadcastWalletAction(actor,input):super.broadcastCryptoAction(actor,input);
 }

 async submitCryptoAction(actor,input,key){
  const a=(await this.pool.query('SELECT action_type FROM avis_core_v2.crypto_chain_actions WHERE action_id=$1',[input.actionId])).rows[0];
  if(a?.action_type==='WALLET_SEND')fault('CRYPTO_ACTION_REQUIRED','actionId');
  return super.submitCryptoAction(actor,input,key);
 }

 async cancelCryptoReview(actor,input,key){
  const a=(await this.pool.query('SELECT action_type,request_id FROM avis_core_v2.crypto_chain_actions WHERE action_id=$1',[input.actionId])).rows[0];
  if(a?.action_type==='WALLET_SEND')return this.cancelPayment(actor,{requestId:a.request_id},key);
  return super.cancelCryptoReview(actor,input,key);
 }

 async pickupTransfer(actor,input,key){
  const r=(await this.pool.query('SELECT delivery_mode FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1',[input.requestId])).rows[0];
  if(r?.delivery_mode==='BLOCKCHAIN')fault('PAYMENT_REQUEST_CLOSED','requestId');
  return super.pickupTransfer(actor,input,key);
 }

 async broadcastWalletAction(actor,{actionId}){
  const r=(await this.pool.query('SELECT * FROM avis_core_v2.crypto_chain_actions WHERE action_id=$1',[actionId])).rows[0];
  if(!r||r.action_type!=='WALLET_SEND'||!pending(r.status))fault('CRYPTO_ACTION_REQUIRED','actionId');
  access(actor,r.user_id);
  if(Transaction.from(r.signed_transaction).hash!==r.tx_hash)fault('CRYPTO_RECEIPT','actionId');
  await this.chain.check(r.network);const provider=this.chain.provider(r.network);
  try{
   try{await provider.broadcastTransaction(r.signed_transaction);}
   catch{let known;try{known=await provider.getTransaction(r.tx_hash);}catch{}if(!known)fault('CRYPTO_CONNECTOR','network');}
   await this.pool.query("UPDATE avis_core_v2.crypto_chain_actions SET status='SUBMITTED' WHERE action_id=$1 AND status='SIGNED'",[actionId]);
   return {id:actionId,txHash:r.tx_hash,status:'SUBMITTED'};
  }finally{provider.destroy();}
 }

 async confirmCryptoAction(actor,input,key){
  const a=(await this.pool.query('SELECT action_type FROM avis_core_v2.crypto_chain_actions WHERE action_id=$1',[input.actionId])).rows[0];
  return a?.action_type==='WALLET_SEND'?this.confirmWalletAction(actor,input,key):super.confirmCryptoAction(actor,input,key);
 }

 async walletReceiptObservation(network,txHash){
  await this.chain.check(network);const provider=this.chain.provider(network);
  try{
   const receipt=await provider.getTransactionReceipt(txHash);
   if(!receipt)return {receipt:null,confirmations:0,finalized:null};
   const [height,block,head]=await Promise.all([provider.getBlockNumber(),provider.getBlock(receipt.blockNumber),provider.getBlock('finalized').catch(()=>null)]);
   const confirmations=Math.max(0,height-receipt.blockNumber+1);
   let finalized=null;
   if(block?.hash===receipt.blockHash&&confirmations>=12&&head&&Number.isSafeInteger(head.number)&&head.number>=receipt.blockNumber&&head.number<=height&&/^0x[0-9a-f]{64}$/i.test(head.hash)){
    const canonical=await provider.getBlock(head.number);
    if(canonical?.hash===head.hash)finalized={number:head.number,hash:head.hash};
   }
   return {receipt,block,confirmations,finalized};
  }finally{provider.destroy();}
 }

 async confirmWalletAction(actor,input,key){
  system(actor);
  const a=(await this.pool.query('SELECT * FROM avis_core_v2.crypto_chain_actions WHERE action_id=$1',[input.actionId])).rows[0];
  if(!a||a.action_type!=='WALLET_SEND')fault('CRYPTO_ACTION_REQUIRED','actionId');
  if(['CONFIRMED','FAILED'].includes(a.status))return {id:a.action_id,status:a.status,txHash:a.tx_hash,journalId:a.journal_id};
  if(!pending(a.status))fault('CRYPTO_ACTION_REQUIRED','actionId');
  const observed=await this.walletReceiptObservation(a.network,a.tx_hash),receipt=observed.receipt;
  let confirmations=observed.confirmations;
  if(!observed.finalized)return {id:a.action_id,status:a.status,confirmations};
  const signed=Transaction.from(a.signed_transaction),i=a.instruction,e=i.expected;
  if(signed.hash!==a.tx_hash||receipt.hash!==a.tx_hash||!sameAddress(signed.from,i.from)||!sameAddress(receipt.from,i.from)||
   !sameAddress(signed.to,i.to)||!sameAddress(receipt.to,i.to)||signed.data!==i.data||signed.value!==BigInt(i.value)||signed.chainId!==BigInt(i.chainId)||
   ![0,1].includes(receipt.status)||receipt.gasUsed>BigInt(i.gasLimit)||receipt.gasPrice>BigInt(i.maxFeePerGas))fault('CRYPTO_RECEIPT','actionId');
  const gasFee=receipt.gasUsed*receipt.gasPrice;
  if(gasFee<0n||gasFee>units(e.gasMaximum))fault('CRYPTO_RECEIPT','actionId');
  let eventIndex=0;
  if(receipt.status===1&&e.contract){
   const transfers=walletTransfers(receipt,e.contract);
   const exact=transfers.find(({event})=>sameAddress(event.args.from,i.from)&&sameAddress(event.args.to,e.recipient)&&event.args.value===BigInt(e.quantity));
   const netDebit=transfers.reduce((sum,{event})=>sum+(sameAddress(event.args.from,i.from)?event.args.value:0n)-(sameAddress(event.args.to,i.from)?event.args.value:0n),0n);
   const netCredit=transfers.reduce((sum,{event})=>sum+(sameAddress(event.args.to,e.recipient)?event.args.value:0n)-(sameAddress(event.args.from,e.recipient)?event.args.value:0n),0n);
   if(!exact||netDebit!==BigInt(e.quantity)||netCredit!==BigInt(e.quantity))fault('CRYPTO_RECEIPT','actionId');eventIndex=exact.index;
  }
  try{return await this.operation(actor,'CONFIRM_WALLET_TRANSFER',input,key,async db=>{
   const r=(await db.query('SELECT * FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1 FOR UPDATE',[a.request_id])).rows[0];
   const current=(await db.query('SELECT * FROM avis_core_v2.crypto_chain_actions WHERE action_id=$1 FOR UPDATE',[a.action_id])).rows[0];
   if(['CONFIRMED','FAILED'].includes(current.status))return {id:current.action_id,status:current.status,txHash:current.tx_hash,journalId:current.journal_id};
   if(!pending(current.status)||r.status!=='OUTGOING')fault('CRYPTO_ACTION_REQUIRED','actionId');
   // Check canonicality and the finalized checkpoint again while the durable
   // request/action locks are held. A pending result must not cache the worker's
   // idempotency key, so roll this transaction back before returning it.
   const proof=await this.walletReceiptObservation(a.network,a.tx_hash);confirmations=proof.confirmations;
   if(!proof.finalized||proof.receipt.blockHash!==receipt.blockHash)fault('CRYPTO_FINALITY_PENDING','actionId');
   if(receiptHash(proof.receipt)!==receiptHash(receipt))fault('CRYPTO_RECEIPT','actionId');
   const principal=current.reservations.find(h=>h.kind==='PRINCIPAL'),gas=current.reservations.find(h=>h.kind==='GAS');
   if(!principal||!gas)fault('CRYPTO_RECEIPT','actionId');
   for(const h of [principal,gas]){
    const released=await db.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=0 WHERE account_id=$1 AND available_balance=$2 AND locked_balance=$2 RETURNING account_id',[h.reservedAsset,h.amount]);
    if(!released.rows.length)fault('CRYPTO_RECEIPT','actionId');
   }
   const lines=[];
   if(receipt.status===0){
    lines.push(line(principal.suspense,'DEBIT',principal.amount),line(principal.source,'CREDIT',principal.amount),line(principal.reservedAsset,'CREDIT',principal.amount),line(principal.backing,'DEBIT',principal.amount));
   }else if(e.recipientUserId){
    const recipient=(await db.query('SELECT public_address FROM avis_core_v2.user_deposit_addresses WHERE user_id=$1 AND network=$2',[e.recipientUserId,a.network])).rows[0];
    if(!recipient||!sameAddress(recipient.public_address,e.recipient))fault('CRYPTO_RECEIPT','actionId');
    if(!['FUNDING','CUSTODY'].includes(e.recipientScope))fault('CRYPTO_RECEIPT','actionId');
    const target=await cryptoLedgerAccount(db,{userId:e.recipientUserId,currency:e.currency,network:a.network,scope:e.recipientScope});
    lines.push(line(principal.suspense,'DEBIT',principal.amount),line(target,'CREDIT',principal.amount),line(principal.reservedAsset,'CREDIT',principal.amount),line(principal.backing,'DEBIT',principal.amount));
   }else lines.push(line(principal.suspense,'DEBIT',principal.amount),line(principal.reservedAsset,'CREDIT',principal.amount));
   lines.push(line(gas.suspense,'DEBIT',gas.amount),line(gas.reservedAsset,'CREDIT',gas.amount));
   const refund=units(gas.amount)-gasFee;
   if(refund>0n)lines.push(line(gas.source,'CREDIT',decimal(refund)),line(gas.backing,'DEBIT',decimal(refund)));
   const journalId=await this.post(db,actor,'wallet-settle:'+r.request_id,receipt.status===1?'CRYPTO_WALLET_SENT':'CRYPTO_WALLET_REVERTED',r.instruction.reference,compact(lines));
   const status=receipt.status===1?'CONFIRMED':'FAILED',result={block:receipt.blockNumber,blockHash:receipt.blockHash,confirmations,finality:'FINALIZED',finalizedBlockNumber:proof.finalized.number,finalizedBlockHash:proof.finalized.hash,gasFee:formatUnits(gasFee,18),txHash:a.tx_hash,status:receipt.status};
   await db.query("INSERT INTO avis_core_v2.onchain_transactions(user_id,journal_id,tx_type,network,tx_hash,event_index,from_address,to_address,currency_code,asset_contract,amount,status,block_timestamp) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",[a.user_id,journalId,e.recipientUserId?'WALLET_INTERNAL':'WALLET_SEND',a.network,a.tx_hash,eventIndex,i.from,e.recipient,e.currency,e.contract,e.amount,status,new Date(proof.block.timestamp*1000)]);
   await db.query('UPDATE avis_core_v2.crypto_chain_actions SET status=$2,receipt=$3,journal_id=$4 WHERE action_id=$1',[a.action_id,status,JSON.stringify(result),journalId]);
   await db.query('UPDATE avis_core_v2.asset_transfer_requests SET status=$2,settlement_journal_id=$3,completed_at=now() WHERE request_id=$1',[r.request_id,receipt.status===1?'COMPLETED':'FAILED',journalId]);
   return {id:a.action_id,status,txHash:a.tx_hash,journalId};
  });}catch(error){if(error.code==='CRYPTO_FINALITY_PENDING')return {id:a.action_id,status:a.status,confirmations};throw error;}
 }
}
