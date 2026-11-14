ALTER TABLE avis_core_v2.sovereign_users ADD COLUMN postal_address jsonb;
-- Reviewed payment instructions. No posting or network delivery occurs during review.
CREATE TABLE avis_core_v2.payment_beneficiaries (
 actor_id text NOT NULL,
 account_number varchar(34) NOT NULL,
 bic varchar(11) NOT NULL,
 full_name varchar(140) NOT NULL,
 postal_address jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,account_number)
);
CREATE TABLE avis_core_v2.payment_requests (
 request_id uuid PRIMARY KEY,
 actor_id text NOT NULL,
 source_bridge_id uuid NOT NULL REFERENCES avis_core_v2.abiq_routing_bridge,
 source_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts,
 receiver_bridge_id uuid REFERENCES avis_core_v2.abiq_routing_bridge,
 profile_id varchar(35) REFERENCES avis_core_v2.bank_connector_profiles,
 currency_code varchar(3) NOT NULL,
 amount numeric(36,6) NOT NULL CHECK(amount>0 AND amount<>'NaN'::numeric),
 beneficiary_account varchar(34) NOT NULL,
 beneficiary_bic varchar(11) NOT NULL,
 beneficiary_name varchar(140) NOT NULL,
 beneficiary_address jsonb NOT NULL,
 payment_reference varchar(140) NOT NULL,
 uetr uuid UNIQUE NOT NULL,
 instruction jsonb NOT NULL,
 route_snapshot jsonb,
 delivery_mode text NOT NULL CHECK(delivery_mode IN ('INTERNAL','CONNECTED','MANUAL')),
 message_format text NOT NULL CHECK(message_format IN ('FIN_MT103','ISO20022')),
 message_content text NOT NULL CHECK(octet_length(message_content)<=65535),
 iso_message text NOT NULL CHECK(octet_length(iso_message)<=65535),
 message_hash varchar(64) NOT NULL CHECK(message_hash~'^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'REVIEW' CHECK(status IN ('REVIEW','OUTGOING','PROCESSING','COMPLETED','CANCELLED')),
 transfer_id uuid UNIQUE REFERENCES avis_core_v2.interbank_ip_transfers,
 reservation_journal_id uuid UNIQUE REFERENCES avis_core_v2.ledger_journals,
 created_at timestamptz NOT NULL DEFAULT now(),
 submitted_at timestamptz,
 cancelled_at timestamptz
);
CREATE INDEX payment_requests_outgoing ON avis_core_v2.payment_requests(status,created_at);
CREATE INDEX payment_requests_by_actor ON avis_core_v2.payment_requests(actor_id,created_at);

-- Review content is append-only. Lifecycle updates retain the exact reviewed instruction.
CREATE FUNCTION avis_core_v2.protect_payment_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD) - ARRAY['status','transfer_id','reservation_journal_id','submitted_at','cancelled_at'])
 IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['status','transfer_id','reservation_journal_id','submitted_at','cancelled_at']) THEN
  RAISE EXCEPTION 'PAYMENT_REVIEW_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payment_review_immutable BEFORE UPDATE ON avis_core_v2.payment_requests
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.protect_payment_review();
