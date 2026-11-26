ALTER TABLE avis_core_v2.checkout_ip_requests
 ADD COLUMN IF NOT EXISTS register_archived_at timestamptz;

-- Remove the reviewed closed registration from the Payments list only.
-- Both fingerprints match the operator-selected pair from migration 047.
WITH archived AS (
 UPDATE avis_core_v2.checkout_ip_requests older
 SET register_archived_at=now()
 FROM avis_core_v2.checkout_ip_requests retained
 WHERE md5(older.request_id::text)='5c702f13d32abe7a689aba986ce4b60d'
  AND md5(retained.request_id::text)='ae496ea3e5a0567ebd9bfbdcb1d875ed'
  AND older.status='CLOSED' AND older.register_archived_at IS NULL
  AND older.checkout_kind='MILESTONE' AND older.source='industrial'
  AND (older.checkout_reference,older.sender_account,older.amount,older.currency_code)
    = (retained.checkout_reference,retained.sender_account,retained.amount,retained.currency_code)
  AND retained.superseded_by IS NULL AND retained.register_archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM avis_core_v2.checkout_ip_processing WHERE request_id=older.request_id
                  AND (handler_status<>'DRAFT' OR operation_completed))
  AND NOT EXISTS (SELECT 1 FROM avis_core_v2.checkout_ip_proofs WHERE request_id=older.request_id)
  AND NOT EXISTS (SELECT 1 FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=older.request_id)
  AND NOT EXISTS (SELECT 1 FROM avis_core_v2.checkout_ip_settlements WHERE request_id=older.request_id)
 RETURNING older.request_id
)
INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id)
SELECT 'system:checkout-register','ARCHIVE_CHECKOUT_REGISTER_ROW',request_id FROM archived;
