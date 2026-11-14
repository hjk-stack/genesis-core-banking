-- M01: additive namespace on an EXISTING PostgreSQL database (15+).
-- Source: Sovereign Core v2 section 3; Azure ESQL v3 section 3;
-- Parallel Migration Runbook section 3; canonical discrepancy D05.
-- Transaction, checksum and deployment target are controlled by the runner.
CREATE TABLE avis_core_v2.sovereign_users (
 user_id BIGINT PRIMARY KEY,
 legacy_identity TEXT UNIQUE,
 avis_account_no VARCHAR(128) UNIQUE NOT NULL,
 full_name VARCHAR(120) NOT NULL,
 kyc_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE avis_core_v2.platform_connectors (
 connector_code VARCHAR(35) PRIMARY KEY,
 display_name VARCHAR(100) NOT NULL,
 is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 auto_provision BOOLEAN NOT NULL DEFAULT FALSE,
 endpoint_url TEXT,
 credential_reference TEXT,
 config_metadata JSONB NOT NULL DEFAULT '{}',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.user_external_connectors (
 binding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id BIGINT NOT NULL REFERENCES avis_core_v2.sovereign_users,
 connector_code VARCHAR(35) NOT NULL REFERENCES avis_core_v2.platform_connectors,
 status VARCHAR(20) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','ACTIVE','SUSPENDED','FAILED')),
 external_account_id VARCHAR(128),
 external_routing_id VARCHAR(128),
 provisioned_at TIMESTAMPTZ,
 UNIQUE (user_id, connector_code)
);
-- A routing identifier belongs to one user within its connector's namespace.
CREATE UNIQUE INDEX connector_routing_owner ON avis_core_v2.user_external_connectors
 (connector_code, external_routing_id) WHERE external_routing_id IS NOT NULL;

CREATE TABLE avis_core_v2.ledger_accounts (
 account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_type VARCHAR(30) NOT NULL CHECK (owner_type IN (
  'USER','TREASURY','COMMON_POOL','MARKETPLACE_ESCROW','SUSPENSE_INBOUND',
  'SUSPENSE_OUTBOUND','SUSPENSE_CARD_FX','CENTRAL_BANK_RESERVE','CORRESPONDENT_NOSTRO',
  'HOT_WALLET','REVENUE','EXCHANGE_CLEARING','TREASURY_DERIVATIVES_POOL','MIGRATION_OFFSET')),
 user_id BIGINT REFERENCES avis_core_v2.sovereign_users,
 sub_account_code VARCHAR(50) NOT NULL DEFAULT 'MAIN',
 currency_code VARCHAR(25) NOT NULL CHECK (currency_code <> ''),
 network VARCHAR(32) CHECK (network <> ''),
 wallet_scope VARCHAR(15) NOT NULL DEFAULT 'FUNDING' CHECK (wallet_scope IN ('FUNDING','MARGIN','CUSTODY')),
 account_category VARCHAR(20) NOT NULL CHECK (account_category IN ('ASSET','LIABILITY','REVENUE','EQUITY','EXPENSE')),
 available_balance NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (available_balance <> 'NaN'::numeric),
 locked_balance NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (locked_balance >= 0 AND locked_balance <> 'NaN'::numeric),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((owner_type = 'USER') = (user_id IS NOT NULL)),
 -- NULL user/network must not allow duplicate system or fiat accounts.
 UNIQUE NULLS NOT DISTINCT (owner_type,user_id,sub_account_code,currency_code,network,wallet_scope)
);
CREATE TABLE avis_core_v2.ledger_journals (
 journal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 idempotency_key VARCHAR(128) UNIQUE NOT NULL,
 event_type VARCHAR(50) NOT NULL,
 reference_id VARCHAR(128),
 fiat_valuation_eur NUMERIC(20,6) CHECK (fiat_valuation_eur <> 'NaN'::numeric),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.ledger_entries (
 entry_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 journal_id UUID NOT NULL REFERENCES avis_core_v2.ledger_journals,
 account_id UUID NOT NULL REFERENCES avis_core_v2.ledger_accounts,
 direction VARCHAR(6) NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
 amount NUMERIC(36,18) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'::numeric),
 running_balance NUMERIC(36,18) NOT NULL CHECK (running_balance <> 'NaN'::numeric),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_by_journal ON avis_core_v2.ledger_entries(journal_id);
CREATE INDEX ledger_entries_by_account ON avis_core_v2.ledger_entries(account_id,entry_id);

CREATE TABLE avis_core_v2.marketplace_merchants (
 merchant_id VARCHAR(64) PRIMARY KEY,
 owner_user_id BIGINT NOT NULL REFERENCES avis_core_v2.sovereign_users,
 shop_name VARCHAR(150) NOT NULL,
 commission_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (commission_rate_bps BETWEEN 0 AND 10000),
 auto_invest_bond_isin VARCHAR(25),
 status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.checkout_payment_sessions (
 checkout_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 marketplace_order_ref VARCHAR(128) UNIQUE NOT NULL,
 buyer_user_id BIGINT REFERENCES avis_core_v2.sovereign_users,
 payment_rail VARCHAR(30) NOT NULL,
 crypto_asset_used VARCHAR(25),
 total_amount_eur NUMERIC(20,6) NOT NULL CHECK (total_amount_eur > 0 AND total_amount_eur <> 'NaN'::numeric),
 status VARCHAR(25) NOT NULL DEFAULT 'PENDING',
 capture_journal_id UUID REFERENCES avis_core_v2.ledger_journals,
 settlement_journal_id UUID REFERENCES avis_core_v2.ledger_journals,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 settled_at TIMESTAMPTZ
);
CREATE TABLE avis_core_v2.checkout_split_lines (
 split_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 checkout_id UUID NOT NULL REFERENCES avis_core_v2.checkout_payment_sessions,
 merchant_id VARCHAR(64) NOT NULL REFERENCES avis_core_v2.marketplace_merchants,
 gross_amount_eur NUMERIC(20,6) NOT NULL CHECK (gross_amount_eur > 0 AND gross_amount_eur <> 'NaN'::numeric),
 marketplace_fee_eur NUMERIC(20,6) NOT NULL CHECK (marketplace_fee_eur >= 0 AND marketplace_fee_eur <> 'NaN'::numeric),
 net_merchant_eur NUMERIC(20,6) NOT NULL CHECK (net_merchant_eur >= 0 AND net_merchant_eur <> 'NaN'::numeric),
 is_released BOOLEAN NOT NULL DEFAULT FALSE,
 CHECK (gross_amount_eur = marketplace_fee_eur + net_merchant_eur)
);
CREATE TABLE avis_core_v2.external_cash_accounts (
 cash_account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 ledger_account_id UUID UNIQUE NOT NULL REFERENCES avis_core_v2.ledger_accounts,
 institution_type VARCHAR(30) NOT NULL CHECK (institution_type IN ('CENTRAL_BANK','CORRESPONDENT_BANK','CORE_BANK_OMNIBUS','CARD_SCHEME_SETTLEMENT')),
 institution_name VARCHAR(100) NOT NULL,
 bic_code VARCHAR(11),
 iban_or_account_no VARCHAR(128) NOT NULL,
 currency_code VARCHAR(25) NOT NULL,
 endpoint_url TEXT,
 is_active BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE avis_core_v2.interbank_ip_transfers (
 transfer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 uetr UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
 direction VARCHAR(10) NOT NULL CHECK (direction IN ('OUTBOUND','INBOUND')),
 cash_account_id UUID NOT NULL REFERENCES avis_core_v2.external_cash_accounts,
 user_id BIGINT REFERENCES avis_core_v2.sovereign_users,
 journal_id UUID REFERENCES avis_core_v2.ledger_journals,
 debtor_iban VARCHAR(128) NOT NULL,
 creditor_iban VARCHAR(128) NOT NULL,
 currency_code VARCHAR(25) NOT NULL,
 amount NUMERIC(20,6) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'::numeric),
 iso_status VARCHAR(10) NOT NULL DEFAULT 'PDNG',
 raw_iso_payload JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.avis_cards (
 card_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id BIGINT NOT NULL REFERENCES avis_core_v2.sovereign_users,
 core_bank_card_ref VARCHAR(128) UNIQUE NOT NULL,
 card_type VARCHAR(15) NOT NULL,
 last_four_digits VARCHAR(4) NOT NULL CHECK (last_four_digits ~ '^[0-9]{4}$'),
 primary_crypto_asset VARCHAR(25),
 status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.user_deposit_addresses (
 address_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES avis_core_v2.sovereign_users,
 network VARCHAR(32) NOT NULL,
 public_address VARCHAR(256) NOT NULL,
 destination_tag BIGINT CHECK (destination_tag BETWEEN 0 AND 4294967295),
 derivation_index BIGINT CHECK (derivation_index >= 0),
 UNIQUE (user_id,network),
 UNIQUE NULLS NOT DISTINCT (network,public_address,destination_tag)
);
CREATE TABLE avis_core_v2.onchain_transactions (
 chain_tx_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id BIGINT REFERENCES avis_core_v2.sovereign_users,
 journal_id UUID REFERENCES avis_core_v2.ledger_journals,
 tx_type VARCHAR(30) NOT NULL,
 network VARCHAR(32) NOT NULL,
 tx_hash VARCHAR(128) NOT NULL,
 event_index BIGINT NOT NULL CHECK (event_index >= 0),
 from_address VARCHAR(256) NOT NULL,
 to_address VARCHAR(256) NOT NULL,
 currency_code VARCHAR(25) NOT NULL,
 asset_contract VARCHAR(256),
 amount NUMERIC(36,18) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'::numeric),
 status VARCHAR(20) NOT NULL,
 parent_tx_hash VARCHAR(128),
 block_timestamp TIMESTAMPTZ NOT NULL,
 UNIQUE (network,tx_hash,event_index)
);
CREATE TABLE avis_core_v2.migration_shadow_errors (
 error_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 legacy_tx_ref VARCHAR(128) NOT NULL,
 event_type VARCHAR(50) NOT NULL,
 raw_payload JSONB NOT NULL,
 error_message TEXT NOT NULL,
 resolved BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- No seeded balances, addresses, credentials, external endpoints or runtime cutover.
