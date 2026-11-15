"""Bounded, offline replay of the installed WEffectStrategy with virtual IOC fills.

This program reads one JSON value and writes one JSON report. It has no live
execution adapter, credentials, account access, data downloader or uploaded code.
The existing strategy creates the actual Nautilus orders; only execution and
accounting below are virtual. A passed replay reports behavioral checks, never
an assertion of profitability or approval to trade.
"""
from __future__ import annotations

import copy
import json
import math
import re
import sys
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, getcontext
from pathlib import Path

getcontext().prec = 96
ENGINE_VERSION = "1.231.0"
MAX_TICKS = 10_000
MAX_RECORDS = 1_000
MAX_DATASET_BYTES = 2 * 1024 * 1024
MAX_INPUT_BYTES = MAX_DATASET_BYTES + 16_384
MAX_SAFE_INTEGER = 9_007_199_254_740_991
ZERO = Decimal("0")
BPS = Decimal("10000")
QUOTE_QUANTUM = Decimal("0.000000000000000001")
DAY_MICROS = 86_400_000_000
BASE_MICROS = 1_800_000_000_000_000


class InputError(ValueError):
    def __init__(self, field, reason):
        self.field = field
        self.reason = reason
        super().__init__(f"{field}: {reason}")


class EngineError(RuntimeError):
    pass


def fixed(value):
    value = value if isinstance(value, Decimal) else Decimal(str(value))
    if value == 0:
        return "0"
    return format(value, "f").rstrip("0").rstrip(".") if value.as_tuple().exponent < 0 else format(value, "f")


def check(identifier, label, passed, detail):
    return {"id": identifier, "label": label, "passed": bool(passed), "detail": str(detail)[:700]}


def keys(value, required, optional, field):
    if not isinstance(value, dict):
        raise InputError(field, "must be an object")
    if set(value) - set(required) - set(optional):
        raise InputError(field, "contains unsupported fields")
    if set(required) - set(value):
        raise InputError(field, "is missing required fields")


def integer(value, field, minimum=0, maximum=MAX_SAFE_INTEGER):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise InputError(field, "must be an integer within the supported bounds")
    return value


def number(value, field, minimum=0, maximum=1e12, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise InputError(field, "must be a finite number")
    if value < minimum or value > maximum or positive and value <= 0:
        raise InputError(field, "is outside the supported bounds")
    if -Decimal(str(value)).as_tuple().exponent > 16:
        raise InputError(field, "exceeds the installed engine's decimal precision")
    return value


def amount(value, field, positive=True, maximum=Decimal("1000000000000000000")):
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise InputError(field, "must be a decimal amount")
    text = str(value)
    if not re.fullmatch(r"\d{1,19}(?:\.\d{1,18})?", text):
        raise InputError(field, "must be a plain nonnegative decimal amount")
    result = Decimal(text)
    if result > maximum or positive and result <= 0:
        raise InputError(field, "is outside the supported bounds")
    return result


def identifier(value, field, limit=80):
    if not isinstance(value, str) or not 1 <= len(value) <= limit or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/@+\-]*", value):
        raise InputError(field, "must be a bounded identifier")
    return value


