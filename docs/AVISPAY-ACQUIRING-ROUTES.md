# AVISPay — Acquiring network model

AVISPay is intended to act as its **own card acquirer**, using its institution-assigned acquiring BIN and the owner's **MIT** identifier. This is the primary card-acquiring path, not an external processor fallback.

The term **MIT** is deliberately retained as supplied. Before it is mapped to ISO 8583 fields or scheme/network records, verify precisely which identifier the registered acquiring network uses; it must not be automatically equated with merchant-initiated transactions, MID, or a terminal ID.

## Independent channels

1. **AVISPAY_DIRECT**: native AVISPay acquiring BIN/MIT, scheme/processor switch and terminal/merchant records, card-present POS and web POS as supported by certified interfaces.
2. **STRIPE**: external processor and hosted checkout/merchant acquiring route, preserving existing Stripe checkout and webhook integration in `hjk-stack/genesis-outlook-automation`.
3. **BUCKZY**: optional external provider route (the owner called it 'Bukzy'; confirm exact contracted company/product and supported card-acquiring vs cross-border payout services before integrating). No invented endpoint or credential.

The core module `src/acquiring-routes.js` represents these as **separate provider adapters**, each with independently configured state and routing selection; this commit does not implement provider network calls or financial postings. The default route is AVISPAY_DIRECT when operator configuration exists. External providers are optional; they do not replace the own-acquirer scheme.

## Production integration requirements

- Record AVISPay acquiring BIN/MIT/processor identity in authenticated administrator configuration backed by managed PostgreSQL and Key Vault; do not insert actual identifiers or network secrets in GitHub.
- Confirm licensed/network-registered acquiring identity, supported card schemes, terminal/MID mappings, merchant onboarding and 3DS/EMV/PCI requirements.
- Implement an authenticated/acquirer-certified ISO 8583 and/or provider-specific adapter, payment lifecycle (authorize, capture/clearing, reversal, refund, disputes), issuer response code mapping, acquirer reference, batch settlement and terminal/merchant records.
- For Stripe, retain signed webhook verification and platform checkout handlers; only verified provider receipts and independently reconciled deposits enter merchant settlement accounting.
- For the separate BUCKZY route, determine whether the contracted service supports card acquiring or only cross-border financial transfers and connect **only** documented permitted functions.
- Map each currency's net clearing/suspense flows into approved COMMON account records, with segregation between merchant settlement liabilities, card scheme settlement, provider receivables and bank cash. No transfer or real balance without an authenticated provider/bank statement and balanced journal.
- Test all channels individually with certification/UAT transactions; then verify a real authorized production settlement and statement matching before marking the route operational.

**Scope of this change:** routing metadata and unit tests only. It neither creates an acquiring BIN/MIT nor deploys a live acquiring switch.
