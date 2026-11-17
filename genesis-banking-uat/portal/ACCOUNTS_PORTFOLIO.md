# Accounts and portfolio workspaces

The former Treasury & ledger navigation item is Portfolio management. Existing
`#ledger` links redirect to `#portfolio`. It reads aggregated investment holdings
by asset and blockchain, without customer account lists or journal tracing.
The administrator portfolio contains institution holdings; customer workspaces
contain only that customer's holdings. Cash accounts, opening offsets and matching
system ledger entries are excluded so they are not counted as additional investments.
Existing offer registration, asset purchase and conversion actions remain available
in their respective institution/customer workspaces.

Account summaries stay in Accounts & ABIQ. Its administrator account-type filter
supports Personal, Business, Common Account and Suspense Account. Open account uses
the same four choices. Every supported FIAT bank account, including Common,
Suspense, Margin and securities Custody accounts, has its own ABIQ IBAN. Common and
Suspense creation returns the issued number and opens a named zero-balance account
without creating a customer or posting funds. Existing accounts receive identifiers
on their original ledger IDs. Crypto holdings and crypto clearing entries are
excluded from this workspace; crypto continues to use Wallets. Move to suspense
is available here to administrators.

Accounts are grouped into collapsible holder menus. Each account row shows exact
ABIQ IBAN, account purpose, exact credit/debit totals and its latest movement
reference. Internal bucket codes are not account numbers in this workspace.
Expand Movements to read that account's activity, with credit, debit,
reference and running balance. Account and movement rows open a single movable
dialog attached to the document body, with close/Escape and account navigation.
The BIC remains available in account details. Account detail and movement APIs
apply holder ownership before selecting any entry; no other party's ledger lines
or raw journal request payloads are returned to customers.

Common/Suspense rows open account-specific statements with incoming/outgoing totals,
running balances and pagination through older entries. Customer accounts cannot be
accessed through this statement endpoint. All backoffice account creation, listing
and statements require an administrator session. The database query scopes the
selected account before pagination and uses a consistent read transaction.

Migration 014 adds nullable display metadata. Migration 029 adds an immutable
identifier registry and backfills metadata for existing supported FIAT ledgers.
It creates no accounts, holders, holdings or journal entries, and preserves all
balances, existing primary ABIQ numbers, aliases and connections. Deferred database
issuance also covers future internal account creation. Account opening cannot
commit a supported FIAT ledger without an ABIQ number.

Account identification does not broaden payment eligibility. Payment, card,
securities purchase and trading source selectors continue to select eligible
funding accounts; margin/custody numbers identify their own accounts. Operational
ledger APIs retain internal bucket metadata for processing and verification.
