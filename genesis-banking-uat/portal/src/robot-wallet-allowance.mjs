import {fault,money} from './core.mjs';
const units = value => /^0(?:\.0+)?$/.test(String(value)) ? 0n : money(String(value));
export const ROBOT_WALLET_MESSAGES = {
 CRYPTO_TRADING_SELECTION_REQUIRED: 'Activate this coin in Trade allowances before starting new entries.',
 CRYPTO_TRADING_ALLOWANCE_LIMIT: 'This order exceeds the selected coin trade allowance.'
};

// Existing non-wallet-funded strategies retain their existing limits. Once a
// holder delegates this base asset, new entries also require that holder's
// selected coin allowances. A quote ticker alone never grants permission.
export async function robotWalletAllowance(pool, robot) {
 const row = (await pool.query(`WITH wallets AS (
  SELECT a.account_id,a.available_balance,a.locked_balance,
   COALESCE(s.enabled,false) AS enabled,
   COALESCE(sum(d.quantity) FILTER(WHERE d.state='ACTIVE'),0) AS quantity
  FROM avis_core_v2.ledger_accounts a
  JOIN avis_core_v2.wallet_trading_delegations d ON d.account_id=a.account_id
   AND d.user_id=a.user_id AND d.network=a.network AND d.currency_code=a.currency_code
  LEFT JOIN avis_core_v2.wallet_trading_selections s ON s.account_id=a.account_id
  WHERE a.user_id=$1 AND lower(a.currency_code)=lower($2)
   AND a.owner_type='USER' AND a.wallet_scope='FUNDING' AND a.account_category='LIABILITY'
  GROUP BY a.account_id,a.available_balance,a.locked_balance,s.enabled
 ) SELECT EXISTS(SELECT 1 FROM wallets) AS governed,
 COALESCE(sum(GREATEST(0,LEAST(quantity,locked_balance,available_balance)))
  FILTER(WHERE enabled),0)::text AS quantity FROM wallets`,
 [robot.user_id,robot.base_asset || ''])).rows[0];
 return {governed:row.governed,quantity:row.quantity,allowed:!row.governed || units(row.quantity)>0n};
}

export async function assertRobotWalletAllowance(db, robot, quantity, excludeOrderId=null) {
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
  ['wallet-trading:'+String(robot.user_id)+':'+String(robot.base_asset||'').toLowerCase()]);
 const allowance=await robotWalletAllowance(db,robot);
 if (!allowance.governed) return allowance;
 if (!allowance.allowed) fault('CRYPTO_TRADING_SELECTION_REQUIRED','robotId');
 // Count all positions and outstanding entries for this owner's base asset in
// one database snapshot; a second profile cannot reuse the same allowance.
 const used=(await db.query(`SELECT
  COALESCE((SELECT sum(r.position_quantity) FROM avis_core_v2.trading_robots r
   WHERE r.user_id=$1 AND lower(r.base_asset)=lower($2)),0)::text AS positions,
  COALESCE((SELECT sum(o.quantity) FROM avis_core_v2.trading_robot_orders o
   JOIN avis_core_v2.trading_robots r USING(robot_id)
   WHERE r.user_id=$1 AND lower(r.base_asset)=lower($2) AND o.side='BUY'
    AND o.status IN ('CREATED','DISPATCHING','ACKNOWLEDGED')
    AND ($3::uuid IS NULL OR o.id<>$3)),0)::text AS pending`,
 [robot.user_id,robot.base_asset,excludeOrderId])).rows[0];
 if (units(used.positions)+units(used.pending)+units(quantity)>units(allowance.quantity))
  fault('CRYPTO_TRADING_ALLOWANCE_LIMIT','quantity');
 return allowance;
}
