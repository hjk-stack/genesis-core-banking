import contextlib
import copy
import importlib.util
import io
import itertools
import json
import os
from pathlib import Path
import stat
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('move_uat_network', Path(__file__).with_name('move-uat-network.py'))
move = importlib.util.module_from_spec(spec)
spec.loader.exec_module(move)

# Requested by the bank owner: "Yes prepare port 8443 for azure". The test server as Azure would show it - made up
# here, with example secret values that must never be printed - and the move run against it.
SUB = '00000000-0000-4000-8000-000000000000'
GROUP = '/subscriptions/' + SUB + '/resourceGroups/' + move.RG
ENVS = GROUP + '/providers/Microsoft.App/managedEnvironments/'
SECRET_VALUES = ('example-db-password-value', 'example-stripe-key-value', 'example-offline-key-value')
PULL = GROUP + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/genesis-banking-uat-pull'


def environment(name, network=False):
    return {'id': ENVS + name, 'name': name, 'location': 'Italy North',
            'properties': {'provisioningState': 'Succeeded', 'defaultDomain': name + '-example.italynorth.azurecontainerapps.io',
                           'staticIp': '203.0.113.10' if network else '203.0.113.9',
                           'vnetConfiguration': {'infrastructureSubnetId': GROUP + '/providers/Microsoft.Network/virtualNetworks/'
                                                 + move.VNET + '/subnets/' + move.SUBNET} if network else None}}


def app(name, external, secrets, port, **extra):
    resource = {'id': GROUP + '/providers/Microsoft.App/containerApps/' + name, 'name': name, 'type': 'Microsoft.App/containerApps',
                'location': 'Italy North', 'tags': {'stack': 'uat'},
                'identity': {'type': 'UserAssigned', 'userAssignedIdentities': {PULL: {'principalId': 'p', 'clientId': 'c'}}},
                'systemData': {'createdBy': 'example'},
                'properties': {'provisioningState': 'Succeeded', 'runningStatus': 'Running', 'managedEnvironmentId': ENVS + move.OLD_ENV,
                               'environmentId': ENVS + move.OLD_ENV, 'workloadProfileName': None, 'outboundIpAddresses': ['203.0.113.50'],
                               'latestRevisionName': name + '--old', 'latestReadyRevisionName': name + '--old', 'latestRevisionFqdn': 'x',
                               'customDomainVerificationId': 'example-verification',
                               'configuration': {'activeRevisionsMode': 'Single', 'secrets': [{'name': secret} for secret in secrets],
                                                 'registries': [{'server': 'genesisbankingacr.azurecr.io', 'identity': PULL}],
                                                 'ingress': {'external': external, 'targetPort': port, 'transport': 'auto',
                                                             'fqdn': name + '.' + move.OLD_ENV + '-example.italynorth.azurecontainerapps.io',
                                                             'traffic': [{'revisionName': name + '--old', 'weight': 100}],
                                                             'ipSecurityRestrictions': [], 'additionalPortMappings': None}},
                               'template': {'containers': [{'name': name, 'image': 'genesisbankingacr.azurecr.io/' + name + ':1'}], 'revisionSuffix': 'example-sha',
                                            'scale': {'minReplicas': 1, 'maxReplicas': 1}}}}
    for key, value in extra.items():
        target = resource
        *parents, last = key.split('__')
        for parent in parents:
            target = target[parent]
        target[last] = value
    return resource


def job(name):
    return {'id': GROUP + '/providers/Microsoft.App/jobs/' + name, 'name': name, 'location': 'Italy North',
            'properties': {'provisioningState': 'Succeeded', 'environmentId': ENVS + move.OLD_ENV, 'workloadProfileName': None,
                           'configuration': {'triggerType': 'Manual', 'replicaTimeout': 5400, 'secrets': [{'name': 'db-password'}]},
                           'template': {'containers': [{'name': 'migrate', 'image': 'genesisbankingacr.azurecr.io/fineract:1'}]}}}


