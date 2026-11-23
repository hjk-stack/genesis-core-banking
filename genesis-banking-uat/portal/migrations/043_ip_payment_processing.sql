-- Handler reports describe the external operation. They do not post the bank ledger.
-- A terminal cancellation may arrive before its registration during a transport
-- retry, so this record deliberately does not depend on a request foreign key.
CREATE TABLE avis_core_v2.checkout_ip_cancellations (
 request_id uuid PRIMARY KEY,
 actor_id varchar(180) NOT NULL,
 cancelled_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER preserve_checkout_ip_cancellations BEFORE UPDATE OR DELETE
 ON avis_core_v2.checkout_ip_cancellations FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();

-- Acquired immediately before the handler books a matched authenticated bank
-- statement. Cancellation and this immutable binding share the request row lock.
CREATE TABLE avis_core_v2.checkout_ip_settlement_claims (
 request_id uuid PRIMARY KEY REFERENCES avis_core_v2.checkout_ip_requests(request_id),
 handler_transfer_id uuid NOT NULL UNIQUE,
 transaction_reference varchar(140) NOT NULL UNIQUE,
 routing_snapshot jsonb NOT NULL,
 actor_id varchar(180) NOT NULL,
 claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER preserve_checkout_ip_settlement_claims BEFORE UPDATE OR DELETE
 ON avis_core_v2.checkout_ip_settlement_claims FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();

CREATE TABLE avis_core_v2.checkout_ip_processing (
 request_id uuid PRIMARY KEY REFERENCES avis_core_v2.checkout_ip_requests(request_id),
 handler_transfer_id uuid NOT NULL UNIQUE,
 revision integer NOT NULL CHECK(revision>0),
 transaction_reference varchar(140) NOT NULL,
 handler_status varchar(40) NOT NULL,
 bank_name varchar(180),
 bank_server_sent_amount numeric(36,18) CHECK(bank_server_sent_amount>=0),
 nostro_iban varchar(128),
 receiving_abiq_iban varchar(64),
 amount_cleared numeric(36,18) CHECK(amount_cleared>=0),
 beneficiary_name varchar(160),
 beneficiary_account varchar(128),
 franchise_allocated_percent numeric(5,2) CHECK(franchise_allocated_percent BETWEEN 0 AND 100),
 operation_completed boolean NOT NULL DEFAULT false,
 manual_report_100_digits varchar(100) CHECK(manual_report_100_digits ~ '^[0-9]{100}$'),
 report_fingerprint char(64) NOT NULL,
 updated_by varchar(180) NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,handler_transfer_id,revision),
 CHECK(NOT operation_completed OR (handler_status='SETTLED' AND manual_report_100_digits IS NOT NULL
  AND bank_name IS NOT NULL AND bank_server_sent_amount IS NOT NULL AND amount_cleared IS NOT NULL
  AND receiving_abiq_iban IS NOT NULL AND beneficiary_name IS NOT NULL AND beneficiary_account IS NOT NULL
  AND franchise_allocated_percent IS NOT NULL))
);
CREATE FUNCTION avis_core_v2.preserve_completed_ip_processing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.operation_completed THEN RAISE EXCEPTION 'APPEND_ONLY_RECORD'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_completed_ip_processing BEFORE UPDATE OR DELETE
 ON avis_core_v2.checkout_ip_processing FOR EACH ROW EXECUTE FUNCTION avis_core_v2.preserve_completed_ip_processing();

CREATE TABLE avis_core_v2.checkout_ip_proofs (
 request_id uuid PRIMARY KEY,
 handler_transfer_id uuid NOT NULL,
 revision integer NOT NULL,
 transaction_reference varchar(140) NOT NULL,
 manual_report_100_digits varchar(100) NOT NULL CHECK(manual_report_100_digits ~ '^[0-9]{100}$'),
 file_name varchar(128) NOT NULL,
 pdf_bytes bytea NOT NULL CHECK(octet_length(pdf_bytes) BETWEEN 8 AND 2097152),
 sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 created_by varchar(180) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(request_id,handler_transfer_id,revision)
  REFERENCES avis_core_v2.checkout_ip_processing(request_id,handler_transfer_id,revision)
);
CREATE TRIGGER preserve_checkout_ip_proofs BEFORE UPDATE OR DELETE
 ON avis_core_v2.checkout_ip_proofs FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();

CREATE TABLE avis_core_v2.checkout_ip_processing_events (
 event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES avis_core_v2.checkout_ip_requests(request_id),
 revision integer NOT NULL,
 report_snapshot jsonb NOT NULL,
 report_fingerprint char(64) NOT NULL,
 actor_id varchar(180) NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,revision)
);
CREATE TRIGGER preserve_checkout_ip_processing_events BEFORE UPDATE OR DELETE
 ON avis_core_v2.checkout_ip_processing_events FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();
