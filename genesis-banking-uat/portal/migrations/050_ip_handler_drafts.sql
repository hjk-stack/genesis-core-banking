CREATE TABLE avis_core_v2.ip_handler_drafts (
 transfer_id uuid PRIMARY KEY,
 register_number text NOT NULL UNIQUE,
 revision integer NOT NULL CHECK (revision > 0),
 saved_at timestamptz NOT NULL,
 beneficiary text NOT NULL,
 account_number text NOT NULL,
 amount_text text NOT NULL,
 currency_text text NOT NULL,
 pdf bytea NOT NULL,
 content_hash text NOT NULL
);
CREATE INDEX ip_handler_draft_date ON avis_core_v2.ip_handler_drafts(saved_at DESC);
