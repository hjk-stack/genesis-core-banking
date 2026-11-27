-- The FinTerminal composer's drafts (src/fin-terminal.mjs): the form as written and its ISO 20022 message as built from it.
-- A UETR names one draft only; the composer also refuses one an IP-to-IP transfer or a bank payment already has.
CREATE TABLE avis_core_v2.fin_terminal_drafts (
 draft_id uuid PRIMARY KEY,
 uetr uuid NOT NULL UNIQUE,
 message_type text NOT NULL CHECK (message_type='pacs.008.001.08'),
 revision integer NOT NULL CHECK (revision>0),
 form jsonb NOT NULL,
 message text NOT NULL CHECK (octet_length(message)<=65535),
 schema_valid boolean NOT NULL,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_by text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fin_terminal_draft_date ON avis_core_v2.fin_terminal_drafts(updated_at DESC);
