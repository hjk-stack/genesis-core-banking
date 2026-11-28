-- The FinTerminal's Debit (src/fin-peer.mjs, transact; src/fin-terminal.mjs, keepDebit and bookDebit). The bank owner: "There is
-- missing a function: Debit. This is when we have authorisation for debiting an external connected account", and "A transaction
-- does either book the message monies to our common account and the physical clearing to our NOSTRO selected or convert the monies
-- by all connected gateways into a coin and books the coin into the chosen wallet". A Debit is the composer's third direction: a
-- direct debit (pacs.003.001.08) under the debtor's mandate, sent to the debtor's bank's peer server. Kept with the draft it was
-- written in, which it closes, who sent it and, while 4-Eyes was on, the holders of the two PINs given; nothing is booked until the
-- debtor's bank answered that it settled - then on the NOSTRO and the chosen account, or converted into the chosen wallet at the
-- rate quoted when it was sent.
ALTER TABLE avis_core_v2.fin_terminal_drafts
 DROP CONSTRAINT fin_terminal_drafts_direction_check,
 ADD CONSTRAINT fin_terminal_drafts_direction_check CHECK (direction IN ('OUTGOING','INCOMING','DEBIT')),
 DROP CONSTRAINT fin_terminal_drafts_message_type_check,
 ADD CONSTRAINT fin_terminal_drafts_message_type_check CHECK ((direction='DEBIT')=(message_type='pacs.003.001.08') AND message_type IN ('pacs.008.001.08','pacs.003.001.08'));
CREATE TABLE avis_core_v2.fin_terminal_debits (
 uetr uuid PRIMARY KEY,
 message_id uuid NOT NULL UNIQUE REFERENCES avis_core_v2.fin_terminal_peer_messages(message_id),
 draft_id uuid NOT NULL UNIQUE REFERENCES avis_core_v2.fin_terminal_drafts(draft_id),
 profile_id varchar(35) NOT NULL REFERENCES avis_core_v2.bank_connector_profiles(profile_id),
 booking_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts(account_id),
 nostro_cash_account_id uuid NOT NULL REFERENCES avis_core_v2.external_cash_accounts(cash_account_id),
 token_wallet_account_id uuid REFERENCES avis_core_v2.ledger_accounts(account_id),
 rate numeric(38,18) CHECK (rate>0),
 rate_source text,
 rate_observed_at timestamptz,
 amount numeric(38,18) NOT NULL CHECK (amount>0),
 currency_code varchar(3) NOT NULL,
 debtor_name text NOT NULL CHECK (char_length(debtor_name) BETWEEN 1 AND 140),
 debtor_account varchar(34) NOT NULL CHECK (char_length(debtor_account)>=1),
 mandate_id varchar(35) NOT NULL CHECK (char_length(mandate_id)>=1),
 mandate_signed date NOT NULL,
 status text NOT NULL DEFAULT 'SENDING' CHECK (status IN ('SENDING','SETTLED','REFUSED','HELD')),
 peer_status varchar(4),
 reason_code varchar(35),
 -- What came back from the debtor's bank, kept as it came before it is read: a debit whose finishing failed is finished from it later.
 answer text CHECK (octet_length(answer)<=65535),
 delivery_error varchar(64),
 delivered_at timestamptz,
 booked_journal_id uuid UNIQUE REFERENCES avis_core_v2.ledger_journals(journal_id),
 four_eyes boolean NOT NULL,
 checkers text[] NOT NULL DEFAULT '{}',
 sent_by text NOT NULL,
 sent_by_name text NOT NULL CHECK (char_length(sent_by_name) BETWEEN 1 AND 80),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((status='SETTLED')=(booked_journal_id IS NOT NULL)),
 CHECK ((token_wallet_account_id IS NULL)=(rate IS NULL) AND (rate IS NULL)=(rate_source IS NULL) AND (rate IS NULL)=(rate_observed_at IS NULL)),
 CHECK (NOT four_eyes OR cardinality(checkers)=2)
);
CREATE INDEX fin_terminal_debits_sending ON avis_core_v2.fin_terminal_debits(created_at) WHERE status='SENDING';
