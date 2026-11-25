-- Migration 047 generated a cancellation and a CLOSE event for an unfinished
-- registration. Restore its visibility. Keep the original CLOSE audit event.
-- migrate() runs this file in one transaction.
ALTER TABLE avis_core_v2.checkout_ip_cancellations
 DISABLE TRIGGER preserve_checkout_ip_cancellations;

WITH restored AS (
 UPDATE avis_core_v2.checkout_ip_requests r
 SET superseded_by=NULL,updated_at=now()
 WHERE r.superseded_by IS NOT NULL AND r.status='CLOSED'
  AND EXISTS (SELECT 1 FROM avis_core_v2.checkout_ip_events e WHERE e.request_id=r.request_id
              AND e.event_type='CLOSE' AND e.actor_id='system:checkout-duplicate-review')
  AND NOT EXISTS (SELECT 1 FROM avis_core_v2.checkout_ip_processing p WHERE p.request_id=r.request_id
                  AND (p.operation_completed OR p.handler_status='SETTLED'))
  AND NOT EXISTS (SELECT 1 FROM avis_core_v2.checkout_ip_settlements s WHERE s.request_id=r.request_id)
  AND NOT EXISTS (SELECT 1 FROM avis_core_v2.checkout_ip_settlement_claims c WHERE c.request_id=r.request_id)
 RETURNING r.request_id
), cleared AS (
 DELETE FROM avis_core_v2.checkout_ip_cancellations c USING restored r
 WHERE c.request_id=r.request_id AND c.actor_id='system:checkout-duplicate-review'
 RETURNING c.request_id
)
INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id)
SELECT 'system:checkout-register','RESTORE_UNFINISHED_CHECKOUT',request_id FROM restored;

ALTER TABLE avis_core_v2.checkout_ip_cancellations
 ENABLE TRIGGER preserve_checkout_ip_cancellations;
