-- Wallet cards are reversible display records, not disposable financial accounts.
-- Never remove ledger entries, key material, address bindings or transaction history.
ALTER TABLE avis_core_v2.ledger_accounts
 ADD COLUMN IF NOT EXISTS wallet_visible boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS ledger_accounts_wallet_visible_idx
 ON avis_core_v2.ledger_accounts (user_id, network, wallet_visible)
 WHERE owner_type='USER' AND network IS NOT NULL;
