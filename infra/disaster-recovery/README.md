# GENESIS banking disaster recovery / backup server blueprint

**Design only. No backup server provisioned or live settings changed.**

## Primary and standby
- Primary: current existing Azure banking application and PostgreSQL database.
- Secondary: isolated alternate-region Azure Container Apps and protected PostgreSQL recovery target, provisioned under separate infrastructure-as-code review.
- Keep payment processing, market order routing and GENESIS Bond connectivity OFF in standby until incident approvals and reconciliation.
- Backups are not the same as availability; test restoring code, PostgreSQL, uploaded assets, configuration, keys and audit logs.

## Recommended validation
1. Run `bash infra/disaster-recovery/inventory-readonly.sh` from authenticated Azure Cloud Shell with appropriate read permissions. Default RG `genesis-banking-rg`. No resources are changed.
2. Inspect database backup policy: retention, zone HA and **geo-backup eligibility at creation**. Confirm the data is private and encrypted.
3. Design and cost separate standby region, private virtual network, independent Key Vault access and blob recovery options.
4. Restore database to a disposable isolated environment and reconcile ledger journals, transaction statuses, idempotency keys and audit logs.
5. Simulate region failure with all payments and trading disabled. Verify single writer, maker-checker promotion and no duplicate payout.
6. Approve and record practical RPO/RTO; proposed targets are RPO <= 5 minutes for ledger/payment state and RTO <= 60 minutes only when synchronous/replica technology and actual restore tests demonstrate them. Neither target is guaranteed by ordinary geo-backups.

**DO NOT** run destructive recovery, database promotion, DNS changes or production failover without human incident-command authorization.

Azure references:
https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-business-continuity
https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview
https://learn.microsoft.com/en-us/azure/architecture/web-apps/guides/multi-region-app-service/multi-region-app-service
