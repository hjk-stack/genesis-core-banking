import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy_sovereign', Path(__file__).with_name('deploy-sovereign.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
real_popen = subprocess.Popen


class OpeningConsoleTests(unittest.TestCase):
    def execute(self, output):
        calls = []

        def process(args, **kwargs):
            calls.append(args)
            return real_popen([sys.executable, '-c', 'import sys; sys.stdout.write(' + repr(output) + '); sys.stdout.flush()'], **kwargs)

        with patch.object(deploy, 'az', return_value=[{'name': 'replica-one'}]), patch.object(deploy.subprocess, 'Popen', side_effect=process):
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                result = deploy.apply_authorized_opening('genesis-banking-uat--bank-fixture', 'banking')
        return result, calls, captured.getvalue()

    def test_reads_receipt_from_real_terminal_without_echoing_console_diagnostics(self):
        receipt = {'journalId': '11111111-1111-4111-8111-111111111111', 'requestId': 'uat-opening-2026-11-14-seven-accounts', 'creditedAccounts': 7}
        result, calls, output = self.execute('private-console-fixture\nAVIS_UAT_OPENING_OK ' + json.dumps(receipt) + '\n')
        self.assertEqual(result, receipt)
        self.assertNotIn('private-console-fixture', output)
        self.assertIn('--revision', calls[0])
        self.assertIn('genesis-banking-uat--bank-fixture', calls[0])
        self.assertIn('node /app/src/uat-opening.mjs', calls[0])

    def test_rejects_incomplete_credit_receipt(self):
        with self.assertRaisesRegex(RuntimeError, 'not confirmed'):
            self.execute('AVIS_UAT_OPENING_OK ' + json.dumps({'creditedAccounts': 5}) + '\n')

    def test_preserves_safe_failure_code(self):
        with self.assertRaisesRegex(RuntimeError, 'UAT_OPENING_TARGET_MISMATCH'):
            self.execute('AVIS_UAT_OPENING_FAILED UAT_OPENING_TARGET_MISMATCH\n')

    def test_requires_an_existing_replica(self):
        with patch.object(deploy, 'az', return_value=[]), patch.object(deploy.subprocess, 'Popen') as start:
            with self.assertRaisesRegex(RuntimeError, 'No running UAT replica'):
                deploy.apply_authorized_opening('revision', 'container')
            start.assert_not_called()


class AzureDiagnosticsTests(unittest.TestCase):
    def test_retains_known_azure_error_codes_without_secret_arguments_or_messages(self):
        errors = [
            ('ERROR: (AuthorizationFailed) private-provider-fixture', 'AuthorizationFailed'),
            ('{"error":{"code":"ResourceGroupNotFound","message":"private-provider-fixture"}}',
             'ResourceGroupNotFound'),
            ('Code: SubscriptionNotFound\nMessage: private-provider-fixture', 'SubscriptionNotFound'),
        ]
        for stderr, expected in errors:
            with self.subTest(code=expected):
                result = subprocess.CompletedProcess([], 1, stdout='', stderr=stderr)
                with patch.object(deploy.subprocess, 'run', return_value=result):
                    with self.assertRaises(deploy.AzureOperationError) as caught:
                        deploy.az('containerapp', 'secret', 'set', '--secrets',
                                  'provider=private-provider-fixture')
                self.assertEqual(caught.exception.azure_code, expected)
                self.assertIn('containerapp secret set', str(caught.exception))
                self.assertNotIn('private-provider-fixture', str(caught.exception))

    def test_unrecognized_error_fields_cannot_be_echoed_as_error_codes(self):
        result = subprocess.CompletedProcess([], 1, stdout='',
                                             stderr='ERROR: (PrivateProviderFixture) request failed')
        with patch.object(deploy.subprocess, 'run', return_value=result):
            with self.assertRaises(deploy.AzureOperationError) as caught:
                deploy.az('webapp', 'config', 'appsettings', 'list')
        self.assertEqual(caught.exception.azure_code, 'AZURE_CLI_ERROR')
        self.assertNotIn('PrivateProviderFixture', str(caught.exception))


