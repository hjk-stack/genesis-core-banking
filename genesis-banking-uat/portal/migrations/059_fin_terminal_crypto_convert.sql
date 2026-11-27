-- The FinTerminal specification v3, its Direct Crypto Converter (src/fin-terminal.mjs): "Auto-routes configured IBAN credits into
-- 1:1 MiCA stablecoins or spot crypto" while ROBOTIC STP is active - each of AVISPay PLC's accounts with the wallet its credits are
-- converted into - and each incoming transfer converted, by the listener or by hand: at the live rate less 0.05% (amount x rate x
-- 0.9995), loaded into the wallet and the bank's custody instead of the NOSTRO (the bank owner: "when the crypto converter is
-- active then nothing will arrive at the NOSTRO instead will be the wallet loaded"), with its hash and its IVMS101 travel-rule data.
CREATE TABLE avis_core_v2.fin_terminal_crypto_routes (
 booking_account_id uuid PRIMARY KEY REFERENCES avis_core_v2.ledger_accounts(account_id),
 token_wallet_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts(account_id),
 changed_by text NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.fin_terminal_conversions (
 uetr uuid PRIMARY KEY,
 draft_id uuid NOT NULL UNIQUE REFERENCES avis_core_v2.fin_terminal_drafts(draft_id),
 journal_id uuid NOT NULL UNIQUE REFERENCES avis_core_v2.ledger_journals(journal_id),
 token_wallet_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts(account_id),
 fiat_amount numeric(38,18) NOT NULL CHECK (fiat_amount>0),
 fiat_currency varchar(3) NOT NULL,
 asset varchar(25) NOT NULL,
 network varchar(32) NOT NULL,
 rate numeric(38,18) NOT NULL CHECK (rate>0),
 rate_source text NOT NULL,
 rate_observed_at timestamptz NOT NULL,
 quantity numeric(38,18) NOT NULL CHECK (quantity>0),
 tx_hash char(66) NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
 mode text NOT NULL CHECK (mode IN ('ROBOTIC','MANUAL')),
 ivms101 jsonb NOT NULL,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
