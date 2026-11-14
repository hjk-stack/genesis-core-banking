-- Sovereign Core v2, Azure ESQL v3 and ABIQ v8/v8.1 payment/clearing lifecycle.
CREATE TABLE avis_core_v2.bank_connector_profiles (
 profile_id varchar(35) PRIMARY KEY REFERENCES avis_core_v2.platform_connectors,
 cash_account_id uuid NOT NULL REFERENCES avis_core_v2.external_cash_accounts,
 protocol text NOT NULL CHECK(protocol IN ('IP_TO_IP','SWIFT_ISO20022','BANK_API')),
 local_bic varchar(11) NOT NULL CHECK(local_bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
 peer_bic varchar(11) NOT NULL CHECK(peer_bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
 operations jsonb NOT NULL DEFAULT '{}'
);
ALTER TABLE avis_core_v2.interbank_ip_transfers ADD COLUMN profile_id varchar(35) REFERENCES avis_core_v2.bank_connector_profiles;
ALTER TABLE avis_core_v2.interbank_ip_transfers ADD COLUMN source_account_id uuid REFERENCES avis_core_v2.ledger_accounts;
ALTER TABLE avis_core_v2.interbank_ip_transfers ADD COLUMN settlement_journal_id uuid REFERENCES avis_core_v2.ledger_journals;
ALTER TABLE avis_core_v2.interbank_ip_transfers ADD COLUMN bank_reference text;
ALTER TABLE avis_core_v2.interbank_ip_transfers ADD COLUMN cash_reserved boolean NOT NULL DEFAULT false;
ALTER TABLE avis_core_v2.ledger_accounts ADD CONSTRAINT cash_available_for_reservations CHECK
 (owner_type NOT IN ('CORRESPONDENT_NOSTRO','CENTRAL_BANK_RESERVE') OR available_balance>=locked_balance);
CREATE TABLE avis_core_v2.payment_outbox (
 transfer_id uuid PRIMARY KEY REFERENCES avis_core_v2.interbank_ip_transfers,
 content text NOT NULL, content_type text NOT NULL, status text NOT NULL DEFAULT 'QUEUED'
 CHECK(status IN ('QUEUED','SENDING','ACKNOWLEDGED','UNCERTAIN')),
 attempts integer NOT NULL DEFAULT 0, lease_until timestamptz, last_error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.payment_events (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id varchar(35) NOT NULL REFERENCES avis_core_v2.bank_connector_profiles,
 message_id varchar(35) NOT NULL, transfer_id uuid NOT NULL REFERENCES avis_core_v2.interbank_ip_transfers,
 event_type text NOT NULL, payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(profile_id,message_id)
);
CREATE TABLE avis_core_v2.connector_nonces (
 profile_id varchar(35) NOT NULL REFERENCES avis_core_v2.bank_connector_profiles,
 nonce varchar(64) NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(profile_id,nonce)
);
CREATE TABLE avis_core_v2.clearing_statements (
 statement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),cash_account_id uuid NOT NULL REFERENCES avis_core_v2.external_cash_accounts,
 provider_reference text NOT NULL, currency_code varchar(3) NOT NULL,
 opening_balance numeric(36,18) NOT NULL, closing_balance numeric(36,18) NOT NULL,
 payload_hash text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(cash_account_id,provider_reference)
);
CREATE TABLE avis_core_v2.clearing_statement_entries (
 statement_id uuid NOT NULL REFERENCES avis_core_v2.clearing_statements,
 bank_reference text NOT NULL, direction varchar(6) NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),
 amount numeric(36,18) NOT NULL CHECK(amount>0), transfer_id uuid REFERENCES avis_core_v2.interbank_ip_transfers,
 PRIMARY KEY(statement_id,bank_reference)
);
CREATE UNIQUE INDEX clearing_bank_entry_once ON avis_core_v2.clearing_statement_entries(transfer_id) WHERE transfer_id IS NOT NULL;
