CREATE TABLE avis_core_v2.crypto_basket_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 markup_bps integer NOT NULL DEFAULT 0 CHECK(markup_bps BETWEEN 0 AND 10000),
 participation_bps integer NOT NULL DEFAULT 0 CHECK(participation_bps BETWEEN 0 AND 10000),
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO avis_core_v2.crypto_basket_policy DEFAULT VALUES;
CREATE TABLE avis_core_v2.crypto_basket_card_terms (
 fiat varchar(3) PRIMARY KEY, fee_bps integer NOT NULL CHECK(fee_bps BETWEEN 0 AND 9999),
 fixed_minor integer NOT NULL CHECK(fixed_minor BETWEEN 0 AND 100000),
 approval_reference text NOT NULL, publishable_key text, updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.crypto_basket_lots (
 offer_id uuid PRIMARY KEY REFERENCES avis_core_v2.crypto_sale_offers,
 deposit_journal uuid UNIQUE NOT NULL REFERENCES avis_core_v2.ledger_journals,
 provider_reference text UNIQUE NOT NULL, cost_minor bigint NOT NULL CHECK(cost_minor>0),
 quantity numeric(36,18) NOT NULL CHECK(quantity>0),
 remaining numeric(36,18) NOT NULL CHECK(remaining BETWEEN 0 AND quantity),
 registered_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.crypto_basket_sessions (
 session_id uuid PRIMARY KEY, token_hash char(64) UNIQUE NOT NULL, buyer_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users,
 opened_by text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.crypto_basket_orders (
 order_id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES avis_core_v2.crypto_basket_sessions,
 buyer_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users, request_key uuid NOT NULL,
 asset varchar(25) NOT NULL, network varchar(32) NOT NULL, quantity numeric(36,18) NOT NULL CHECK(quantity>0),
 fiat varchar(3), method text NOT NULL CHECK(method IN ('ACCOUNT','CARD')),
 offer_id uuid REFERENCES avis_core_v2.crypto_sale_offers, terms jsonb,
 status text NOT NULL CHECK(status IN ('SOURCING','QUOTED','RESERVED','CARD_OPEN','PAID','EXPIRED','FAILED','REVIEW')),
 expires_at timestamptz, reserved_journal uuid UNIQUE REFERENCES avis_core_v2.ledger_journals,
 settlement_journal uuid UNIQUE REFERENCES avis_core_v2.ledger_journals,
 stripe_session text UNIQUE, stripe_intent text UNIQUE, stripe_mode text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(session_id,request_key)
);
CREATE INDEX crypto_basket_active ON avis_core_v2.crypto_basket_orders(buyer_id,status);
CREATE TABLE avis_core_v2.crypto_basket_stripe_events (
 event_id text PRIMARY KEY, order_id uuid NOT NULL REFERENCES avis_core_v2.crypto_basket_orders, event_type text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now()
);
