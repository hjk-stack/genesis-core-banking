# Trading tests

Crypto & tokenisation → Trading contains a test lab for the installed NautilusTrader 1.231.0 W-effect strategy.

## Test modes

**Acceptance suite** runs documented synthetic reference scenarios. It exercises the repository's real strategy and Nautilus tick/order objects with a separate virtual account. The report includes the actual checks, assumptions, orders, partial fills, fees, cash, position and drawdown. The suite can run before any execution account or credential is configured. It never qualifies an institution robot for live entries.

**Market replay** uses a bounded uploaded JSON dataset and the selected robot's saved configuration. A virtual profile is also available for exploration. Each tick has a recorded market time and may include a later receipt time. INDEX observations are supplied separately with their observation times. Replay only applies information available at that point in the recording. Missing, stale or mismatched INDEX data continues to prevent new entries.

The virtual broker uses the supplied bid/ask spread and top-of-book size, explicit adverse slippage and quote-currency fees. Unfilled IOC quantities expire. Remaining positions are marked to the final recorded bid; the runner does not invent a final sale. Test profit/loss describes that recording and those assumptions.

## Isolation

- Test runs and explicit reviews are stored in `trading_test_runs` and `trading_test_reviews`, separate from live orders and ledger journals.
- The fixed Python runner receives data and strategy settings only. Its subprocess has a stripped environment, no execution connector or account credentials, a deadline and bounded output.
- A single database-coordinated queue prevents concurrent test jobs from consuming the application's resources. Interrupted runs receive a terminal failure rather than a fabricated result.
- Reports, inputs, configuration fingerprints and reviews are retained as immutable evidence.
- Only the actual administrator workspace can read or operate the lab. Browser mutations require the existing same-origin session, CSRF and idempotency controls.

## Review and live entry

A completed test does not start a robot. Live eligibility requires all of the following:

1. A passed **market replay** linked to the exact saved institution robot.
2. At least one executed virtual BUY and SELL, no open orders, a flat final virtual position, complete checks and untruncated execution evidence.
3. Matching fingerprints for the robot configuration and trading implementation.
4. A separate administrator review of that run.
5. A subsequent explicit **Start live trading** action.

Changing trading parameters, account/credential references, instrument terms or the relevant implementation invalidates prior evidence. The server checks review at live-start, order-creation and unsubmitted-entry dispatch boundaries. The runtime suppresses new entry generation for unreviewed configurations.

The installation pauses pre-existing entry flags once. Positions, stops, funds and order history are preserved. Existing-position exits and already-submitted order reconciliation continue. Reviewing a new run leaves entries paused until the separate live-start action.

A reviewed replay establishes tested strategy behaviour for that configuration. Actual venue connectivity, funds, current INDEX evidence and all existing order limits remain independent execution requirements.

## Replay JSON

Upload an object with `ticks` and `indices`. It may contain at most 10,000 of each, within the 2 MiB request limit. Times are UTC Unix microseconds for `tsMicros`, `receivedAtMicros` and `atMicros`, and milliseconds for INDEX generation/expiry.

```json
{
  "ticks": [
    {
      "tsMicros": 1800000000000000,
      "receivedAtMicros": 1800000000001000,
      "bid": 100.00,
      "ask": 100.02,
      "bidSize": 2,
      "askSize": 1,
      "sellVolume": 0.5
    }
  ],
  "indices": [
    {
      "atMicros": 1799999999000000,
      "index": {
        "instrumentId": "BTC",
        "score": 20,
        "confidence": 0.6,
        "sourceCount": 3,
        "generatedAtMs": 1799999998000,
        "validUntilMs": 1800000178000,
        "sequence": "recorded-observation-id"
      }
    }
  ]
}
```

This abbreviated example describes the format. A W-pattern evaluation requires 250 eligible ticks, and a reviewable round trip also needs subsequent market observations for its exit.

## Verification

The existing release workflow installs the pinned Python requirements and runs the Python, database and browser regressions. The HTTP regression executes the real isolated engine and checks that ledger journals, real orders and activation remain unchanged. Deployment verification runs the unbound acceptance suite on the installed application and verifies the actual report; it never reviews or starts a trading profile.
