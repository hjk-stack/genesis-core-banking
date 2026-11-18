import contextlib
from copy import deepcopy
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
        outputs = iter(output if isinstance(output, list) else [output])
        self.console_calls = calls

        def process(args, **kwargs):
            calls.append(args)
            return real_popen([sys.executable, '-c', 'import sys; sys.stdout.write(' + repr(next(outputs)) + '); sys.stdout.flush()'], **kwargs)

        with patch.object(deploy, 'az', return_value=[{'name': 'replica-one'}]) as replicas, patch.object(deploy.subprocess, 'Popen', side_effect=process):
            self.replica_reads = replicas
            captured = io.StringIO()
            try:
                with contextlib.redirect_stdout(captured):
                    result = deploy.apply_authorized_opening('genesis-banking-uat--bank-fixture', 'banking')
            finally:
                self.console_output = captured.getvalue()
        return result, calls, captured.getvalue()

    def receipt(self):
        return {'journalId': '11111111-1111-4111-8111-111111111111',
                'requestId': 'uat-opening-2026-11-14-seven-accounts', 'creditedAccounts': 7}

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

    def test_wrapped_ansi_receipt_survives_remote_terminal_formatting(self):
        receipt = self.receipt()
        line = 'AVIS_UAT_OPENING_OK ' + json.dumps(receipt, separators=(',', ':'))
        decorated = '\x1b[32m' + line[:13] + '\r\n' + line[13:120] + '\x1b[0m\r\n' + line[120:] + '\n'
        result, calls, output = self.execute('private-console-fixture\n' + decorated)
        self.assertEqual(result, receipt)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('private-console-fixture', output)

    def test_split_marker_and_json_wait_for_the_complete_receipt(self):
        receipt = self.receipt()
        line = 'AVIS_UAT_OPENING_OK ' + json.dumps(receipt, separators=(',', ':'))
        for length in (5, 21, 44, len(line) - 1):
            self.assertIsNone(deploy.parse_console_receipt(line[:length], 'AVIS_UAT_OPENING', 'failed', 'invalid'))
        self.assertEqual(deploy.parse_console_receipt(line, 'AVIS_UAT_OPENING', 'failed', 'invalid'), receipt)

    def test_unconfirmed_console_reconnects_once_with_the_identical_command(self):
        receipt = self.receipt()
        result, calls, output = self.execute(['private-disconnect-fixture\n',
                                             'AVIS_UAT_OPENING_OK ' + json.dumps(receipt) + '\n'])
        self.assertEqual(result, receipt)
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(self.replica_reads.call_count, 2)
        self.assertIn('"attempt": 1', output)
        self.assertIn('"bytes":', output)
        self.assertNotIn('private-disconnect-fixture', output)

    def test_missing_receipt_is_bounded_and_never_prints_console_text(self):
        with self.assertRaisesRegex(RuntimeError, 'unavailable after 2 attempts'):
            self.execute(['private-first-transport-error\n', 'private-second-transport-error\n'])
        self.assertEqual(len(self.console_calls), 2)
        self.assertEqual(self.replica_reads.call_count, 2)
        self.assertNotIn('private-', self.console_output)

    def test_explicit_operation_failure_is_preserved_without_reconnect(self):
        with self.assertRaisesRegex(RuntimeError, 'UAT_OPENING_ACCOUNT_SET'):
            self.execute('\x1b[31mAVIS_UAT_OPENING_FAILED UAT_OPENING_ACCOUNT_SET\x1b[0m\n')
        self.assertEqual(len(self.console_calls), 1)
        self.assertNotIn('Opening console transport', self.console_output)

    def test_split_failure_code_is_not_reported_until_complete(self):
        partial = 'AVIS_UAT_OPENING_FAILED UAT_OPENING_ACC'
        self.assertIsNone(deploy.parse_console_receipt(partial, 'AVIS_UAT_OPENING', 'failed', 'invalid'))
        for final, output in ((False, partial + 'OUNT_SET\n'), (True, partial + 'OUNT_SET')):
            with self.assertRaisesRegex(RuntimeError, 'failed: UAT_OPENING_ACCOUNT_SET$'):
                deploy.parse_console_receipt(output, 'AVIS_UAT_OPENING', 'failed', 'invalid', final=final)

    def test_malformed_receipt_is_a_protocol_failure_without_reconnect(self):
        for line in ('AVIS_UAT_OPENING_OK {"journalId":}\n',
                     'AVIS_UAT_OPENING_OK ["private-payload"]\n'):
            with self.subTest(line=line):
                with self.assertRaisesRegex(RuntimeError, 'Invalid UAT opening receipt'):
                    self.execute(line)
                self.assertEqual(len(self.console_calls), 1)
                self.assertNotIn('private-payload', self.console_output)

    def test_exact_request_count_and_canonical_journal_checks_are_preserved(self):
        for change in ({'requestId': 'other-opening'}, {'creditedAccounts': 6},
                       {'creditedAccounts': '7'}, {'creditedAccounts': 7.0},
                       {'journalId': '-' * 36}, {'journalId': None}):
            with self.subTest(change=change):
                receipt = {**self.receipt(), **change}
                with self.assertRaisesRegex(RuntimeError, 'not confirmed|Invalid UAT opening receipt'):
                    self.execute('AVIS_UAT_OPENING_OK ' + json.dumps(receipt) + '\n')
                self.assertEqual(len(self.console_calls), 1)


