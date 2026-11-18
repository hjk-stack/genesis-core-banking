import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('verify_existing_crypto', Path(__file__).with_name('verify-existing-crypto.py'))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
SHA = 'a' * 40


class Fixture:
    def __init__(self):
        self.calls = []
        self.wallets = []
        self.portfolio = []
        self.catalogue = []
        for i, (symbol, asset_id, contract) in enumerate(verify.ASSETS, 1):
            address = '0x' + str(i) * 40
            wallet = {'user_id': '1', 'currency_code': symbol, 'asset_id': asset_id,
                      'network': 'ETHEREUM', 'wallet_scope': 'FUNDING',
                      'account_id': 'account-' + symbol, 'address_id': str(i),
                      'available_balance': '10000000000.000000000000000001', 'locked_balance': '0',
                      'contract_address': contract, 'historical_wallet_address': address,
                      'public_address': address, 'wallet_visible': False,
                      'historical_transaction_hash': '0x' + str(i) * 64,
                      'historical_source_url': 'https://etherscan.io/token/' + contract + '?a=' + address}
            self.wallets.append(wallet)
            self.portfolio.append({'currency_code': symbol, 'network': 'ETHEREUM',
                                   'historical_proof': [{'contractAddress': contract, 'walletAddress': address}]})
            self.catalogue.append({'asset_id': asset_id, 'networks': [
                {'network': 'ETHEREUM', 'approved': True, 'verifiedAt': '2026-11-17T00:00:00Z'}]})

    def request(self, path, body=None, key=None):
        self.calls.append((path, body, key))
        if path == '/readyz':
            return {'status': 'ready', 'release': SHA}
        views = {
            'customers': [{'user_id': '1', 'full_name': 'AVISPay PLC', 'account_role': 'INSTITUTION'}],
            'cryptowallets': self.wallets, 'portfolio': self.portfolio, 'cryptocatalogue': self.catalogue,
            'cryptosecurities': [{'symbol': 'aAVISP'}] + [{'symbol': 'DEMO' + str(i)} for i in range(9)]}
        if path.startswith('/api/views/'):
            return {'rows': copy.deepcopy(views[path.rsplit('/', 1)[1]])}
        if path == '/api/crypto/activate':
            row = next(w for w in self.wallets if w['asset_id'] == body['assetId'])
            row['wallet_visible'] = True
            return {'accountId': row['account_id'], 'addressId': row['address_id'],
                    'address': row['public_address'], 'network': row['network']}
        if path == '/api/crypto/wallet':
            row = next(w for w in self.wallets if w['address_id'] == body['addressId'])
            return {'address_id': row['address_id'], 'network': row['network'],
                    'public_address': row['public_address'], 'qr': 'data:image/png;base64,fixture'}
        raise AssertionError('Unexpected action: ' + path)


class ExistingWalletReleaseTests(unittest.TestCase):
    def test_activate_only_original_funded_accounts_with_exact_decimal_balances(self):
        fixture = Fixture()
        before = copy.deepcopy(fixture.wallets)
        result = verify.verify_existing_wallets(fixture.request, SHA)
        self.assertEqual(len(result['wallets']), 2)
        self.assertEqual(result['securityWalletCount'], 10)
        for old, new, evidence in zip(before, fixture.wallets, result['wallets']):
            self.assertTrue(new['wallet_visible'])
            self.assertEqual({**old, 'wallet_visible': True}, new)
            self.assertEqual(evidence['available'], old['available_balance'])
            self.assertTrue(evidence['balancesUnchanged'])
        mutations = [path for path, body, _ in fixture.calls if body is not None]
        self.assertEqual(mutations, ['/api/crypto/activate', '/api/crypto/wallet'] * 2)

    def test_empty_existing_wallet_receives_without_adding_funds_or_an_account(self):
        fixture = Fixture()
        for row in fixture.wallets:
            row['available_balance'] = '0.000000000000000000'
        evidence = verify.verify_existing_wallets(fixture.request, SHA)
        self.assertEqual([w['accountId'] for w in evidence['wallets']], [r['account_id'] for r in fixture.wallets])
        self.assertTrue(all(w['receivingQrVerified'] and w['available'] == '0.000000000000000000'
                            for w in evidence['wallets']))

    def test_conflicting_empty_routes_are_not_selected_by_list_order(self):
        fixture = Fixture()
        first = fixture.wallets[0]
        first.update(available_balance='0', wallet_visible=True)
        fixture.wallets.append({**first, 'account_id': 'different-empty-account'})
        with self.assertRaisesRegex(RuntimeError, 'EXISTING_ACCOUNT_NOT_UNIQUE'):
            verify.verify_existing_wallets(fixture.request, SHA)
        self.assertFalse(any(path == '/api/crypto/activate' for path, _, _ in fixture.calls))

    def test_replay_uses_stable_operation_keys_and_no_new_accounts(self):
        fixture = Fixture()
        verify.verify_existing_wallets(fixture.request, SHA)
        first = [key for path, _, key in fixture.calls if path == '/api/crypto/activate']
        fixture.calls.clear()
        verify.verify_existing_wallets(fixture.request, SHA)
        self.assertEqual(first, [key for path, _, key in fixture.calls if path == '/api/crypto/activate'])
        self.assertEqual(len(fixture.wallets), 2)

    def test_wrong_release_stops_before_any_activation(self):
        fixture = Fixture()
        with self.assertRaisesRegex(RuntimeError, 'RELEASE_MISMATCH'):
            verify.verify_existing_wallets(fixture.request, 'b' * 40)
        self.assertEqual(len(fixture.calls), 1)

    def test_missing_provenance_or_mismatched_receiver_cannot_be_activated(self):
        for broken in ('public_address', 'historical_wallet_address', 'historical_source_url', 'contract_address'):
            fixture = Fixture()
            fixture.wallets[0][broken] = ''
            with self.assertRaises(RuntimeError):
                verify.verify_existing_wallets(fixture.request, SHA)
            self.assertFalse(any(path == '/api/crypto/activate' for path, _, _ in fixture.calls))

    def test_portfolio_mismatch_and_duplicate_funded_accounts_fail_before_activation(self):
        fixture = Fixture()
        fixture.portfolio[0]['historical_proof'] = []
        with self.assertRaisesRegex(RuntimeError, 'PORTFOLIO_PROOF_MISMATCH'):
            verify.verify_existing_wallets(fixture.request, SHA)
        fixture = Fixture()
        fixture.wallets.append({**fixture.wallets[0], 'account_id': 'different-funded-account'})
        with self.assertRaisesRegex(RuntimeError, 'FUNDED_ACCOUNT_NOT_UNIQUE'):
            verify.verify_existing_wallets(fixture.request, SHA)

    def test_a_wrong_activation_account_or_balance_change_fails_verification(self):
        for mode in ('account', 'balance', 'qr'):
            fixture = Fixture()
            original = fixture.request
            def altered(path, body=None, key=None):
                result = original(path, body, key)
                if path == '/api/crypto/activate':
                    if mode == 'account':
                        result['accountId'] = 'wrong-account'
                    if mode == 'balance':
                        fixture.wallets[0]['available_balance'] = '0'
                if mode == 'qr' and path == '/api/crypto/wallet':
                    result['public_address'] = '0x' + 'f' * 40
                return result
            with self.assertRaises(RuntimeError):
                verify.verify_existing_wallets(altered, SHA)


if __name__ == '__main__':
    unittest.main()
