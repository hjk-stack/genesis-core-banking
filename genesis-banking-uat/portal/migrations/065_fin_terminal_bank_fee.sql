-- Page 1's Bank fee (src/fin-terminal.mjs). The bank owner: "bank fees is taken from the amount and if converted after it is
-- converted and booked into the treasury wallets or account ... If the conversion is pressed then we will take the fees in the
-- Crypto section. we will not book wallet fees in the payment page". Typed for an incoming transfer or a Debit that is not converted,
-- it is kept with the draft and, sent, with the Debit: the chosen account is booked the amount less the fee, the bank's Treasury
-- account the fee.
ALTER TABLE avis_core_v2.fin_terminal_drafts
 ADD COLUMN bank_fee numeric(38,18),
 ADD CONSTRAINT fin_terminal_drafts_bank_fee_check CHECK (bank_fee IS NULL OR bank_fee>0 AND token_wallet_account_id IS NULL AND direction IN ('INCOMING','DEBIT'));
ALTER TABLE avis_core_v2.fin_terminal_debits
 ADD COLUMN bank_fee numeric(38,18),
 ADD CONSTRAINT fin_terminal_debits_bank_fee_check CHECK (bank_fee IS NULL OR bank_fee>0 AND bank_fee<amount AND token_wallet_account_id IS NULL);
