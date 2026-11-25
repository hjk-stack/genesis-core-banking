ALTER TABLE avis_core_v2.checkout_ip_requests
 ADD COLUMN superseded_by uuid REFERENCES avis_core_v2.checkout_ip_requests(request_id);

-- Both request fingerprints identify the operator-reviewed pair. The older routed
-- record stays available to the bank handler. Never suppress a processed request.
WITH archived AS (
 UPDATE avis_core_v2.checkout_ip_requests duplicate
 SET superseded_by=retained.request_id,status='CLOSED',closed_at=coalesce(duplicate.closed_at,now()),updated_at=now()
 FROM avis_core_v2.checkout_ip_requests retained
 WHERE md5(duplicate.request_id::text)='5c702f13d32abe7a689aba986ce4b60d' AND md5(retained.request_id::text)='ae496ea3e5a0567ebd9bfbdcb1d875ed'
  AND duplicate.checkout_kind='MILESTONE' AND duplicate.source='industrial'
  AND (duplicate.checkout_kind,duplicate.source,duplicate.checkout_reference,duplicate.sender_account,
       duplicate.amount,duplicate.currency_code,duplicate.sender_ip)
    = (retained.checkout_kind,retained.source,retained.checkout_reference,retained.sender_account,
       retained.amount,retained.currency_code,retained.sender_ip)
  AND duplicate.nostro_cash_account_id IS NULL AND retained.nostro_cash_account_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM avis_core_v2.checkout_ip_processing WHERE request_id=duplicate.request_id)
  AND NOT EXISTS (SELECT 1 FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=duplicate.request_id)
 RETURNING duplicate.request_id
), audited AS (
 INSERT INTO avis_core_v2.checkout_ip_events(request_id,event_type,actor_id)
 SELECT request_id,'CLOSE','system:checkout-duplicate-review' FROM archived RETURNING request_id
)
INSERT INTO avis_core_v2.checkout_ip_cancellations(request_id,actor_id)
SELECT request_id,'system:checkout-duplicate-review' FROM audited ON CONFLICT DO NOTHING;
