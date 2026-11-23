-- Administrator-only NOSTRO account identity corrections.
-- ABIQ manual selections remain generated and bound to the same ledger; old
-- identifiers and every posting are retained. Currency changes allocate a
-- new ledger only for an entirely unused external bank account.
ALTER TABLE avis_core_v2.external_cash_accounts
 ADD COLUMN preferred_abiq_iban text REFERENCES avis_core_v2.abiq_generated_numbers(identifier);

CREATE TABLE avis_core_v2.nostro_account_corrections (
 correction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 cash_account_id uuid NOT NULL REFERENCES avis_core_v2.external_cash_accounts(cash_account_id),
 previous_ledger_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts(account_id),
 current_ledger_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts(account_id),
 previous_currency varchar(3) NOT NULL,
 current_currency varchar(3) NOT NULL,
 previous_bank_identifier varchar(128) NOT NULL,
 current_bank_identifier varchar(128) NOT NULL,
 previous_abiq_identifier text,
 current_abiq_identifier text,
 corrected_by text NOT NULL,
 corrected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nostro_account_corrections_history ON avis_core_v2.nostro_account_corrections(cash_account_id,corrected_at DESC);
CREATE TRIGGER preserve_nostro_account_corrections
 BEFORE UPDATE OR DELETE ON avis_core_v2.nostro_account_corrections
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();