class FakeAzure:
    """Azure as the move sees it through az: resources by their path, every call kept in order."""

    def __init__(self, apps=None, jobs=None, firewall=True, fail=None):
        self.environments = {move.OLD_ENV: environment(move.OLD_ENV)}
        self.apps = {item['name']: item for item in apps or [
            app('genesis-iso-sandbox-uat', False, [], 8090),
            app('genesis-fineract-uat', False, ['db-password'], 8080),
            app('genesis-mifos-uat', True, [], 80, properties__configuration__ingress__customDomains=[{'name': 'uat.example.test', 'certificateId': ENVS + move.OLD_ENV + '/managedCertificates/c'}]),
            app(move.BANK, True, ['avispay-db-password', 'avispay-provider-stripe-secret-key', 'avispay-offline-key'], 8080)]}
        self.jobs = {item['name']: item for item in jobs or [job('genesis-fineract-migrate')]}
        self.secrets = {'genesis-fineract-uat': [{'name': 'db-password', 'value': SECRET_VALUES[0]}],
                        'genesis-fineract-migrate': [{'name': 'db-password', 'value': SECRET_VALUES[0]}],
                        move.BANK: [{'name': 'avispay-db-password', 'value': SECRET_VALUES[0]},
                                    {'name': 'avispay-provider-stripe-secret-key', 'value': SECRET_VALUES[1]},
                                    {'name': 'avispay-offline-key', 'value': SECRET_VALUES[2]},
                                    {'name': 'vault-example', 'keyVaultUrl': 'https://example.vault.azure.net/secrets/x', 'identity': PULL, 'value': 'resolved'}]}
        self.firewall, self.fail, self.calls, self.puts, self.network = firewall, fail or set(), [], [], {}

    @staticmethod
    def error(code):
        return move.AzureError(('rest',), '{"error": {"code": "' + code + '", "message": "example"}}')

    def __call__(self, *args):
        self.calls.append(args)
        if args[:2] == ('account', 'show'):
            return SUB
        if args[:2] == ('provider', 'show'):
            versions = ['2024-03-01', '2026-07-01', '2026-09-02-preview']
            return [{'type': kind, 'versions': versions} for kind in ('containerApps', 'jobs', 'managedEnvironments', 'managedEnvironments/daprComponents')]
        if args[0] == 'rest':
            return self.rest(args)
        if args[0] == 'network':
            return self.net(args)
        if args[:3] == ('containerapp', 'env', 'create'):
            self.environments[move.NEW_ENV] = environment(move.NEW_ENV, network=True)
            return None
        if args[:2] == ('containerapp', 'delete') or args[:3] == ('containerapp', 'job', 'delete'):
            name = args[args.index('-n') + 1]
            store = self.jobs if 'job' in args else self.apps
            if name not in store:
                raise self.error('ResourceNotFound')
            del store[name]
            return None
        raise AssertionError('unexpected az call: ' + repr(args))

    def net(self, args):
        name = args[args.index('-n') + 1]
        kind = ' '.join(arg for arg in args[1:4] if not arg.startswith('-'))
        if args[-1] == 'ipAddress':
            return '198.51.100.20'
        if 'show' in args:
            return self.network.get((kind.replace(' show', ''), name))
        if 'update' in args:
            return {'id': GROUP + '/providers/Microsoft.Network/virtualNetworks/' + move.VNET + '/subnets/' + name}
        self.network[(kind.replace(' create', ''), name)] = {'name': name}
        return {'name': name}

    def rest(self, args):
        method, url = args[2], args[4]
        path = url.split('https://management.azure.com', 1)[-1].split('?api-version=')[0].split('&api-version=')[0]
        assert 'api-version=2026-07-01' in url or 'api-version=2022' in url, url
        body = None
        if '--body' in args:
            file = args[args.index('--body') + 1][1:]
            self.body_mode = stat.S_IMODE(os.stat(file).st_mode)
            with open(file) as handle:
                body = json.load(handle)
            self.body_files = getattr(self, 'body_files', []) + [file]
        tail = path.rsplit('/', 1)[-1]
        if method == 'get' and path.startswith(ENVS) and path.count('/') == ENVS.count('/'):
            if tail not in self.environments:
                raise self.error('ResourceNotFound')
            return copy.deepcopy(self.environments[tail])
        if method == 'get' and path.endswith('/daprComponents'):
            return {'value': []}
        if method == 'get' and path.endswith('/providers/Microsoft.App/jobs'):
            return {'value': copy.deepcopy(list(self.jobs.values()))}
        if method == 'get' and path.endswith('/providers/Microsoft.App/containerApps'):
            return {'value': copy.deepcopy(list(self.apps.values()))}
        if method == 'get' and path.endswith('/flexibleServers'):
            return {'value': [{'name': 'genesis-fineract-uat-example', 'id': GROUP + '/providers/Microsoft.DBforPostgreSQL/flexibleServers/genesis-fineract-uat-example'}]}
        if method == 'get' and path.endswith('/firewallRules'):
            return {'value': [{'properties': {'startIpAddress': '0.0.0.0', 'endIpAddress': '0.0.0.0'}}] if self.firewall else []}
        if method == 'get' and '/roleAssignments' in path:
            return {'value': []}
        store = self.jobs if '/Microsoft.App/jobs/' in path else self.apps
        name = path.split('/')[-2] if tail == 'listSecrets' else tail
        if method == 'post' and tail == 'listSecrets':
            return {'value': copy.deepcopy(self.secrets.get(name, []))}
        if method == 'put':
            self.puts.append((name, body))
            if (name, body['properties']['environmentId'].rsplit('/', 1)[-1]) in self.fail:
                raise self.error('InvalidParameterValueInContainerTemplate')
            resource = copy.deepcopy(body)
            resource.update(id=path, name=name)
            properties = resource['properties']
            properties.update(provisioningState='Succeeded', runningStatus='Running', latestRevisionName=name + '--new', latestReadyRevisionName=name + '--new')
            ingress = properties['configuration'].get('ingress')
            if ingress:
                ingress['fqdn'] = name + '.' + self.environments[properties['environmentId'].rsplit('/', 1)[-1]]['properties']['defaultDomain']
            store[name] = resource
            return copy.deepcopy(resource)
        if method == 'get' and name in store:
            return copy.deepcopy(store[name])
        raise AssertionError('unexpected Azure call: ' + method + ' ' + path)

    def writes(self):
        return [call for call in self.calls if call[0] != 'rest' and any(word in call for word in ('create', 'update', 'delete'))
                or call[0] == 'rest' and call[2] in ('put', 'delete', 'patch')]


