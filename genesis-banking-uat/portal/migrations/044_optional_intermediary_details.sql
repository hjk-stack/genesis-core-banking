-- Intermediary details can be entered independently. Keep existing identities,
-- cash-account links, supplied values and settlement ledgers unchanged.
ALTER TABLE avis_core_v2.nostro_intermediary_banks
 ALTER COLUMN bank_name DROP NOT NULL,
 ALTER COLUMN bank_address DROP NOT NULL,
 ALTER COLUMN account_name DROP NOT NULL,
 ALTER COLUMN reference DROP NOT NULL;