def validate_request(payload):
    keys(payload, {"mode", "settings", "initialCash", "feeBps", "slippageBps"}, {"schemaVersion", "dataset"}, "request")
    if "schemaVersion" in payload and (isinstance(payload["schemaVersion"], bool) or payload["schemaVersion"] != 1):
        raise InputError("schemaVersion", "must be 1")
    mode = payload["mode"]
    if mode not in ("ACCEPTANCE", "REPLAY"):
        raise InputError("mode", "must be ACCEPTANCE or REPLAY")
    required = {"id", "symbol", "venue", "indexId", "maxNotional", "dailyNotional", "maxLoss", "trailingBps", "minimumIndex", "quantityStep", "priceTick"}
    optional = {"priceMultiplier", "enabled", "positionQuantity", "stopPrice", "peakPrice"}
    settings = payload["settings"]
    keys(settings, required, optional, "settings")
    settings = copy.deepcopy(settings)
    for field in ("id", "symbol", "indexId"):
        identifier(settings[field], "settings." + field, 100 if field == "id" else 80)
    if settings["venue"] not in ("AVIS", "BINANCE"):
        raise InputError("settings.venue", "must name an existing supported strategy venue")
    for field in ("maxNotional", "dailyNotional", "maxLoss", "quantityStep", "priceTick"):
        settings[field] = fixed(amount(settings[field], "settings." + field))
    for field in ("quantityStep", "priceTick"):
        if -Decimal(settings[field]).as_tuple().exponent > 16:
            raise InputError("settings." + field, "exceeds the installed engine's decimal precision")
    settings["priceMultiplier"] = fixed(amount(settings.get("priceMultiplier", "1"), "settings.priceMultiplier"))
    if Decimal(settings["dailyNotional"]) < Decimal(settings["maxNotional"]):
        raise InputError("settings.dailyNotional", "must be at least the order limit")
    integer(settings["trailingBps"], "settings.trailingBps", 5, 2000)
    number(settings["minimumIndex"], "settings.minimumIndex", -100, 100)
    if "enabled" in settings and settings["enabled"] is not True:
        raise InputError("settings.enabled", "replay starts with entry decisions enabled")
    for field in ("positionQuantity", "stopPrice", "peakPrice"):
        if field in settings and amount(settings[field], "settings." + field, positive=False) != 0:
            raise InputError("settings." + field, "replay starts with a separate zero position")
        settings[field] = "0"
    settings["enabled"] = True
    initial_cash = amount(payload["initialCash"], "initialCash")
    fee = number(payload["feeBps"], "feeBps", 0, 1000)
    slip = number(payload["slippageBps"], "slippageBps", 0, 1000)
    result = {"mode": mode, "settings": settings, "initialCash": fixed(initial_cash), "feeBps": fee, "slippageBps": slip}
    if mode == "ACCEPTANCE":
        if "dataset" in payload:
            raise InputError("dataset", "ACCEPTANCE uses its disclosed fixed reference scenarios")
        return result
    dataset = payload.get("dataset")
    keys(dataset, {"ticks", "indices"}, set(), "dataset")
    if len(json.dumps(dataset, allow_nan=False, separators=(",", ":")).encode()) > MAX_DATASET_BYTES:
        raise InputError("dataset", "exceeds the 2 MiB limit")
    ticks, indices = dataset["ticks"], dataset["indices"]
    if not isinstance(ticks, list) or not 1 <= len(ticks) <= MAX_TICKS:
        raise InputError("dataset.ticks", "requires 1 to 10000 ticks")
    if not isinstance(indices, list) or len(indices) > MAX_TICKS:
        raise InputError("dataset.indices", "requires at most 10000 observations")
    previous, previous_arrival = 0, 0
    normalized_ticks = []
    for i, tick in enumerate(ticks):
        field = f"dataset.ticks[{i}]"
        keys(tick, {"tsMicros", "bid", "ask", "bidSize", "askSize", "sellVolume"}, {"receivedAtMicros"}, field)
        stamp = integer(tick["tsMicros"], field + ".tsMicros", 1)
        arrival = integer(tick.get("receivedAtMicros", stamp), field + ".receivedAtMicros", 1)
        if stamp <= previous:
            raise InputError(field + ".tsMicros", "timestamps must be strictly increasing; duplicates are rejected")
        if arrival < stamp or arrival < previous_arrival:
            raise InputError(field + ".receivedAtMicros", "arrival must follow event time and remain ordered")
        previous, previous_arrival = stamp, arrival
        for name in ("bid", "ask", "bidSize", "askSize", "sellVolume"):
            number(tick[name], field + "." + name, positive=name != "sellVolume")
        if tick["bid"] > tick["ask"]:
            raise InputError(field, "bid must not exceed ask")
        normalized_ticks.append({**tick, "receivedAtMicros": arrival})
    previous = 0
    for i, observation in enumerate(indices):
        field = f"dataset.indices[{i}]"
        keys(observation, {"atMicros", "index"}, set(), field)
        stamp = integer(observation["atMicros"], field + ".atMicros", 1)
        if stamp <= previous:
            raise InputError(field + ".atMicros", "observations must be strictly increasing")
        previous = stamp
        index = observation["index"]
        keys(index, {"instrumentId", "score", "confidence", "sourceCount", "generatedAtMs", "validUntilMs", "sequence"}, set(), field + ".index")
        identifier(index["instrumentId"], field + ".index.instrumentId")
        identifier(index["sequence"], field + ".index.sequence", 128)
        number(index["score"], field + ".index.score", -100, 100)
        number(index["confidence"], field + ".index.confidence", 0, 1)
        integer(index["sourceCount"], field + ".index.sourceCount", 0, 10000)
        integer(index["generatedAtMs"], field + ".index.generatedAtMs")
        integer(index["validUntilMs"], field + ".index.validUntilMs")
        if index["generatedAtMs"] > stamp // 1000:
            raise InputError(field + ".index.generatedAtMs", "cannot be generated after its recorded observation")
    result["dataset"] = {"ticks": normalized_ticks, "indices": copy.deepcopy(indices)}
    return result


