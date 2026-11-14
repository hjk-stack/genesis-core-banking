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
| IP-to-IP / SWIFT / ISO 20022 payment server | Sovereign Core v2; Azure ESQL v3 | Required: transport, durable send/receive, pacs.008/pacs.002 lifecycle and settlement reconciliation |
| IBAN–ABIQ and external-bank APIs | ABIQ v8/v8.1 | Foundation has validated bank route ownership; connector execution and HTTP mounting remain to be integrated |
| Clearing account connector | Sovereign Core v2 §§2–4 | Required: incoming cash → suspense → common → user; outgoing suspense → confirmed cash settlement |
| ISO 8583 online and offline cards | POS v6; Industrial v6.2 | Required: scheme-specific codecs, verified replies, signed SAF batches, ATC deduplication, bounded reservation/capture and clearing |
| Multichain crypto and tokenization automation | Complete Bank & Crypto; OmniChain; Universal Asset Bridge | Preserve existing addresses; integrate chain verification, signing and automated asset registration |
| Fiat converter | v3 and ABIQ v8.1 | Required: firm quote, expiry, treasury inventory, exact two-currency journals and reversal |
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
