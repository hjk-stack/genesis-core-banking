-- GENESIS ArtOfCards 0.3: review-only PostgreSQL schema.
-- Requires migrations/001_foundation.sql; NEVER auto-applied by deployment.
-- Card data environment (PAN, CVV, PIN, keys, card network tokens) excluded.
BEGIN;
CREATE TABLE IF NOT EXISTS banking.card_applications (
 id uuid PRIMARY KEY,
 customer_id uuid NOT NULL REFERENCES banking.customers(id),
 form_factor text NOT NULL CHECK(form_factor IN ('virtual','physical')),
 product_type text NOT NULL CHECK(product_type IN ('debit','prepaid')),
 client_request_id varchar(80) NOT NULL UNIQUE,
 status text NOT NULL CHECK(status IN ('pending_review','approved','rejected','cancelled')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS banking.merchant_applications (
 id uuid PRIMARY KEY,
 customer_id uuid NOT NULL REFERENCES banking.customers(id),
 display_name varchar(120) NOT NULL,
 merchant_category char(4) NOT NULL CHECK(merchant_category ~ '^[0-9]{4}$'),
 client_request_id varchar(80) NOT NULL UNIQUE,
 status text NOT NULL CHECK(status IN ('pending_review','approved','rejected','suspended')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS banking.acquiring_event_reports (
 id uuid PRIMARY KEY,
 merchant_application_id uuid NOT NULL REFERENCES banking.merchant_applications(id),
 external_reference varchar(80) NOT NULL,
 event_type text NOT NULL CHECK(event_type IN ('authorization','capture','refund','chargeback')),
 asset_code varchar(12) NOT NULL CHECK(asset_code ~ '^[A-Z0-9]{3,12}$'),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 status text NOT NULL CHECK(status IN ('unverified','reconciled','rejected')),
 created_by text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(merchant_application_id,external_reference,event_type)
);
-- Do not use this schema to store raw card data or authorize financial settlement.
COMMIT;