def load_strategy():
    # -I deliberately ignores PYTHONPATH and the working directory. Only this
    # fixed, repository-owned sibling directory is added; input supplies no path.
    sibling = str(Path(__file__).resolve().parent)
    if sibling not in sys.path:
        sys.path.insert(0, sibling)
    try:
        import nautilus_trader
        from w_effect import WEffectStrategy
    except ImportError as error:
        raise EngineError("The pinned NautilusTrader engine could not be imported") from error
    if nautilus_trader.__version__ != ENGINE_VERSION:
        raise EngineError("The installed NautilusTrader version does not match the pinned version")
    return WEffectStrategy


class VirtualExecution:
    """Quote-currency fees, top-of-book IOC liquidity, and isolated Decimal books."""
    def __init__(self, settings, initial_cash, fee_bps, slippage_bps):
        self.settings = settings
        self.initial_cash = Decimal(initial_cash)
        self.cash = self.initial_cash
        self.position = ZERO
        self.cost_basis = ZERO
        self.realised = ZERO
        self.fees = ZERO
        self.fee_rate = Decimal(str(fee_bps)) / BPS
        self.slip_rate = Decimal(str(slippage_bps)) / BPS
        self.multiplier = Decimal(settings["priceMultiplier"])
        self.step = Decimal(settings["quantityStep"])
        self.tick_size = Decimal(settings["priceTick"])
        self.orders, self.fills = [], []
        self.seen = set()
        self.daily_used = {}
        self.counters = {"ordersGenerated": 0, "filledOrders": 0, "rejectedOrders": 0, "partialFills": 0, "buyFills": 0, "sellFills": 0, "duplicateSignalsIgnored": 0, "ordersTruncated": 0, "fillsTruncated": 0}
        self.peak_equity = self.initial_cash
        self.drawdown = ZERO
        self.drawdown_fraction = ZERO
        self.last_bid = ZERO
        self.buy_notional = ZERO
        self.sell_notional = ZERO
        self.bought = ZERO
        self.sold = ZERO
        self.ledger_valid = True

    def mark(self, tick):
        self.last_bid = Decimal(str(tick["bid"]))
        equity = self.cash + self.position * self.last_bid * self.multiplier
        self.peak_equity = max(self.peak_equity, equity)
        self.drawdown = max(self.drawdown, self.peak_equity - equity)
        if self.peak_equity:
            self.drawdown_fraction = max(self.drawdown_fraction, (self.peak_equity - equity) / self.peak_equity)
        self.ledger_valid &= self.cash >= 0 and self.position >= 0 and self.cost_basis >= 0
        self.ledger_valid &= self.cash == self.initial_cash - self.buy_notional + self.sell_notional - self.fees
        self.ledger_valid &= self.position == self.bought - self.sold
        self.ledger_valid &= self.cash + self.cost_basis - self.initial_cash == self.realised

    def execute(self, signal, tick, observed_at):
        self.counters["ordersGenerated"] += 1
        signal_id = signal["signalId"]
        if signal_id in self.seen:
            self.counters["duplicateSignalsIgnored"] += 1
            return None
        self.seen.add(signal_id)
        side = signal["side"]
        quantity, limit = Decimal(signal["quantity"]), Decimal(signal["price"])
        requested_notional = quantity * limit * self.multiplier
        day = observed_at // DAY_MICROS
        order_logged = len(self.orders) < MAX_RECORDS
        order = {"id": "virtual-" + str(len(self.seen)), "signalId": signal_id, "tsMicros": observed_at, "side": side, "requestedQuantity": fixed(quantity), "limitPrice": fixed(limit), "filledQuantity": "0", "status": "EXPIRED", "reason": None, "type": signal["order"].get("type", "LIMIT"), "timeInForce": signal["order"].get("time_in_force")}
        reason = None
        if side not in ("BUY", "SELL") or order["timeInForce"] != "IOC" or quantity <= 0 or limit <= 0 or quantity % self.step or limit % self.tick_size:
            reason = "ORDER_SHAPE"
        elif side == "BUY":
            if self.position:
                reason = "POSITION_OPEN"
            elif requested_notional > Decimal(self.settings["maxNotional"]):
                reason = "ORDER_LIMIT"
            elif self.realised <= -Decimal(self.settings["maxLoss"]):
                reason = "LOSS_LIMIT"
            elif self.daily_used.get(day, ZERO) + requested_notional > Decimal(self.settings["dailyNotional"]):
                reason = "DAILY_LIMIT"
        elif quantity > self.position:
            reason = "POSITION_LIMIT"
        best = Decimal(str(tick["ask"] if side == "BUY" else tick["bid"]))
        price = best * (1 + self.slip_rate if side == "BUY" else 1 - self.slip_rate)
        price = (price / self.tick_size).to_integral_value(rounding=ROUND_CEILING if side == "BUY" else ROUND_FLOOR) * self.tick_size
        marketable = price <= limit if side == "BUY" else price >= limit
        depth = Decimal(str(tick["askSize"] if side == "BUY" else tick["bidSize"]))
        filled = (min(quantity, depth) / self.step).to_integral_value(rounding=ROUND_FLOOR) * self.step if marketable else ZERO
        notional = (filled * price * self.multiplier).quantize(QUOTE_QUANTUM, rounding=ROUND_HALF_EVEN)
        fee = (notional * self.fee_rate).quantize(QUOTE_QUANTUM, rounding=ROUND_HALF_EVEN)
        if not reason and side == "BUY" and requested_notional * (1 + self.fee_rate) > self.cash:
            reason = "INSUFFICIENT_VIRTUAL_CASH"
        if not reason and filled > 0 and notional <= 0:
            reason = "NOTIONAL_PRECISION"
        if reason:
            order.update(status="REJECTED", reason=reason)
            self.counters["rejectedOrders"] += 1
        else:
            if side == "BUY":
                self.daily_used[day] = self.daily_used.get(day, ZERO) + requested_notional
            if not filled:
                order["reason"] = "LIMIT_NOT_MARKETABLE" if not marketable else "NO_EXECUTABLE_DEPTH"
            else:
                if side == "BUY":
                    self.cash -= notional + fee
                    self.position += filled
                    self.cost_basis += notional + fee
                    self.buy_notional += notional
                    self.bought += filled
                else:
                    allocated = self.cost_basis if filled == self.position else (self.cost_basis * filled / self.position).quantize(QUOTE_QUANTUM, rounding=ROUND_HALF_EVEN)
                    self.cash += notional - fee
                    self.position -= filled
                    self.cost_basis -= allocated
                    self.realised += notional - fee - allocated
                    self.sell_notional += notional
                    self.sold += filled
                self.fees += fee
                self.counters["filledOrders"] += 1
                self.counters["buyFills" if side == "BUY" else "sellFills"] += 1
                order.update(filledQuantity=fixed(filled), status="FILLED" if filled == quantity else "PARTIALLY_FILLED")
                if filled < quantity:
                    self.counters["partialFills"] += 1
                fill = {"orderId": order["id"], "tsMicros": observed_at, "side": side, "quantity": fixed(filled), "price": fixed(price), "notional": fixed(notional), "fee": fixed(fee), "cashAfter": fixed(self.cash), "positionAfter": fixed(self.position)}
                if order_logged and len(self.fills) < MAX_RECORDS:
                    self.fills.append(fill)
                else:
                    self.counters["fillsTruncated"] += 1
        if order_logged:
            self.orders.append(order)
        else:
            self.counters["ordersTruncated"] += 1
        self.mark(tick)
        return order

    def metrics(self):
        value = self.position * self.last_bid * self.multiplier
        return {**self.counters, "initialCash": fixed(self.initial_cash), "finalCash": fixed(self.cash), "finalPosition": fixed(self.position), "costBasis": fixed(self.cost_basis), "realisedPnl": fixed(self.realised), "unrealisedPnl": fixed((value - self.cost_basis).quantize(QUOTE_QUANTUM, rounding=ROUND_HALF_EVEN)), "fees": fixed(self.fees), "finalEquity": fixed((self.cash + value).quantize(QUOTE_QUANTUM, rounding=ROUND_HALF_EVEN)), "drawdown": fixed(self.drawdown.quantize(QUOTE_QUANTUM, rounding=ROUND_HALF_EVEN)), "drawdownFraction": fixed(self.drawdown_fraction.quantize(QUOTE_QUANTUM, rounding=ROUND_HALF_EVEN)), "openOrders": 0}


