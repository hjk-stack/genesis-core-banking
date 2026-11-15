# Securities portfolio and AVISPay exchange

Portfolio management contains the securities register and Buy/Sell orders for
the administrator and the current customer's own holdings. Accounts and their
movement history remain in Accounts & ABIQ. Existing crypto holdings remain
visible below the securities register.

## Security data and valuation

`POST /api/portfolio/catalogue/sync` imports published securities from the existing
AVIS exchange's `https://avis.land/api/xchg/markets` feed. This is the same Green
Bond security data used by its exchange screens, subject to the source's
publication policy. No private databank route is opened. Catalogue refresh
updates reference metadata, not holdings or manually recorded market prices.
Currency, denomination and identifier changes require explicit handling rather
than silently rewriting an existing holding. Issued supply is never imported as
owned inventory.

The administrator may use **+ Add security** for a new instrument. ISIN and CUSIP
are optional for instruments without assigned identifiers; provided identifiers
must pass their format and check-digit validation. Selecting a security fills
its name, currency, short name, ISIN, CUSIP and denomination automatically.

**Record holding** records quantity, issuing price and market price against an
existing account holder, with a booking reference and immutable quantity
movement. Edits use a version to reject a stale overwrite and cannot reduce
quantity below reservations. Initial inventory booking is an administrator
operation; a customer cannot create saleable inventory by editing a form.

The portfolio value is calculated using decimal integer arithmetic:

- Bonds, notes and CDs: quantity × denomination × market price / 100.
- Unit-priced securities: quantity × market price.
- The result rounds to the account currency's minor unit (JPY whole units,
  otherwise two decimal places for the currently supported currencies).

Prices on percentage-quoted rows carry a `%` suffix. Currency totals are never
added across currencies without an explicit conversion.
The catalogue's quantity precision is retained: a whole-unit bond cannot be
booked or traded as a fractional denomination. Manually added securities default
to whole units; the registration API accepts an explicit `quantityDecimals`
between 0 and 18 where an instrument supports fractional units. A repeated
catalogue request returns its committed receipt before contacting the source.

## Five-step order popup

1. Select the registered security; inspect its automatically filled metadata.
2. Select the debit source for a buy, or proceeds destination for a sell:
   bank account, active AVIS card purse, or actual crypto holding with an
   institution's registered conversion offer in the security currency.
3. Enter quantity and select the security's registered denomination.
4. Enter price and reference; inspect the calculated cash and crypto totals.
5. Review the server's immutable instruction and confirm Buy or Sell.

Only the active step participates in validation. Back preserves input. Adding
a security uses the same popup and returns to the draft. Closing, signing out,
or switching customer clears the popup. Field-specific errors remain in this
workflow rather than becoming platform-wide messages.

## Execution and accounting

The UAT AVISPay exchange book accepts all-or-none orders at the reviewed price.
It matches an opposite open order for the same security, quantity and price,
from a different account holder, in submission order. Securities delivery and
payment post in one database transaction. A submitted order without a match
stays Open; it is not represented as an executed trade. The catalogue connection
does **not** submit these UAT orders to the separate production AVIS.Land exchange
book or to Vienna, Frankfurt, a broker, or a blockchain. This release's order
execution is between the existing UAT account holders.

Buy orders move the exact reviewed payment into a per-order exchange clearing
account. Sell orders reserve existing portfolio units. Crypto-funded buys
reserve both the customer's crypto and the dealer's actual fiat liquidity.
Crypto sale proceeds reserve the dealer's actual crypto stock. A matched trade
delivers both assets atomically; a cancellation restores the exact original
balances and unit reservations. Card funding uses the selected card's purse,
including its existing balance, ownership, status and expiry checks.

No balance, holdings, quote, or execution status supplied by a browser is trusted.
Reviews expire after 15 minutes; replay keys, per-security locks, row locks,
server totals and the existing ledger's funds checks prevent duplicate debits
or sales. Customers can only submit, inspect and cancel their own orders.
Administrator access is retained for the complete order register. No external
trade or financial test is executed by deployment.

## Release verification

The additive migration creates only the securities catalogue, positions,
immutable position movements and exchange order tables. Regression tests cover
valuation, catalogue mapping, manual records, ownership, stale reviews and
prices, insufficient balances/holdings, card block and expiry, crypto conversion
reservation, cancellation, atomic delivery versus payment and PostgreSQL
concurrent submissions. Chromium checks cover all five populated steps at
1440, 834 and 390 pixels, card/crypto selection and draft preservation.
