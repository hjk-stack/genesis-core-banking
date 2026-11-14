-- Additive transfer methods. Existing bank requests and ledger accounts remain intact.
ALTER TABLE avis_core_v2.payment_requests ADD COLUMN execution_mode text CHECK(execution_mode IN ('INTERNAL','CONNECTED','MANUAL'));
CREATE OR REPLACE FUNCTION avis_core_v2.protect_payment_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD)-ARRAY['status','transfer_id','reservation_journal_id','submitted_at','cancelled_at','execution_mode'])
 IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','transfer_id','reservation_journal_id','submitted_at','cancelled_at','execution_mode']) THEN RAISE EXCEPTION 'PAYMENT_REVIEW_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
ALTER TABLE avis_core_v2.avis_cards ADD COLUMN stored_value_account_id uuid REFERENCES avis_core_v2.ledger_accounts;
ALTER TABLE avis_core_v2.offline_card_grants ADD COLUMN debit_account_id uuid REFERENCES avis_core_v2.ledger_accounts;
ALTER TABLE avis_core_v2.card_authorizations ADD COLUMN debit_account_id uuid REFERENCES avis_core_v2.ledger_accounts;
CREATE TABLE avis_core_v2.external_payment_cards (
 card_id uuid PRIMARY KEY, user_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users,
 holder_name varchar(140) NOT NULL, last_four varchar(4) NOT NULL CHECK(last_four~'^[0-9]{4}$'),
 pan_fingerprint varchar(64) NOT NULL, sealed_details jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,pan_fingerprint)
);
CREATE TABLE avis_core_v2.asset_transfer_requests (
 request_id uuid PRIMARY KEY, actor_id text NOT NULL,
 payment_method text NOT NULL CHECK(payment_method IN ('CRYPTO','CARD','CODED_CARD')),
 source_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts,
 source_user_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users,
 currency_code varchar(25) NOT NULL, network varchar(32), amount numeric(36,18) NOT NULL CHECK(amount>0 AND amount<>'NaN'::numeric),
 target_account_id uuid REFERENCES avis_core_v2.ledger_accounts,
 card_id uuid REFERENCES avis_core_v2.avis_cards, external_card_id uuid REFERENCES avis_core_v2.external_payment_cards,
 instruction jsonb NOT NULL, message_content text NOT NULL, message_hash varchar(64) NOT NULL,
 delivery_mode text NOT NULL CHECK(delivery_mode IN ('INTERNAL','MANUAL')),
 status text NOT NULL DEFAULT 'REVIEW' CHECK(status IN ('REVIEW','OUTGOING','COMPLETED','CANCELLED')),
 reservation_journal_id uuid REFERENCES avis_core_v2.ledger_journals,
 settlement_journal_id uuid REFERENCES avis_core_v2.ledger_journals,
 created_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz, completed_at timestamptz,
 sealed_delivery jsonb
);
CREATE FUNCTION avis_core_v2.protect_asset_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD)-ARRAY['status','card_id','reservation_journal_id','settlement_journal_id','submitted_at','completed_at','sealed_delivery'])
 IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','card_id','reservation_journal_id','settlement_journal_id','submitted_at','completed_at','sealed_delivery']) THEN RAISE EXCEPTION 'PAYMENT_REVIEW_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER asset_transfer_immutable BEFORE UPDATE ON avis_core_v2.asset_transfer_requests FOR EACH ROW EXECUTE FUNCTION avis_core_v2.protect_asset_transfer();
CREATE INDEX asset_transfer_queue ON avis_core_v2.asset_transfer_requests(status,created_at);
CREATE TABLE avis_core_v2.transfer_pickups (
 request_id uuid PRIMARY KEY, actor_id text NOT NULL, claimed_at timestamptz NOT NULL DEFAULT now(),
 settlement_reference varchar(140), completed_at timestamptz
);
CREATE TABLE avis_core_v2.coded_card_debits (
 request_id uuid PRIMARY KEY REFERENCES avis_core_v2.asset_transfer_requests,
 card_id uuid NOT NULL REFERENCES avis_core_v2.avis_cards,
 token_hash varchar(64) UNIQUE NOT NULL, code_hash varchar(64) NOT NULL,
 hold_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts,
 amount numeric(36,18) NOT NULL CHECK(amount>0), currency_code varchar(3) NOT NULL,
 expires_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REDEEMED','LOCKED','CANCELLED')),
 redemption_journal_id uuid REFERENCES avis_core_v2.ledger_journals
);
CREATE TABLE avis_core_v2.crypto_sale_offers (
 offer_id uuid PRIMARY KEY, stock_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts,
 proceeds_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts,
 unit_price numeric(36,18) NOT NULL CHECK(unit_price>0 AND unit_price<>'NaN'::numeric),
 is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
