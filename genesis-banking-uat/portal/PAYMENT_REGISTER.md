# Payment registration

Payments → New payment opens one modal containing five horizontally sliding panels:
sender account and its available balance; receiving account and BIC; receiver name
and postal address; reference; and the exact message with final Transfer action.
Back retains inputs and invalidates the previous review. No ledger entry or network
delivery occurs when validating a receiver or generating the review.

The receiver resolver recognizes the full ABIQ identifier, retained ABIQ aliases,
and the current 12-digit AVIP account number. A matching internal account supplies
its BIC, holder name and registered address. Account holder details can be maintained
under Accounts & ABIQ. Saved beneficiary details are scoped to the creating operator.
Missing addresses are entered in the receiver-details panel; they are never invented.

## Confirmation and routing

- Internal: final confirmation posts one balanced debit/credit journal directly
  between the source and receiver funding accounts.
- Connected: an active source bank route, bank profile and application credentials
  select the existing authenticated ISO 20022 transport. The exact reviewed
  pacs.008 is reserved and placed in the durable outbox, then submitted once.
  Route changes invalidate delivery; bank status evidence determines settlement.
- Manual: final confirmation posts customer funds to a dedicated outbound suspense
  account and records an outgoing request under Administration → Transfer requests.
  The operator can view/download its exact message or cancel the pending request
  to reverse the reservation. Downloading does not mark a payment settled.

Manual counterparties receive an MT103 instruction when its text fits FIN character
and field limits. Otherwise the complete text is retained in schema-validated ISO
20022, including names with non-ASCII characters. FIN session/sequence header values
are an instruction envelope, not an acknowledgment or proof of SWIFT transmission.
Automatic routes use ISO 20022. ABIQ identifiers use `Othr/Id`, not a national IBAN
element; mapped bank-issued IBANs retain `IBAN` elements. The receiving bank's BIC
is distinct from the instructed correspondent BIC.

Reviews are persisted and immutable. Confirmation checks the creator, message hash,
current account routes and message date. Request-row locks and persisted idempotency
prevent repeat posting. Transport claims prevent blind resend after an uncertain
response. Customer reservations use balanced suspense postings rather than relying
on a display-only locked-balance field. Manual cancellation reverses once.

## Receiver validation

IBAN country format and check digits and BIC syntax are checked locally. Internal
account/BIC agreement is checked against the bank's records. When the existing
deployment supplies `AVIS_SWIFTREF_TOKEN`, the server additionally calls SwiftRef
`POST https://api.swift.com/swiftrefdata/v5/account_numbers/validity` with account,
country, IBAN flag, BIC and retail usage. Directory errors are logged; a directory
rejection is a receiving-account field error. A directory outage does not invent a
successful bank-directory result: `validationSource` remains `FORMAT`.

An IBAN checksum does not reveal a beneficiary's identity or postal address.
Autofill uses internal holder records and saved payees. Swift's beneficiary-account
verification service is separate from identifier validation; it requires supplied
beneficiary information and a participating verification provider.

Primary references:

- [SwiftRef API reference](https://docs.developer.swift.com/docs/api-guides/swiftref-api/swiftref-api-reference)
- [Swift payment preparation overview](https://docs.developer.swift.com/api-catalogue/payment-preparation-api/documentation/getting-started/overview)
- [Swift beneficiary account verification reference](https://docs.developer.swift.com/docs/api-guides/payment-prevalidation-api/payment-prevalidation-bav-api-reference)
- [Swift ISO 20022 payment migration](https://www.swift.com/insights/news/iso-20022-bytes-payments-make-leap-iso-20022)

Migration 011 adds request/beneficiary records and an optional customer postal
address. It does not change existing identifiers, journals, balances, infrastructure,
bank profiles or credentials. CI tests use isolated PostgreSQL; deployment verifies
authenticated reads of the new register and queue without initiating live payments.
