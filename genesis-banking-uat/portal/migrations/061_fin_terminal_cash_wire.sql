-- The FinTerminal's Cash Wire (NOSTRO) (specification v3, FinTerminal_Unified_NOSTRO_Crypto_System_v3: "Execute & Dispatch";
-- src/fin-peer.mjs): a credit transfer from AVISPay PLC's account to a beneficiary at a peer bank, settled on the bank's NOSTRO at
-- that peer (INDA). Kept with the message that carried it, who dispatched it and, while 4-Eyes was on, the holders of the two PINs
-- given; its money held in the wires' suspense account (sub-account FIN:WIRES) until the peer's answer, then settled on the NOSTRO or
-- returned to the account.
CREATE TABLE avis_core_v2.fin_terminal_wires (
 uetr uuid PRIMARY KEY,
 message_id uuid NOT NULL UNIQUE REFERENCES avis_core_v2.fin_terminal_peer_messages(message_id),
 profile_id varchar(35) NOT NULL REFERENCES avis_core_v2.bank_connector_profiles(profile_id),
 booking_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts(account_id),
 nostro_cash_account_id uuid NOT NULL REFERENCES avis_core_v2.external_cash_accounts(cash_account_id),
 suspense_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts(account_id),
 amount numeric(38,18) NOT NULL CHECK (amount>0),
 currency_code varchar(3) NOT NULL,
 creditor_name text NOT NULL CHECK (char_length(creditor_name) BETWEEN 1 AND 140),
 creditor_iban varchar(34) NOT NULL,
 status text NOT NULL DEFAULT 'SENDING' CHECK (status IN ('SENDING','SETTLED','RETURNED','HELD')),
 peer_status varchar(4),
 reason_code varchar(35),
 -- What came back from the peer, kept as it came before it is read: a wire whose finishing failed is finished from it later.
 answer text CHECK (octet_length(answer)<=65535),
 delivery_error varchar(64),
 delivered_at timestamptz,
 reserve_journal_id uuid NOT NULL UNIQUE REFERENCES avis_core_v2.ledger_journals(journal_id),
 settle_journal_id uuid UNIQUE REFERENCES avis_core_v2.ledger_journals(journal_id),
 four_eyes boolean NOT NULL,
 checkers text[] NOT NULL DEFAULT '{}',
 dispatched_by text NOT NULL,
 dispatched_by_name text NOT NULL CHECK (char_length(dispatched_by_name) BETWEEN 1 AND 80),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((status IN ('SETTLED','RETURNED'))=(settle_journal_id IS NOT NULL)),
 CHECK (NOT four_eyes OR cardinality(checkers)=2)
);
