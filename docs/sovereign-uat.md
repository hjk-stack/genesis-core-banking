# AVISPay sovereign banking implementation

The current production-facing launcher is not the banking implementation described by the uploaded specifications. The replacement lives in `genesis-banking-uat/portal`. Its ledger is AVISPay's `avis_core_v2`; the existing Fineract installation supplies administrator authentication only. Customer provisioning, account numbering and financial posting do not call Fineract or an external bank.

## Source-to-flow mapping

| Required flow | Governing source | Implementation / acceptance boundary |
|---|---|---|
| Sovereign customer and partitioned accounts | Sovereign Core v2 §§1–4; ABIQ v8.1 §§1–4 | Atomic customer + ABIQ funding accounts + margin/custody scopes; asynchronous connector outbox |
| Exact, balanced, immutable posting | Sovereign Core v2 §§2–3; Azure ESQL v3 §3 | `post_journal`, deterministic locks, currency/network balance checks, payload-bound idempotency and rollback |
| ABIQ internal payments | ABIQ v8/v8.1 | Active account resolution and atomic payer/payee posting |
| Marketplace City shops and escrow | Azure ESQL v3 §§2–4 | Business-owned shops, multi-shop EUR bank capture, partial/full delivery release, escrow refund |
| AVIS proprietary cards and POS | POS/Card Bridge v6 §§1–4 | Separate card/terminal/gateway records; fiat authorization to suspense, capture to merchant/fees, reversal |
| IP-to-IP / SWIFT / ISO 20022 payment server | Sovereign Core v2; Azure ESQL v3 | HTTPS/mTLS and length-framed TLS transport; authenticated ingress; official-XSD validation; durable outbox; separate ACTC/ACSP/ACCC/RJCT processing; uncertain delivery retained without automatic retransmission |
| IBAN–ABIQ and external-bank APIs | ABIQ v8/v8.1 | Bank-issued IBAN to ABIQ ownership mapping and operational forms/API. Protocol transport is mounted; bank-specific REST contracts still require their actual field/authentication profiles. |
| Clearing account connector | Sovereign Core v2 §§2–4 | Incoming confirmed cash → suspense → common → user; outgoing reservation → confirmed cash settlement; balanced statement reconciliation; clearing liquidity reserved alongside customer funds. |
| ISO 8583 online and offline cards | POS v6; Industrial v6.2 | ASCII/binary bitmap codec with configurable dictionary, correlated replies, AVIS switch authorization/capture/reversal, signed prefunded offline allowances and atomic SAF settlement with card + terminal verification. External scheme profiles, EMV cryptogram adapters and industrial tranche processing are subsequent acceptance items. |
| Multichain crypto and tokenization automation | Complete Bank & Crypto; OmniChain; Universal Asset Bridge | Preserve existing addresses; integrate chain verification, signing and automated asset registration |
| Fiat converter | v3 and ABIQ v8.1 | Treasury-funded 30-second quotes, expiry/cancellation release, exact two-currency posting and commissions. The ECB reference feed retains its publication date; these are AVISPay treasury quotes, not external bank trade confirmations. |
| Exchange / robot / index picker | Exchange v5; Board W-Effect clarification | Required in final workstream; W-Effect has no margin or leverage prerequisite |

This branch does not claim completion of the full banking programme. Internal operator-account tests do not prove external network acceptance, card certification, on-chain execution or live exchange operation. Those are engineering acceptance evidence, not customer-facing banners.

## Preservation and deployment

- Migrations 001 and 002 are unchanged copies of the checksummed account foundation already applied to the existing UAT database.
- Migration 003 adds operations, journal posting, audit and card/terminal records. It does not update legacy/public tables or seed money, customers, blockchain addresses or bank accounts.
- The internal `AVIS` ABIQ participant is seeded from v8.1; its account checksum is computed, not copied from inconsistent sample numbers. External IBAN/BIC allocation remains a separate bank route.
- The test environment and existing application remain the deployment target. No new infrastructure, HSM, database reset or legacy cutover is included.
- The old infrastructure workflow now requires its explicit maintenance input; a banking application change must not recreate or reset the existing stack.

## Verification

`cd genesis-banking-uat/portal && npm ci && npm test` runs the actual SQL posting and services against embedded PostgreSQL. CI uses PostgreSQL 17, including concurrent insufficient-funds contention. Tests use a dedicated temporary `avispay_ci` database and never an Azure customer database.

The interface fetches records from the authenticated API. There are no fabricated balances or external-integration placeholder banners. Each form reports its own failure; technical codes are logged with request IDs.

## Payment protocol contracts

- Authenticated peer endpoints: `POST /network/{profile}/iso20022`, `/iso8583`, `/offline-batch`. HMAC binds method, path, timestamp, nonce and body hash; nonces persist in PostgreSQL. mTLS is used for outbound bank transport. Terminal credentials restrict the terminal IDs accepted by the card endpoints.
- Connector secrets are existing application secret references named `AVIS_CONNECTOR_*`; JSON contains `hmacSecret`, TLS `cert`/`key`, optional `ca` and `allowedTerminals`. Neither private keys nor secret values are stored in source or operator request records.
- `AVIS_OFFLINE_SIGNING_KEY` is the application signing key for the AVIS proprietary allowance protocol. Card and terminal verification supports Ed25519 or P-256. The protocol is named `AVIS_OFFLINE_V1`; it is not represented as EMV certification or a verified EMV TC. A scheme EMV adapter must validate scheme cryptograms separately.
- Allowance funds move to a dedicated suspense account before issuance. Signed card transactions bind grant, amount, currency, terminal, time, nonce and counter. The upload window closes two days after spending expiry. Remaining allowance can be released only after that window. A bad item rolls back the entire batch.
- `signedBytes` sorts JSON object keys recursively. Both device implementations must use that exact canonical encoding. Terminal batches include the full card-signed transactions.
- Official XSDs: [pacs.008.001.08](https://www.iso20022.org/message/14231/download), [pacs.002.001.10](https://www.iso20022.org/message/14061/download). XSD validation does not establish compliance with every bank's additional message profile.
- [Worldpay ISO 8583 reference](https://docs.worldpay.com/assets/pdf/Worldpay_ISO_8583_Reference_Guide_V2.62.pdf) and [FIS LISO reference](https://developerengine.fisglobal.com/assets/pdf/ISO_8583_Host_Capture_Msg_Spec_LISO_V1.2.pdf) demonstrate differing field layouts. `AVIS_ASCII` is the AVIS proprietary dictionary; it is not automatically a Worldpay/FIS/Visa/Mastercard profile.
- Breinrock's public BaaS page advertises APIs but its documentation link leads to its contact page. No endpoint, bank response or account-creation confirmation has been invented.

## FX reference data and execution

The ECB daily XML feed supplies published reference rates; publication date and retrieval time are retained. These are not advertised as streaming prices. The feed covers 13 of the 14 configured fiat currencies including EUR; AED requires an external-bank rate source and is not synthesized. Quotes reserve destination-currency treasury inventory for 30 seconds, with automatic expiry release. Execution posts both currencies and the chosen commission atomically. No initial treasury balance is seeded. The rate publisher runs on startup/hourly and cannot veto account creation or payment operation.

## Payment process restart recovery

A startup and 10-second recovery worker resolves expired delivery leases in bounded, audited batches. Unconfirmed deliveries retain their reservations and are never automatically resent. An authenticated final bank response or matched statement closes delivery and financial settlement in the same database transaction. Recovery repairs earlier committed-settlement/outbox gaps without posting a second journal. Transport requests also have a 15-second wall-clock deadline, including peers that continue sending partial data.
