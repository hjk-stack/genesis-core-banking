ALTER TABLE avis_core_v2.avis_cards ADD COLUMN offline_public_key_pem text;
ALTER TABLE avis_core_v2.pos_terminals ADD COLUMN offline_floor_limit_eur numeric(20,6) NOT NULL DEFAULT 50 CHECK(offline_floor_limit_eur>0);
ALTER TABLE avis_core_v2.pos_terminals ADD COLUMN offline_batch_cap_eur numeric(20,6) NOT NULL DEFAULT 10000 CHECK(offline_batch_cap_eur>0);
ALTER TABLE avis_core_v2.card_authorizations ADD COLUMN commission_rate_bps integer NOT NULL DEFAULT 0 CHECK(commission_rate_bps BETWEEN 0 AND 10000);
UPDATE avis_core_v2.card_authorizations a SET commission_rate_bps=m.commission_rate_bps FROM avis_core_v2.pos_terminals t JOIN avis_core_v2.marketplace_merchants m USING(merchant_id) WHERE t.terminal_id=a.terminal_id;
CREATE TABLE avis_core_v2.offline_card_grants (
 grant_id uuid PRIMARY KEY,card_id uuid NOT NULL REFERENCES avis_core_v2.avis_cards,
 allowance numeric(20,6) NOT NULL CHECK(allowance>0),spent numeric(20,6) NOT NULL DEFAULT 0 CHECK(spent>=0 AND spent<=allowance),
 max_transactions integer NOT NULL CHECK(max_transactions BETWEEN 1 AND 5000),used_transactions integer NOT NULL DEFAULT 0,
 issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,settle_by timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CLOSED')),
 signed_allowance jsonb NOT NULL,hold_journal_id uuid NOT NULL REFERENCES avis_core_v2.ledger_journals,
 CHECK(used_transactions BETWEEN 0 AND max_transactions),CHECK(expires_at>issued_at AND settle_by>expires_at)
);
CREATE UNIQUE INDEX one_active_offline_grant ON avis_core_v2.offline_card_grants(card_id) WHERE status='ACTIVE';
CREATE TABLE avis_core_v2.pos_offline_saf_transactions (
 saf_tx_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),batch_id uuid NOT NULL,terminal_id varchar(32) NOT NULL REFERENCES avis_core_v2.pos_terminals,
 card_id uuid NOT NULL REFERENCES avis_core_v2.avis_cards,grant_id uuid NOT NULL REFERENCES avis_core_v2.offline_card_grants,
 atc integer NOT NULL CHECK(atc BETWEEN 1 AND 65535),payload_hash text NOT NULL,
 amount_eur numeric(20,6) NOT NULL CHECK(amount_eur>0),offline_timestamp timestamptz NOT NULL,
 journal_id uuid NOT NULL REFERENCES avis_core_v2.ledger_journals,UNIQUE(card_id,atc)
);
