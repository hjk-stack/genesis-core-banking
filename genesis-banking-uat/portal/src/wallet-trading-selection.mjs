import {fault} from './core.mjs';

export const WALLET_SELECTION_MESSAGES = {
 CRYPTO_TRADING_ALLOWANCE: 'Authorize a positive trading allowance for this wallet first.',
 CRYPTO_TRADING_SELECTION_CHANGED: 'This wallet selection changed. Refresh this coin and retry.',
 CRYPTO_TRADING_ALLOWANCE_CHANGED: 'The reserved trading allowance changed. Review this wallet allocation.'
};
const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const authorize = actor => {
 if (!actor?.admin || !actor.id) fault('FORBIDDEN', null, 403);
};

// One entry per original account, never per ticker alone. Two owners or two
// blockchains must not share a selection merely because their symbols match.
export async function walletTradingAllowances(pool, actor) {
 authorize(actor);
 return (await pool.query(`SELECT a.account_id,a.user_id,u.full_name,
  a.currency_code,a.network,COALESCE(asset.name,a.currency_code) AS name,
  asset.asset_id,asset.icon_url,d.quantity::text,d.consent_count,
  COALESCE(s.enabled,false) AS enabled,COALESCE(s.version,0) AS version,
  s.updated_at,a.locked_balance::text
  FROM avis_core_v2.ledger_accounts a
  JOIN avis_core_v2.sovereign_users u ON u.user_id=a.user_id
  JOIN LATERAL (
   SELECT sum(w.quantity) AS quantity,count(*)::integer AS consent_count
   FROM avis_core_v2.wallet_trading_delegations w
   WHERE w.account_id=a.account_id AND w.user_id=a.user_id
    AND w.currency_code=a.currency_code AND w.network=a.network AND w.state='ACTIVE'
  ) d ON d.quantity>0
  LEFT JOIN avis_core_v2.wallet_trading_selections s USING(account_id)
  LEFT JOIN LATERAL (
   SELECT c.asset_id,c.name,c.icon_url FROM avis_core_v2.crypto_assets c
   WHERE c.currency_code=a.currency_code ORDER BY c.asset_id LIMIT 1
  ) asset ON true
  WHERE a.owner_type='USER' AND a.wallet_scope='FUNDING'
   AND a.account_category='LIABILITY' AND a.network IS NOT NULL
   AND ($1::bigint IS NULL OR a.user_id=$1)
  ORDER BY d.quantity DESC,a.currency_code,a.network,a.user_id,a.account_id`,
 [actor.customerUserId || null])).rows;
}

export async function setWalletTradingSelection(core, actor, input, key) {
 authorize(actor);
 if (!validId(input?.accountId)) fault('INVALID_FIELD', 'accountId');
 if (typeof input.enabled !== 'boolean') fault('INVALID_FIELD', 'enabled');
 if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
  fault('INVALID_FIELD', 'expectedVersion');
 const intent = {accountId: input.accountId, enabled: input.enabled, expectedVersion: input.expectedVersion};
 return core.operation(actor, 'SELECT_WALLET_FOR_ROBOT', intent, key, async db => {
  // The same account lock serializes allocation, selection and allowance release.
  const account = (await db.query(`SELECT account_id,user_id,currency_code,network,
   owner_type,wallet_scope,account_category,available_balance,locked_balance
   FROM avis_core_v2.ledger_accounts WHERE account_id=$1 FOR UPDATE`, [intent.accountId])).rows[0];
  if (!account || actor.customerUserId && String(account.user_id) !== String(actor.customerUserId))
   fault('FORBIDDEN', 'accountId', 403);
  if (account.owner_type !== 'USER' || account.wallet_scope !== 'FUNDING' ||
      account.account_category !== 'LIABILITY' || !account.network)
   fault('CRYPTO_WALLET_REQUIRED', 'accountId');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['wallet-trading:'+String(account.user_id)+':'+String(account.currency_code).toLowerCase()]);
  const current = (await db.query(`SELECT enabled,version FROM avis_core_v2.wallet_trading_selections
   WHERE account_id=$1 FOR UPDATE`, [intent.accountId])).rows[0];
  if ((current?.version || 0) !== intent.expectedVersion)
   fault('CRYPTO_TRADING_SELECTION_CHANGED', 'accountId', 409);
  const allowance = (await db.query(`SELECT COALESCE(sum(quantity),0)::text AS quantity,
   COALESCE(sum(quantity),0)>0 AS positive,
   COALESCE(sum(quantity),0)<=$5::numeric AND COALESCE(sum(quantity),0)<=$6::numeric AS covered
   FROM avis_core_v2.wallet_trading_delegations
   WHERE account_id=$1 AND user_id=$2 AND currency_code=$3 AND network=$4 AND state='ACTIVE'`,
  [account.account_id,account.user_id,account.currency_code,account.network,account.locked_balance,account.available_balance])).rows[0];
  if (intent.enabled && !allowance.positive) fault('CRYPTO_TRADING_ALLOWANCE', 'accountId');
  if (intent.enabled && !allowance.covered) fault('CRYPTO_TRADING_ALLOWANCE_CHANGED', 'accountId');
  const row = (await db.query(`INSERT INTO avis_core_v2.wallet_trading_selections
   (account_id,enabled,updated_by) VALUES($1,$2,$3)
   ON CONFLICT(account_id) DO UPDATE SET enabled=EXCLUDED.enabled,
    version=wallet_trading_selections.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()
   RETURNING account_id,enabled,version,updated_at`, [intent.accountId,intent.enabled,actor.id])).rows[0];
  // Selecting a coin neither moves money nor reserves its allowance a second time.
  return {...row,currency_code:account.currency_code,network:account.network,quantity:allowance.quantity};
 });
}
