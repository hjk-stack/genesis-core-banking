-- Account IDs and original book owners are part of the permanent routing and journal history.
ALTER TABLE avis_core_v2.sovereign_users ADD COLUMN merged_into_user_id bigint
    REFERENCES avis_core_v2.sovereign_users(user_id) CHECK (merged_into_user_id <> user_id);

WITH merged AS (
    UPDATE avis_core_v2.sovereign_users former
       SET merged_into_user_id = institution.user_id
      FROM avis_core_v2.sovereign_users institution
     WHERE (former.user_id, former.full_name, former.account_type, former.account_role)
           = (3, 'AVISPay PLC', 'BUSINESS', 'CUSTOMER')
       AND (institution.user_id, institution.full_name, institution.account_type, institution.account_role)
           = (1, 'AVISPay PLC', 'BUSINESS', 'INSTITUTION')
    RETURNING former.user_id, former.merged_into_user_id
)
INSERT INTO avis_core_v2.operation_audit (actor_id, operation, resource_id)
SELECT 'migration:032', 'MERGE_BUSINESS_IDENTITY', user_id || '->' || merged_into_user_id FROM merged;

CREATE UNIQUE INDEX avispay_plc_active_identity ON avis_core_v2.sovereign_users
    ((lower(btrim(full_name)))) WHERE merged_into_user_id IS NULL
    AND account_type = 'BUSINESS' AND lower(btrim(full_name)) = 'avispay plc';

CREATE VIEW avis_core_v2.holder_identities AS
SELECT source.user_id AS record_user_id, source.account_role AS record_role,
       holder.user_id, holder.full_name, holder.account_type, holder.account_role,
       coalesce(holder.postal_address,source.postal_address) AS postal_address, holder.created_at
  FROM avis_core_v2.sovereign_users source
  JOIN avis_core_v2.sovereign_users holder ON holder.user_id = coalesce(source.merged_into_user_id, source.user_id);