class DeploymentRevisionTests(unittest.TestCase):
    def test_rollback_restores_the_image_tag_release_even_if_environment_already_drifted(self):
        previous = 'a' * 40
        container = {'name': 'banking', 'image': 'registry.example/avispay-sovereign:' + previous,
                     'env': [{'name': 'RELEASE_SHA', 'value': 'b' * 40},
                             {'name': 'PGPASSWORD', 'secretRef': 'private-secret-ref'}]}
        original = deepcopy(container)
        with patch.object(deploy, 'az') as azure:
            deploy.restore_application_image(container)
        azure.assert_called_once_with('containerapp', 'update', '-g', deploy.RG, '-n', deploy.APP,
            '--image', container['image'], '--container-name', 'banking',
            '--set-env-vars', 'RELEASE_SHA=' + previous)
        self.assertEqual(container, original)
        self.assertNotIn('private-secret-ref', str(azure.call_args))

    def test_rollback_does_not_guess_release_for_an_unversioned_image(self):
        container = {'name': 'banking', 'image': 'registry.example/avispay-sovereign:latest',
                     'env': [{'name': 'RELEASE_SHA', 'value': 'b' * 40}]}
        with patch.object(deploy, 'az') as azure:
            with self.assertRaisesRegex(RuntimeError, 'image release is not verified'):
                deploy.restore_application_image(container)
        azure.assert_not_called()

    def test_same_commit_has_unique_run_and_attempt_names(self):
        sha = 'b9a23b8ad316f559d208348272d1d6006ec9e1d6'
        first = deploy.deployment_revision_suffix(sha, {'GITHUB_RUN_ID': '44199999999', 'GITHUB_RUN_ATTEMPT': '1'})
        retry = deploy.deployment_revision_suffix(sha, {'GITHUB_RUN_ID': '44199999999', 'GITHUB_RUN_ATTEMPT': '2'})
        next_run = deploy.deployment_revision_suffix(sha, {'GITHUB_RUN_ID': '44200000000', 'GITHUB_RUN_ATTEMPT': '1'})
        self.assertEqual(len({first, retry, next_run}), 3)
        for suffix in (first, retry, next_run):
            self.assertRegex(suffix, r'^bank-b9a23b8ad316-r[0-9]+-a[0-9]+$')
            self.assertLessEqual(len(deploy.APP + '--' + suffix), 64)

    def test_invalid_run_context_is_rejected_before_azure_mutation(self):
        for environment in ({}, {'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '0'},
                            {'GITHUB_RUN_ID': '1\nprivate', 'GITHUB_RUN_ATTEMPT': '1'},
                            {'GITHUB_RUN_ID': '-1', 'GITHUB_RUN_ATTEMPT': '1'},
                            {'GITHUB_RUN_ID': '9' * 20, 'GITHUB_RUN_ATTEMPT': '9' * 6}):
            with self.subTest(environment=environment):
                with self.assertRaisesRegex(RuntimeError, 'Release run identity invalid|revision name too long'):
                    deploy.deployment_revision_suffix('b' * 40, environment)

    def test_invalid_run_context_stops_main_before_any_azure_access(self):
        sha = 'b' * 40
        with patch.dict(os.environ, {'GITHUB_SHA': sha, 'AVISPAY_IMAGE': 'registry/avispay-sovereign:' + sha,
                                     'GITHUB_RUN_ID': 'invalid', 'GITHUB_RUN_ATTEMPT': '1'}), patch.object(deploy, 'az') as azure:
            with self.assertRaisesRegex(RuntimeError, 'Release run identity invalid'):
                deploy.main()
        azure.assert_not_called()


class AzureDiagnosticsTests(unittest.TestCase):
    def test_known_revision_conflict_is_classified_without_echoing_template_or_secrets(self):
        for code in ('InvalidParameterValueInContainerTemplate', 'WebhookInvalidParameterValue'):
            with self.subTest(code=code):
                error = deploy.AzureOperationError(('containerapp', 'update', '--set-env-vars', 'SECRET=private-value'),
                    'ERROR: (' + code + ') template.revisionsuffix: revision with suffix bank-private-value already exists; private-template')
                self.assertEqual(error.azure_code, 'REVISION_SUFFIX_CONFLICT')
                self.assertNotIn('private-', str(error))
                self.assertNotIn('SECRET', str(error))
                other = deploy.AzureOperationError(('containerapp', 'update'),
                    'ERROR: (' + code + ') unrelated private-template field validation')
                self.assertEqual(other.azure_code, code)

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


class ProviderValidationDiagnosticsTests(unittest.TestCase):
    def output(self, result):
        with contextlib.redirect_stdout(io.StringIO()) as captured:
            deploy.log_provider_validation(result)
        return captured.getvalue()

    def test_retains_known_provider_codes_without_private_response_fields(self):
        cases = [
            ('CoinAPI Market Data', 'MARKET_HTTP_401'),
            ('CoinAPI Market Data', 'MARKET_HTTP_429'),
            ('CoinAPI Market Data', 'MARKET_SCHEMA'),
            ('CoinAPI Market Data', 'MARKET_TRANSPORT'),
            ('CoinAPI EMS', 'EMS_HTTP_403'),
            ('CoinAPI EMS', 'EMS_SCHEMA'),
            ('CoinAPI EMS', 'EMS_TRANSPORT'),
            ('Alchemy', 'RPC_VALIDATION'),
            ('CoinAPI NaaS', 'RPC_VALIDATION'),
        ]
        for provider, code in cases:
            with self.subTest(provider=provider, code=code):
                output = self.output({'provider': provider, 'configured': True,
                                      'verified': False, 'code': code,
                                      'endpoint': 'https://node.example/private-key',
                                      'key': 'private-key', 'message': 'private-message',
                                      'accounts': ['private-account']})
                self.assertEqual(output, 'Provider validation: ' + provider
                                 + '; configured=True; verified=False; code=' + code + '\n')
                self.assertNotIn('private-', output)
                self.assertNotIn('https://', output)

    def test_codes_require_exact_known_format_for_the_correct_provider(self):
        for code in ('https://node.example/private-key', 'MARKET_HTTP_401 private-key',
                     'MARKET_HTTP_401\nprivate-key', 'MARKET_HTTP_401\rprivate-key',
                     'MARKET_HTTP_999', 'MARKET_HTTP_4010', 'MARKET_PRIVATE_KEY',
                     'EMS_HTTP_401', 'RPC_VALIDATION', {'key': 'private-key'},
                     ['MARKET_HTTP_401'], None):
            with self.subTest(code_type=type(code).__name__):
                output = self.output({'provider': 'CoinAPI Market Data', 'configured': True,
                                      'verified': False, 'code': code})
                self.assertEqual(output,
                                 'Provider validation: CoinAPI Market Data; configured=True; verified=False\n')

    def test_provider_name_and_boolean_fields_cannot_log_freeform_values(self):
        for name in ('https://node.example/private-key', 'CoinAPI NaaS\nprivate-key',
                     {'private-key': True}, None):
            with self.subTest(name_type=type(name).__name__):
                output = self.output({'provider': name, 'configured': 'private-key',
                                      'verified': {'message': 'private-message'},
                                      'code': 'RPC_VALIDATION'})
                self.assertEqual(output,
                                 'Provider validation: Unknown provider; configured=False; verified=False\n')

    def test_verified_result_does_not_require_or_invent_an_error_code(self):
        self.assertEqual(self.output({'provider': 'CoinAPI Market Data', 'configured': True,
                                      'verified': True, 'capability': 'private-message'}),
                         'Provider validation: CoinAPI Market Data; configured=True; verified=True\n')


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



class BankAccountIdentifierVerificationTests(unittest.TestCase):
    def fixture(self):
        def row(index, identifier, owner='USER', scope='FUNDING', currency='EUR'):
            return {'account_id': f'11111111-1111-4111-8111-{index:012d}',
                    'abiq_iban': identifier, 'account_reference': identifier,
                    'currency_code': currency, 'network': None, 'wallet_scope': scope,
                    'owner_type': owner, 'user_id': '1' if owner == 'USER' else None,
                    'account_holder': 'private-holder-fixture',
                    'available_balance': '123.456789012345678901', 'locked_balance': '0'}
        funding = row(1, 'TN89AVIP000978000011000101')
        margin = row(2, 'TN39AVIP97800000000001001', scope='MARGIN')
        custody = row(3, 'TN12AVIP97800000000001002', scope='CUSTODY')
        common = row(4, 'TN82AVIP97800000000001003', owner='COMMON_POOL')
        common['account_type'] = 'COMMON'
        suspense = row(5, 'TN55AVIP97800000000001004', owner='SUSPENSE_INBOUND')
        suspense['account_type'] = 'SUSPENSE'
        treasury = row(6, 'TN14AVIP84000000000001005', owner='TREASURY', currency='USD')
        crypto = []
        for index, (currency, network) in enumerate([('AG', None), ('AGi', None),
                                                    ('BTC', 'BITCOIN'), ('USD', 'ETHEREUM')], 7):
            item = row(index, None, owner='COMMON_POOL', currency=currency)
            item.update(network=network, account_reference='private-crypto-code')
            crypto.append(item)
        accounts = [{'abiq_iban': funding['abiq_iban'], 'user_id': '1', 'currency_code': 'EUR'}]
        ledger = deepcopy([funding, margin, custody, common, suspense, treasury, *crypto])
        views = {'/api/views/accountsummaries': {'rows': deepcopy([funding, margin, custody])},
                 '/api/views/backofficeaccounts': {'rows': deepcopy([common, suspense])}}
        for item in [common, suspense, custody, margin]:
            views['/api/accounts/' + item['account_id']] = {'account': deepcopy(item), 'entries': []}
        calls = []

        def request(client, base, path, *args, **kwargs):
            self.assertFalse(args or kwargs, 'bank numbering verifier must use GET reads only')
            calls.append(path)
            return views[path]
        return accounts, ledger, views, calls, request

    def verify(self, fixture):
        accounts, ledger, _, _, request = fixture
        with patch.object(deploy, 'api', side_effect=request):
            return deploy.verify_bank_account_identifiers(object(), 'https://bank.example', accounts, ledger)

    def test_validates_existing_common_suspense_and_custody_without_mutation_or_private_output(self):
        fixture = self.fixture()
        snapshot = deepcopy(fixture[:3])
        with contextlib.redirect_stdout(io.StringIO()) as output:
            evidence = self.verify(fixture)
        self.assertEqual(fixture[:3], snapshot)
        self.assertEqual({key: value for key, value in evidence.items() if key != 'identifierMapSha256'},
                         {'bankLedgerRows': 6, 'common': 1, 'suspense': 1, 'custody': 1,
                          'margin': 1, 'primaryFunding': 1, 'cryptoLedgerRowsExcluded': 4,
                          'statementsVerified': 4})
        self.assertRegex(evidence['identifierMapSha256'], r'^[a-f0-9]{64}$')
        self.assertEqual(len(fixture[3]), 6)
        for private in ['private-', '11111111-', 'TN89AVIP', '123.456789012345678901']:
            self.assertNotIn(private, output.getvalue())

    def test_rejects_missing_iban_and_internal_codes_on_common_or_suspense_rows(self):
        for index in (0, 1):
            for update in ({'abiq_iban': None}, {'account_reference': 'MANAGED:private-code'}):
                with self.subTest(index=index, update=update):
                    fixture = self.fixture()
                    fixture[2]['/api/views/backofficeaccounts']['rows'][index].update(update)
                    with self.assertRaisesRegex(RuntimeError, 'identifier missing|reference or scope mismatch'):
                        self.verify(fixture)

    def test_rejects_network_wallets_and_unnetworked_crypto_in_banking_views(self):
        for index in range(6, 10):
            with self.subTest(crypto_index=index):
                fixture = self.fixture()
                fixture[2]['/api/views/backofficeaccounts']['rows'].append(deepcopy(fixture[1][index]))
                with self.assertRaisesRegex(RuntimeError, 'Crypto wallet|currency unsupported'):
                    self.verify(fixture)

    def test_crypto_accounting_rows_cannot_receive_bank_identifiers(self):
        for index in range(6, 10):
            with self.subTest(crypto_index=index):
                fixture = self.fixture()
                fixture[1][index]['abiq_iban'] = 'TN98AVIP97800000000001006'
                with self.assertRaisesRegex(RuntimeError, 'Crypto ledger was assigned'):
                    self.verify(fixture)

    def test_distinct_custody_or_margin_cannot_reuse_the_funding_identifier(self):
        for index in (1, 2):
            with self.subTest(scope_index=index):
                fixture = self.fixture()
                rows = fixture[2]['/api/views/accountsummaries']['rows']
                rows[index].update(abiq_iban=rows[0]['abiq_iban'], account_reference=rows[0]['abiq_iban'])
                with self.assertRaisesRegex(RuntimeError, 'share an ABIQ identifier'):
                    self.verify(fixture)

    def test_missing_common_or_user_account_from_the_ui_fails_verification(self):
        for path in ('/api/views/backofficeaccounts', '/api/views/accountsummaries'):
            fixture = self.fixture()
            fixture[2][path]['rows'].pop()
            with self.assertRaisesRegex(RuntimeError, 'missing from Accounts & ABIQ'):
                self.verify(fixture)

    def test_primary_payment_account_must_retain_its_exact_funding_identity(self):
        fixture = self.fixture()
        fixture[0][0]['abiq_iban'] = 'TN98AVIP97800000000001006'
        with self.assertRaisesRegex(RuntimeError, 'Primary funding account identity'):
            self.verify(fixture)

    def test_statement_must_match_the_same_numbered_account(self):
        fixture = self.fixture()
        path = next(path for path in fixture[2] if path.startswith('/api/accounts/'))
        fixture[2][path]['account'].update(abiq_iban='TN98AVIP97800000000001006',
                                         account_reference='TN98AVIP97800000000001006')
        with self.assertRaisesRegex(RuntimeError, 'differs across views'):
            self.verify(fixture)

    def test_issued_identifiers_require_checksum_and_currency_consistency(self):
        deploy.validate_bank_identifier('TN89AVIP000978000011000101', 'EUR')
        deploy.validate_bank_identifier('TN39AVIP97800000000001001', 'EUR')
        deploy.validate_bank_identifier('TN14AVIP84000000000001005', 'USD')
        deploy.validate_bank_identifier('AQ40AVIP097800000000000001', 'EUR')
        for identifier, currency in [('TN40AVIP97800000000001001', 'EUR'),
                                     ('TN39AVIP97800000000001001', 'USD'),
                                     ('TN89AVIP000978000021000101', 'EUR'),
                                     ('TN89AVIP000978000011000101', 'AG'),
                                     ('TN89AVIP000978000011000101', 'AGi'),
                                     ('MANAGED:private-code', 'EUR')]:
            with self.subTest(currency=currency, identifier=identifier):
                with self.assertRaisesRegex(RuntimeError, 'identifier'):
                    deploy.validate_bank_identifier(identifier, currency)


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
                 '/payment-wizard.mjs': 'public/payment-wizard.mjs',
                 '/accounts.mjs': 'public/accounts.mjs',
                 '/portfolio.mjs': 'public/portfolio.mjs',
                 '/crypto-workspace.mjs': 'public/crypto-workspace.mjs',
                 '/treasury-source.mjs': 'public/treasury-source.mjs',
        '/wallet-trading-scroller.mjs': 'public/wallet-trading-scroller.mjs',
        '/wallet-trading-scroller.css': 'public/wallet-trading-scroller.css',
                 '/trading-panel.mjs': 'public/trading-panel.mjs',
                 '/trading-live.mjs': 'public/trading-live.mjs',
                 '/index-advice.mjs': 'public/index-advice.mjs',
                 '/crypto.css': 'public/crypto.css',
                 '/approved-robot.mjs': 'public/approved-robot.mjs',
                 '/approved-robot.css': 'public/approved-robot.css',
                 '/crypto-icons/robot-approved.jpg': 'public/crypto-icons/robot-approved.jpg'}
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

    def test_stale_treasury_source_module_is_rejected(self):
        release = 'd' * 40
        portal = Path(__file__).resolve().parent.parent / 'portal'
        class Opener:
            def open(self, request, timeout):
                route = request.full_url.split('?')[0].split('.io')[-1]
                relative = 'index.html' if route == '/' else 'public' + route
                body = (b'previous treasury module' if route == '/treasury-source.mjs'
                        else (portal / relative).read_bytes())
                return FrontendReleaseIntegrityTests.Response(body, release)
        with self.assertRaisesRegex(RuntimeError, 'source checksum mismatch: /treasury-source.mjs'):
            deploy.verify_deployed_frontend(Opener(), 'https://example.azurecontainerapps.io', release)