class ExistingProviderSettingsTests(unittest.TestCase):
    def test_only_named_existing_crypto_settings_are_copied_and_current_values_win(self):
        settings=[{'name':'COINAPI_EMS_API_KEY','value':'fixture-ems'},
                  {'name':'ALCHEMY_API_KEY','value':'fixture-existing'},
                  {'name':'PGPASSWORD','value':'never-copy'},
                  {'name':'COINAPI_API_KEY','value':'@Microsoft.KeyVault(SecretUri=fixture)'}]
        calls=[]
        def azure(*args):
            calls.append(args)
            return settings if args[0]=='webapp' else None
        with patch.object(deploy,'az',side_effect=azure),contextlib.redirect_stdout(io.StringIO()) as output:
            result=deploy.existing_crypto_settings([{'name':'ALCHEMY_API_KEY','secretRef':'keep-this'}])
        self.assertEqual(result,['COINAPI_EMS_API_KEY=secretref:avispay-provider-coinapi-ems-api-key'])
        self.assertEqual(len(calls),2)
        self.assertNotIn('fixture-ems',output.getvalue())
        self.assertNotIn('never-copy',str(calls))
        self.assertIn('Key Vault reference: COINAPI_API_KEY', output.getvalue())
        self.assertNotIn('SecretUri=fixture', output.getvalue())

    def test_imports_supported_multichain_rpc_settings_without_replacing_existing_endpoints(self):
        settings = [
            {'name': 'AVIS_RPC_TRON', 'value': 'https://node.example/private-tron-fixture'},
            {'name': 'CRYPTO_RPC_XRPL', 'value': 'https://node.example/private-xrpl-fixture'},
            {'name': 'AVIS_RPC_ETHEREUM', 'value': 'https://node.example/do-not-replace'},
            {'name': 'AVIS_WALLET_ENCRYPTION_KEY', 'value': 'never-copy-wallet-key'},
            {'name': 'AVIS_RPC_UNKNOWN', 'value': 'never-copy-unknown-chain'},
        ]
        calls = []
        def azure(*args):
            calls.append(args)
            return settings if args[0] == 'webapp' else None
        current = [{'name': 'AVIS_RPC_ETHEREUM', 'secretRef': 'existing-node'}]
        with patch.object(deploy, 'az', side_effect=azure), contextlib.redirect_stdout(io.StringIO()) as output:
            result = deploy.existing_crypto_settings(current)
        self.assertEqual(result, [
            'AVIS_RPC_TRON=secretref:avispay-provider-avis-rpc-tron',
            'CRYPTO_RPC_XRPL=secretref:avispay-provider-crypto-rpc-xrpl',
        ])
        self.assertEqual(current, [{'name': 'AVIS_RPC_ETHEREUM', 'secretRef': 'existing-node'}])
        self.assertEqual(len(calls), 2)
        self.assertIn('avispay-provider-avis-rpc-tron=https://node.example/private-tron-fixture', calls[1])
        self.assertIn('avispay-provider-crypto-rpc-xrpl=https://node.example/private-xrpl-fixture', calls[1])
        self.assertNotIn('do-not-replace', str(calls))
        self.assertNotIn('never-copy', str(calls))
        self.assertNotIn('https://node.example', output.getvalue())

    def test_recovers_existing_target_secret_binding_without_reading_or_overwriting_credentials(self):
        current = [{'name': name, 'secretRef': 'existing'} for name in deploy.CRYPTO_PROVIDER_SETTINGS
                   if name != 'COINAPI_EMS_API_KEY']
        known = [{'name': 'avispay-provider-coinapi-ems-api-key'}]
        with patch.object(deploy, 'az') as azure, contextlib.redirect_stdout(io.StringIO()):
            result = deploy.existing_crypto_settings(current, known)
        self.assertEqual(result, ['COINAPI_EMS_API_KEY=secretref:avispay-provider-coinapi-ems-api-key'])
        azure.assert_not_called()

    def test_protected_release_provider_secret_survives_source_resource_group_denial(self):
        denial = deploy.AzureOperationError(('webapp', 'config', 'appsettings', 'list'),
                                           'ERROR: (AuthorizationFailed) fixture')
        calls = []
        def azure(*args):
            calls.append(args)
            if args[0] == 'webapp':
                raise denial
            return None
        with patch.dict(os.environ, {
                'AVISPAY_PROVIDER_COINAPI_EMS_API_KEY': 'ems-fixture-secret',
                'AVISPAY_PROVIDER_COINAPI_NAAS_API_KEY': 'naas-fixture-secret',
                'AVISPAY_PROVIDER_ALCHEMY_API_KEY': 'alchemy-fixture-secret',
                'AVISPAY_PROVIDER_AVIS_WALLET_ENCRYPTION_KEY': 'never-transfer-wallet-secret',
            }), patch.object(deploy, 'az', side_effect=azure), contextlib.redirect_stdout(io.StringIO()) as output:
            result = deploy.existing_crypto_settings([])
        for key in ('COINAPI_EMS_API_KEY', 'COINAPI_NAAS_API_KEY', 'ALCHEMY_API_KEY'):
            self.assertIn(key + '=secretref:avispay-provider-' + key.lower().replace('_','-'), result)
        self.assertEqual(len(calls), 2)
        self.assertIn('AuthorizationFailed', output.getvalue())
        self.assertNotIn('fixture-secret', output.getvalue())
        self.assertNotIn('AVIS_WALLET_ENCRYPTION_KEY', str(calls))
        self.assertNotIn('never-transfer-wallet-secret', str(calls))

    def test_existing_provider_binding_not_overwritten_by_release_secrets(self):
        current = [{'name': 'ALCHEMY_API_KEY', 'secretRef': 'existing-alchemy'}]
        with patch.dict(os.environ, {'AVISPAY_PROVIDER_ALCHEMY_API_KEY': 'new-secret'}, clear=False), patch.object(deploy, 'az', return_value=[]) as azure:
            result=deploy.existing_crypto_settings(current)
        self.assertEqual(result, [])
        self.assertEqual(azure.call_count, 1)
        self.assertNotIn('new-secret', str(azure.call_args_list))

    def test_source_denial_preserves_existing_secret_binding_and_reports_only_safe_error_code(self):
        error = deploy.AzureOperationError(('webapp', 'config', 'appsettings', 'list'),
                                           'ERROR: (AuthorizationFailed) private-source-fixture')
        with patch.object(deploy, 'az', side_effect=error) as azure, contextlib.redirect_stdout(io.StringIO()) as output:
            result = deploy.existing_crypto_settings([], [{'name': 'avispay-provider-coinapi-ems-api-key'}])
        self.assertEqual(result, ['COINAPI_EMS_API_KEY=secretref:avispay-provider-coinapi-ems-api-key'])
        self.assertEqual(azure.call_count, 1)
        self.assertIn('AuthorizationFailed', output.getvalue())
        self.assertIn('genesis-email-automation-rg/genesis-email-bd74cf8', output.getvalue())
        self.assertNotIn('private-source-fixture', output.getvalue())

    def test_explicit_current_settings_are_preserved_even_when_empty(self):
        current = [{'name': name, 'value': ''} for name in deploy.CRYPTO_PROVIDER_SETTINGS]
        with patch.object(deploy, 'az') as azure:
            self.assertEqual(deploy.existing_crypto_settings(current), [])
        azure.assert_not_called()

    def test_read_failure_does_not_replace_current_configuration(self):
        with patch.object(deploy,'az',side_effect=RuntimeError('access')),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(deploy.existing_crypto_settings([]),[])


