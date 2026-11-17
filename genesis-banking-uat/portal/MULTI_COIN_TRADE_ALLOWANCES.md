# Multi-coin trade allowances

The first row of the approved trading terminal lists accepted wallet trading allowances, not public market-price cards. The public market ticker remains in the footer.

## Data and controls

`GET /api/views/tradingallowances` returns one positive active allowance total per original wallet account, including currency, blockchain, holder, exact quantity and persisted selection version. AG and AGi do not require a market price to appear. Different account IDs and different blockchains remain separate.

`POST /api/crypto/trading/select-wallet` takes `accountId`, Boolean `enabled`, and `expectedVersion`. The existing authenticated session, CSRF checks, idempotency and ownership boundary apply. Selecting or pausing changes only the account's selection record. It does not post a journal, move a balance, create a key, or replace an address.

Several coins may be selected simultaneously. Refreshing or signing in again reads their persisted states. Releasing the final allowance removes that coin from the row and clears its selection. A later allocation does not silently reactivate a released selection.

## Robot enforcement

A configured strategy's existing master activation and reviewed-test requirements are retained. For a holder/base asset with wallet delegation history, new robot entries additionally require a selected active allowance. The server checks total position quantity plus outstanding entry quantities against the selected base-asset allowance across that holder's profiles. The admission and dispatch boundaries both enforce this check. Pausing a coin stops new entries; existing-position exits remain available. Strategies without wallet delegation history retain their original funding and risk checks.

## Acceptance

- Positive AG/AGi allowances appear without USD market data.
- Multiple selections persist and pause independently.
- Customer A cannot read or select Customer B's allowances.
- Decimal quantities retain all 18 fractional places.
- Selection does not alter ledger balances, journals or key records.
- Stale updates do not overwrite another session's selection.
- Final allowance release withdraws its selection.
- Multiple profiles cannot reuse the same base-asset allowance.
- Deployment checks the exact served JS/CSS and compares live allowance rows with authenticated consent records using read-only requests.

No deployment verification step activates a user's coin or submits a trading order.
