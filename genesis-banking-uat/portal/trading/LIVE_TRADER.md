# Live W-effect trader

The Crypto back office contains a live market and execution view, two instruction columns, the isolated Trading tests lab, and the existing explicit Start/Pause controls. Reading a feed, filtering the robot display, saving instructions or reading security backing never submits a trade.

## Market connection

`LiveMarketFeed` shares one bounded transport per exact market between the administrator screen and the running W strategy. A configured `COINAPI_MARKET_DATA_API_KEY`, `COINAPI_API_KEY` or `APIBRICKS_COINAPI_KEY` selects CoinAPI's quote/trade WebSocket. With no market-data key, the existing Binance public bookTicker/aggTrade stream supplies Binance spot observations. A configured provider error is recorded against that provider; it is not relabelled as a successful connection to another source.

CoinAPI symbols are resolved from the saved exact base/quote identity, for example `BINANCE_SPOT_BTC_USDT`. Exchange and provider timestamps remain distinct from local receipt time. The screen reports observed age and delay. Binance bookTicker does not provide an exchange timestamp, so its receipt timestamp is identified accordingly. There is no zero-latency claim.

Subscriptions reject wrong identities, backwards source times and duplicate sequences. Delayed trade observations cannot inflate current sell pressure. Unknown CoinAPI quote sizes remain unknown and cannot become strategy depth. Market count, message size, history, retries and idle lifetime are bounded. Runtime callbacks have subscription identity and shutdown guards.

An installation with no saved robot may read the actual BTC/USDT reference market. That read creates no profile, position, order or performance record. AVIS profiles use the actual internal counterpart order book: own orders and inconsistent reservations are excluded from executable levels. The W runtime consumes the same verified book, and its first observation does not import all historical sales as new sell volume.

The existing execution adapters remain AVIS internal matching and Binance Spot IOC. CoinAPI market-data credentials are not exchange trading authorization. The existing CoinAPI EMS balance validator is separate from order submission. Alchemy is a chain RPC provider; a MetaMask connection is a wallet authorization/signing interface.

## Execution audit

The audit uses durable settled robot orders and their actual execution responses. AVIS fills additionally bind to the matched security orders and ledger journals. A requested or acknowledged quantity does not count as a fill. The display keeps base quantity, quote consideration and per-asset fee payments separate.

Inventory, cost basis and realised profit are reconstructed from supported exact evidence and compared with saved robot state. The report distinguishes recorded realised P&L, gross profit and complete fee-adjusted net profit. Unpriced third-asset fees, missing execution details or a truncated history prevent an invented all-in net result. Ordinary quote observations do not animate a BUY/SELL event: the robot's brief activity indication follows new recorded fills only.

## Instructions

The left column saves the existing versioned INDEX analysis instructions. The right column edits the selected robot's executable JSON settings:

```json
{
  "maxNotional": "1000",
  "dailyNotional": "10000",
  "maxLoss": "1000",
  "minimumIndex": 0,
  "trailingBps": 50,
  "notes": "Operator context retained with the order evidence."
}
```

The five execution values update the existing W strategy and server-side risk limits. Notes are recorded context, not executable model commands. Saving uses the current profile version, locks the robot, requires no open position or pending order, appends immutable history and pauses new entries. Each order records server-owned instruction evidence. Replay eligibility includes the canonical instruction content; a different untested configuration must be replayed and reviewed. An identical previously reviewed configuration can retain matching evidence, but saving never starts it.

## Security liquidity

The internal book exposes whole maker lots, their quote basis and consideration, and reservation evidence. BUY cash holds and aggregate SELL obligations are verified independently of the visible row cap. Registered token supply and collateral capacity are not counted as executable market depth.

**Read security backing** is a separate administrator action. It binds the existing security card, institution wallet, token, hub registry and ISIN at a finalized block, then rechecks the canonical block hash. The result separates supply/custody cap, locked collateral, configured margin capacity, AG/AGi settlement escrow, accumulated fees, balances and allowances. Cached results retain the original observation time. Ordinary market polling does not perform those chain calls.

See [SECURITY_LIQUIDITY_AUDIT.md](SECURITY_LIQUIDITY_AUDIT.md) for the contract audit and dated public-chain evidence. The existing rolling-security contract implements funded escrow and collateral controls; it does not itself implement an AMM, borrowing facility or external exchange liquidity venue.

## API and release proof

- `GET /api/crypto/trading/live?robotId=…` — private market/execution/book snapshot; robotId is optional for the initial selection.
- `GET /api/crypto/trading/live/liquidity?robotId=…` — explicit finalized backing read with a one-minute cache.
- `GET /api/crypto/trading/robot-instructions?robotId=…` — coherent current execution rules and instruction version.
- `POST /api/crypto/trading/robot-instructions` — versioned, idempotent save with `{robotId, expectedVersion, instructions}`.

These APIs require the actual administrator workspace. Existing authentication, origin, CSRF and idempotency controls apply. The deployment verifier reads the selected live market, requires a current external quote or a current AVIS book, checks the instruction field, and reports only provider names and registration counts. It never enables a profile, reviews a replay or sends an order.

Provider protocol: [CoinAPI WebSocket messages](https://www.coinapi.io/products/market-data-api/docs/websocket/messages).
