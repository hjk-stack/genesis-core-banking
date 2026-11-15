import contextlib
import importlib.util
import io
import json
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


if __name__ == '__main__':
    unittest.main()
