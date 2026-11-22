-- Expire unapproved Web POS activation requests after sixty minutes.
-- Retain the original event stream and the last expiry timestamp for operators.
ALTER TABLE avis_core_v2.checkout_pos_controls
 ADD COLUMN expired_at timestamptz;
ALTER TABLE avis_core_v2.checkout_pos_events
 DROP CONSTRAINT checkout_pos_events_event_type_check;
ALTER TABLE avis_core_v2.checkout_pos_events
 ADD CONSTRAINT checkout_pos_events_event_type_check
 CHECK (event_type IN ('REQUEST','APPROVE','CLOSE','EXPIRE'));
CREATE INDEX checkout_pos_expiry_due
 ON avis_core_v2.checkout_pos_controls(requested_at)
 WHERE state='REQUESTED';
