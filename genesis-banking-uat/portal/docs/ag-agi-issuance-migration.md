# AVIS Greens AG / AGi issuance and migration acceptance contract

## Treasury ownership and valuation
- Issuer treasury holder: AVISPay PLC (institutional custody, not private user).
- AG target authorised units: 10,000,000,000. Peg reference: 1 AG = 1 USD. A peg is a denomination policy, not proof of redeemability, reserves, or USD cash.
- AGi target authorised units: 10,000,000,000. Initial market valuation is UNPRICED until the first verified arm's-length executed trade. Do not set its asset price to 1 USD or assign the AG nominal valuation.
- Authorised supply, issued/minted supply, chain-confirmed circulating supply, and treasury-booked quantity are separate fields. Never book an authorised amount as an on-chain mint or funded cash balance.
- AVIS Greens Databank is the inventory and issuance registry; AVIS Greens Wallet is a holder- and chain-scoped custody view; AVISPay PLC treasury is the legal/accounting owner.

## Required live issuance sequence
1. Authenticate administrator and resolve exact AVISPay PLC institutional holder, treasury ledger and AG/AGi network/token contract identifiers from existing records.
2. Read existing Databank issuance records, existing treasury balances, chain totalSupply and chain treasury token balances; reconcile each asset independently and identify any already-issued or already-booked quantities.
3. Verify issuer approval, token contract authority and issuance limits. For AG, independently record the reserve/attestation and redemption policy for the 1 USD peg; do not create a cash asset from the peg.
4. Record an idempotent issuance request keyed by asset, issuer approval and external mint reference. Require ledger balancing entries and immutable audit evidence.
5. Mint only any approved, unissued delta using the existing chain transaction outbox; reconcile the canonical receipt and required finality before posting a custody wallet credit.
6. Post the confirmed quantity to AVISPay PLC treasury and update AVIS Greens Databank and Wallet from the same verified issuance reference. Reject duplicate mint or duplicate ledger credit.
7. AGi unit supply may be posted once minted and confirmed; mark market value unpriced until an actual executed first trade supplies a validated price and timestamp.
8. Compare inventory, treasury, wallet, blockchain and journal totals; produce signed reconciliation output.

## Migration gate
- Keep the old live environment unchanged until UAT matches the above and all holder balances, account IDs, custody addresses, token contracts, journal history and external references have been compared.
- Migrate via an approved cutover plan with rollback, not by creating a second independent 10 billion supply.
- No private-account rebooking or live issuance merely from a UI instruction. Never alter existing financial balances without verified issuer authorization, on-chain evidence and idempotent double-entry booking.

## Regression cases
- Repeated issuance request cannot double-mint or double-credit.
- Partially existing treasury supply issues only an authorised delta.
- AGi has no fabricated USD price before a confirmed trade.
- AG peg metadata does not book USD cash.
- Cross-holder request is rejected.
- Chain receipt reorg/timeout never causes duplicate booking.
- Old environment remains unchanged before cutover.
