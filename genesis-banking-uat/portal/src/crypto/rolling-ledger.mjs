import {Interface,formatUnits} from 'ethers';
import {fault,money,decimal} from '../core.mjs';
const U=v=>/^0(?:\.0+)?$/.test(String(v))?0n:money(String(v));
export async function cryptoLedgerAccount(db,{owner='USER',userId=null,currency,network,bucket='CRYPTO',scope='FUNDING',category='LIABILITY'}){
 await db.query('INSERT INTO avis_core_v2.ledger_accounts(owner_type,user_id,sub_account_code,currency_code,network,wallet_scope,account_category) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[owner,userId,bucket,currency,network,scope,category]);return (await db.query('SELECT account_id FROM avis_core_v2.ledger_accounts WHERE owner_type=$1 AND user_id IS NOT DISTINCT FROM $2 AND sub_account_code=$3 AND currency_code=$4 AND network=$5 AND wallet_scope=$6',[owner,userId,bucket,currency,network,scope])).rows[0].account_id;
}
export async function reserveRollingFunds(db,action,card){
 const expected=action.instruction.expected,holds=[];
 if(action.action_type==='LOCK'){const r=(await db.query('SELECT security_amount FROM avis_core_v2.crypto_rolling_channels WHERE channel_id=$1',[expected.channelId])).rows[0];holds.push({accountId:await cryptoLedgerAccount(db,{userId:card.user_id,currency:card.symbol,network:card.network,scope:'CUSTODY'}),amount:r.security_amount,collateral:true});}
 if(['ROLL','BATCH'].includes(action.action_type)){const ids=expected.batch||[expected.channelId],r=(await db.query('SELECT sum(gross_value)::text AS amount FROM avis_core_v2.crypto_rolling_channels WHERE channel_id=ANY($1::uuid[])',[ids])).rows[0];holds.push({accountId:await cryptoLedgerAccount(db,{userId:card.user_id,currency:expected.settlementAsset,network:card.network}),amount:r.amount,collateral:false});}
 for(const h of holds){const result=await db.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=locked_balance+$2 WHERE account_id=$1 AND available_balance-locked_balance>=$2 RETURNING account_id',[h.accountId,h.amount]);if(!result.rows.length)fault('INSUFFICIENT_FUNDS','accountId');}
 return holds;
}
export async function releaseRollingReservation(db,action,failed=false){for(const h of action.reservations||[])if(failed||!h.collateral)await db.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=locked_balance-$2 WHERE account_id=$1 AND locked_balance>=$2',[h.accountId,h.amount]);}
export async function bookRollingReceipt(core,db,actor,action,card,receipt,tokenABI){
 const T=new Interface(tokenABI),lines=[];const add=(accountId,direction,amount)=>{if(U(amount)>0n)lines.push({accountId,direction,amount});};
 for(const log of receipt.logs){if(log.address.toLowerCase()!==card.contract_address?.toLowerCase())continue;let e;try{e=T.parseLog(log);}catch{continue;}if(!e)continue;
  if(e.name==='MarginCollateralReleased'){const accountId=await cryptoLedgerAccount(db,{userId:card.user_id,currency:card.symbol,network:card.network,scope:'CUSTODY'});const updated=await db.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=locked_balance-$2 WHERE account_id=$1 AND locked_balance>=$2 RETURNING account_id',[accountId,formatUnits(e.args.tokenAmount,18)]);if(!updated.rows.length)fault('CRYPTO_RECEIPT');}
  if(!['RollingTradeInitiatedAndHeld','RollingJournal'].includes(e.name))continue;
  const channel=(await db.query('SELECT * FROM avis_core_v2.crypto_rolling_channels WHERE card_id=$1 AND chain_channel=$2 FOR UPDATE',[card.card_id,e.args.channelId.toString()])).rows[0];if(!channel)fault('CRYPTO_CHANNEL');
  const currency=channel.settlement_asset,network=card.network,userId=card.user_id;
  const cash=await cryptoLedgerAccount(db,{userId,currency,network}),held=await cryptoLedgerAccount(db,{owner:'EXCHANGE_CLEARING',currency,network,bucket:channel.channel_id}),backing=await cryptoLedgerAccount(db,{owner:'HOT_WALLET',currency,network,bucket:'CHAIN_CUSTODY',category:'ASSET'}),vault=await cryptoLedgerAccount(db,{owner:'HOT_WALLET',currency,network,bucket:channel.channel_id,category:'ASSET'});
  if(e.name==='RollingTradeInitiatedAndHeld'){const gross=formatUnits(e.args.grossValue,18);add(cash,'DEBIT',gross);add(held,'CREDIT',gross);add(vault,'DEBIT',gross);add(backing,'CREDIT',gross);}
  else {const net=formatUnits(e.args.netPaid,18),fee=formatUnits(e.args.fee,18),gross=decimal(e.args.netPaid+e.args.fee),revenue=await cryptoLedgerAccount(db,{owner:'REVENUE',currency,network,bucket:'ROLLING_FEES',category:'REVENUE'});add(held,'DEBIT',gross);add(cash,'CREDIT',net);add(revenue,'CREDIT',fee);add(backing,'DEBIT',gross);add(vault,'CREDIT',gross);}
 }
 // Net repeated accounts before posting: next-leg settlement and the new hold are atomic.
 const net=new Map();for(const l of lines)net.set(l.accountId,(net.get(l.accountId)||0n)+(l.direction==='DEBIT'?1n:-1n)*U(l.amount));const compact=[...net].filter(([,v])=>v).map(([accountId,v])=>({accountId,direction:v>0n?'DEBIT':'CREDIT',amount:decimal(v>0n?v:-v)}));
 return compact.length?core.post(db,actor,'rolling:'+card.network+':'+action.tx_hash.slice(2),'ROLLING_CHAIN_SETTLEMENT',action.tx_hash,compact):null;
}
