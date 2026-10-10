-- GENESIS omnibus COMMON accounts and suspense foundation.
-- REVIEW / MIGRATION STAGING ONLY. No live account issuance or posting.
-- Requires 001_foundation.sql. Apply only via reviewed DB administrator.
BEGIN;
CREATE SCHEMA IF NOT EXISTS banking;

CREATE TABLE IF NOT EXISTS banking.common_product_types (
 code varchar(48) PRIMARY KEY, name varchar(140) NOT NULL,
 legal_ownership_class varchar(40) NOT NULL DEFAULT 'third_party_omnibus'
 CHECK(legal_ownership_class='third_party_omnibus'),
 enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS banking.common_accounts (
 id uuid PRIMARY KEY, account_code varchar(24) NOT NULL UNIQUE,
 product_code varchar(48) NOT NULL REFERENCES banking.common_product_types(code),
 account_role varchar(24) NOT NULL DEFAULT 'omnibus_common'
 CHECK(account_role='omnibus_common'),
 status varchar(24) NOT NULL DEFAULT 'disabled'
 CHECK(status IN ('disabled','pending_review','active','frozen','closed')),
 legal_ownership_class varchar(40) NOT NULL DEFAULT 'third_party_omnibus'
 CHECK(legal_ownership_class='third_party_omnibus'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,product_code)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_common_account_per_product
 ON banking.common_accounts(product_code) WHERE status<>'closed';

CREATE TABLE IF NOT EXISTS banking.suspense_accounts (
 id uuid PRIMARY KEY, account_code varchar(32) NOT NULL UNIQUE,
 common_account_id uuid NOT NULL REFERENCES banking.common_accounts(id),
 purpose varchar(40) NOT NULL CHECK(purpose IN
 ('UNMATCHED_BENEFICIARY','SETTLEMENT_UNCONFIRMED','COVER_UNMATCHED',
 'CORRESPONDENT_BREAK','COMPLIANCE_HOLD','RETURN_REPAIR')),
 status varchar(24) NOT NULL DEFAULT 'disabled'
 CHECK(status IN ('disabled','pending_review','active','frozen','closed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(common_account_id,purpose)
);

CREATE TABLE IF NOT EXISTS banking.correspondent_connections (
 id uuid PRIMARY KEY, common_account_id uuid NOT NULL REFERENCES banking.common_accounts(id),
 provider_code varchar(80) NOT NULL, provider_kind varchar(30) NOT NULL
 CHECK(provider_kind IN ('correspondent_bank','custodian','central_bank','psp','clearing_system')),
 external_reference varchar(160), api_profile_ref varchar(160),
 settlement_rail varchar(40) NOT NULL,
 status varchar(24) NOT NULL DEFAULT 'disabled'
 CHECK(status IN ('disabled','pending_review','approved','suspended')),
 last_reconciled_at timestamptz,
 UNIQUE(common_account_id,provider_code,settlement_rail)
);
-- API credentials and signing keys remain exclusively in Key Vault; never here.

CREATE TABLE IF NOT EXISTS banking.inbound_message_headers (
 id uuid PRIMARY KEY,
 source_code varchar(80) NOT NULL, message_family varchar(32) NOT NULL
 CHECK(message_family IN ('MT103','MT202','MT202_COV','PACS008','PACS009','PACS009_COV',
 'PACS002','CAMT052','CAMT053','CAMT054')),
 external_reference varchar(90) NOT NULL,
 correlation_reference varchar(90),
 uetr uuid,
 message_fingerprint char(64) NOT NULL UNIQUE,
 common_account_id uuid REFERENCES banking.common_accounts(id),
 suspense_account_id uuid REFERENCES banking.suspense_accounts(id),
 receiving_account_reference varchar(140),
 received_at timestamptz NOT NULL DEFAULT now(),
 authenticity varchar(24) NOT NULL DEFAULT 'unverified'
 CHECK(authenticity IN ('unverified','authenticated','rejected')),
 settlement_status varchar(24) NOT NULL DEFAULT 'unconfirmed'
 CHECK(settlement_status IN ('unconfirmed','confirmed','rejected')),
 beneficiary_match_status varchar(24) NOT NULL DEFAULT 'unallocated'
 CHECK(beneficiary_match_status IN ('unallocated','candidate','verified','disputed')),
 booking_status varchar(24) NOT NULL DEFAULT 'unposted'
 CHECK(booking_status IN ('unposted','held','allocated','rejected')),
 CHECK(booking_status<>'allocated' OR
 (authenticity='authenticated' AND settlement_status='confirmed'
 AND beneficiary_match_status='verified'))
);
CREATE UNIQUE INDEX IF NOT EXISTS inbound_message_source_reference
 ON banking.inbound_message_headers(source_code,message_family,external_reference);

CREATE TABLE IF NOT EXISTS banking.beneficiary_allocation_records (
 id uuid PRIMARY KEY,
 inbound_message_id uuid NOT NULL REFERENCES banking.inbound_message_headers(id),
 customer_id uuid REFERENCES banking.customers(id),
 common_account_id uuid NOT NULL REFERENCES banking.common_accounts(id),
 status varchar(30) NOT NULL DEFAULT 'unallocated'
 CHECK(status IN ('unallocated','candidate','verified','allocated','rejected')),
 matching_basis jsonb NOT NULL DEFAULT '{}'::jsonb,
 verified_by text, verified_at timestamptz,
 allocation_reference varchar(140) UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status NOT IN ('verified','allocated') OR
 (customer_id IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS banking.account_number_pools (
 code varchar(48) PRIMARY KEY, internal_prefix varchar(30) NOT NULL,
 capacity integer NOT NULL CHECK(capacity=100000),
 allocated_count integer NOT NULL DEFAULT 0 CHECK(allocated_count BETWEEN 0 AND 100000),
 jurisdiction_country char(2), licensed_bank_identifier varchar(40),
 national_bban_pattern varchar(160), issuing_enabled boolean NOT NULL DEFAULT false,
 CHECK(NOT issuing_enabled OR
 (jurisdiction_country IS NOT NULL AND licensed_bank_identifier IS NOT NULL
 AND national_bban_pattern IS NOT NULL))
);
INSERT INTO banking.account_number_pools(code,internal_prefix,capacity)
 VALUES('GENESIS-IBAN-BASE','GCB-INT-',100000)
 ON CONFLICT(code) DO NOTHING;

-- The 100,000 slots are internal references; never claim valid IBANs.
-- Durable, atomic allocation is by PRIMARY KEY/row lock, not process-memory increment.
CREATE TABLE IF NOT EXISTS banking.account_number_slots (
 pool_code varchar(48) NOT NULL REFERENCES banking.account_number_pools(code),
 serial integer NOT NULL CHECK(serial BETWEEN 0 AND 99999),
 status varchar(20) NOT NULL DEFAULT 'reserved'
 CHECK(status IN ('reserved','allocated_internal','issued_iban','closed')),
 assigned_common_account_id uuid REFERENCES banking.common_accounts(id),
 assigned_customer_id uuid REFERENCES banking.customers(id),
 iban varchar(34) UNIQUE,
 issued_at timestamptz,
 PRIMARY KEY(pool_code,serial),
 CHECK(status<>'issued_iban' OR (iban IS NOT NULL AND issued_at IS NOT NULL))
);
INSERT INTO banking.account_number_slots(pool_code,serial)
 SELECT 'GENESIS-IBAN-BASE',n FROM generate_series(0,99999) AS n
 ON CONFLICT(pool_code,serial) DO NOTHING;

-- Internal cross-reference only; publication of an IBAN needs licensed issuing
-- configuration, country-specific BBAN validation, MOD-97, and bank approval.
CREATE INDEX IF NOT EXISTS common_suspense_parent_idx
 ON banking.suspense_accounts(common_account_id,purpose);
CREATE INDEX IF NOT EXISTS inbound_common_idx
 ON banking.inbound_message_headers(common_account_id,received_at);
CREATE INDEX IF NOT EXISTS alloc_message_idx
 ON banking.beneficiary_allocation_records(inbound_message_id);
COMMIT;