class IndexAccessVerificationTests(unittest.TestCase):
    def fixture(self, expose_customer=False, bad_policy=False):
        operator, anonymous = object(), object()
        calls, scope = [], {'customer': False}
        instructions = 'private-model-instruction-fixture'
        policy = {'schemaVersion': 1, 'policyVersion': 2,
                  'policyHash': deploy.hashlib.sha256(instructions.encode()).hexdigest(),
                  'instructions': instructions,
                  'taxonomy': [{'id': prefix + str(i).zfill(2)} for prefix, count in
                               [('EQ', 18), ('CM', 6), ('CR', 10), ('MA', 4)] for i in range(1, count + 1)]}
        if bad_policy:
            policy['taxonomy'].pop()

        def request(client, base, path, body=None, csrf=None):
            calls.append((path, body))
            if path == '/api/workspace':
                scope['customer'] = body['userId'] is not None
                return {}
            if client is anonymous or scope['customer'] and not expose_customer:
                raise deploy.urllib.error.HTTPError(base + path, 401 if client is anonymous else 403, '', {}, None)
            if path.endswith('index-policy') or scope['customer']:
                return policy
            return {'schemaVersion': 1, 'policyHash': policy['policyHash'], 'lastAccepted': None}
        return operator, anonymous, request, calls, scope

    def test_verifies_policy_and_denials_without_logging_private_instructions_or_mutating_finance(self):
        operator, anonymous, request, calls, scope = self.fixture()
        with patch.object(deploy, 'api', side_effect=request), patch.object(deploy.urllib.request, 'build_opener', return_value=anonymous), contextlib.redirect_stdout(io.StringIO()) as output:
            deploy.verify_index_access(operator, 'https://bank.example', 'fixture-csrf')
        self.assertFalse(scope['customer'])
        self.assertNotIn('private-model-instruction-fixture', output.getvalue())
        self.assertIn('38 categories', output.getvalue())
        self.assertEqual([(path, body) for path, body in calls if body is not None],
                         [('/api/workspace', {'userId': '2'}), ('/api/workspace', {'userId': None})])

    def test_customer_leak_fails_and_always_restores_administrator_workspace(self):
        operator, anonymous, request, calls, scope = self.fixture(expose_customer=True)
        with patch.object(deploy, 'api', side_effect=request), patch.object(deploy.urllib.request, 'build_opener', return_value=anonymous):
            with self.assertRaisesRegex(RuntimeError, 'crossed an access boundary'):
                deploy.verify_index_access(operator, 'https://bank.example', 'fixture-csrf')
        self.assertFalse(scope['customer'])
        self.assertEqual(calls[-1], ('/api/workspace', {'userId': None}))

    def test_incomplete_taxonomy_fails_before_workspace_switch(self):
        operator, anonymous, request, calls, scope = self.fixture(bad_policy=True)
        with patch.object(deploy, 'api', side_effect=request):
            with self.assertRaisesRegex(RuntimeError, 'schema mismatch'):
                deploy.verify_index_access(operator, 'https://bank.example', 'fixture-csrf')
        self.assertEqual(len(calls), 1)


