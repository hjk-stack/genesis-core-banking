# GENESIS payment-monitoring integration (Hawk AI)

Status: **disabled synthetic-only adapter**, not connected to Hawk. Requires vendor agreement, sandbox URL and API key. No real customer data, banking payment, settlement or GENESIS Bond access.

This adapter uses the documented Hawk API transaction-check workflow with a dry-run flag, but **a compliant production mapping is not implemented**.

## Vendor connection checklist
1. Contact Hawk AI for a sandbox tenant, API specification and test credentials.
2. Review data processing agreements, data locality, transaction-check schema, screening latency, availability and audit requirements.
3. Configure allowed vendor host, read-only test data and secrets through Azure Key Vault.
4. Enable outbound sandbox calls only with `HAWK_ENVIRONMENT=sandbox`, `HAWK_ALLOW_SANDBOX_CALLS=YES`, `HAWK_SANDBOX_URL` and a securely injected `HAWK_SANDBOX_API_KEY`.
5. Run tests in an isolated network and observe HTTP failures without storing sensitive payloads.
6. Conduct a separate production architecture/security review. Never auto-approve money movement based on an AI response.

Reference: https://docs.hawk.ai/apidocs/perform-transaction-check
