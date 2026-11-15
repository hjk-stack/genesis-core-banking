CREATE TABLE avis_core_v2.portfolio_securities (
 security_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name varchar(200) NOT NULL, short_name varchar(80) NOT NULL,
 currency_code varchar(3) NOT NULL, isin varchar(12), cusip varchar(9),
 denomination numeric(36,18) NOT NULL CHECK(denomination>0 AND denomination<>'NaN'::numeric),
 quote_basis varchar(10) NOT NULL CHECK(quote_basis IN ('PERCENT','UNIT')),
 quantity_decimals smallint NOT NULL DEFAULT 0 CHECK(quantity_decimals BETWEEN 0 AND 18),
 kind varchar(20) NOT NULL, source varchar(20) NOT NULL CHECK(source IN ('GREEN_BOND','MANUAL')),
 exchange_symbol varchar(80), reference_price numeric(36,18), source_updated_at timestamptz,
 created_by varchar(180) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(isin), UNIQUE(exchange_symbol)
);
CREATE TABLE avis_core_v2.portfolio_positions (
 position_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users(user_id),
 security_id uuid NOT NULL REFERENCES avis_core_v2.portfolio_securities(security_id),
 quantity numeric(36,18) NOT NULL DEFAULT 0 CHECK(quantity>=0 AND quantity<>'NaN'::numeric),
 reserved_quantity numeric(36,18) NOT NULL DEFAULT 0 CHECK(reserved_quantity>=0 AND reserved_quantity<=quantity),
 issuing_price numeric(36,18) NOT NULL CHECK(issuing_price>=0 AND issuing_price<>'NaN'::numeric),
 market_price numeric(36,18) NOT NULL CHECK(market_price>=0 AND market_price<>'NaN'::numeric),
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,security_id)
);
CREATE TABLE avis_core_v2.securities_orders (
 order_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users(user_id),
 security_id uuid NOT NULL REFERENCES avis_core_v2.portfolio_securities(security_id),
 side varchar(4) NOT NULL CHECK(side IN ('BUY','SELL')),
 status varchar(12) NOT NULL DEFAULT 'REVIEW' CHECK(status IN ('REVIEW','OPEN','FILLED','CANCELLED')),
 instruction jsonb NOT NULL, review_hash varchar(64) NOT NULL,
 quantity numeric(36,18) NOT NULL CHECK(quantity>0 AND quantity<>'NaN'::numeric),
 price numeric(36,18) NOT NULL CHECK(price>0 AND price<>'NaN'::numeric),
 total numeric(36,18) NOT NULL CHECK(total>0 AND total<>'NaN'::numeric),
 cash_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts(account_id),
 source_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts(account_id),
 cash_hold_id uuid REFERENCES avis_core_v2.ledger_accounts(account_id),
 crypto_hold_id uuid REFERENCES avis_core_v2.ledger_accounts(account_id),
 matched_order_id uuid REFERENCES avis_core_v2.securities_orders(order_id),
 journal_id uuid REFERENCES avis_core_v2.ledger_journals(journal_id),
 created_by varchar(180) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 submitted_at timestamptz, executed_at timestamptz,
 execution_reference varchar(128)
);
CREATE INDEX securities_open_orders ON avis_core_v2.securities_orders(security_id,side,price,quantity,created_at) WHERE status='OPEN';
CREATE TABLE avis_core_v2.portfolio_movements (
 movement_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 position_id uuid NOT NULL REFERENCES avis_core_v2.portfolio_positions(position_id),
 order_id uuid REFERENCES avis_core_v2.securities_orders(order_id),
 quantity_delta numeric(36,18) NOT NULL CHECK(quantity_delta<>'NaN'::numeric),
 resulting_quantity numeric(36,18) NOT NULL,
 reference varchar(128) NOT NULL, actor_id varchar(180) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER portfolio_movements_immutable BEFORE UPDATE OR DELETE ON avis_core_v2.portfolio_movements
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();
