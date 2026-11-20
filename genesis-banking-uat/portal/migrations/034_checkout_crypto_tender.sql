CREATE TABLE avis_core_v2.checkout_crypto_tenders (
 asset_id text NOT NULL,network varchar(32) NOT NULL,updated_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(asset_id,network),FOREIGN KEY(asset_id,network) REFERENCES avis_core_v2.crypto_asset_networks
);
ALTER TABLE avis_core_v2.crypto_basket_orders DROP CONSTRAINT crypto_basket_orders_method_check;
ALTER TABLE avis_core_v2.crypto_basket_orders ADD CHECK(method IN ('ACCOUNT','CARD','WIRE','INTERBANK','CRYPTO'));
ALTER TABLE avis_core_v2.crypto_basket_orders ADD COLUMN tender_wallet uuid REFERENCES avis_core_v2.ledger_accounts;
ALTER TABLE avis_core_v2.crypto_basket_lots ADD COLUMN gas_minor bigint CHECK(gas_minor BETWEEN 0 AND cost_minor);
CREATE TABLE avis_core_v2.checkout_store_payments (
 invoice_id uuid PRIMARY KEY,store_key char(64) UNIQUE NOT NULL,terms jsonb NOT NULL,session_id uuid REFERENCES avis_core_v2.crypto_basket_sessions,
 buyer_id bigint REFERENCES avis_core_v2.sovereign_users,wallet_id uuid REFERENCES avis_core_v2.ledger_accounts,quote jsonb,
 quoted_until timestamptz,journal_id uuid UNIQUE REFERENCES avis_core_v2.ledger_journals,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE avis_core_v2.checkout_store_payments ADD COLUMN notified_at timestamptz,ADD COLUMN notify_attempt timestamptz;