class Ready:
    def __init__(self, url, timeout=None):
        self.url = url

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, size=-1):
        return json.dumps({'status': 'ready', 'release': 'a' * 40}).encode()


class MoveTests(unittest.TestCase):
    def run_move(self, mode, azure, expect_exit=False):
        output, summary = io.StringIO(), Path(self.tmp) / 'summary.md'
        with patch.object(move, 'az', azure), patch.object(move.time, 'sleep', lambda seconds: None), \
                patch.object(move.urllib.request, 'urlopen', Ready), patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(summary)}), \
                contextlib.redirect_stdout(output):
            if expect_exit:
                with self.assertRaises(SystemExit):
                    move.main(mode)
            else:
                move.main(mode)
        text = output.getvalue() + summary.read_text()
        for value in SECRET_VALUES + ('resolved',):
            self.assertNotIn(value, text)
        return text

    def setUp(self):
        import tempfile
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_plan_reads_and_reports_and_changes_nothing(self):
        azure = FakeAzure()
        text = self.run_move('plan', azure)
        self.assertEqual(azure.writes(), [])
        self.assertFalse([call for call in azure.calls if call[0] == 'rest' and call[2] == 'post'], 'plan reads no secret values')
        moves = [line.split(': ')[1].split(' ')[1] for line in text.splitlines() if line.startswith('Moves: ')]
        self.assertEqual(moves, ['genesis-fineract-migrate', 'genesis-fineract-uat', 'genesis-iso-sandbox-uat', 'genesis-mifos-uat', move.BANK])
        self.assertIn("Azure's default network, where no TCP port opens to the outside", text)
        self.assertIn('Moves: app genesis-banking-uat: external auto port 8080; identity UserAssigned; secrets 3 (0 from Key Vault); IP rules 0; profile none; opens port 8443 to the outside', text)
        self.assertIn('Custom domain uat.example.test on genesis-mifos-uat: bound again after the move.', text)
        self.assertIn('Database genesis-fineract-uat-example: stays as it is and lets Azure services in.', text)
        self.assertIn('Nothing was changed.', text)
        self.assertNotIn('STOP', text)

    def test_apply_makes_the_network_first_then_moves_each_app_with_its_settings_and_opens_8443_on_the_bank(self):
        azure = FakeAzure()
        text = self.run_move('apply', azure)
        writes = [' '.join(itertools.takewhile(lambda arg: not arg.startswith('-'), call)) if call[0] != 'rest'
                  else call[2] + ' ' + call[4].split('?')[0].rsplit('/', 1)[-1] for call in azure.writes()]
        self.assertEqual(writes[:5], ['network vnet create', 'network public-ip create', 'network nat gateway create', 'network vnet subnet update', 'containerapp env create'])
        self.assertEqual(writes[5:], ['containerapp job delete', 'put genesis-fineract-migrate', 'containerapp delete', 'put genesis-fineract-uat',
                                      'containerapp delete', 'put genesis-iso-sandbox-uat', 'containerapp delete', 'put genesis-mifos-uat',
                                      'containerapp delete', 'put ' + move.BANK])
        subnet = next(call for call in azure.calls if call[:4] == ('network', 'vnet', 'subnet', 'update'))
        self.assertIn('Microsoft.App/environments', subnet)
        self.assertEqual(subnet[subnet.index('--nat-gateway') + 1], move.NAT)
        create = next(call for call in azure.calls if call[:3] == ('containerapp', 'env', 'create'))
        self.assertEqual(create[create.index('-l') + 1], 'italynorth')
        for call in azure.calls:
            if call[0] == 'network' and 'create' in call:
                self.assertEqual(call[call.index('-l') + 1], 'italynorth')
        self.assertEqual(create[create.index('--internal-only') + 1], 'false')
        bodies = dict(azure.puts)
        for name, body in bodies.items():
            properties = body['properties']
            self.assertEqual(properties['environmentId'], ENVS + move.NEW_ENV)
            self.assertEqual(properties['workloadProfileName'], 'Consumption')
            for key in move.READ_ONLY:
                self.assertNotIn(key, properties)
            self.assertNotIn('id', body)
            self.assertNotIn('systemData', body)
            if name != 'genesis-fineract-migrate':
                self.assertNotIn('revisionSuffix', properties['template'])
                self.assertEqual(properties['template']['containers'][0]['name'], name)
        bank = bodies[move.BANK]['properties']['configuration']
        self.assertEqual(bank['ingress']['additionalPortMappings'], [{'external': True, 'targetPort': 8443, 'exposedPort': 8443}])
        self.assertEqual(bank['ingress']['traffic'], [{'latestRevision': True, 'weight': 100}])
        self.assertNotIn('fqdn', bank['ingress'])
        self.assertEqual(bank['secrets'], [{'name': 'avispay-db-password', 'value': SECRET_VALUES[0]},
                                           {'name': 'avispay-provider-stripe-secret-key', 'value': SECRET_VALUES[1]},
                                           {'name': 'avispay-offline-key', 'value': SECRET_VALUES[2]},
                                           {'name': 'vault-example', 'keyVaultUrl': 'https://example.vault.azure.net/secrets/x', 'identity': PULL}])
        self.assertEqual(bodies[move.BANK]['identity'], {'type': 'UserAssigned', 'userAssignedIdentities': {PULL: {}}})
        self.assertEqual(bodies[move.BANK]['tags'], {'stack': 'uat'})
        self.assertEqual(bank['registries'], [{'server': 'genesisbankingacr.azurecr.io', 'identity': PULL}])
        for name in ('genesis-iso-sandbox-uat', 'genesis-fineract-uat', 'genesis-mifos-uat'):
            self.assertIsNone(bodies[name]['properties']['configuration']['ingress']['additionalPortMappings'])
        self.assertNotIn('customDomains', bodies['genesis-mifos-uat']['properties']['configuration']['ingress'])
        self.assertEqual(bodies['genesis-fineract-migrate']['properties']['configuration']['secrets'], [{'name': 'db-password', 'value': SECRET_VALUES[0]}])
        # The secrets' file was private while it existed and is gone.
        self.assertEqual(azure.body_mode, 0o600)
        self.assertFalse(any(os.path.exists(file) for file in azure.body_files))
        self.assertIn('Environment genesis-banking-uat-net ready: addresses *.genesis-banking-uat-net-example.italynorth.azurecontainerapps.io, '
                      'incoming address 203.0.113.10, outgoing address 198.51.100.20.', text)
        self.assertIn('Custom domain uat.example.test on genesis-mifos-uat: to be bound again on the new environment.', text)
        self.assertIn('Port 8443 open to the outside on genesis-banking-uat.', text)
        self.assertIn('Bank app ready at https://genesis-banking-uat.genesis-banking-uat-net-example.italynorth.azurecontainerapps.io', text)
        self.assertIn('The old environment genesis-banking-uat-env stays, empty, until the owner says to delete it.', text)
        # Run again: everything is there, nothing moves twice.
        before = len(azure.writes())
        again = self.run_move('apply', azure)
        self.assertIn('Moved already: app ' + move.BANK, again)
        self.assertEqual(len(azure.writes()), before + 1, 'only the subnet is set again')

    def test_an_app_that_does_not_come_up_in_the_new_environment_puts_back_all_that_moved_in_the_run(self):
        # Review finding: the bank calls Fineract by its short name, which reaches only within one environment - the
        # bank alone put back, with Fineract moved before it, would be cut off. Everything moved in the run goes back.
        names = ['genesis-fineract-migrate', 'genesis-fineract-uat', 'genesis-iso-sandbox-uat', 'genesis-mifos-uat', move.BANK]
        for failing in ('genesis-fineract-uat', move.BANK):
            with self.subTest(failing=failing):
                azure = FakeAzure(fail={(failing, move.NEW_ENV)})
                text = self.run_move('apply', azure, expect_exit=True)
                moved = names[:names.index(failing) + 1]
                backs = azure.puts[len(moved):]
                self.assertEqual([name for name, _ in backs], list(reversed(moved)))
                for name, body in backs:
                    self.assertEqual(body['properties']['environmentId'], ENVS + move.OLD_ENV)
                    self.assertNotIn('workloadProfileName', body['properties'])
                    self.assertIn('Put back: ' + ('job ' if name.endswith('migrate') else 'app ') + name + ' runs in genesis-banking-uat-env as before.', text)
                self.assertEqual(dict(backs)['genesis-fineract-uat']['properties']['configuration']['secrets'], [{'name': 'db-password', 'value': SECRET_VALUES[0]}])
                self.assertIn('Not moved (Azure rest failed: InvalidParameterValueInContainerTemplate): what moved in this run goes back as it was.', text)
                # The whole test server is where it was: every app and the job in the old environment, none in the new.
                for resource in list(azure.apps.values()) + list(azure.jobs.values()):
                    self.assertEqual(resource['properties']['environmentId'], ENVS + move.OLD_ENV, resource['name'])
                self.assertEqual(set(azure.apps) | set(azure.jobs), set(names))
                self.assertNotIn('Port 8443 open', text)

    def test_a_bank_that_does_not_answer_at_its_new_address_puts_everything_back(self):
        class Starting(Ready):
            def read(self, size=-1):
                return json.dumps({'status': 'starting'}).encode()
        azure = FakeAzure()
        with patch.object(move, 'WAIT', 0), patch.object(move.urllib.request, 'urlopen', Starting):
            output, summary = io.StringIO(), Path(self.tmp) / 'summary.md'
            with patch.object(move, 'az', azure), patch.object(move.time, 'sleep', lambda seconds: None), \
                    patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(summary)}), contextlib.redirect_stdout(output), self.assertRaises(SystemExit):
                move.main('apply')
        text = output.getvalue()
        self.assertIn('Port 8443 open to the outside on genesis-banking-uat.', text)
        self.assertIn('Not moved (The bank app did not answer ready at its new address.): what moved in this run goes back as it was.', text)
        for resource in list(azure.apps.values()) + list(azure.jobs.values()):
            self.assertEqual(resource['properties']['environmentId'], ENVS + move.OLD_ENV, resource['name'])
        for value in SECRET_VALUES:
            self.assertNotIn(value, text)

    def test_what_the_move_can_not_carry_over_stops_it_before_any_change(self):
        cases = {
            'Not known as part of the test server, so not moved blind: app example-other-app.':
                dict(apps=[app(move.BANK, True, [], 8080), app('example-other-app', True, [], 80)]),
            'genesis-banking-uat has its own Azure identity in use (avispay-db-password); a moved app gets a new identity without those rights.':
                dict(apps=[app(move.BANK, True, ['avispay-db-password'], 8080, identity={'type': 'SystemAssigned', 'principalId': 'example'},
                               properties__configuration__secrets=[{'name': 'avispay-db-password', 'keyVaultUrl': 'https://example.vault.azure.net/secrets/x', 'identity': 'system'}])]),
            'genesis-banking-uat uses the environment storage files, which is not carried over.':
                dict(apps=[app(move.BANK, True, [], 8080, properties__template__volumes=[{'name': 'data', 'storageType': 'AzureFile', 'storageName': 'files'}])]),
            'The bank app is not reachable from outside, so its port 8443 can not be either.':
                dict(apps=[app(move.BANK, False, [], 8080)]),
            'The database genesis-fineract-uat-example does not let Azure services in: the new outgoing address must be allowed first.':
                dict(firewall=False),
            'genesis-banking-uat runs on workload profile D4, which the new environment does not have.':
                dict(apps=[app(move.BANK, True, [], 8080, properties__workloadProfileName='D4')]),
        }
        for problem, setup in cases.items():
            with self.subTest(problem=problem[:40]):
                azure = FakeAzure(**setup)
                text = self.run_move('apply', azure, expect_exit=True)
                self.assertIn('STOP: ' + problem, text)
                self.assertIn('FAILED: Stopped before any change.', text)
                self.assertEqual(azure.writes(), [])

    def test_an_azure_error_shows_its_codes_never_the_command_or_the_answer(self):
        error = move.AzureError(('containerapp', 'secret', 'set', '-g', 'rg', '--secrets', 'name=example-stripe-key-value'),
                                'ERROR: (InvalidParameterValue) The value example-stripe-key-value is not valid.\nCode: InvalidParameterValue\n'
                                '{"error": {"code": "BadRequest", "message": "example-stripe-key-value"}}')
        self.assertEqual(str(error), 'Azure containerapp secret set failed: InvalidParameterValue, BadRequest')
        self.assertNotIn('example-stripe-key-value', str(error))
        self.assertEqual(str(move.AzureError(('rest',), 'no code here')), 'Azure rest failed: AZURE_CLI_ERROR')

    def test_the_newest_stable_api_is_used(self):
        with patch.object(move, 'az', FakeAzure()):
            self.assertEqual(move.versions(), {'containerApps': '2026-07-01', 'jobs': '2026-07-01', 'managedEnvironments': '2026-07-01'})


if __name__ == '__main__':
    unittest.main()
