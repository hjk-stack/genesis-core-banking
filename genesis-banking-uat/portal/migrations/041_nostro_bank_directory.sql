-- Add bank-directory details without replacing existing external accounts,
-- their settlement ledgers or any booked transaction.
ALTER TABLE avis_core_v2.external_cash_accounts
 ADD COLUMN bank_address varchar(300),
 ADD COLUMN account_name varchar(140),
 ADD COLUMN aba varchar(9),
 ADD COLUMN bank_reference varchar(140),
 ADD CONSTRAINT external_cash_accounts_aba_digits
  CHECK (aba IS NULL OR aba ~ '^[0-9]{9}$');

-- Intermediary/correspondent chains belong to a registered external account;
-- there is no separate settlement balance or automatically created ledger.
CREATE TABLE avis_core_v2.nostro_intermediary_banks (
 intermediary_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 cash_account_id uuid NOT NULL REFERENCES avis_core_v2.external_cash_accounts(cash_account_id),
 bank_name varchar(100) NOT NULL,
 bank_address varchar(300) NOT NULL,
 account_name varchar(140) NOT NULL,
 aba varchar(9) CHECK (aba IS NULL OR aba ~ '^[0-9]{9}$'),
 reference varchar(140) NOT NULL,
 bic_code varchar(11),
 account_number varchar(128),
 created_by varchar(180) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(cash_account_id,bank_name,reference)
);
CREATE INDEX nostro_intermediaries_by_account ON avis_core_v2.nostro_intermediary_banks(cash_account_id,created_at DESC);
