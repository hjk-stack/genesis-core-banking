CREATE TABLE avis_core_v2.trading_robots (
 robot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(100) NOT NULL, user_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users,
 venue varchar(20) NOT NULL CHECK(venue IN ('AVIS','BINANCE')), symbol varchar(80) NOT NULL, index_id varchar(80) NOT NULL,
 security_id uuid REFERENCES avis_core_v2.portfolio_securities, account_id uuid REFERENCES avis_core_v2.ledger_accounts,
 key_ref varchar(80), enabled boolean NOT NULL DEFAULT false, max_notional numeric(36,18) NOT NULL CHECK(max_notional>0 AND max_notional<>'NaN'::numeric),
 daily_notional numeric(36,18) NOT NULL CHECK(daily_notional>0 AND daily_notional<>'NaN'::numeric), max_loss numeric(36,18) NOT NULL CHECK(max_loss>0 AND max_loss<>'NaN'::numeric),
 minimum_index numeric NOT NULL DEFAULT 0 CHECK(minimum_index BETWEEN -100 AND 100), trailing_bps integer NOT NULL CHECK(trailing_bps BETWEEN 5 AND 2000),
 quantity_step numeric(36,18) NOT NULL, price_tick numeric(36,18) NOT NULL, base_asset varchar(25), quote_asset varchar(25),
 position_quantity numeric(36,18) NOT NULL DEFAULT 0, cost_basis numeric(36,18) NOT NULL DEFAULT 0, realized_pnl numeric(36,18) NOT NULL DEFAULT 0,
 stop_price numeric(36,18) NOT NULL DEFAULT 0, peak_price numeric(36,18) NOT NULL DEFAULT 0,
 version integer NOT NULL DEFAULT 1, last_tick_at timestamptz, last_index jsonb, engine_state jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(venue,symbol,user_id)
);
CREATE TABLE avis_core_v2.trading_robot_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),robot_id uuid NOT NULL REFERENCES avis_core_v2.trading_robots,
 signal_id varchar(64) NOT NULL, client_order_id varchar(36) UNIQUE NOT NULL, side varchar(4) NOT NULL CHECK(side IN('BUY','SELL')),
 quantity numeric(36,18) NOT NULL,price numeric(36,18) NOT NULL, status varchar(16) NOT NULL DEFAULT 'CREATED' CHECK(status IN('CREATED','DISPATCHING','ACKNOWLEDGED','SETTLED','REJECTED')),
 instruction jsonb NOT NULL,response jsonb, journal_id uuid REFERENCES avis_core_v2.ledger_journals, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(robot_id,signal_id)
);
CREATE UNIQUE INDEX robot_one_inflight ON avis_core_v2.trading_robot_orders(robot_id) WHERE status IN('CREATED','DISPATCHING','ACKNOWLEDGED');
