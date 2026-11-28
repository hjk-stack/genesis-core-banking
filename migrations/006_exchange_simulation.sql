-- GENESIS Exchange UAT simulation: listed instruments, orders and trades produced by
-- src/matching-engine.js. Requires 001_foundation.sql.
-- REVIEW ONLY. No auto-migration. Simulated trades never move money, securities or crypto.
BEGIN;
CREATE TABLE IF NOT EXISTS banking.exchange_instruments (
 venue varchar(80) NOT NULL, symbol varchar(40) NOT NULL,
 asset_class text NOT NULL CHECK(asset_class IN ('equity','bond','fund','crypto','token','future','option')),
 quote_asset varchar(12) NOT NULL,
 tick_size numeric(38,0) NOT NULL CHECK(tick_size>0),
 lot_size numeric(38,0) NOT NULL CHECK(lot_size>0),
 price_band_bps integer CHECK(price_band_bps BETWEEN 1 AND 10000),
 reference_price numeric(38,0) CHECK(reference_price>0),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','halted','delisted')),
 listed_by text NOT NULL, listed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(venue,symbol)
);
CREATE TABLE IF NOT EXISTS banking.exchange_orders (
 venue varchar(80) NOT NULL, symbol varchar(40) NOT NULL,
 order_id varchar(80) NOT NULL, account_ref varchar(80) NOT NULL, client_order_id varchar(80) NOT NULL,
 side text NOT NULL CHECK(side IN ('buy','sell')),
 order_type text NOT NULL CHECK(order_type IN ('limit','market')),
 time_in_force text NOT NULL CHECK(time_in_force IN ('GTC','IOC','FOK')),
 price numeric(38,0) CHECK(price>0), quantity numeric(38,0) NOT NULL CHECK(quantity>0),
 remaining numeric(38,0) NOT NULL CHECK(remaining>=0),
 status text NOT NULL CHECK(status IN ('new','resting','partially_filled','filled','cancelled')),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(venue,order_id), UNIQUE(venue,symbol,account_ref,client_order_id),
 FOREIGN KEY(venue,symbol) REFERENCES banking.exchange_instruments(venue,symbol),
 CHECK((order_type='limit')=(price IS NOT NULL))
);
-- Append-only event journal: the book can be rebuilt by replaying it in seq order.
CREATE TABLE IF NOT EXISTS banking.exchange_events (
 venue varchar(80) NOT NULL, symbol varchar(40) NOT NULL, seq numeric(38,0) NOT NULL,
 event_type text NOT NULL CHECK(event_type IN ('order_accepted','order_resting','order_cancelled','trade','trading_halted','trading_resumed')),
 body jsonb NOT NULL, occurred_at timestamptz NOT NULL,
 PRIMARY KEY(venue,symbol,seq),
 FOREIGN KEY(venue,symbol) REFERENCES banking.exchange_instruments(venue,symbol)
);
CREATE TABLE IF NOT EXISTS banking.exchange_trades (
 venue varchar(80) NOT NULL, symbol varchar(40) NOT NULL, seq numeric(38,0) NOT NULL,
 price numeric(38,0) NOT NULL CHECK(price>0), quantity numeric(38,0) NOT NULL CHECK(quantity>0),
 aggressor text NOT NULL CHECK(aggressor IN ('buy','sell')),
 buy_order_id varchar(80) NOT NULL, sell_order_id varchar(80) NOT NULL,
 buy_account_ref varchar(80) NOT NULL, sell_account_ref varchar(80) NOT NULL,
 settlement_status text NOT NULL DEFAULT 'simulated_unsettled' CHECK(settlement_status IN ('simulated_unsettled')),
 occurred_at timestamptz NOT NULL,
 PRIMARY KEY(venue,symbol,seq),
 FOREIGN KEY(venue,symbol,seq) REFERENCES banking.exchange_events(venue,symbol,seq),
 CHECK(buy_account_ref<>sell_account_ref)
);
CREATE INDEX IF NOT EXISTS exchange_trades_by_account_buy ON banking.exchange_trades(buy_account_ref,occurred_at);
CREATE INDEX IF NOT EXISTS exchange_trades_by_account_sell ON banking.exchange_trades(sell_account_ref,occurred_at);
COMMIT;
