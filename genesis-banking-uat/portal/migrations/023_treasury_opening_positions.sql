-- Existing registered inventory is carried to AVISPay PLC Treasury by an operator booking.
-- No exchange, blockchain transfer, correspondent payment, or settlement workflow.
CREATE TABLE avis_core_v2.treasury_opening_positions (
 booking_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_system varchar(100) NOT NULL,
 source_reference varchar(160) NOT NULL,
 owner_user_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users(user_id),
 asset_class varchar(12) NOT NULL CHECK(asset_class IN ('SECURITY','CRYPTO')),
 asset_code varchar(64) NOT NULL,
 asset_name varchar(200) NOT NULL,
 isin varchar(12),
 quantity numeric(36,18) NOT NULL CHECK(quantity>0 AND quantity<>'NaN'::numeric),
 destination varchar(40) NOT NULL CHECK(destination IN ('TREASURY_PORTFOLIO','TREASURY_WALLET')),
 ledger_account_id uuid REFERENCES avis_core_v2.ledger_accounts,
 journal_id uuid REFERENCES avis_core_v2.ledger_journals,
 booking_reference varchar(128) NOT NULL UNIQUE,
 booked_by varchar(180) NOT NULL,
 booked_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_system,source_reference,asset_class,asset_code)
);
CREATE TRIGGER treasury_opening_positions_immutable
 BEFORE UPDATE OR DELETE ON avis_core_v2.treasury_opening_positions
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();
CREATE INDEX treasury_opening_positions_owner ON avis_core_v2.treasury_opening_positions(owner_user_id,asset_class);
