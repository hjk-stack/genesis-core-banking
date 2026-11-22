-- Independent NOSTRO external-settlement mirrors. Existing accounts, balances,
-- provider statements and settlement journals remain unchanged.
CREATE TABLE avis_core_v2.nostro_manual_mirrors (
 mirror_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 cash_account_id uuid NOT NULL REFERENCES avis_core_v2.external_cash_accounts(cash_account_id),
 journal_id uuid NOT NULL UNIQUE REFERENCES avis_core_v2.ledger_journals(journal_id),
 external_reference varchar(128) NOT NULL,
 direction varchar(6) NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
 rail varchar(20) NOT NULL CHECK (rail IN ('BANK_TRANSFER','CARD','IP_TO_IP','ISO20022','BANK_API','OTHER')),
 amount numeric(36,18) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'::numeric),
 currency_code varchar(3) NOT NULL,
 memo varchar(250),
 actor_id varchar(180) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (cash_account_id,external_reference)
);
CREATE INDEX nostro_mirrors_recent ON avis_core_v2.nostro_manual_mirrors
 (cash_account_id,created_at DESC);
CREATE TRIGGER nostro_manual_mirrors_immutable BEFORE UPDATE OR DELETE
 ON avis_core_v2.nostro_manual_mirrors FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();
