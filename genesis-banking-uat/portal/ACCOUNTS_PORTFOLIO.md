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
the same four choices. Personal/Business still provision ABIQ accounts; Common and
Suspense create named zero-balance internal accounts without creating a customer,
issuing a bank identifier or posting funds. Existing common/suspense accounts are
included automatically. Move to suspense is available here to administrators.

Accounts are grouped into collapsible holder menus. Each account row shows exact
credit/debit totals and its latest movement reference, without a BIC/ABIQ-code
column. Expand Movements to read that account's activity, with credit, debit,
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

Migration 014 adds nullable display metadata only. It does not delete, reclassify,
renumber or rewrite existing accounts, balances, ledgers or connections. Operational
ledger APIs remain for internal processing and deployment verification.