class TradingTestVerificationTests(unittest.TestCase):
    def fixture(self, patch_run=None):
        calls = []
        run_id = '11111111-1111-4111-8111-111111111111'
        fingerprint = 'a' * 64
        run = {'runId': run_id, 'robotId': None, 'mode': 'ACCEPTANCE', 'status': 'PASSED',
               'engineFingerprint': fingerprint, 'reviewEligible': False, 'reviewedAt': None,
               'report': {'engine': 'NautilusTrader', 'engineVersion': '1.231.0',
                          'status': 'PASSED', 'complete': True,
                          'checks': [{'id': str(i), 'passed': True} for i in range(6)]}}
        run.update(patch_run or {})

        def request(client, base, path, body=None, csrf=None, idempotency_key=None):
            calls.append((path, body, idempotency_key))
            if path == '/api/crypto/trading/tests':
                return {'runId': run_id, 'status': 'QUEUED'}
            return {'engine': {'name': 'NautilusTrader', 'version': '1.231.0',
                               'fingerprint': fingerprint}, 'profiles': [], 'runs': [run]}
        return request, calls

    def test_runs_only_isolated_acceptance_without_approving_or_starting_a_profile(self):
        request, calls = self.fixture()
        with patch.object(deploy, 'api', side_effect=request), contextlib.redirect_stdout(io.StringIO()) as output:
            deploy.verify_trading_tests(object(), 'https://bank.example', 'csrf', 'b' * 40)
        posts = [(path, body, key) for path, body, key in calls if body is not None]
        self.assertEqual(posts, [('/api/crypto/trading/tests',
                                 {'mode': 'ACCEPTANCE', 'initialCash': '10000', 'feeBps': 10, 'slippageBps': 5},
                                 'release-trading-acceptance:' + 'b' * 40)])
        self.assertIn('6 checks passed; no live trading approval', output.getvalue())

    def test_rejects_any_reference_run_that_could_approve_live_trading(self):
        for update in ({'reviewEligible': True}, {'robotId': '22222222-2222-4222-8222-222222222222'},
                       {'reviewedAt': '2026-11-15T20:00:00Z'}):
            with self.subTest(update=update):
                request, _ = self.fixture(update)
                with patch.object(deploy, 'api', side_effect=request):
                    with self.assertRaisesRegex(RuntimeError, 'did not pass'):
                        deploy.verify_trading_tests(object(), 'https://bank.example', 'csrf', 'b' * 40)

    def test_rejects_failed_or_different_engine_results(self):
        for update in ({'status': 'FAILED'}, {'engineFingerprint': 'c' * 64},
                       {'report': {'status': 'PASSED', 'complete': True, 'checks': []}}):
            with self.subTest(update=update):
                request, _ = self.fixture(update)
                with patch.object(deploy, 'api', side_effect=request):
                    with self.assertRaisesRegex(RuntimeError, 'did not pass'):
                        deploy.verify_trading_tests(object(), 'https://bank.example', 'csrf', 'b' * 40)


