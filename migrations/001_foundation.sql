-- GENESIS Core Banking 0.2 foundation (development only)
-- MANUAL REVIEW REQUIRED. Never apply directly to a live financial database.
-- Run as a dedicated migration administrator; do not give the web app DDL rights.
BEGIN;
CREATE SCHEMA IF NOT EXISTS banking;
CREATE TABLE IF NOT EXISTS banking.customers (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('person','organization')),
 status text NOT NULL CHECK(status IN ('pending_review','approved','suspended','closed')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS banking.wallets (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES banking.customers(id),
 asset_code varchar(12) NOT NULL CHECK(asset_code ~ '^[A-Z0-9]{3,12}$'),
 status text NOT NULL CHECK(status IN ('pending_review','active','frozen','closed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS banking.ledger_accounts (
 id uuid PRIMARY KEY, wallet_id uuid REFERENCES banking.wallets(id),
 asset_code varchar(12) NOT NULL CHECK(asset_code ~ '^[A-Z0-9]{3,12}$'),
 kind text NOT NULL CHECK(kind IN ('asset','liability','equity','income','expense')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,asset_code)
);
CREATE TABLE IF NOT EXISTS banking.journals (
 id uuid PRIMARY KEY, reference text NOT NULL UNIQUE,
 asset_code varchar(12) NOT NULL,
 status text NOT NULL CHECK(status='posted'),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,asset_code)
);
CREATE TABLE IF NOT EXISTS banking.journal_entries (
 id uuid PRIMARY KEY, journal_id uuid NOT NULL, ledger_account_id uuid NOT NULL,
 side text NOT NULL CHECK(side IN ('debit','credit')),
 amount_minor bigint NOT NULL CHECK(amount_minor > 0), asset_code varchar(12) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(journal_id,asset_code) REFERENCES banking.journals(id,asset_code),
 FOREIGN KEY(ledger_account_id,asset_code) REFERENCES banking.ledger_accounts(id,asset_code)
);
CREATE TABLE IF NOT EXISTS banking.payment_instructions (
 id uuid PRIMARY KEY, debtor_wallet_id uuid NOT NULL REFERENCES banking.wallets(id),
 creditor_reference text NOT NULL, asset_code varchar(12) NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor > 0),
 idempotency_key text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_review','rejected','cancelled')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS banking.audit_events (
 id uuid PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL,
 entity_type text NOT NULL, entity_id uuid, occurred_at timestamptz NOT NULL DEFAULT now(),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
-- Prevent alteration/deletion of posted journal facts. Elevated owners can still
-- change DDL, therefore independent audit and immutable external retention remain necessary.
CREATE OR REPLACE FUNCTION banking.forbid_journal_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'POSTED_JOURNAL_IMMUTABLE'; END $$;
DROP TRIGGER IF EXISTS journal_immutable ON banking.journals;
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON banking.journals
FOR EACH ROW EXECUTE FUNCTION banking.forbid_journal_mutation();
DROP TRIGGER IF EXISTS entries_immutable ON banking.journal_entries;
CREATE TRIGGER entries_immutable BEFORE UPDATE OR DELETE ON banking.journal_entries
FOR EACH ROW EXECUTE FUNCTION banking.forbid_journal_mutation();
-- Defense-in-depth: journal must balance at commit, not merely in the Node layer.
CREATE OR REPLACE FUNCTION banking.check_journal_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_journal uuid; v_net numeric;
BEGIN
 v_journal := CASE WHEN TG_TABLE_NAME='journals' THEN NEW.id ELSE NEW.journal_id END;
 SELECT COALESCE(SUM(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END),0)
 INTO v_net FROM banking.journal_entries WHERE journal_id=v_journal;
 IF v_net <> 0 OR NOT EXISTS(SELECT 1 FROM banking.journal_entries WHERE journal_id=v_journal)
 THEN RAISE EXCEPTION 'UNBALANCED_JOURNAL'; END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS journal_balance_check ON banking.journal_entries;
CREATE CONSTRAINT TRIGGER journal_balance_check AFTER INSERT ON banking.journal_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION banking.check_journal_balance();
DROP TRIGGER IF EXISTS journal_created_balance_check ON banking.journals;
CREATE CONSTRAINT TRIGGER journal_created_balance_check AFTER INSERT ON banking.journals
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION banking.check_journal_balance();
COMMIT;