def replay(request, strategy_class):
    strategy = strategy_class(request["settings"])
    book = VirtualExecution(request["settings"], request["initialCash"], request["feeBps"], request["slippageBps"])
    observations = request["dataset"]["indices"]
    position = 0
    stale, accepted, causality = 0, 0, True
    first_signal = None
    for tick in request["dataset"]["ticks"]:
        observed_at = tick["receivedAtMicros"]
        while position < len(observations) and observations[position]["atMicros"] <= observed_at:
            observation = observations[position]
            strategy.index = copy.deepcopy(observation["index"])
            causality &= observation["atMicros"] <= observed_at and strategy.index["generatedAtMs"] <= observation["atMicros"] // 1000
            position += 1
        now_ms = (observed_at + 999) // 1000
        raw = {key: value for key, value in tick.items() if key != "receivedAtMicros"}
        previous = strategy.last_ts
        signal = strategy.receive(raw, now_ms)
        accepted += int(strategy.last_ts != previous)
        stale += int(now_ms * 1000 - raw["tsMicros"] > 5_000_000)
        if signal:
            if first_signal is None:
                first_signal = (copy.deepcopy(signal), copy.deepcopy(raw), observed_at)
            book.execute(signal, raw, observed_at)
            stop = max(strategy.stop, float(signal.get("stopPrice", 0))) if book.position else 0
            peak = max(strategy.peak, float(signal.get("price", 0))) if book.position else 0
            strategy.acknowledge({"positionQuantity": fixed(book.position), "stopPrice": str(stop), "peakPrice": str(peak)})
        if strategy.last_ts != previous:
            book.mark(raw)
    metrics = {**book.metrics(), "ticksProcessed": len(request["dataset"]["ticks"]), "ticksAccepted": accepted, "staleTicksRejected": stale, "indexObservationsUsed": position, "indexObservationsUnconsumed": len(observations) - position}
    checks = [
        check("ENGINE_VERSION", "Pinned Nautilus engine", True, "Loaded installed NautilusTrader " + ENGINE_VERSION + " and repository WEffectStrategy"),
        check("INPUT_VALIDATION", "Bounded chronological input", True, f"Validated {metrics['ticksProcessed']} ticks and {len(observations)} INDEX observations"),
        check("INDEX_CAUSALITY", "INDEX observations available at decision time", causality, f"Applied {position} recorded observations; no later observation was applied"),
        check("VIRTUAL_ACCOUNTING", "Cash, fees, cost basis and position conserve value", book.ledger_valid, "Checked balances after every tick and fill using decimal arithmetic"),
        check("IOC_TERMINAL", "Each virtual IOC has no resting remainder", all(o["status"] in ("FILLED", "PARTIALLY_FILLED", "EXPIRED", "REJECTED") for o in book.orders), f"{book.counters['ordersGenerated']} strategy orders; open virtual orders 0"),
        check("NO_DUPLICATE_FILLS", "Each signal is executed at most once", len({o["signalId"] for o in book.orders}) == len(book.orders) and len({f["orderId"] for f in book.fills}) == len(book.fills), f"Ignored {book.counters['duplicateSignalsIgnored']} duplicate signal deliveries"),
    ]
    return {"checks": checks, "metrics": metrics, "orders": book.orders, "fills": book.fills, "book": book, "firstSignal": first_signal}