class LiveTraderVerificationTests(unittest.TestCase):
    def fixture(self, profile=False, quote=True, stale=False, provider='CoinAPI'):
        robot_id = '11111111-1111-4111-8111-111111111111' if profile else None
        market = {'provider': provider, 'reference': not profile, 'connection': {'state': 'OPEN'},
                  'quote': {'bid': '100.123456789012345678', 'ask': '101', 'ageMs': 100, 'stale': stale} if quote else None}
        state = {'schemaVersion': 1, 'profiles': [{'robotId': robot_id}] if profile else [],
                 'selectedRobotId': robot_id, 'market': market, 'audit': {} if profile else None,
                 'liquidity': {'kind': 'AVIS_ORDER_BOOK', 'bids': [], 'asks': []} if provider == 'AVIS' else None}
        calls = []
        def request(client, base, path, *args):
            calls.append((path, args))
            self.assertFalse(args, 'live verifier must use GET reads only')
            if path.startswith('/api/crypto/trading/live'):
                return state
            if path.startswith('/api/crypto/trading/robot-instructions'):
                return {'robotId': robot_id, 'version': 3, 'policyHash': 'a' * 64,
                        'instructions': json.dumps({'maxNotional': '100', 'dailyNotional': '200',
                                                    'maxLoss': '20', 'minimumIndex': 0, 'trailingBps': 50,
                                                    'notes': 'private-policy-fixture'})}
            if path == '/api/views/cryptosecurities':
                return {'rows': [{'mode': 'REAL', 'contract_address': 'private-contract-fixture',
                                  'hub_address': 'private-hub-fixture'}]}
            raise AssertionError(path)
        return request, calls, state

    def test_verifies_actual_reference_quote_without_creating_or_approving_a_profile(self):
        request, calls, _ = self.fixture()
        with patch.object(deploy, 'api', side_effect=request), contextlib.redirect_stdout(io.StringIO()) as output:
            deploy.verify_live_trading(object(), 'https://bank.example')
        self.assertEqual(len(calls), 2)
        self.assertIn('current timestamped quote; saved profiles=0', output.getvalue())
        self.assertNotIn('private-', output.getvalue())

    def test_reads_selected_instructions_and_exact_empty_avis_book_without_mutation(self):
        request, calls, _ = self.fixture(profile=True, provider='AVIS', quote=False)
        with patch.object(deploy, 'api', side_effect=request), contextlib.redirect_stdout(io.StringIO()) as output:
            deploy.verify_live_trading(object(), 'https://bank.example')
        self.assertTrue(any('/robot-instructions?' in path for path, _ in calls))
        self.assertIn('current reserved order book', output.getvalue())
        self.assertNotIn('private-', output.getvalue())

    def test_missing_and_stale_external_quotes_cannot_pass_as_live_data(self):
        for settings in ({'quote': False}, {'stale': True}):
            request, _, _ = self.fixture(**settings)
            with patch.object(deploy, 'api', side_effect=request), patch.object(deploy.time, 'sleep'):
                with self.assertRaisesRegex(RuntimeError, 'current quote'):
                    deploy.verify_live_trading(object(), 'https://bank.example')

    def test_unknown_provider_and_fabricated_reference_profile_fail_verification(self):
        request, _, state = self.fixture(provider='invented')
        with patch.object(deploy, 'api', side_effect=request):
            with self.assertRaisesRegex(RuntimeError, 'source mismatch'):
                deploy.verify_live_trading(object(), 'https://bank.example')
        state['market']['provider'] = 'CoinAPI'
        state['audit'] = {'fabricated': True}
        with patch.object(deploy, 'api', side_effect=request):
            with self.assertRaisesRegex(RuntimeError, 'created a trading profile'):
                deploy.verify_live_trading(object(), 'https://bank.example')



