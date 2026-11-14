# ABIQ issuer installation

This change implements currency-account issuance in the existing Sovereign UAT core. Source precedence: the owner's current `AVIPTN64XXX` / `AVIP` and customer-numbering instructions, fit.INTELECT ABIQ API v1 (2023), then the v8.1 currency and ledger requirements. Existing AQ/AVIS identifiers continue to resolve unchanged.

| Component | Current implementation |
|---|---|
| Issuer | AVIPTN64XXX |
| Country | TN, derived from the supplied issuer code |
| ABIQ institution ID | AVIP |
| Check digits | ISO 7064 MOD 97-10, calculated for every complete identifier |
| Currency block | Six digits: `000` + ISO 4217 numeric currency; EUR 000978, USD 000840, GBP 000826, CHF 000756 |
| Account suffix | Permanent five-digit currency series + seven-digit customer number, shared across that customer's currencies |
| Length | 26 characters: 2 + 2 + 4 + 6 + 5 + 7 |
| Corporate holder | User 1, AVISPay PLC, BUSINESS / INSTITUTION |
| Frontend holder | User 2, Frontend user, PERSONAL / CUSTOMER |
| Initial currency accounts | EUR, GBP, USD for both requested holders, zero opening balances |

Customer numbers start at `1000101` for AVISPay PLC, followed by `1000102` for frontend holder 2. They are independent of database user IDs and allocated once by a non-cycling PostgreSQL sequence. The range ends at `9999999`, providing 8,999,899 customer-number slots. Rollbacks may leave gaps; numbers are never recycled. This is identifier capacity, not a concurrent-load performance claim.

Currency series are fixed regardless of opening order: EUR 00001, USD 00002, GBP 00003, CHF 00004, SEK 00005, NOK 00006, DKK 00007, PLN 00008, CZK 00009, HUF 00010, RON 00011, AED 00012, SGD 00013, JPY 00014. A USD account opened first still uses series 00002. One funding account per holder/currency remains the existing rule; FUNDING/MARGIN/CUSTODY ledger scopes remain separate.

Examples for customer `1000101` (spacing for display only):

| Currency | ABIQ identifier |
|---|---|
| EUR | `TN89AVIP000978 000011000101` |
| USD | `TN37AVIP000840 000021000101` |
| GBP | `TN07AVIP000826 000031000101` |
| CHF | `TN14AVIP000756 000041000101` |

Check digits are computed from the full identifier, so `73` is not a fixed prefix. CHF uses ISO code 756; 978 belongs to EUR. The format examples do not open additional accounts: currencies are created when requested. The fit.REQUEST ORDER input remains three numeric digits (for example `756`); the six-digit currency block is a component of the resulting identifier only.

The manual's §3.2 distinguishes the ABIQ network's private BBAN layout from registered national IBAN layouts. This module therefore routes ABIQ identifiers internally. Existing bank-issued IBAN mappings remain separate and retain provider provenance. It does not assert registration of the issuer in an external registry or connectivity to the fit.INTELECT host.

## Account-opening path

`POST /api/customers` validates the holder and selected currency, then creates identity, ABIQ allocation, FUNDING/MARGIN/CUSTODY ledgers and enabled connector events in one transaction. The administrative account form selects the currency and displays the returned number. Adding a currency uses the same allocator. Database ownership/currency foreign keys, unique customer numbers, permanent currency series, and per-holder locks prevent duplicate or cross-owned allocations. Retrying a completed request returns its saved response; changing its payload returns a conflict.

The corporate identity is a business account on the existing customer-account side of the core ledger. System TREASURY, reserve, common and suspense accounts retain their existing classifications and balances. This installation does not move company capital or change any historical booking. The frontend holder is an account record; it does not create a separate frontend sign-in credential.

## ABIQ message interface

`POST /api/abiq` accepts the manual's `fitREQUEST` envelope under existing administrator authentication, same-origin and CSRF protection. The local `userId` field supplies verified account ownership context outside that envelope.

```json
{
  "userId": "2",
  "fitREQUEST": {
    "HEADER": {"requestID": "account-request-0001", "function": "ORDER"},
    "ORDER_INFO": {"abiqCODE": "AVIPTN64XXX", "abiqCURRENCY": "978", "numberIBANS": "1"}
  }
}
```

`ORDER` atomically opens or returns that holder's currency account and returns `fitRESPONSE.ABIQ_INFO.IBAN001.abiqIBAN` and `abiqACCOUNT`. The count is one, as required for core account opening in manual §5.2. Batch inventory ordering (up to 200 in the external host manual) is not this account-opening endpoint. `SEARCH` returns the configured issuer; `IBANCHECK` verifies checksum, currency and active registered account ownership. `REGABIQ` is not exposed: issuer configuration is installed by this migration, not re-registered remotely.

## Preservation and validation

Migration 008 installed the issuer within `avis_core_v2`; migrations 001–007 retain their checksums. It creates the two requested UAT identities only if their numeric IDs are free or already match; conflicts abort the transaction. Historical AQ accounts, bank routes, ledger identifiers, journal lines and connector configuration remain unchanged. Merchant funding continues to prefer its existing AVIS account when present. No financial opening journal is fabricated.

Migration 010 converts existing 25-character AVIP identifiers to the requested customer-based format atomically. Every previous AVIP identifier is retained as an alias to its original bridge and ledger. Both old and new identifiers observe the same owner, currency and active-account validation. Existing primary account references change only when they exactly match the former issued identifier; custom references remain intact. Historical request responses and audit records are preserved, so a retry may return its old, still-routable identifier. The original serial column remains as historical allocation metadata. No balances, journals, external bank routes, connector settings or Azure infrastructure are changed.

Tests exercise populated v7 and v9 upgrades, preservation of funded ledgers and routing aliases, 100,001 distinct customer-number allocations, exact identifier vectors, all accepted currencies, persistence, wrong ownership, unsupported inputs, duplicate/replayed requests, concurrent PostgreSQL allocations and authenticated HTTP operations. Existing transfer, FX, card, offline POS, ISO 20022, transport and reconciliation regressions also run. Deployment validates the live release, existing administrator login, issuer, users 1/2 and their account checksums on the existing Azure Container App without submitting payments.

## Source review

The plan inventory is recorded in `abiq-source-inventory.json`. Core-account, ledger, currency, preservation and deployment provisions were checked across the available plan set; three pairs are identical copies. The latest attached v8 master plan supplies the v8 source in this review. The separate fit.INTELECT manual and gateway PDF supply the current message and identifier details. The older plans also describe later crypto, tokenization, card-network and trading work; this account-issuance change does not mark those milestones complete.

Manual discrepancies resolved: `ISO 4127` in ORDER means ISO 4217; SEARCH uses `abiqCODE` as its JSON example specifies; malformed JSON punctuation in examples is corrected. Country/check digits are computed, not copied from illustrative samples. Gateway material's batch-size examples do not replace the manual's one-identifier account-opening request.

Reference checks: [SIX currency maintenance](https://www.six-group.com/en/products-services/financial-information/market-reference-data/data-standards.html), [Swift IBAN registry](https://www.swift.com/standards/data-standards/iban-international-bank-account-number).