def reference_settings():
    return {"id": "synthetic-w-reference", "symbol": "REFERENCE", "venue": "AVIS", "indexId": "REFERENCE", "maxNotional": "1000", "dailyNotional": "10000", "maxLoss": "1000", "trailingBps": 50, "minimumIndex": 0, "quantityStep": "0.01", "priceTick": "0.0000000001", "priceMultiplier": "1"}


def synthetic_ticks(start=BASE_MICROS, exits=True):
    ticks = []
    for i in range(250):
        mid = 101 + math.sin(i) * .05
        if 80 <= i < 160:
            mid = 101.5 + math.sin(i) * .05
        if 160 <= i < 240:
            mid = 100.5 + math.sin(i) * .05
        if i == 60:
            mid = 99
        if i == 120:
            mid = 102
        if i == 200:
            mid = 99.1
        if i >= 240:
            mid = 101.7 + (i - 240) * .045
        ticks.append({"tsMicros": start + i * 1000, "bid": round(mid - .01, 5), "ask": round(mid + .01, 5), "bidSize": 2., "askSize": 1., "sellVolume": 10. if 56 <= i <= 64 else .5 if 196 <= i <= 204 else 1.})
    if exits:
        for seconds, bid, bid_size in ((6, 105., 2.), (12, 104., .4), (18, 103.9, 2.)):
            ticks.append({"tsMicros": start + seconds * 1_000_000, "bid": bid, "ask": round(bid + .02, 5), "bidSize": bid_size, "askSize": 1., "sellVolume": 1.})
    return ticks