class TreasuryOpeningConsoleTests(unittest.TestCase):
    def run_console(self, output):
        def process(args, **kwargs):
            return real_popen([sys.executable, '-c',
                               'import sys; sys.stdout.write(' + repr(output) + '); sys.stdout.flush()'],
                              **kwargs)
        with patch.object(deploy, 'az', return_value=[{'name': 'replica-one'}]), \
             patch.object(deploy.subprocess, 'Popen', side_effect=process):
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                result = deploy.apply_treasury_opening('genesis-banking-uat--bank-fixture', 'banking')
        return result, captured.getvalue()

    def test_accepts_short_azure_treasury_receipt(self):
        receipt = {'requestId': 'avispay-treasury-registered-inventory-2026-11-16', 'booked': 4}
        result, output = self.run_console('AVISPAY_TREASURY_BOOKING_OK ' + json.dumps(receipt) + '\\n')
        self.assertEqual(result, receipt)
        self.assertIn('four booking references', output)

    def test_rejects_failed_treasury_operation(self):
        with self.assertRaisesRegex(RuntimeError, 'Treasury opening posting failed'):
            self.run_console('AVISPAY_TREASURY_BOOKING_FAILED TREASURY_OWNER_MISMATCH\\n')


if __name__ == '__main__':
    unittest.main()


class FrontendReleaseIntegrityTests(unittest.TestCase):
    class Response:
        def __init__(self, body, release, cached=False):
            self.data = io.BytesIO(body)
            self.status = 200
            self.headers = {'x-avispay-release': release,
                            'cache-control': 'public, max-age=3600' if cached else 'no-store, max-age=0'}

        def read(self, limit):
            return self.data.read(limit)

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    def test_real_checked_out_frontend_assets_match_release(self):
        release = 'a' * 40
        portal = Path(__file__).resolve().parent.parent / 'portal'
        files = {'/': 'index.html', '/app.mjs': 'public/app.mjs',
                 '/crypto-workspace.mjs': 'public/crypto-workspace.mjs',
                 '/trading-panel.mjs': 'public/trading-panel.mjs',
                 '/trading-live.mjs': 'public/trading-live.mjs',
                 '/index-advice.mjs': 'public/index-advice.mjs',
                 '/crypto.css': 'public/crypto.css'}
        seen = []
        class Opener:
            def open(self, request, timeout):
                route = request.full_url.split('?')[0].split('.io')[-1]
                seen.append(route)
                return FrontendReleaseIntegrityTests.Response(
                    (portal / files[route]).read_bytes(), release)
        with contextlib.redirect_stdout(io.StringIO()):
            deploy.verify_deployed_frontend(Opener(), 'https://example.azurecontainerapps.io', release)
        self.assertEqual(set(seen), set(files))

    def test_stale_crypto_asset_is_rejected_even_with_correct_ready_revision(self):
        release = 'b' * 40
        class Opener:
            def open(self, request, timeout):
                return FrontendReleaseIntegrityTests.Response(b'previous wallet JavaScript', release)
        with self.assertRaisesRegex(RuntimeError, 'frontend source checksum'):
            deploy.verify_deployed_frontend(Opener(), 'https://example.azurecontainerapps.io', release)

    def test_cached_assets_are_rejected_by_release_acceptance(self):
        release = 'c' * 40
        class Opener:
            def open(self, request, timeout):
                return FrontendReleaseIntegrityTests.Response(b'data', release, cached=True)
        with self.assertRaisesRegex(RuntimeError, 'cache policy'):
            deploy.verify_deployed_frontend(Opener(), 'https://example.azurecontainerapps.io', release)

