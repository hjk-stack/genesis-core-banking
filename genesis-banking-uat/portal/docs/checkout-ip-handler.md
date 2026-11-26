# Checkout IP-to-IP processing and original payment proof

The website registers checkout activation requests. A bank administrator approves the receiving Common/Suspense account and optional NOSTRO/intermediary. The IP-to-IP handler reads that approved context, claims a matched bank settlement before booking it, and publishes processing reports and its original proof PDF. A new report with authenticated booked-bank evidence also credits the approved core account. The core creates its own journal; a website treasury UUID never identifies a core ledger account or journal.

## Endpoints and authentication

All service endpoints are `POST` with `Content-Type: application/json`. Sign the exact method, path and SHA-256 of the transmitted JSON bytes. Tokens also contain `iat`, `exp` (at most 60 seconds after `iat`) and a fresh 64-character hexadecimal `jti`; replayed tokens are rejected. Both profiles verify Ed25519 signatures against `https://avis.land/press/api/index-service/jwks`, while enforcing separate scopes:

| Profile | Authorization | Header `typ` | `iss` | `aud` |
| --- | --- | --- | --- | --- |
| Checkout | `Index-JWS <token>`; `Pos-JWS` also accepted | `AVIS-POS-REQUEST+JWT` | `https://avis.land/checkout` | `AVIS_BANK_POS_V1` |
| Handler | `Ip-JWS <token>` | `AVIS-IP-HANDLER-REQUEST+JWT` | `https://avis.land/ip-handler` | `AVIS_BANK_IP_HANDLER_V1` |

| Core endpoint | Profile | Input and result |
| --- | --- | --- |
| `/api/services/checkout-ip/register` | Checkout | Registration payload below; returns the request and its state. |
| `/api/services/checkout-ip/status` | Checkout | `{requestId}`; returns state and timestamps, without administrator routing data. |
| `/api/services/checkout-ip/cancel` | Checkout | `{requestId}`; records terminal cancellation and closes an existing request once. A previously unknown ID returns `{requestId,cancelled:true,registered:false,cancelledAt}` without creating a registration. |
| `/api/services/checkout-ip/context` | Handler | `{requestId}`; returns `{request,routing,claim,nostroAccounts,receivingAccount}`. `request.processing` is the latest report or `null`; `claim` is the retained settlement claim or `null`. |
| `/api/services/checkout-ip/claim` | Handler | `{requestId,handlerTransferId,transactionReference,...routing}`; returns `{requestId,claimed:true,handlerTransferId,transactionReference,routing,claimedAt}`. |
| `/api/services/checkout-ip/processing` | Handler | Flat processing payload below; returns `{requestId,processing}`. |

The registration payload is `{requestId,checkoutKind,source,checkoutReference,title,amount,currency,bankName,ip,authorized,account,accountName,contactName?,contactEmail?,documents?}`. `checkoutKind` is `MILESTONE` or `SHOP`; `source` is **required** and is `industrial` or `shop-basket`. `requestId` is a UUID, `amount` is a positive decimal string, `ip` is a valid IP address, and `documents` contains at most three filenames. The handler context may represent an ordinary amount as `10.000000000000000000`: remove trailing fractional zeros exactly before currency precision validation; do not convert through a JavaScript `Number`.

`routing` has exactly these business fields: `receivingAccountId`, `receivingAbiqIban`, `nostroCashAccountId`, `nostroIban`, and `intermediaryId`. Optional NOSTRO/intermediary fields are `null`. The claim submits all five fields from the approved context. Its transfer, stable UETR transaction reference and routing become immutable.

`receivingAccount` is `{accountId,accountType,label,currency,abiqIban}` for the approved core account, or `null`. `nostroAccounts` contains active same-currency registered cash accounts as `{cashAccountId,accountNumber,currency,bankName}`. If approval omitted the NOSTRO, the handler can select one at transaction time by submitting its canonical `nostroCashAccountId` and `nostroIban` when claiming. The account number must match exactly after case/whitespace normalization and identify only one active same-currency registered account. The supplied core ID must match that record. An explicitly approved NOSTRO cannot be replaced, and receiving/intermediary routing remains unchanged. Before claiming, reports use the original approved route, including a null NOSTRO. After claiming, context and reports use the frozen selected route.

Each `nostroAccounts` item also includes `receiverClearing` with `receiverBankName`, `receiverBankAddress`, `receiverAccountHolder`, `receiverIban`, `receiverBic`, `receiverSortCode`, `receiverCountry` and `receiverBankCode`. The first six values come directly from the registered core institution name, bank address, account holder, external account number, BIC and ABA. Missing optional values remain empty strings; country and bank code remain empty for transaction-time completion. Context reads do not infer a country from the BIC or modify registered metadata, accounts or balances.

