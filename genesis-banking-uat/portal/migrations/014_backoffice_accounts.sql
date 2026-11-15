-- Presentation metadata only: existing account identities and balances stay intact.
ALTER TABLE avis_core_v2.ledger_accounts ADD COLUMN display_name varchar(120);
