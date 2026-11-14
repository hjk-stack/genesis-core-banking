-- Additive card management and identity scopes; no balance or journal rewrites.
ALTER TABLE avis_core_v2.operator_sessions ADD COLUMN is_admin boolean NOT NULL DEFAULT true;
ALTER TABLE avis_core_v2.operator_sessions ADD COLUMN customer_user_id bigint REFERENCES avis_core_v2.sovereign_users;
ALTER TABLE avis_core_v2.operator_sessions ADD COLUMN workspace_user_id bigint REFERENCES avis_core_v2.sovereign_users;
CREATE TABLE avis_core_v2.customer_logins (
 principal_id text PRIMARY KEY, user_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.managed_card_accounts (
 user_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users, currency_code varchar(3) NOT NULL,
 account_id uuid UNIQUE NOT NULL REFERENCES avis_core_v2.ledger_accounts,
 PRIMARY KEY(user_id,currency_code)
);
ALTER TABLE avis_core_v2.avis_cards ADD COLUMN card_product text NOT NULL DEFAULT 'STANDARD_BUSINESS'
 CHECK(card_product IN ('VIRTUAL','STANDARD_BUSINESS','GOLD_STANDARD','BLACK_VIP','GOLD_METAL','GOLD_DIAMOND'));
ALTER TABLE avis_core_v2.avis_cards ADD COLUMN display_number text UNIQUE;
ALTER TABLE avis_core_v2.avis_cards ADD COLUMN issued_at timestamptz;
ALTER TABLE avis_core_v2.avis_cards ADD COLUMN expires_at timestamptz;
ALTER TABLE avis_core_v2.avis_cards ADD COLUMN pin_salt text;
ALTER TABLE avis_core_v2.avis_cards ADD COLUMN pin_hash text;
ALTER TABLE avis_core_v2.avis_cards ADD COLUMN pin_updated_at timestamptz;
ALTER TABLE avis_core_v2.coded_card_debits ADD COLUMN valid_from timestamptz NOT NULL DEFAULT now();
CREATE INDEX customer_login_holder ON avis_core_v2.customer_logins(user_id);
CREATE INDEX cards_by_account ON avis_core_v2.avis_cards(stored_value_account_id);