## Settlement and cancellation ordering

The handler obtains a matching authenticated booked statement, validates the proposed accounting change, and then acquires the core claim **before** its existing settlement journal is written. Claim and cancellation contend on the same request row lock. If cancellation wins, settlement cannot claim or book. If the claim wins, cancellation returns `CHECKOUT_IP_PROCESSING` (409), and website rejection/expiry must retain the order and stock reservation. A settled/completed report returns `CHECKOUT_IP_COMPLETED` (409) instead. Cancellation records also prevent a late first registration or retry from reopening the request (`CHECKOUT_IP_CANCELLED`, 409).

A repeated claim must have the same request, transfer, transaction reference and routing. Its owner may recover a lost response, finish settlement, and publish the completion report after an administrator closes the activation switch. A retained claim prevents changing the linked draft or reopening its request. This protocol does not perform an external bank transfer; the handler's existing authenticated connector and statement reconciliation retain that responsibility.

## Processing payload

The input is flat except for the optional `proof` and `settlementEvidence` objects:

| Field | Contract |
| --- | --- |
| `requestId`, `handlerTransferId` | UUIDs; one handler transfer belongs to one request. |
| `revision` | Positive integer, increasing before completion. An identical revision/content retry is idempotent; conflicting content or an older revision is rejected. |
| `transactionReference` | Stable handler UETR throughout the report lifecycle, up to 140 characters. The original PDF separately includes the bank transaction ID. |
| `handlerStatus` | Handler state, up to 40 characters; `SETTLED` requires an owned settlement claim. |
| `bankName` | Sender bank, up to 180 characters. |
| `bankServerSentAmount`, `amountCleared` | Nonnegative decimal strings, at most 18 integer and 18 fractional digits; `null` before known. |
| `nostroIban`, `receivingAbiqIban` | Must match the approved route, or the immutable claimed route during recovery. Limits: 128 and 64 characters. |
| `beneficiaryName`, `beneficiaryAccount` | At most 160 and 128 characters. |
| `franchiseAllocatedPercent` | Decimal string from `0` to `100`, at most two fractional digits. |
| `operationCompleted` | Boolean. `true` requires `SETTLED`, a matching claim, populated sender/payment/ABIQ/cleared/beneficiary/allocation fields, the report and proof. |
| `manualReport100Digits` | Exactly 100 decimal digits when supplied; required for completion. |
| `proof` | `{fileName,pdfBase64}` containing the original handler-generated PDF; accepted only with completion. |
| `settlementEvidence` | Optional new booked-bank evidence described below; accepted only with `handlerStatus: 'SETTLED'` and a matching immutable claim. |

## Core ledger settlement

The authenticated handler supplies `settlementEvidence` only after its bound bank connector returned a matching booked statement entry. A transport acknowledgement, operator field or browser assertion is not settlement evidence.

| Evidence field | Contract |
| --- | --- |
| `journalId` | Handler-side journal UUID retained for audit. It is not a core journal UUID. |
| `bankTransactionId`, `statementId` | Stable bank entry reference and statement reference, each up to 140 characters. |
| `currency`, `amount` | Uppercase three-letter currency and exact positive decimal string. Both must match the registered request; amount also matches `amountCleared` and any supplied `bankServerSentAmount`. |
| `nostroAccount` | Registered external account number, up to 128 characters, matching the frozen claim after case/whitespace normalization. |
| `statementHash` | Required lowercase SHA-256 of the retained authenticated statement bytes. |
| `bookedDate` | Optional valid `YYYY-MM-DD` bank booking date. |
| `bookedAt` | Optional ISO timestamp only when supplied by the bank; `null` for a date-only statement. |

Within the existing processing transaction, core validates the claim, request amount/currency, active receiving ABIQ, Common/Suspense liability classification and linked NOSTRO asset account. It calls the existing balanced `post_journal` function to debit that NOSTRO asset and credit the approved receiving account. The journal, immutable evidence, processing revision and audit event either all commit or all roll back. No core account ID is taken from the handler's local treasury data.

The returned `processing.settlement` is `{journalId,handlerJournalId,cashAccountId,receivingAccountId,bankTransactionId,statementId,currency,amount,nostroAccount,statementHash,bookedAt,bookedDate,booked:true}`. Its `journalId` is the core journal, while `handlerJournalId` identifies the handler's evidence. Amount remains an exact decimal string, normally with 18 fractional digits. The handler verifies this receipt against its evidence and the claimed core route before acknowledging core credit. A missing receipt is not a successful core settlement.

