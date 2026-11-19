-- Durable Ethereum deposit scanning cursor. Balances remain booked only by
-- reconcileCryptoDeposit after canonical finalized receipt verification.
CREATE TABLE avis_core_v2.crypto_deposit_scan_cursor (
 network varchar(32) PRIMARY KEY CHECK (network='ETHEREUM'),
 next_block bigint NOT NULL CHECK(next_block>=0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
