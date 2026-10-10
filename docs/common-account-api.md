# GENESIS COMMON-account and messaging API contract

**Status: DEVELOPMENT / DISABLED.** This is a contract for future authenticated correspondent adapters, not a production FIN or ISO 20022 gateway. No funds may be accepted, transferred, booked or presented as settled by these diagnostic endpoints.

## Bank-wide account chart
- 20 third-party omnibus COMMON product templates, COM-0001 through COM-0020.
- 120 suspense templates, six per COMMON product, SUS-nnnn-01 through SUS-nnnn-06. Purposes: unmatched beneficiary, unconfirmed settlement, unmatched cover, correspondent breaks, compliance holds and returns.
- COMMON assets are third-party interests, not proprietary bank assets. Beneficiary allocation must follow source authentication and settlement confirmation.
- Ledger postings are separate from incoming messages. Unallocated funds remain in suspense.

## Internal account numbering
- GENESIS-IBAN-BASE reserves 100,000 internal slots (00000-99999), with non-bank references GCB-INT-00000 to GCB-INT-99999.
- None of these are IBANs. Production issuance requires approved national IBAN format, licensed bank identifier, national BBAN rules, MOD-97 validation and bank-controlled activation.
- PostgreSQL reservations must be atomic with uniqueness and audit trail. No process-memory increment.

## Inbound correspondent API flow
1. Authenticated FIN, MX, bank API, custodian or PSP connector with certificates and Key Vault credentials.
2. Parse, authenticate, validate schemas and participant identifiers, UETR where applicable, and detect duplicates.
3. Normalize structured headers into inbound_message_headers; retain signed originals in restricted immutable archival storage.
4. Link MT103 with MT202 COV; link ISO pacs.008 with pacs.009 COV. The cover leg must never create a second beneficiary credit.
5. Reconcile against pacs.002 and camt.052/053/054 confirmations or bank-certified correspondent balances.
6. Hold unmatched, disputed or unconfirmed funds in the appropriate suspense account.
7. Identify the beneficiary using bank account reference, customer identifiers, Contact Incubator profile, transaction identifiers and required screening. A message alone does not prove ownership or settlement.
8. Authorized maker/checker workflow posts balanced, audited double-entry journals and allocates beneficiary subledger interests.
9. Outbound instructions remain disabled until dedicated authentication, approval, liquidity, legal and payment-rail controls are verified.

## Current development endpoints
- GET /api/common-accounts: COMMON/suspense catalog and disabled rail types.
- GET /api/iban-range: capacity and non-issued status.
- GET /api/message-templates: SWIFT FIN and ISO message templates.
- GET /message-workbench: example form. Not a live SWIFT terminal or ISO XML sender.
- GET /healthz: service liveness.

No anonymous financial message intake or booking routes are enabled. src/message-adapters.js exports normalization code only for eventual authorized adapters.

## Formats
- MT103 is a FIN customer credit-transfer message (ISO pacs.008).
- MT202 COV is the FIN cover payment message (ISO pacs.009 COV).
- MT202 is a financial institution transfer (ISO pacs.009).
- MT203 is a retired legacy message type, not a cover payment.
- pacs.002 gives payment statuses; camt.052/053/054 support liquidity reporting and reconciliation.

## Required before financial operation
- Review/apply migrations 001, 004 and 005 using restricted migration credentials.
- Confirm settlement/correspondent agreements, correct bank identifiers and authorized payment provider access.
- Configure managed identities, Key Vault, schema validation, replay controls and reliable idempotency.
- Validate client asset segregation, custody title, source/beneficiary identity and immutable audit.
- Complete end-to-end sandbox and bank-approved external certification, where required.
