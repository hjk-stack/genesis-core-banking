# Card and wallet workspaces

Implements the supplied Test Server Configuration requirements on the existing
UAT application and database. Migration 013 adds identity scopes and card metadata;
it does not rewrite existing account balances, card references or journal entries.

## Payments

The popup omits the redundant red heading, account/amount heading and sender prompts.
Bank payments select a currency account. Crypto selects a wallet holding directly.
Card payments select a card and show its current spendable ledger balance.
The “Make a force payment” choice still enforces funds and ownership. Its optional
“Card debit secured by code” control exposes start/end times after amount entry.
Confirmation reserves funds and generates the six-digit code and redemption token.
New code windows cannot exceed 48 hours; redemption checks start, expiry, card state,
attempt limits and one-time use. Existing grants keep their historical dates.

AG/AGi purchase and FIAT conversion use registered inventory and exchange offers.
Both directions post atomic balanced exchanges at the reviewed price. No inventory,
price or external cash is invented by this deployment.

## Cards and POS

Cards has its own navigation item. It contains grouped card accounts, a card-number
selector, incoming/outgoing activity, balance, issue/expiry dates, PIN reset,
block/unblock and encrypted delivery. New cards for a holder/currency share one
purse; older distinct purses remain intact. New card products are Virtual,
Standard - Business, Gold Card Standard, Black VIP Card, Gold Card Metal and
Gold Diamond. AVIS numbers identify proprietary cards; external scheme issuance
continues to use its own integration. Card loading and external-card requests remain
available. POS retains terminal and merchant processing separately.

## Customer access

Administrator logins retain the full operator workspace and may select a customer
workspace through the top-bar Workspace selector. That session then uses the same
restricted API boundary as a customer, while retaining the explicit ability to return
to Administration. Selecting a workspace is not a new credential or a second user.

Non-administrator Fineract identities require an explicit administrator-created
binding to a sovereign customer. The Link customer login action accepts the existing
Fineract user ID; it does not create or reset upstream credentials. Unbound identities
are rejected. Session roles and the holder ID come from the server, never request
body claims. Customer reads apply ownership before pagination; source accounts,
wallets, cards, reviewed requests and mutations are checked before ledger operations.
Administrative pickup, suspense, connector, audit and identity actions are excluded.

PINs use salted scrypt hashes; audit requests contain a keyed fingerprint, not the
PIN. Card delivery uses the existing encrypted-message mechanism. Blocking a card
prevents new card spending and coded redemption; unused reserved codes can be refunded.

Regression coverage includes real PostgreSQL concurrency, cross-customer access
attempts, login/session scopes, card accounting, timed codes, conversion, PIN storage,
and Chromium checks of the complete Cards/POS interface and payment popup geometry.
