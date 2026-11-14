# Authorized UAT opening entries — 14 November 2026

Helmut requested 1,000 in each account and selected **UAT opening balances**:
EUR, USD and GBP funding accounts for existing holders 1 (AVISPay PLC) and 2
(Frontend user). This is six credits of 1,000, balanced by three treasury opening
asset entries of 2,000 in the respective currencies. It is not an external bank
deposit or a correspondent cash settlement.

`src/uat-opening.mjs` implements only this fixed request. The deployment executes
it inside the existing Azure container using its existing database connection.
There is no HTTP endpoint, generic credit API, new server, database reset, changed
bank connection or change to margin/custody balances.

Execution requires the exact UAT app name, environment DNS suffix and database.
The six recipients must match the existing holder identities, roles, active ABIQ
routes and funding liability ledgers. Before the first posting, all six available
and reserved balances must be zero. Validation, nine journal lines and the audit
record commit atomically. Unexpected existing balances fail without a partial
credit or reset.

The immutable request ID is `uat-opening-2026-11-14-six-accounts`. Database locks
and persisted operation idempotency return the original receipt on repeats;
later deployment runs cannot replenish spent funds or create another journal.
Account IDs and ABIQ identifiers remain unchanged. The technical journal event
`UAT_OPENING_BALANCE` records the origin of these balances.

The Payments menu now exposes **New payment**. The Reconcile statement action is
removed from that screen; existing statement records and backend reconciliation
are retained.
