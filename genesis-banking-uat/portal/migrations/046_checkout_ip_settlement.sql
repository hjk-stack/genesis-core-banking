-- Book only new authenticated handler evidence. Existing reports and balances
-- are retained as recorded; this migration performs no settlement backfill.
CREATE TABLE avis_core_v2.checkout_ip_settlements (
 request_id uuid PRIMARY KEY REFERENCES avis_core_v2.checkout_ip_settlement_claims(request_id),
 journal_id uuid NOT NULL UNIQUE REFERENCES avis_core_v2.ledger_journals(journal_id),
 handler_journal_id uuid NOT NULL UNIQUE,
 cash_account_id uuid NOT NULL REFERENCES avis_core_v2.external_cash_accounts(cash_account_id),
 receiving_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts(account_id),
 bank_transaction_id varchar(140) NOT NULL,
 statement_id varchar(140) NOT NULL,
 currency_code varchar(3) NOT NULL,
 amount numeric(36,18) NOT NULL CHECK(amount>0 AND amount<>'NaN'::numeric),
 nostro_account varchar(128) NOT NULL,
 statement_hash char(64) NOT NULL CHECK(statement_hash ~ '^[a-f0-9]{64}$'),
 booked_at timestamptz,
 booked_date date,
 evidence_snapshot jsonb NOT NULL,
 evidence_fingerprint char(64) NOT NULL CHECK(evidence_fingerprint ~ '^[a-f0-9]{64}$'),
 actor_id varchar(180) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(cash_account_id,bank_transaction_id)
);
CREATE TRIGGER preserve_checkout_ip_settlements BEFORE UPDATE OR DELETE
 ON avis_core_v2.checkout_ip_settlements FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();
