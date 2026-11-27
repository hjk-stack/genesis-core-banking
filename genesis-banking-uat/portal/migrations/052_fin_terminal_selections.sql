-- The FinTerminal draft's chosen accounts (src/fin-terminal.mjs): the Common or Suspense account it is booked against, the NOSTRO
-- account it settles through and the "+" wallet that receives the converted tokens. Nothing is booked by choosing them.
ALTER TABLE avis_core_v2.fin_terminal_drafts
 ADD COLUMN booking_account_id uuid REFERENCES avis_core_v2.ledger_accounts(account_id),
 ADD COLUMN nostro_cash_account_id uuid REFERENCES avis_core_v2.external_cash_accounts(cash_account_id),
 ADD COLUMN token_wallet_account_id uuid REFERENCES avis_core_v2.ledger_accounts(account_id);
