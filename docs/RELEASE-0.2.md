# GENESIS Core Banking - Release 0.2 foundation

This release adds source modules and a **review-only** PostgreSQL migration for:
- customer registry with review states;
- currency/asset-coded wallets;
- double-entry journal tables and debit/credit validation;
- draft payment instruction intake with idempotency;
- audit-event storage foundation.

**Not live banking:** The API intentionally exposes no customer, balance, payment, or ledger write endpoints. Existing /healthz stays independent of the database. The SQL migration is NOT automatically executed on Azure. Banking services cannot be used until the approved database identity, schema migration, and service authorization are deployed.

## How to review
1. Inspect migrations/001_foundation.sql with a PostgreSQL and security engineer.
2. Review currency precision: the schema uses integer minor units; multi-asset token precision and FX conversion require a separate asset-specific precision registry, conversion journal pairs and rounding policy.
3. Test with a disposable development database only; test rollback, concurrency, journals, reconciliation, all permissions.
4. Provision a least-privilege Entra PostgreSQL role. Separate migration identity from runtime identity.
5. Implement authenticated staff/customer API, maker-checker, sanctions/KYC, payout approvals, velocity limits, audit, reconciliation and account freeze controls.
6. Connect payments via certified provider sandbox adapters only; no direct routing to live rails without operational approval.

## Security gates
- Public GitHub project contains no secrets or customer information.
- Never expose administrative DB credentials in App Service env or repository.
- Do not enable GENESIS_ENABLE_TEST_POSTING in an Internet-facing deployment.
- Payments are drafts, not instructions sent to ACH, SEPA, SWIFT or crypto networks.
- Ensure managed-identity token refresh and PostgreSQL certificate validation before enabling the database connector.

## Modules not implemented yet
External FIAT rails (SEPA, SWIFT, ACH, ISO 20022), card issuing/acquiring (PCI scope),
crypto custody and chain settlement, derivatives lifecycle, tokenisation, trading, AML, regulatory reporting and production reconciliation.
