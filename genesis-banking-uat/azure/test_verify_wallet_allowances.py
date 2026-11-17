import contextlib
import copy
import importlib.util
import io
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('wallet_acceptance', Path(__file__).with_name('verify_wallet_allowances.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WalletAllowanceAcceptanceTests(unittest.TestCase):
    def records(self):
        return {
            '/api/views/tradingallowances': {'rows': [
                {'account_id': 'ag', 'currency_code': 'AG', 'network': 'ETHEREUM', 'quantity': '2000.000000000000000001', 'enabled': True, 'version': 1},
                {'account_id': 'agi', 'currency_code': 'AGi', 'network': 'ETHEREUM', 'quantity': '1000', 'enabled': False, 'version': 0}]},
            '/api/views/walletdelegations': {'rows': [
                {'account_id': 'ag', 'quantity': '1999', 'state': 'ACTIVE'},
                {'account_id': 'ag', 'quantity': '1.000000000000000001', 'state': 'ACTIVE'},
                {'account_id': 'agi', 'quantity': '1000', 'state': 'ACTIVE'},
                {'account_id': 'old', 'quantity': '1', 'state': 'REVOKED'}]}}

    def test_current_allowance_row_matches_exact_consents_without_writes(self):
        records = self.records()
        before = copy.deepcopy(records)
        calls = []
        def read(path):
            calls.append(path)
            return records[path]
        with contextlib.redirect_stdout(io.StringIO()):
            result = module.verify_wallet_allowances(read)
        self.assertEqual(result, {'accounts': 2, 'selected': 1})
        self.assertEqual(records, before)
        self.assertEqual(len(calls), 2)

    def test_missing_consent_or_rounded_amount_fails_release_acceptance(self):
        records = self.records()
        records['/api/views/tradingallowances']['rows'][0]['quantity'] = '2000'
        with self.assertRaisesRegex(RuntimeError, 'does not match'):
            module.verify_wallet_allowances(records.__getitem__)

    def test_duplicate_account_or_false_activation_state_is_rejected(self):
        records = self.records()
        records['/api/views/tradingallowances']['rows'][1]['account_id'] = 'ag'
        with self.assertRaisesRegex(RuntimeError, 'Duplicate'):
            module.verify_wallet_allowances(records.__getitem__)
        records = self.records()
        records['/api/views/tradingallowances']['rows'][0]['enabled'] = 'true'
        with self.assertRaisesRegex(RuntimeError, 'activation state'):
            module.verify_wallet_allowances(records.__getitem__)
