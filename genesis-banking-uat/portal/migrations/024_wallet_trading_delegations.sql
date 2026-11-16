-- Record wallet-denominated robot allocations without fabricating blockchain transfers.
-- The ledger's locked_balance is the authoritative reservation. All changes
-- to this table and the wallet reservation occur within one operation transaction.
CREATE TABLE avis_core_v2.wallet_trading_delegations (
 delegation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts(account_id),
 user_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users(user_id),
 currency_code varchar(25) NOT NULL,
 network varchar(32) NOT NULL,
 quantity numeric(36,18) NOT NULL CHECK(quantity>0),
 consent_text_hash char(64) NOT NULL CHECK(consent_text_hash~'^[0-9a-f]{64}$'),
 consent_at timestamptz NOT NULL DEFAULT now(),
 state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','REVOKED')),
 released_at timestamptz,
 CHECK((state='ACTIVE' AND released_at IS NULL) OR (state='REVOKED' AND released_at IS NOT NULL))
);
CREATE INDEX wallet_trading_delegations_account ON avis_core_v2.wallet_trading_delegations(account_id,state);
CREATE INDEX wallet_trading_delegations_owner ON avis_core_v2.wallet_trading_delegations(user_id,state);
