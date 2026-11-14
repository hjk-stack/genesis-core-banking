# ABIQ issuer installation

This change implements currency-account issuance in the existing Sovereign UAT core. Source precedence: the owner's current `AVIPTN64XXX` / `AVIP` instruction, fit.INTELECT ABIQ API v1 (2023), then the v8.1 currency and ledger requirements. Existing AQ/AVIS identifiers continue to resolve unchanged.

| Component | Current implementation |
|---|---|
| Issuer | AVIPTN64XXX |
| Country | TN, derived from the supplied issuer code |
| ABIQ institution ID | AVIP |
| Check digits | ISO 7064 MOD 97-10, calculated for every complete identifier |
| Currency block | Three ISO 4217 numeric digits: EUR 978, USD 840, GBP 826; all 14 configured currencies supported |
| Account suffix | Fourteen decimal digits from a non-cycling PostgreSQL sequence, independent of the holder ID |
| Length | 25 characters: 2 + 2 + 4 + 3 + 14 |
| Corporate holder | User 1, AVISPay PLC, BUSINESS / INSTITUTION |
| Frontend holder | User 2, Frontend user, PERSONAL / CUSTOMER |
| Initial currency accounts | EUR, GBP, USD for both requested holders, zero opening balances |

The suffix width is an implementation choice retaining the earlier plan's 14-digit capacity; the latest instruction replaces its AQ prefix, AVIS ID and four-digit currency partition. Sequence gaps after rolled-back requests are intentional: allocated numbers are never recycled. EUR suffix 1 produces `TN73AVIP97800000000000001`.

The manual's §3.2 distinguishes the ABIQ network's private BBAN layout from registered national IBAN layouts. This module therefore routes ABIQ identifiers internally. Existing bank-issued IBAN mappings remain separate and retain provider provenance. It does not assert registration of the issuer in an external registry or connectivity to the fit.INTELECT host.

## Account-opening path

`POST /api/customers` validates the holder and selected currency, then creates identity, ABIQ allocation, FUNDING/MARGIN/CUSTODY ledgers and enabled connector events in one transaction. The administrative account form selects the currency and displays the returned number. Adding a currency uses the same allocator. Database ownership/currency foreign keys, a unique serial number, and per-holder locks prevent duplicate or cross-owned allocations. Retrying a completed request returns its saved response; changing its payload returns a conflict.

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

Migration 008 is additive within `avis_core_v2`; migrations 001–007 retain their checksums. It creates the two requested UAT identities only if their numeric IDs are free or already match; conflicts abort the transaction. Historical AQ accounts, bank routes, ledger identifiers, journal lines and connector configuration remain unchanged. Merchant funding continues to prefer its existing AVIS account when present. No financial opening journal is fabricated.

Tests exercise a populated v7 upgrade, exact identifier vectors, all accepted currencies, persistence, wrong ownership, unsupported inputs, duplicate/replayed requests, concurrent PostgreSQL allocations and authenticated HTTP operations. Existing transfer, FX, card, offline POS, ISO 20022, transport and reconciliation regressions also run. Deployment validates the live release, existing administrator login, issuer, users 1/2 and their account checksums on the existing Azure Container App without submitting payments.

## Source review

The plan inventory is recorded in `abiq-source-inventory.json`. Core-account, ledger, currency, preservation and deployment provisions were checked across the available plan set; three pairs are identical copies. The latest attached v8 master plan supplies the v8 source in this review. The separate fit.INTELECT manual and gateway PDF supply the current message and identifier details. The older plans also describe later crypto, tokenization, card-network and trading work; this account-issuance change does not mark those milestones complete.

Manual discrepancies resolved: `ISO 4127` in ORDER means ISO 4217; SEARCH uses `abiqCODE` as its JSON example specifies; malformed JSON punctuation in examples is corrected. Country/check digits are computed, not copied from illustrative samples. Gateway material's batch-size examples do not replace the manual's one-identifier account-opening request.

Reference checks: [SIX currency maintenance](https://www.six-group.com/en/products-services/financial-information/market-reference-data/data-standards.html), [Swift IBAN registry](https://www.swift.com/standards/data-standards/iban-international-bank-account-number).
