-- Explicit incoming receipts only. A claim remains stable when a transaction's
-- block-global log indexes change; the selected transaction-relative ordinals
-- and canonical block identity are retained with the journal.
CREATE TABLE avis_core_v2.crypto_wallet_deposits (
 deposit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users,
 account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts,
 address_id bigint NOT NULL REFERENCES avis_core_v2.user_deposit_addresses,
 asset_id text NOT NULL REFERENCES avis_core_v2.crypto_assets,
 network varchar(32) NOT NULL CHECK(network='ETHEREUM'),
 tx_hash varchar(66) NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
 asset_key varchar(42) NOT NULL CHECK(asset_key='NATIVE' OR asset_key ~ '^0x[0-9a-f]{40}$'),
 currency_code varchar(25) NOT NULL,
 wallet_scope varchar(15) NOT NULL CHECK(wallet_scope IN ('FUNDING','CUSTODY')),
 decimals smallint NOT NULL CHECK(decimals BETWEEN 0 AND 18),
 amount numeric(36,18) NOT NULL CHECK(amount>0 AND amount<>'NaN'::numeric),
 block_number bigint NOT NULL CHECK(block_number>=0),
 block_hash varchar(66) NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 finalized_block_number bigint NOT NULL CHECK(finalized_block_number>=block_number),
 finalized_block_hash varchar(66) NOT NULL CHECK(finalized_block_hash ~ '^0x[0-9a-f]{64}$'),
 confirmations bigint NOT NULL CHECK(confirmations>=12),
 receipt_digest varchar(64) NOT NULL CHECK(receipt_digest ~ '^[0-9a-f]{64}$'),
 event_proofs jsonb NOT NULL CHECK(jsonb_typeof(event_proofs)='array' AND jsonb_array_length(event_proofs)>0),
 journal_id uuid UNIQUE NOT NULL REFERENCES avis_core_v2.ledger_journals,
 reorg_detected_at timestamptz,
 reorg_evidence jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(network,tx_hash,address_id,asset_key)
);
