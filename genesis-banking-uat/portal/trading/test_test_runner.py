"""Real-engine regressions for the isolated testing protocol and virtual books."""
import copy
import hashlib
import json
import socket
import subprocess
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import test_runner as runner


class RunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.strategy = runner.load_strategy()

    def run_payload(self, payload):
        # A regression must fail if this otherwise offline path tries a network
        # connection; no live execution or provider adapter is involved.
        with patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden")), patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")):
            return runner.run_request(payload)

    def test_acceptance_runs_real_strategy_and_all_observed_scenarios(self):
        request = runner.reference_request()
        request.update(mode="ACCEPTANCE", initialCash="1", feeBps=100, slippageBps=100)
        request.pop("dataset")
        report = self.run_payload(request)
        self.assertEqual(report["engineVersion"], "1.231.0")
        self.assertEqual(report["status"], "PASSED", report["checks"])
        self.assertTrue(report["complete"])
        checks = {check["id"]: check for check in report["checks"]}
        for key in ("REFERENCE_ROUND_TRIP", "PARTIAL_IOC", "TRAILING_EXIT", "FEE_ACCOUNTING", "FUTURE_INDEX", "STALE_TICK", "DUPLICATE_SIGNAL", "DAILY_BUDGET", "LOSS_BUDGET"):
            self.assertTrue(checks[key]["passed"], key)
        self.assertEqual(report["metrics"]["buyFills"], 1)
        self.assertEqual(report["metrics"]["sellFills"], 2)
        self.assertEqual(report["metrics"]["finalPosition"], "0")
        self.assertEqual(report["assumptions"]["referenceInitialCash"], "10000")
        self.assertEqual(report["assumptions"]["feeBps"], 10)
        self.assertTrue(report["assumptions"]["synthetic"])

    def test_replay_report_is_deterministic_despite_engine_clock_ids(self):
        request = runner.reference_request()
        first, second = self.run_payload(request), self.run_payload(request)
        self.assertEqual(first, second)
        self.assertFalse(first["assumptions"]["synthetic"])
        self.assertTrue(all(o["type"] == "LIMIT" and o["timeInForce"] == "IOC" for o in first["orders"]))

    def test_virtual_cash_position_fees_and_partial_fills_reconcile(self):
        report = self.run_payload(runner.reference_request())
        self.assertEqual(report["status"], "PASSED")
        cash = Decimal(report["metrics"]["initialCash"])
        position = Decimal(0)
        fee = Decimal(0)
        by_order = {o["id"]: o for o in report["orders"]}
        for fill in report["fills"]:
            q, notional, commission = (Decimal(fill[k]) for k in ("quantity", "notional", "fee"))
            fee += commission
            cash += (-notional if fill["side"] == "BUY" else notional) - commission
            position += q if fill["side"] == "BUY" else -q
            self.assertEqual(cash, Decimal(fill["cashAfter"]))
            self.assertEqual(position, Decimal(fill["positionAfter"]))
            self.assertLessEqual(q, Decimal(by_order[fill["orderId"]]["requestedQuantity"]))
        self.assertEqual(position, 0)
        self.assertEqual(cash, Decimal(report["metrics"]["finalCash"]))
        self.assertEqual(fee, Decimal(report["metrics"]["fees"]))
        self.assertEqual(cash - Decimal("10000"), Decimal(report["metrics"]["realisedPnl"]))
        self.assertEqual(report["metrics"]["partialFills"], 2)

    def test_partial_exit_with_repeating_cost_ratio_conserves_every_quote_unit(self):
        request = runner.reference_request()
        request["dataset"]["ticks"][249].update(askSize=1.07, bidSize=2.14)
        report = self.run_payload(request)
        self.assertEqual(report["status"], "PASSED", report["checks"])
        self.assertEqual(report["fills"][0]["quantity"], "1.07")
        self.assertEqual(report["fills"][1]["quantity"], "0.4")
        self.assertEqual(report["fills"][2]["quantity"], "0.67")
        self.assertEqual(report["metrics"]["finalPosition"], "0")
        self.assertEqual(report["metrics"]["costBasis"], "0")
        self.assertEqual(Decimal(report["metrics"]["finalCash"]) - Decimal(report["metrics"]["initialCash"]), Decimal(report["metrics"]["realisedPnl"]))

    def test_no_future_observation_and_empty_news_never_create_entry(self):
        for observations in ([], [{"atMicros": runner.BASE_MICROS + 250_000, "index": runner.reference_request()["dataset"]["indices"][0]["index"]}]):
            request = runner.reference_request(False)
            request["dataset"]["indices"] = observations
            report = self.run_payload(request)
            self.assertEqual(report["status"], "PASSED")
            self.assertEqual(report["orders"], [])
            self.assertEqual(report["metrics"]["indexObservationsUsed"], 0)
            self.assertEqual(report["metrics"]["finalCash"], "10000")

    def test_news_is_applied_at_its_recorded_arrival_and_cannot_be_backdated(self):
        request = runner.reference_request(False)
        request["dataset"]["indices"][0]["atMicros"] = runner.BASE_MICROS + 249_000
        report = self.run_payload(request)
        self.assertEqual(report["metrics"]["buyFills"], 1)
        invalid = copy.deepcopy(request)
        invalid["dataset"]["indices"][0]["index"]["generatedAtMs"] = runner.BASE_MICROS // 1000 + 250
        self.assertEqual(self.run_payload(invalid)["status"], "FAILED")

    def test_stale_tick_is_rejected_and_does_not_change_valuation(self):
        request = runner.reference_request(False)
        tick = copy.deepcopy(request["dataset"]["ticks"][-1])
        tick.update(tsMicros=runner.BASE_MICROS + 250_000, receivedAtMicros=runner.BASE_MICROS + 6_251_000, bid=1., ask=1.01)
        before = self.run_payload(request)
        request["dataset"]["ticks"].append(tick)
        after = self.run_payload(request)
        self.assertEqual(after["metrics"]["staleTicksRejected"], 1)
        self.assertEqual(before["orders"], after["orders"])
        self.assertEqual(before["metrics"]["finalEquity"], after["metrics"]["finalEquity"])

    def test_open_position_is_marked_without_an_invented_exit(self):
        report = self.run_payload(runner.reference_request(False))
        self.assertEqual(report["metrics"]["buyFills"], 1)
        self.assertEqual(report["metrics"]["sellFills"], 0)
        self.assertEqual(report["metrics"]["finalPosition"], "1")
        self.assertNotEqual(report["metrics"]["unrealisedPnl"], "0")
        self.assertEqual(report["metrics"]["realisedPnl"], "0")

    def test_existing_position_can_exit_after_entry_index_expires(self):
        request = runner.reference_request()
        request["dataset"]["indices"][0]["index"]["validUntilMs"] = runner.BASE_MICROS // 1000 + 5000
        report = self.run_payload(request)
        self.assertEqual(report["metrics"]["buyFills"], 1)
        self.assertEqual(report["metrics"]["sellFills"], 2)
        self.assertEqual(report["metrics"]["finalPosition"], "0")

    def test_full_requested_buy_must_be_funded_even_with_partial_depth(self):
        request = runner.reference_request(False)
        request["initialCash"] = "200"
        report = self.run_payload(request)
        self.assertEqual(report["metrics"]["buyFills"], 0)
        self.assertEqual(report["orders"][0]["reason"], "INSUFFICIENT_VIRTUAL_CASH")
        self.assertEqual(report["metrics"]["finalCash"], "200")

    def test_quote_fee_changes_exactly_the_virtual_fee_amount(self):
        request = runner.reference_request()
        charged = self.run_payload(request)
        request["feeBps"] = 0
        free = self.run_payload(request)
        self.assertEqual(Decimal(free["metrics"]["finalCash"]) - Decimal(charged["metrics"]["finalCash"]), Decimal(charged["metrics"]["fees"]))

    def test_unmarketable_slippage_does_not_fill_above_limit(self):
        request = runner.reference_request(False)
        request["slippageBps"] = 20
        report = self.run_payload(request)
        self.assertEqual(report["fills"], [])
        self.assertEqual(report["orders"][0]["status"], "EXPIRED")
        self.assertEqual(report["orders"][0]["reason"], "LIMIT_NOT_MARKETABLE")

    def test_postgresql_decimal_settings_and_fixed_reset_fields_are_supported(self):
        request = runner.reference_request()
        request["schemaVersion"] = 1
        for field in ("maxNotional", "dailyNotional", "maxLoss", "quantityStep", "priceTick", "priceMultiplier"):
            request["settings"][field] = format(Decimal(request["settings"][field]), ".18f")
        request["settings"].update(enabled=True, positionQuantity="0", stopPrice="0", peakPrice="0")
        report = self.run_payload(request)
        self.assertEqual(report["status"], "PASSED", report["checks"])
        request["settings"]["positionQuantity"] = "1"
        self.assertFalse(self.run_payload(request)["complete"])

    def test_duplicate_and_out_of_order_data_fail_before_engine(self):
        for change in ("duplicate_tick", "backward_tick", "duplicate_index", "bad_arrival"):
            request = runner.reference_request(False)
            ticks = request["dataset"]["ticks"]
            if change == "duplicate_tick":
                ticks[1]["tsMicros"] = ticks[0]["tsMicros"]
            elif change == "backward_tick":
                ticks[1]["tsMicros"] = ticks[0]["tsMicros"] - 1
            elif change == "bad_arrival":
                ticks[1]["receivedAtMicros"] = ticks[1]["tsMicros"] - 1
            else:
                request["dataset"]["indices"] *= 2
            with patch.object(runner, "load_strategy", side_effect=AssertionError("engine must not run")):
                report = runner.run_request(request)
            self.assertFalse(report["complete"], change)
            self.assertEqual(report["checks"][0]["id"], "INPUT_VALIDATION")

    def test_nonfinite_boolean_negative_unknown_or_code_inputs_are_rejected(self):
        for value in (float("nan"), float("inf"), -1, True, "__import__('os').system('id')"):
            request = runner.reference_request(False)
            request["dataset"]["ticks"][0]["bid"] = value
            report = self.run_payload(request)
            self.assertEqual(report["status"], "FAILED", value)
            self.assertFalse(report["complete"])
            self.assertEqual(report["fills"], [])
        request = runner.reference_request(False)
        request["dataset"]["script"] = "anything"
        self.assertEqual(self.run_payload(request)["status"], "FAILED")

    def test_tick_count_and_byte_limits_are_enforced(self):
        request = runner.reference_request(False)
        request["dataset"]["ticks"] *= 41
        self.assertEqual(self.run_payload(request)["status"], "FAILED")
        request = runner.reference_request(False)
        request["dataset"]["indices"][0]["index"]["sequence"] = "x" * (runner.MAX_DATASET_BYTES + 1)
        self.assertEqual(self.run_payload(request)["status"], "FAILED")

    def test_maximum_tick_replay_finishes_with_bounded_report(self):
        request = runner.reference_request(False)
        sample = request["dataset"]["ticks"][0]
        request["dataset"]["ticks"] = [{**sample, "tsMicros": runner.BASE_MICROS + i * 1000} for i in range(runner.MAX_TICKS)]
        request["dataset"]["indices"] = []
        report = self.run_payload(request)
        self.assertEqual(report["status"], "PASSED", report["checks"])
        self.assertEqual(report["metrics"]["ticksProcessed"], 10000)
        self.assertEqual(report["orders"], [])
        self.assertLess(len(json.dumps(report).encode()), 2 * 1024 * 1024)

    def test_late_fill_after_log_cap_never_references_an_omitted_order(self):
        request = runner.validate_request(runner.reference_request(False))
        replay = runner.replay(request, self.strategy)
        signal, tick, stamp = replay["firstSignal"]
        book = runner.VirtualExecution({**request["settings"], "dailyNotional": "10000000"}, "10000", 10, 20)
        for i in range(runner.MAX_RECORDS):
            event = {**signal, "signalId": hashlib.sha256(str(i).encode()).hexdigest()}
            book.execute(event, tick, stamp + i)
        self.assertEqual(len(book.orders), runner.MAX_RECORDS)
        self.assertEqual(book.fills, [])
        book.slip_rate = Decimal(0)
        book.execute({**signal, "signalId": "a" * 64}, tick, stamp + runner.MAX_RECORDS)
        self.assertEqual(book.counters["buyFills"], 1)
        self.assertEqual(book.counters["ordersTruncated"], 1)
        self.assertEqual(book.counters["fillsTruncated"], 1)
        self.assertEqual(book.fills, [])
        self.assertTrue(book.ledger_valid)

    def test_isolated_cli_emits_one_json_report_with_no_engine_fallback(self):
        request = runner.reference_request()
        request["mode"] = "ACCEPTANCE"
        request.pop("dataset")
        result = subprocess.run([sys.executable, "-I", str(Path(runner.__file__).resolve())], input=json.dumps(request), text=True, capture_output=True, timeout=60, env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "TZ": "UTC", "OMP_NUM_THREADS": "1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.strip().splitlines()), 1)
        self.assertEqual(result.stderr, "")
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "PASSED")
        self.assertLess(len(result.stdout.encode()), 2 * 1024 * 1024)

    def test_cli_rejects_duplicate_json_keys_and_nonfinite_json(self):
        for raw in ('{"mode":"REPLAY","mode":"ACCEPTANCE"}', '{"mode":"REPLAY","x":NaN}', '[' * 2000 + ']' * 2000):
            result = subprocess.run([sys.executable, "-I", str(Path(runner.__file__).resolve())], input=raw, text=True, capture_output=True, timeout=10)
            report = json.loads(result.stdout)
            self.assertFalse(report["complete"])
            self.assertEqual(report["checks"][0]["id"], "INPUT_VALIDATION")
            self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
