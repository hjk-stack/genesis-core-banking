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


if __name__ == '__main__':
    unittest.main()

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

    def test_read_failure_does_not_replace_current_configuration(self):
        with patch.object(deploy,'az',side_effect=RuntimeError('access')),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(deploy.existing_crypto_settings([]),[])
