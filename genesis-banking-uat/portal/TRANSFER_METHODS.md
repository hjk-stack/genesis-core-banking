# Payment methods and administrator pickup

The five-step popup supports bank accounts, crypto holdings, AVIS card loading,
external card loading, and coded card debit. Step 1 retains the account holder and
shows the selected asset's available balance. The active panel stays within the
popup at desktop and mobile widths.

All final transfers use persisted idempotency and balanced, atomic journals.
Reviewing an instruction does not debit funds. Existing bank transfers still use
the authenticated ISO 20022 connector. Missing credentials or insufficient
correspondent availability move an otherwise funded instruction to manual pickup.
A changed bank destination still requires a new review. A response lost after
sending remains subject to reconciliation and is never blindly resent.

Crypto selectors show only the selected holder's funding balances, by asset and
network. Internal transfers credit the receiving user's matching asset/network.
External crypto and external card loads debit into an outgoing suspense account
and appear in Administration with pickup ownership. They are manual instructions
in this release, not asserted blockchain broadcasts or processor settlements.
An administrator records the external receipt against the actual funded settlement
account; cancellation returns the reservation. Existing UAT opening offsets are
not eligible external settlement accounts.

AG purchases use an administrator-registered offer backed by the institution's
existing crypto funding stock. Purchase exchanges fiat and crypto in one journal,
checks the reviewed price, and cannot oversell the stock. No token inventory,
market price, blockchain transaction, external cash or provider connection is seeded.

AVIS cards have a separate stored-value purse. Loading debits the selected bank
account and credits that purse. POS authorization, reversal and signed offline
allowances retain the actual debit account for correct refunds. New cards are
AVIS proprietary prepaid card references; this operation does not allocate a
Visa or Mastercard PAN.

Offline coded debit reserves the specified amount and creates a random six-digit
code plus a separate 256-bit redemption token. Both are required to redeem.
Five incorrect codes lock the debit, the code expires after seven days, and an
unused/locked debit can be cancelled back to its original funding account.
Concurrent redemption can post only one credit. This code flow supplements the
existing signed offline terminal batch protocol.

PANs and card delivery credentials are authenticated-encrypted at rest using a
purpose-separated key derived from the existing Azure secret. PANs never enter
operation request/audit payloads or reviewed messages. A claimed outgoing request
and an audited action are required to reveal external card processing details.
The original submitting operator can retrieve the issued card delivery package.

The browser encrypts delivery messages with AES-256-GCM and a password-derived key
(PBKDF2-SHA256, random salt and IV). The password stays on the device. Recipients
open the file at `/card-message`; decryption is local and requires no bank login.
The sender distributes the encrypted file and communicates its password separately.

Reference interfaces: [Visa Direct funds transfer](https://developer.visa.com/docs/visa_direct/docs-how-to)
defines external card push payments; [Web Cryptography](https://www.w3.org/TR/webcrypto/)
defines the browser encryption primitives. Provider activation and authenticated
settlement evidence remain distinct from recording a manual transfer instruction.

Validation covers balances, currency/network separation, holder ownership,
concurrent redemption, duplicate posting, expiry/lockout, cancellation, PAN privacy,
encrypted-message tampering, bank fallback, and actual Chromium panel geometry.
