# GENESIS build roadmap: Exchange, ArtOfCard, Crypto, Derivatives, API network

Everything below is built and tested in UAT simulation first: no real money,
securities, crypto or card data moves, and no real venue, card scheme or
blockchain mainnet is connected. Going live with any line requires the licences and
partners named under it.

## Shared core (done in this release): GENESIS Exchange matching engine

`src/matching-engine.js`, tested in `test/matching-engine.test.js`, review-only
schema in `migrations/006_exchange_simulation.sql`.

- Price-time-priority central limit order book; integer (atomic-unit) prices and
  quantities, no floating point.
- Limit and market orders; GTC, IOC and FOK.
- Per-instrument tick size, lot size and price band (circuit breaker); market
  orders never sweep past the band.
- Trading halt and resume; self-trade prevention; duplicate client-order-id
  rejection; cancel only by the owning account.
- Every change is a sequenced event (`order_accepted`, `trade`, ...), so the
  book can be rebuilt by replaying the journal, and every downstream line
  (ledger, clearing, market data, reporting) consumes the same events.
- One engine lists equities, bonds, funds, crypto pairs, tokens, futures and
  options side by side.

## 1. Stock exchange

Next steps on the shared core:

- Instrument master (ISIN, issuer, currency, trading calendar), opening and
  closing auctions, and a market-data feed (top of book, depth, trades,
  OHLC candles).
- Pre-trade risk per member (credit limit, max order size, fat-finger checks)
  and post-trade capture into the Fineract ledger as simulated settlement.
- Market surveillance hooks (spoofing and layering patterns, wash trades) and
  regulatory trade reporting formats.
- Member and broker portal in Mifos/AVIS.Land.

Going live: an MTF or regulated-market licence (MiFID II), or routing through a
licensed venue; a CCP or CSD for clearing and settlement.

## 2. Crypto exchange and tokenisation

- Crypto pairs on the shared engine; wallet ledger with deposits and
  withdrawals simulated against testnets only.
- Tokenisation registry: issue, transfer-restrict, redeem and corporate-action
  security tokens (green bonds, fund units, real-world assets), with
  whitelist-based permissioned transfers in the style of ERC-3643. Testnet
  contracts first.
- Key management through an HSM or MPC custody provider; keys never live in
  this app.

Going live: MiCA CASP authorisation (EU) or a partner custodian and exchange;
the DLT Pilot Regime for tokenised securities.

## 3. Derivative HUB

- Contract specifications (futures, options, forwards, swaps) listed on the
  shared engine.
- Mark-to-market, initial and variation margin, and expiry and exercise
  processing.
- Position limits and a risk dashboard.

Going live: clearing through an authorised CCP (EMIR), and trade-repository
reporting.

## 4. AVIS ArtOfCard manufacturing

- Card design studio: artwork upload, safe-zone and bleed checks against the
  ISO/IEC 7810 ID-1 format, and scheme brand placement rules.
- Production orders and batch lifecycle (design approved → bureau file →
  printed → embossed or personalised → shipped → activated), with QR-tracked
  batches.
- Card-bureau file generation with tokenised references only. PAN, PIN and keys
  stay with the certified processor or bureau and are never stored here.
- Virtual cards and wallet provisioning through the processor's API.

Going live: BIN sponsorship and scheme membership (Visa or Mastercard), a
PCI DSS certified processor and card bureau, and card scheme approval of the
artwork.

## 5. API network (interaction layer)

- One authenticated API gateway in front of every line: OAuth2 client
  credentials and mTLS for partners, per-client scopes and rate limits, and
  idempotency keys.
- An event bus that carries matching-engine, ledger and card events to
  subscribers, with signed webhooks to partners.
- ISO 20022 and FIX adapters (the existing sandbox gateway) and an open-banking
  (PSD2) API surface.
- A developer portal with keys, a sandbox and documentation.

## Order of work

1. Matching engine (this release).
2. API gateway and event bus, so every later line plugs in through one path.
3. Stock exchange: auctions, market data, ledger capture.
4. Crypto pairs and the tokenisation registry.
5. Derivative HUB: margin and expiry.
6. ArtOfCard design studio and production pipeline.
