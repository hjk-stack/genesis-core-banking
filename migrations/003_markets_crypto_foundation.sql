-- GENESIS Markets and Crypto development-only migration; requires 001_foundation.sql.
-- REVIEW ONLY. No auto-migration, no operational custody or live trading.
BEGIN;
CREATE TABLE IF NOT EXISTS banking.custody_accounts (
 id uuid PRIMARY KEY,
 customer_id uuid NOT NULL REFERENCES banking.customers(id),
 provider varchar(80) NOT NULL, external_reference varchar(80) NOT NULL,
 status text NOT NULL CHECK(status IN ('pending_review','active','suspended','closed')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,external_reference)
);
CREATE TABLE IF NOT EXISTS banking.market_orders (
 id uuid PRIMARY KEY,
 custody_account_id uuid NOT NULL REFERENCES banking.custody_accounts(id),
 asset_class text NOT NULL CHECK(asset_class IN ('equity','bond','future','option')),
 venue varchar(80) NOT NULL, instrument varchar(80) NOT NULL,
 side text NOT NULL CHECK(side IN ('buy','sell')),
 quantity_atomic bigint NOT NULL CHECK(quantity_atomic>0),
 price_atomic bigint NOT NULL CHECK(price_atomic>0),
 client_order_id varchar(80) NOT NULL UNIQUE,
 status text NOT NULL CHECK(status IN ('draft','pending_review','rejected','cancelled')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS banking.derivative_contracts (
 id uuid PRIMARY KEY,
 custody_account_id uuid NOT NULL REFERENCES banking.custody_accounts(id),
 kind text NOT NULL CHECK(kind IN ('future','option','forward','swap')),
 underlying varchar(80) NOT NULL, contract_reference varchar(80) NOT NULL,
 settlement_asset varchar(80) NOT NULL, expiry_date date NOT NULL,
 option_right text CHECK(option_right IN ('call','put')),
 status text NOT NULL CHECK(status IN ('draft','pending_review','rejected','cancelled')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='option' AND option_right IS NOT NULL) OR (kind<>'option' AND option_right IS NULL))
);
CREATE TABLE IF NOT EXISTS banking.custody_position_snapshots (
 id uuid PRIMARY KEY,
 custody_account_id uuid NOT NULL REFERENCES banking.custody_accounts(id),
 instrument varchar(80) NOT NULL, quantity_atomic numeric(38,0) NOT NULL,
 observed_at timestamptz NOT NULL, source_reference text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(custody_account_id,instrument,observed_at,source_reference)
);
CREATE TABLE IF NOT EXISTS banking.crypto_assets (
 network varchar(32) NOT NULL, symbol varchar(16) NOT NULL,
 decimals integer NOT NULL CHECK(decimals BETWEEN 0 AND 30),
 status text NOT NULL CHECK(status IN ('pending_review','approved','disabled')),
 PRIMARY KEY(network,symbol)
);
CREATE TABLE IF NOT EXISTS banking.crypto_transfer_drafts (
 id uuid PRIMARY KEY,
 custody_account_id uuid NOT NULL REFERENCES banking.custody_accounts(id),
 network varchar(32) NOT NULL, symbol varchar(16) NOT NULL,
 amount_atomic numeric(38,0) NOT NULL CHECK(amount_atomic>0),
 destination_address varchar(256) NOT NULL, idempotency_key varchar(80) NOT NULL UNIQUE,
 status text NOT NULL CHECK(status IN ('draft','pending_review','rejected','cancelled')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(network,symbol) REFERENCES banking.crypto_assets(network,symbol)
);
CREATE TABLE IF NOT EXISTS banking.exchange_venues (
 venue varchar(80) PRIMARY KEY, protocol text NOT NULL CHECK(protocol IN ('FIX','REST','ISO20022')),
 connection_status text NOT NULL DEFAULT 'disabled' CHECK(connection_status IN ('disabled','pending_review'))
);
COMMIT;
