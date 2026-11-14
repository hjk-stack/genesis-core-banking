CREATE INDEX payment_outbox_unresolved ON avis_core_v2.payment_outbox(status,lease_until)
 WHERE status<>'ACKNOWLEDGED';
