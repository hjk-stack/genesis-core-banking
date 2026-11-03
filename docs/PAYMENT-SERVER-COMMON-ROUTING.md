# Payment Server — COMMON and suspense currency mapping

This increment implements **pure, testable routing logic** linking incoming normalized SWIFT FIN / ISO 20022 payment metadata to the existing PAYMENT_CLEARING COMMON and SETTLEMENT_UNCONFIRMED suspense account **templates**.

The source catalog has 20 COMMON product templates (including PAYMENT_CLEARING) and 120 suspense purpose templates. These are *product-level templates*, not yet live currency balances or correspondent accounts. The new routing code makes the required **currency-level allocation** explicit.

For every currency you intend to activate, provision **two actual records** in the authenticated banking ledger and admin register: one COMMON clearing account and one separate suspense account. Example configuration shape **only, without production account numbers**:

```json
{
  "currency": "EUR",
  "commonAccountCode": "COM-0018",
  "suspenseAccountCode": "SUS-0018-02",
  "commonAccountRef": "COMMON-EUR",
  "suspenseAccountRef": "SUSPENSE-EUR",
  "status": "activated"
}
```

**Do not use the demonstration account references in a real bank.** They are illustrative IDs for unit tests. The admin account activation must write unique authenticated references to a persistent database; user-provided values are not sufficient to assert live allocation.

Internal adapter libraries:

- `src/payment-server.js`: `mapCurrencyAccounts` rejects duplicates, wrong account products, reused references, nonactivated mapping and invalid currency; `prepareInboundPayment` validates FIN or ISO 20022 metadata, binds currency to configured account refs and outputs an **unposted** envelope for further authentication and settlement validation. It does not accept money or mutate balances.
- `src/payment-server-framing.js`: bounded 2-byte length-prefixed TCP message framing for integration test fixtures; it is **not** full FIN envelope parsing, SWIFT network authentication, encryption or certified correspondent interoperability. Framing must be selected per external bank's signed protocol contract, not inferred as universal FIN transport.
- `GET /api/payment-server/status`: read-only operational summary; **not** transaction intake.

**Remaining for an operational, live IP-to-IP server:**

1. Contracted correspondent-bank endpoint/address/port, bank-supported protocol profile (including any length framing), mTLS / VPN or private link, authenticated server identity and bank-approved cryptographic trust anchors.
2. An isolated, private network listener/client, strict message authentication, parser/serializer to the actual host specification, timeout/acknowledgement/retry/idempotency and replay protections, persistent inbox/outbox and audit logs.
3. Managed-identity PostgreSQL configuration and **reviewed migrations** providing an approved account registry, immutable double-entry journal, permissioned bank operators and independently reconciled statement records.
4. A secure administrator activation workflow for each currency COMMON and suspense account. Link activated records to correspondent account identities and settlement currencies. Initial balances must be zero unless funded by independently verified financial entries.
5. Integrate transaction states (received, validated, correspondent-accepted, settled, reconciled, posted/exception), beneficiary identification, sanctions/payment screening and suspense investigation. Do not post a card, SWIFT or other payment twice for cover-leg messages.
6. Test with a certified/contracted bank host using non-production test credentials, then perform the approved production acceptance sequence and verify actual external reconciliation before enabling financial movement.

A user-facing status or successful frame exchange is not evidence of actual bank connectivity, booked COMMON funds or settled FIN transactions.
