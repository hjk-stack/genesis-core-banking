-- Each checkout's IP-to-IP payment request is an independently controlled
-- bank-operator approval, not a payment, ledger posting, or bank settlement.
CREATE TABLE avis_core_v2.checkout_ip_requests (
 request_id uuid PRIMARY KEY,
 checkout_kind varchar(12) NOT NULL CHECK(checkout_kind IN ('MILESTONE','SHOP')),
 checkout_reference varchar(128) NOT NULL,
 checkout_title varchar(160) NOT NULL,
 source varchar(32) NOT NULL CHECK(source IN ('industrial','shop-basket')),
 amount numeric(36,18) NOT NULL CHECK(amount>0),
 currency_code varchar(3) NOT NULL,
 sender_bank_name varchar(180) NOT NULL,
 sender_ip inet NOT NULL,
 authorized_person varchar(160) NOT NULL,
 sender_account varchar(80) NOT NULL,
 sender_account_name varchar(160) NOT NULL,
 buyer_contact_name varchar(140),
 buyer_contact_email varchar(254),
 document_names jsonb NOT NULL DEFAULT '[]'::jsonb,
 request_fingerprint char(64) NOT NULL,
 status varchar(12) NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('CLOSED','REQUESTED','ACTIVE')),
 requested_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now()+interval '60 minutes'),
 approved_at timestamptz,
 closed_at timestamptz,
 approved_by varchar(180),
 receiving_account_id uuid REFERENCES avis_core_v2.ledger_accounts(account_id),
 nostro_cash_account_id uuid REFERENCES avis_core_v2.external_cash_accounts(cash_account_id),
 intermediary_id uuid REFERENCES avis_core_v2.nostro_intermediary_banks(intermediary_id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status<>'ACTIVE' OR (receiving_account_id IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX checkout_ip_requested_index ON avis_core_v2.checkout_ip_requests(requested_at DESC) WHERE status='REQUESTED';
CREATE INDEX checkout_ip_recent_index ON avis_core_v2.checkout_ip_requests(requested_at DESC);
CREATE TABLE avis_core_v2.checkout_ip_events (
 event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES avis_core_v2.checkout_ip_requests(request_id),
 event_type varchar(12) NOT NULL CHECK(event_type IN ('REQUEST','APPROVE','CLOSE','EXPIRE')),
 actor_id varchar(180) NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER preserve_checkout_ip_events BEFORE UPDATE OR DELETE
 ON avis_core_v2.checkout_ip_events FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();
