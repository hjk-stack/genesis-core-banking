-- Existing corporate holders retain their account number while receiving the
-- institution classification. Migration 008 only set this role for new holders.
WITH corrected AS (
 UPDATE avis_core_v2.sovereign_users SET account_role='INSTITUTION'
 WHERE user_id=1 AND full_name='AVISPay PLC' AND account_type='BUSINESS'
 AND account_role<>'INSTITUTION'
 RETURNING user_id
)
INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id)
 SELECT 'migration:009','ASSIGN_INSTITUTION_ROLE',user_id::text FROM corrected;