def reference_request(exits=True):
    return {"mode": "REPLAY", "settings": reference_settings(), "initialCash": "10000", "feeBps": 10, "slippageBps": 5, "dataset": {"ticks": synthetic_ticks(exits=exits), "indices": [{"atMicros": BASE_MICROS, "index": {"instrumentId": "REFERENCE", "score": 20, "confidence": .5, "sourceCount": 3, "generatedAtMs": BASE_MICROS // 1000 - 1000, "validUntilMs": BASE_MICROS // 1000 + 120000, "sequence": "synthetic-reference-index"}}]}}


def acceptance(strategy_class):
    def run(value):
        return replay(validate_request(value), strategy_class)

    primary = run(reference_request())
    checks = list(primary["checks"])
    metric = primary["metrics"]
    checks.append(check("REFERENCE_ROUND_TRIP", "Synthetic W entry and complete trailing exit", metric["buyFills"] == 1 and metric["sellFills"] == 2 and Decimal(metric["finalPosition"]) == 0, f"BUY fills {metric['buyFills']}; SELL fills {metric['sellFills']}; final position {metric['finalPosition']}"))
    checks.append(check("PARTIAL_IOC", "Available quote depth bounds IOC fills", metric["partialFills"] >= 2 and all(Decimal(o["filledQuantity"]) <= Decimal(o["requestedQuantity"]) for o in primary["orders"]), f"Observed {metric['partialFills']} partial IOC fills; unfilled remainders do not rest"))
    sell_times = [f["tsMicros"] for f in primary["fills"] if f["side"] == "SELL"]
    checks.append(check("TRAILING_EXIT", "Trailing stop exits only after the retracement", sell_times == [BASE_MICROS + 12_000_000, BASE_MICROS + 18_000_000], "Synthetic rise at +6s held; retracements at +12s and +18s closed the filled position"))
    no_fee_request = reference_request()
    no_fee_request["feeBps"] = 0
    no_fee = run(no_fee_request)
    checks.append(check("FEE_ACCOUNTING", "Quote-currency fees reduce virtual equity", Decimal(metric["fees"]) > 0 and Decimal(no_fee["metrics"]["finalCash"]) - Decimal(metric["finalCash"]) == Decimal(metric["fees"]), "Fee-free comparison differs by exactly the recorded fee total"))
    last_entry = reference_request()["dataset"]["ticks"][249]
    checks.append(check("SPREAD_SLIPPAGE", "Entry uses ask and adverse fill slippage", bool(primary["fills"]) and Decimal(primary["fills"][0]["price"]) > Decimal(str(last_entry["ask"])), "Synthetic fill uses the supplied spread plus declared adverse slippage and tick rounding"))
    expired_exit = reference_request()
    expired_exit["dataset"]["indices"][0]["index"]["validUntilMs"] = BASE_MICROS // 1000 + 5000
    exit_result = run(expired_exit)
    checks.append(check("EXIT_AFTER_NEWS_EXPIRY", "Protective exits remain available after entry news expires", exit_result["metrics"]["buyFills"] == 1 and exit_result["metrics"]["sellFills"] == 2 and Decimal(exit_result["metrics"]["finalPosition"]) == 0, "Observed both trailing SELL fills after the recorded INDEX expired"))
    cases = []
    missing = reference_request(False)
    missing["dataset"]["indices"] = []
    cases.append(("NO_NEWS", "Missing INDEX prevents a new position", missing))
    stale = reference_request(False)
    stale["dataset"]["indices"][0]["index"]["generatedAtMs"] = BASE_MICROS // 1000 - 180001
    cases.append(("STALE_NEWS", "Stale INDEX prevents a new position", stale))
    sources = reference_request(False)
    sources["dataset"]["indices"][0]["index"]["sourceCount"] = 1
    cases.append(("SOURCE_COUNT", "Independent source requirement is enforced", sources))
    wrong = reference_request(False)
    wrong["dataset"]["indices"][0]["index"]["instrumentId"] = "DIFFERENT"
    cases.append(("INDEX_IDENTITY", "Another instrument's INDEX cannot authorize entry", wrong))
    future = reference_request(False)
    future["dataset"]["indices"][0]["atMicros"] = BASE_MICROS + 250_000
    cases.append(("FUTURE_INDEX", "Later INDEX is not read ahead", future))
    stale_tick = reference_request(False)
    stale_tick["dataset"]["ticks"][-1]["receivedAtMicros"] = BASE_MICROS + 6_250_000
    cases.append(("STALE_TICK", "Delayed market tick is rejected", stale_tick))
    incomplete = reference_request(False)
    incomplete["dataset"]["ticks"].pop()
    cases.append(("FULL_WINDOW", "Incomplete W window cannot open a position", incomplete))
    false_w = reference_request(False)
    for tick in false_w["dataset"]["ticks"][196:205]:
        tick["sellVolume"] = 20.
    cases.append(("W_RETEST_VOLUME", "Increasing retest selling invalidates the W", false_w))
    insufficient = reference_request(False)
    insufficient["initialCash"] = "0.01"
    cases.append(("VIRTUAL_FUNDS", "Insufficient virtual cash prevents a fill", insufficient))
    high_slip = reference_request(False)
    high_slip["slippageBps"] = 20
    cases.append(("IOC_PRICE_LIMIT", "Slippage beyond the limit expires without a fill", high_slip))
    for identifier_, label, request in cases:
        result = run(request)
        observed = result["metrics"]
        passed = observed["buyFills"] == 0 and Decimal(observed["finalPosition"]) == 0
        if identifier_ == "STALE_TICK":
            passed &= observed["staleTicksRejected"] == 1
        if identifier_ == "FUTURE_INDEX":
            passed &= observed["indexObservationsUsed"] == 0
        if identifier_ == "VIRTUAL_FUNDS":
            passed &= any(o["reason"] == "INSUFFICIENT_VIRTUAL_CASH" for o in result["orders"])
        if identifier_ == "IOC_PRICE_LIMIT":
            passed &= any(o["reason"] == "LIMIT_NOT_MARKETABLE" for o in result["orders"])
        checks.append(check(identifier_, label, passed, f"Observed BUY fills {observed['buyFills']}, rejected orders {observed['rejectedOrders']}, position {observed['finalPosition']}"))
    daily = reference_request()
    daily["settings"]["dailyNotional"] = "1000"
    daily["dataset"]["ticks"] += synthetic_ticks(BASE_MICROS + 30_000_000, exits=False)
    daily_result = run(daily)
    checks.append(check("DAILY_BUDGET", "Later entries respect the daily requested-notional budget", any(o["reason"] == "DAILY_LIMIT" for o in daily_result["orders"]) and daily_result["metrics"]["buyFills"] == 1, "Replayed a second valid W after closing the first position in the same UTC day"))
    loss = reference_request()
    loss["settings"]["maxLoss"] = "0.1"
    loss["dataset"]["ticks"][250].update(bid=98., ask=98.02)
    loss["dataset"]["ticks"] += synthetic_ticks(BASE_MICROS + 30_000_000, exits=False)
    loss_result = run(loss)
    checks.append(check("LOSS_BUDGET", "Realised loss limit prevents a later entry", Decimal(loss_result["metrics"]["realisedPnl"]) < Decimal("-0.1") and any(o["reason"] == "LOSS_LIMIT" for o in loss_result["orders"]) and loss_result["metrics"]["buyFills"] == 1, "Replayed a loss-making trailing exit before a second valid W"))
    duplicate = primary["firstSignal"]
    if duplicate:
        book = primary["book"]
        before = (book.cash, book.position, book.fees, len(book.fills))
        book.execute(*duplicate)
        unchanged = before == (book.cash, book.position, book.fees, len(book.fills))
    else:
        unchanged = False
    checks.append(check("DUPLICATE_SIGNAL", "Repeated delivery cannot debit cash or fill twice", unchanged and primary["book"].counters["duplicateSignalsIgnored"] == 1, "Redelivered an actual previously generated strategy signal and compared all virtual balances"))
    invalids = []
    duplicate_tick = reference_request(False)
    duplicate_tick["dataset"]["ticks"][1]["tsMicros"] = duplicate_tick["dataset"]["ticks"][0]["tsMicros"]
    invalids.append(("DUPLICATE_TIMESTAMP", duplicate_tick))
    reverse = reference_request(False)
    reverse["dataset"]["ticks"][1]["tsMicros"] -= 2000
    invalids.append(("OUT_OF_ORDER", reverse))
    negative = reference_request(False)
    negative["dataset"]["ticks"][0]["bid"] = -1
    invalids.append(("NEGATIVE_PRICE", negative))
    nonfinite = reference_request(False)
    nonfinite["dataset"]["ticks"][0]["ask"] = float("inf")
    invalids.append(("NONFINITE_PRICE", nonfinite))
    for identifier_, invalid in invalids:
        rejected = False
        try:
            validate_request(invalid)
        except (InputError, ValueError):
            rejected = True
        checks.append(check(identifier_, "Malformed market input is rejected: " + identifier_.lower().replace("_", " "), rejected, "Validation rejected the supplied counterexample before strategy execution"))
    primary["checks"] = checks
    # Keep the primary report internally consistent; the duplicate assertion is a
    # separate acceptance scenario, not another fill in the reference account.
    primary["metrics"] = metric
    return primary


def assumptions(request):
    value = {
        "execution": "Separate virtual account; no live execution adapter or account access",
        "strategy": "Existing repository WEffectStrategy; actual installed Nautilus typed ticks and IOC orders",
        "resultMeaning": "Behavioral checks only; profitability and live readiness are not inferred",
        "liquidity": "Provided top-of-book size at each order tick; IOC remainder cancels immediately",
        "spread": "Uses supplied ask for BUY and bid for SELL",
        "slippage": "Fixed adverse basis points, rounded adversely to the venue price tick; unmarketable limits expire",
        "feeCurrency": "Quote currency; charged on each executed notional",
        "accountingPrecision": "Quote notional, fees and allocated cost basis round half-even to 18 decimal places",
        "funding": "Full requested BUY limit notional plus estimated quote fees must fit virtual cash",
        "clock": "Recorded arrival time, or tick time when omitted; rounded upward to engine milliseconds",
        "indexCausality": "Only provided observations with atMicros at or before the current arrival are applied",
        "initialPosition": "0",
        "markToMarket": "Remaining position valued at last accepted tick bid; stale ticks are excluded and no terminal sale is invented",
        "dailyBudget": "UTC-day requested BUY notional; rejected orders do not consume it",
        "logLimitPerKind": MAX_RECORDS,
        "synthetic": request["mode"] == "ACCEPTANCE",
        "feeBps": request["feeBps"],
        "slippageBps": request["slippageBps"],
    }
    if request["mode"] == "ACCEPTANCE":
        value.update(referenceSettings=reference_settings(), referenceInitialCash="10000", feeBps=10, slippageBps=5)
    return value


def failure_report(mode, identifier_, detail):
    return {"schemaVersion": 1, "engine": "NautilusTrader", "engineVersion": ENGINE_VERSION, "mode": mode if mode in ("ACCEPTANCE", "REPLAY") else "REPLAY", "status": "FAILED", "complete": False, "checks": [check(identifier_, "Test run could not complete", False, detail)], "metrics": {}, "orders": [], "fills": [], "assumptions": {"execution": "Separate virtual account; no live execution adapter or account access"}}


def run_request(payload):
    mode = payload.get("mode") if isinstance(payload, dict) else None
    try:
        request = validate_request(payload)
        strategy_class = load_strategy()
        result = acceptance(strategy_class) if request["mode"] == "ACCEPTANCE" else replay(request, strategy_class)
        return {"schemaVersion": 1, "engine": "NautilusTrader", "engineVersion": ENGINE_VERSION, "mode": request["mode"], "status": "PASSED" if all(c["passed"] for c in result["checks"]) else "FAILED", "complete": True, "checks": result["checks"], "metrics": result["metrics"], "orders": result["orders"], "fills": result["fills"], "assumptions": assumptions(request)}
    except InputError as error:
        return failure_report(mode, "INPUT_VALIDATION", str(error))
    except EngineError as error:
        return failure_report(mode, "ENGINE_UNAVAILABLE", str(error))
    except (ValueError, OverflowError) as error:
        return failure_report(mode, "INPUT_VALIDATION", "Input could not be represented within the supported finite bounds")
    except Exception:
        return failure_report(mode, "RUNNER_FAILURE", "The isolated strategy replay did not complete")


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise InputError("request", "duplicate JSON object keys are rejected")
        value[key] = item
    return value


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise InputError("request", "exceeds the input byte limit")
        payload = json.loads(raw, object_pairs_hook=unique_object, parse_constant=lambda _: (_ for _ in ()).throw(InputError("request", "nonfinite JSON values are rejected")))
        report = run_request(payload)
    except (InputError, ValueError, UnicodeError, RecursionError) as error:
        report = failure_report("REPLAY", "INPUT_VALIDATION", str(error) if isinstance(error, InputError) else "Enter one valid bounded JSON object")
    sys.stdout.write(json.dumps(report, allow_nan=False, separators=(",", ":")) + "\n")
    return 1 if report["checks"][0]["id"] in ("ENGINE_UNAVAILABLE", "RUNNER_FAILURE") else 0


if __name__ == "__main__":
    raise SystemExit(main())
