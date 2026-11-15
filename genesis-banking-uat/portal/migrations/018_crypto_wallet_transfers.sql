-- Ethereum wallet sends reuse the durable contract-action outbox. Older manual
-- requests keep their original delivery mode and settlement process.
ALTER TABLE avis_core_v2.asset_transfer_requests DROP CONSTRAINT asset_transfer_requests_delivery_mode_check;
ALTER TABLE avis_core_v2.asset_transfer_requests ADD CONSTRAINT asset_transfer_requests_delivery_mode_check
 CHECK(delivery_mode IN ('INTERNAL','MANUAL','BLOCKCHAIN'));
ALTER TABLE avis_core_v2.asset_transfer_requests DROP CONSTRAINT asset_transfer_requests_status_check;
ALTER TABLE avis_core_v2.asset_transfer_requests ADD CONSTRAINT asset_transfer_requests_status_check
 CHECK(status IN ('REVIEW','OUTGOING','COMPLETED','CANCELLED','FAILED'));
ALTER TABLE avis_core_v2.crypto_chain_actions ADD COLUMN request_id uuid UNIQUE
 REFERENCES avis_core_v2.asset_transfer_requests;
