import {fault} from './core.mjs';

// A recorded asset route takes precedence over the generic per-network address.
// A missing key on that exact route must never fall through to another address.
export async function assetReceivingWallet(db,userId,network,assetId,{lock=false}={}){
 return (await db.query(`SELECT d.* FROM avis_core_v2.user_deposit_addresses d
  WHERE d.user_id=$1 AND d.network=$2 AND
   (d.address_id=(SELECT r.address_id FROM avis_core_v2.crypto_asset_wallet_routes r
     WHERE r.user_id=$1 AND r.network=$2 AND r.asset_id=$3)
    OR (d.is_primary AND NOT EXISTS (SELECT 1 FROM avis_core_v2.crypto_asset_wallet_routes r
     WHERE r.user_id=$1 AND r.network=$2 AND r.asset_id=$3)))`+(lock?' FOR SHARE OF d':''),
  [userId,network,assetId])).rows[0]||null;
}

export async function existingFundingAccount(core,db,userId,asset){
 const rows=(await db.query(`SELECT l.account_id,l.sub_account_code,l.available_balance::text,
    l.locked_balance::text,(l.available_balance<>0 OR l.locked_balance<>0) AS funded
   FROM avis_core_v2.ledger_accounts l WHERE l.owner_type='USER' AND l.user_id=$1
    AND l.currency_code=$2 AND l.network=$3 AND l.wallet_scope='FUNDING'
    AND l.account_category='LIABILITY' ORDER BY l.account_id FOR UPDATE`,
   [userId,asset.currency_code,asset.network])).rows;
 const funded=rows.filter(r=>r.funded);
 if(funded.length>1)fault('CRYPTO_ACCOUNT_AMBIGUOUS','assetId',409);
 const active=(await db.query(`SELECT account_id FROM avis_core_v2.crypto_activations
   WHERE user_id=$1 AND asset_id=$2 AND network=$3`,[userId,asset.asset_id,asset.network])).rows[0];
 const selected=funded[0]||rows.find(r=>r.account_id===active?.account_id)||
   rows.find(r=>r.sub_account_code==='CRYPTO')||(rows.length===1?rows[0]:null);
 if(!selected&&rows.length)fault('CRYPTO_ACCOUNT_AMBIGUOUS','assetId',409);
 const accountId=selected?.account_id||await core.networkAccount(db,'USER',asset.currency_code,asset.network,'CRYPTO',userId);
 await db.query('UPDATE avis_core_v2.ledger_accounts SET wallet_visible=true WHERE account_id=$1',[accountId]);
 // Empty duplicate cards can be archived; their account, movements and keys remain.
 await db.query(`UPDATE avis_core_v2.ledger_accounts SET wallet_visible=false WHERE
   account_id=ANY($1::uuid[]) AND account_id<>$2 AND available_balance=0 AND locked_balance=0`,
   [rows.map(r=>r.account_id),accountId]);
 return accountId;
}

export async function cryptoWalletRows(db,actor){
 return (await db.query(`SELECT l.account_id,l.user_id,u.full_name,u.account_role,l.currency_code,
  l.network,l.wallet_scope,l.wallet_visible,l.available_balance::text,l.locked_balance::text,
  a.asset_id,a.name,a.icon_url,n.contract_address,n.decimals,d.address_id,d.public_address,d.destination_tag,
  p.historical_wallet_address,p.source_url AS historical_source_url,p.transaction_hash AS historical_transaction_hash
  FROM avis_core_v2.ledger_accounts l JOIN avis_core_v2.sovereign_users u USING(user_id)
  LEFT JOIN avis_core_v2.crypto_assets a ON a.currency_code=l.currency_code
  LEFT JOIN avis_core_v2.crypto_asset_networks n ON n.asset_id=a.asset_id AND n.network=l.network
  LEFT JOIN avis_core_v2.crypto_asset_wallet_routes r ON r.user_id=l.user_id AND r.asset_id=a.asset_id AND r.network=l.network
  LEFT JOIN avis_core_v2.user_deposit_addresses d ON d.user_id=l.user_id AND d.network=l.network
   AND (d.address_id=r.address_id OR (r.address_id IS NULL AND d.is_primary))
  LEFT JOIN avis_core_v2.crypto_asset_provenance p ON p.user_id=l.user_id AND p.asset_id=a.asset_id AND p.network=l.network
  WHERE l.owner_type='USER' AND l.network IS NOT NULL AND l.wallet_scope IN ('FUNDING','CUSTODY')
   AND l.account_category='LIABILITY' AND ($1::bigint IS NULL OR l.user_id=$1)
  ORDER BY l.user_id,a.market_rank NULLS LAST,l.currency_code,l.network,l.account_id`,[actor.customerUserId||null])).rows;
}

export async function enrichPortfolioHistory(db,actor,rows){
 const history=(await db.query(`SELECT a.currency_code,p.* FROM avis_core_v2.crypto_asset_provenance p
   JOIN avis_core_v2.crypto_assets a USING(asset_id)
   JOIN avis_core_v2.sovereign_users u USING(user_id)
   WHERE (($1::bigint IS NULL AND u.account_role='INSTITUTION') OR p.user_id=$1)
   ORDER BY p.user_id,p.asset_id,p.network`,[actor.customerUserId||null])).rows;
 return rows.map(row=>{
  const records=history.filter(p=>p.currency_code===row.currency_code&&p.network===row.network);
  if(!records.length)return row;
  return {...row,smart_contract:[...new Set(records.map(p=>p.contract_address))].join('\n'),
   historical_wallet_address:[...new Set(records.map(p=>p.historical_wallet_address))].join('\n'),
   historical_proof:records.map(p=>({contractAddress:p.contract_address,walletAddress:p.historical_wallet_address,
    transactionHash:p.transaction_hash,url:p.source_url,sourceRecord:p.source_record}))};
 });
}