One request can own only one settlement. `(cashAccountId, bankTransactionId)` is unique independently of amount, statement, date or retry revision; the handler journal is unique too. Retries return the same journal. Later report revisions cannot remove or change booked evidence. Existing settled bank transfers and manual NOSTRO mirrors block a duplicate checkout credit, and those booking paths reject an entry already credited by checkout. Retained unmatched statement entries must agree in direction, currency and exact amount.

Payloads without `settlementEvidence` preserve the original report-only behavior and historical retry fingerprints. Migration `046_checkout_ip_settlement.sql` creates immutable settlement storage without backfilling old reports, journals or balances. Previously retained statements without the required source hash are not automatically credited on rollout.

The original PDF is bounded to **2 MiB**, uses canonical base64, has a valid PDF header/end marker, and has an ASCII filename ending in `.pdf` (up to 128 characters). The handler retains the original bytes before publication. The core stores those bytes, their SHA-256 and their request/transfer/revision/transaction/report linkage. Completed reports, proof bytes, claims and processing audit records are immutable. This hash verifies stored byte integrity; it is not a PDF certificate signature.

Administrator register reads at `GET /api/views/checkoutip` expose `processing` and `processing.proof = {available,fileName,sha256,sizeBytes}` without document bytes. `GET /api/checkout-ip/:requestId/proof.pdf` returns the original PDF only to an administrator session; `?download=1` changes the response to an attachment. Customer workspaces cannot retrieve it. The UI fetches the PDF into one printable popup and revokes the preview URL on close, navigation or sign-out. The handler itself continues to open in a normal browser tab.

## Persistent administrator controls

The Payments page mounts the **Manual IP-Handler** switch before loading the checkout register. It opens a fresh transfer form through the authenticated direct-transfer entry, including when there are no checkout requests. Red means the handler window is closed. Green means it is open.

Each checkout row keeps its own activation switch and **Open handler** button. That button passes only the selected request's UUID to the handler.

The management tab opens synchronously from the switch interaction. Its opener is cleared before navigating to the handler. The controller retains the tab handle to observe closure, rather than persisting an assumed open state. The authenticated handler accepts a private closing channel only from its configured core origin with the matching per-tab capability; it closes itself when instructed over that channel. The capability is passed in the URL fragment and retained in the tab's history state for reloads. Request refreshes and selection changes do not navigate the management tab. Signing out or changing workspace clears the controls and requests closure of the tab owned by that page. If the destination cannot honor a close request, the active control stays green until the actual tab closes and shows feedback beside that action.

## Reproduce the integration evidence

Use Node.js 22.19 or later and both PR branches:

```bash
mkdir avispay-ip-review
cd avispay-ip-review
git clone https://github.com/hjk-stack/genesis-core-banking.git core
git clone https://github.com/hjk-stack/genesis-outlook-automation.git website
npm ci --no-audit --no-fund --prefix core/genesis-banking-uat/portal
npm ci --no-audit --no-fund --prefix website
node core/genesis-banking-uat/portal/scripts/verify-ip-handler-integration.mjs --website-repo ./website --output-dir ./evidence
```

`AVIS_WEBSITE_REPO` may supply the website path instead of `--website-repo`. The output directory is optional; when supplied it receives `result.json` and `fixture-handler-proof.pdf`. The script requires a local website checkout and imports its actual payload builder, clients, signer and handler. It creates an in-memory PGlite database, a temporary website store and signing key, a loopback HTTP server and a fixture statement connector. It makes no production service calls, ignores production database URLs, and removes its temporary state on exit.

Assertions cover the signed HTTP registration/approval/context flow, exact amount handling, stable identities, original PDF parsing and byte equality, immutable completion, terminal cancellation, cancellation between statement validation and claiming, and recovery after a claim response is lost. Recovery is tested after administrator closure. New authenticated evidence posts one handler journal and one distinct core journal, with the core NOSTRO debit and approved Common/Suspense credit checked directly; report/proof retries create no further postings. `test/checkout-ip-settlement.test.mjs` also exercises cross-path bank-entry deduplication, immutable evidence, optional NOSTRO selection and atomic rollback after a report-write failure.

The browser regression remains separate: `node --test test-browser/checkout-ip-layout.mjs` from the portal directory verifies the register and printable popup in Chromium; the normal sovereign UAT workflow runs the complete browser suite.

## Rollout

Deploy the core settlement release first, including additive migration `046_checkout_ip_settlement.sql`. Verify the release SHA and sovereign UAT checks for the merged commit. Then deploy the website release that publishes the new evidence and validates the core settlement receipt using the existing service signing identity. Re-run this integration script against the exact two source revisions used for the release. Historical report-only records remain unchanged. PR validation alone does not establish that either production deployment has completed.
