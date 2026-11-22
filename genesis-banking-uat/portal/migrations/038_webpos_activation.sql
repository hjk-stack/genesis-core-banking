-- Dedicated per-checkout Web POS activation register. No ledger or payment changes.
-- A registered terminal is CLOSED until the administrator explicitly enables it.
CREATE TABLE avis_core_v2.checkout_pos_controls (
 terminal_id varchar(32) PRIMARY KEY REFERENCES avis_core_v2.pos_terminals(terminal_id),
 checkout_kind varchar(12) NOT NULL CHECK(checkout_kind IN ('MILESTONE','SHOP','REGISTERED')),
 checkout_reference varchar(120) NOT NULL,
 checkout_title varchar(160) NOT NULL,
 state varchar(12) NOT NULL DEFAULT 'CLOSED' CHECK(state IN ('CLOSED','REQUESTED','ACTIVE')),
 requested_at timestamptz,
 approved_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 changed_by text,
 CHECK(state<>'REQUESTED' OR requested_at IS NOT NULL)
);
CREATE INDEX checkout_pos_pending ON avis_core_v2.checkout_pos_controls(requested_at DESC)
 WHERE state='REQUESTED';
CREATE TABLE avis_core_v2.checkout_pos_events (
 event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 terminal_id varchar(32) NOT NULL REFERENCES avis_core_v2.pos_terminals,
 event_type varchar(20) NOT NULL CHECK(event_type IN ('REQUEST','APPROVE','CLOSE')),
 actor_id text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER preserve_checkout_pos_events BEFORE UPDATE OR DELETE
 ON avis_core_v2.checkout_pos_events FOR EACH ROW
 EXECUTE FUNCTION avis_core_v2.immutable_record();
CREATE TABLE avis_core_v2.checkout_pos_service_nonces (
 issuer varchar(120) NOT NULL,
 nonce char(64) NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(issuer,nonce)
);
CREATE INDEX checkout_pos_nonce_expiry ON avis_core_v2.checkout_pos_service_nonces(expires_at);
