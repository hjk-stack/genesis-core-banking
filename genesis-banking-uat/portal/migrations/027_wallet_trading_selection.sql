-- A selection does not allocate or release money. It references the original
-- wallet account and its existing, authenticated trading consent records.
CREATE TABLE avis_core_v2.wallet_trading_selections (
 account_id uuid PRIMARY KEY REFERENCES avis_core_v2.ledger_accounts(account_id),
 enabled boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_by text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
