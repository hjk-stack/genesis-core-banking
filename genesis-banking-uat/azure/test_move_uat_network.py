import contextlib
import copy
import importlib.util
import io
import itertools
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('move_uat_network', Path(__file__).with_name('move-uat-network.py'))
move = importlib.util.module_from_spec(spec)
spec.loader.exec_module(move)

# Requested by the bank owner: "Yes prepare port 8443 for azure", then "Yes fix the script, ChatGPT does the DNS". The test
# server as the plan found it on Azure - made up here, with example secret values that must never be printed - and the
# move run against it.
SUB = '00000000-0000-4000-8000-000000000000'
GROUP = '/subscriptions/' + SUB + '/resourceGroups/' + move.RG
ENVS = GROUP + '/providers/Microsoft.App/managedEnvironments/'
REGISTRY = GROUP + '/providers/Microsoft.ContainerRegistry/registries/genesisbankingacr'
ACR = 'genesisbankingacr-example.azurecr.io'
PULL = GROUP + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/genesis-banking-uat-pull'
ACR_PULL = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
DATABASE = 'genesis-fineract-uat-example.postgres.database.azure.com'
SECRET_VALUES = ('example-db-password-value', 'example-stripe-key-value', 'example-offline-key-value', 'example-registry-password-value',
                 'example-url-password-value')
LOGIN = {'server': ACR, 'username': 'genesisbankingacr', 'passwordSecretRef': 'registry-password'}


def environment(name, network=False):
    return {'id': ENVS + name, 'name': name, 'location': 'Italy North',
            'properties': {'provisioningState': 'Succeeded', 'defaultDomain': name + '-example.italynorth.azurecontainerapps.io',
                           'staticIp': '203.0.113.10' if network else '203.0.113.9',
                           'vnetConfiguration': {'infrastructureSubnetId': GROUP + '/providers/Microsoft.Network/virtualNetworks/'
                                                 + move.VNET + '/subnets/' + move.SUBNET} if network else None}}


def app(name, external, secrets, port, identity=None, registry=LOGIN, env=(), **extra):
    resource = {'id': GROUP + '/providers/Microsoft.App/containerApps/' + name, 'name': name, 'type': 'Microsoft.App/containerApps',
                'location': 'Italy North', 'tags': {'stack': 'uat'}, 'identity': identity or {'type': 'None'},
                'systemData': {'createdBy': 'example'},
                'properties': {'provisioningState': 'Succeeded', 'runningStatus': 'Running', 'managedEnvironmentId': ENVS + move.OLD_ENV,
                               'environmentId': ENVS + move.OLD_ENV, 'workloadProfileName': 'Consumption', 'outboundIpAddresses': ['203.0.113.50'],
                               'latestRevisionName': name + '--old', 'latestReadyRevisionName': name + '--old', 'latestRevisionFqdn': 'x',
                               'customDomainVerificationId': 'example-verification',
                               'configuration': {'activeRevisionsMode': 'Single', 'secrets': [{'name': secret} for secret in secrets],
                                                 'registries': [dict(registry)],
                                                 'ingress': {'external': external, 'targetPort': port, 'transport': 'auto',
                                                             'fqdn': name + '.' + move.OLD_ENV + '-example.italynorth.azurecontainerapps.io',
                                                             'traffic': [{'revisionName': name + '--old', 'weight': 100}],
                                                             'ipSecurityRestrictions': [], 'additionalPortMappings': None}},
                               'template': {'containers': [{'name': name, 'image': ACR + '/' + name + ':1', 'env': [dict(item) for item in env]}],
                                            'revisionSuffix': 'example-sha', 'scale': {'minReplicas': 1, 'maxReplicas': 1}}}}
    for key, value in extra.items():
        target = resource
        *parents, last = key.split('__')
        for parent in parents:
            target = target[parent]
        target[last] = value
    return resource


def own(principal):
    return {'type': 'SystemAssigned', 'principalId': principal, 'tenantId': 'example-tenant'}


def bank(**extra):
    return app(move.BANK, True, ['avispay-db-password', 'avispay-provider-stripe-secret-key', 'avispay-offline-key'], 80,
               identity=own('bank-principal'), registry={'server': ACR, 'identity': 'system'},
               env=[{'name': 'PGHOST', 'value': DATABASE}, {'name': 'PGPASSWORD', 'secretRef': 'avispay-db-password'}],
               properties__configuration__ingress__customDomains=[{'name': 'banking.example.test', 'bindingType': 'SniEnabled',
                                                                   'certificateId': ENVS + move.OLD_ENV + '/managedCertificates/example'}], **extra)


def job(name):
    return {'id': GROUP + '/providers/Microsoft.App/jobs/' + name, 'name': name, 'location': 'Italy North',
            'properties': {'provisioningState': 'Succeeded', 'environmentId': ENVS + move.OLD_ENV, 'workloadProfileName': 'Consumption',
                           'configuration': {'triggerType': 'Manual', 'replicaTimeout': 5400, 'registries': [dict(LOGIN)],
                                             'secrets': [{'name': 'db-password'}, {'name': 'registry-password'}]},
                           'template': {'containers': [{'name': 'migrate', 'image': ACR + '/fineract:1'}]}}}


class FakeAzure:
    """Azure as the move sees it through az: resources by their path, every call kept in order."""

    def __init__(self, apps=None, jobs=None, firewall=True, fail=None, pull='may pull', roles=None):
        self.environments = {move.OLD_ENV: environment(move.OLD_ENV)}
        self.apps = {item['name']: item for item in apps or [
            app('genesis-iso-sandbox-uat', False, ['registry-password'], 8090, identity=own('iso-principal')),
            app('genesis-fineract-uat', False, ['db-password', 'registry-password'], 8080,
                env=[{'name': 'FINERACT_DEFAULT_TENANTDB_HOSTNAME', 'value': DATABASE}]),
            app('genesis-mifos-uat', True, ['registry-password'], 80), bank()]}
        self.jobs = {item['name']: item for item in (jobs if jobs is not None else [job('genesis-fineract-migrate')])}
        login = {'name': 'registry-password', 'value': SECRET_VALUES[3]}
        self.secrets = {'genesis-fineract-uat': [{'name': 'db-password', 'value': SECRET_VALUES[0]}, login],
                        'genesis-fineract-migrate': [{'name': 'db-password', 'value': SECRET_VALUES[0]}, login],
                        'genesis-iso-sandbox-uat': [login], 'genesis-mifos-uat': [login],
                        move.BANK: [{'name': 'avispay-db-password', 'value': SECRET_VALUES[0]},
                                    {'name': 'avispay-provider-stripe-secret-key', 'value': SECRET_VALUES[1]},
                                    {'name': 'avispay-offline-key', 'value': SECRET_VALUES[2]},
                                    {'name': 'vault-example', 'keyVaultUrl': 'https://example.vault.azure.net/secrets/x', 'identity': PULL, 'value': 'resolved'}]}
        # The roles each identity holds: the bank's and the ISO sandbox's own identities may pull from the registry.
        self.roles = roles if roles is not None else {'bank-principal': [(ACR_PULL, REGISTRY)], 'iso-principal': [(ACR_PULL, REGISTRY)]}
        if pull == 'may pull':
            self.roles.setdefault('pull-principal', [(ACR_PULL, REGISTRY)])
        self.pull = pull
        self.databases = {'genesis-fineract-uat-example': firewall, 'genesis-banking-pg-example': False}
        self.fail, self.calls, self.puts, self.network = fail or set(), [], [], {}

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
        if args[:3] == ('containerapp', 'hostname', 'add'):
            ingress = self.apps[args[args.index('-n') + 1]]['properties']['configuration']['ingress']
            ingress['customDomains'] = (ingress.get('customDomains') or []) + [{'name': args[args.index('--hostname') + 1], 'bindingType': 'Disabled'}]
            return None
        if args[:3] == ('containerapp', 'hostname', 'bind'):
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
        assert 'api-version=2026-07-01' in url or 'api-version=202' in url, url
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
            return {'value': [{'name': name, 'id': GROUP + '/providers/Microsoft.DBforPostgreSQL/flexibleServers/' + name} for name in self.databases]}
        if method == 'get' and path.endswith('/firewallRules'):
            azure = self.databases[path.split('/')[-2]]
            return {'value': [{'properties': {'startIpAddress': '0.0.0.0', 'endIpAddress': '0.0.0.0'}}] if azure else
                    [{'properties': {'startIpAddress': '198.51.100.7', 'endIpAddress': '198.51.100.7'}}]}
        if method == 'get' and path.endswith('/registries'):
            return {'value': [{'id': REGISTRY, 'name': 'genesisbankingacr', 'properties': {'loginServer': ACR}}]}
        if method == 'get' and path.endswith('/userAssignedIdentities/' + move.PULL_IDENTITY):
            if not self.pull:
                raise self.error('ResourceNotFound')
            return {'id': PULL, 'name': move.PULL_IDENTITY, 'properties': {'principalId': 'pull-principal'}}
        if method == 'get' and '/roleAssignments' in path:
            principal = url.split('%27')[1]
            return {'value': [{'properties': {'roleDefinitionId': '/subscriptions/' + SUB + '/providers/Microsoft.Authorization/roleDefinitions/' + role,
                                              'scope': scope, 'principalId': principal}} for role, scope in self.roles.get(principal, [])]}
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
            properties.update(provisioningState='Succeeded', runningStatus='Running', latestRevisionName=name + '--new',
                              latestReadyRevisionName=name + '--new', customDomainVerificationId='example-verification')
            ingress = properties['configuration'].get('ingress')
            if ingress:
                ingress['fqdn'] = name + '.' + self.environments[properties['environmentId'].rsplit('/', 1)[-1]]['properties']['defaultDomain']
            store[name] = resource
            return copy.deepcopy(resource)
        if method == 'get' and name in store:
            return copy.deepcopy(store[name])
        raise AssertionError('unexpected Azure call: ' + method + ' ' + path)

    def writes(self):
        return [call for call in self.calls if call[0] != 'rest' and any(word in call for word in ('create', 'update', 'delete', 'add', 'bind'))
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
    def run_move(self, mode, azure, expect_exit=False, hostname=''):
        output, summary = io.StringIO(), Path(self.tmp) / 'summary.md'
        with patch.object(move, 'az', azure), patch.object(move.time, 'sleep', lambda seconds: None), \
                patch.object(move.urllib.request, 'urlopen', Ready), patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(summary)}), \
                contextlib.redirect_stdout(output):
            if expect_exit:
                with self.assertRaises(SystemExit):
                    move.main(mode, hostname)
            else:
                move.main(mode, hostname)
        text = output.getvalue() + summary.read_text()
        summary.unlink()
        for value in SECRET_VALUES + ('resolved',):
            self.assertNotIn(value, text)
        return text

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_plan_reads_and_reports_and_changes_nothing(self):
        azure = FakeAzure()
        text = self.run_move('plan', azure)
        self.assertEqual(azure.writes(), [])
        self.assertFalse([call for call in azure.calls if call[0] == 'rest' and call[2] == 'post'], 'plan reads no secret values')
        moves = [line.split(': ')[1].split(' ')[1] for line in text.splitlines() if line.startswith('Moves: ')]
        self.assertEqual(moves, ['genesis-fineract-migrate', 'genesis-fineract-uat', 'genesis-iso-sandbox-uat', 'genesis-mifos-uat', move.BANK])
        self.assertIn("Azure's default network, where no TCP port opens to the outside", text)
        self.assertIn('Moves: app genesis-banking-uat: external auto port 80; identity SystemAssigned; secrets 3 (0 from Key Vault); IP rules 0;'
                      ' profile Consumption; opens port 8443 to the outside', text)
        # The plan's findings, answered: the bank pulls with the pull identity; the ISO sandbox's own right to pull is not
        # what it pulls with; the database the apps do not use is no reason to stop.
        self.assertIn('genesis-banking-uat pulls from ' + ACR + ' with genesis-banking-uat-pull instead of its own identity.', text)
        self.assertIn('Custom domain banking.example.test on genesis-banking-uat: after the move ChatGPT points its DNS to the new address apply'
                      ' gives, then it is bound again (bind).', text)
        self.assertIn('Database genesis-fineract-uat-example: stays as it is; used by genesis-fineract-uat, genesis-banking-uat and lets Azure services in.', text)
        self.assertIn("Database genesis-banking-pg-example: stays as it is; not used by the test server's apps.", text)
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
        self.assertEqual(create[create.index('--internal-only') + 1], 'false')
        for call in azure.calls:
            if call[0] == 'network' and 'create' in call:
                self.assertEqual(call[call.index('-l') + 1], 'italynorth')
        bodies = dict(azure.puts)
        for name, body in bodies.items():
            properties = body['properties']
            self.assertEqual(properties['environmentId'], ENVS + move.NEW_ENV)
            self.assertEqual(properties['workloadProfileName'], 'Consumption')
            for key in move.READ_ONLY:
                self.assertNotIn(key, properties)
            self.assertNotIn('id', body)
            self.assertNotIn('systemData', body)
            self.assertNotIn('revisionSuffix', properties['template'])
        bank = bodies[move.BANK]['properties']['configuration']
        self.assertEqual(bank['ingress']['additionalPortMappings'], [{'external': True, 'targetPort': 8443, 'exposedPort': 8443}])
        self.assertEqual(bank['ingress']['traffic'], [{'latestRevision': True, 'weight': 100}])
        self.assertNotIn('fqdn', bank['ingress'])
        self.assertNotIn('customDomains', bank['ingress'])
        self.assertEqual(bank['secrets'], [{'name': 'avispay-db-password', 'value': SECRET_VALUES[0]},
                                           {'name': 'avispay-provider-stripe-secret-key', 'value': SECRET_VALUES[1]},
                                           {'name': 'avispay-offline-key', 'value': SECRET_VALUES[2]},
                                           {'name': 'vault-example', 'keyVaultUrl': 'https://example.vault.azure.net/secrets/x', 'identity': PULL}])
        # The bank pulls with the test server's pull identity, its own identity kept (the plan's finding).
        self.assertEqual(bank['registries'], [{'server': ACR, 'identity': PULL}])
        self.assertEqual(bodies[move.BANK]['identity'], {'type': 'SystemAssigned,UserAssigned', 'userAssignedIdentities': {PULL: {}}})
        self.assertEqual(bodies[move.BANK]['tags'], {'stack': 'uat'})
        # The other apps pull as before, with their registry login.
        for name in ('genesis-iso-sandbox-uat', 'genesis-fineract-uat', 'genesis-mifos-uat'):
            self.assertIsNone(bodies[name]['properties']['configuration']['ingress']['additionalPortMappings'])
            self.assertEqual(bodies[name]['properties']['configuration']['registries'], [LOGIN])
        self.assertEqual(bodies['genesis-iso-sandbox-uat']['identity'], {'type': 'SystemAssigned'})
        self.assertNotIn('identity', bodies['genesis-fineract-uat'])
        self.assertEqual(bodies['genesis-fineract-migrate']['properties']['configuration']['secrets'],
                         [{'name': 'db-password', 'value': SECRET_VALUES[0]}, {'name': 'registry-password', 'value': SECRET_VALUES[3]}])
        # The secrets' file was private while it existed and is gone.
        self.assertEqual(azure.body_mode, 0o600)
        self.assertFalse(any(os.path.exists(file) for file in azure.body_files))
        self.assertIn('Environment genesis-banking-uat-net ready: addresses *.genesis-banking-uat-net-example.italynorth.azurecontainerapps.io, '
                      'incoming address 203.0.113.10, outgoing address 198.51.100.20.', text)
        self.assertIn('Port 8443 open to the outside on genesis-banking-uat.', text)
        self.assertIn('Bank app ready at https://genesis-banking-uat.genesis-banking-uat-net-example.italynorth.azurecontainerapps.io', text)
        # What ChatGPT sets for the custom domain (the bank owner: "ChatGPT does the DNS"), then bind.
        self.assertIn('DNS for ChatGPT: banking.example.test CNAME genesis-banking-uat.genesis-banking-uat-net-example.italynorth.azurecontainerapps.io;'
                      ' asuid.banking.example.test TXT example-verification. Then: bind banking.example.test.', text)
        self.assertIn('The old environment genesis-banking-uat-env stays, empty, until the owner says to delete it.', text)
        # Run again: everything is there, nothing moves twice.
        before = len(azure.writes())
        again = self.run_move('apply', azure)
        self.assertIn('Moved already: app ' + move.BANK, again)
        self.assertEqual(len(azure.writes()), before + 1, 'only the subnet is set again')

    def test_without_the_pull_identity_s_right_the_bank_pulls_with_the_registry_login_of_the_other_apps(self):
        for pull in (None, 'without right'):
            with self.subTest(pull=pull):
                azure = FakeAzure(pull=pull)
                plan = self.run_move('plan', azure)
                self.assertIn('genesis-banking-uat pulls from ' + ACR + ' with the registry login genesis-fineract-migrate pulls with instead of its own identity.', plan)
                self.assertNotIn('STOP', plan)
                self.run_move('apply', azure)
                bank = dict(azure.puts)[move.BANK]
                self.assertEqual(bank['properties']['configuration']['registries'],
                                 [{'server': ACR, 'username': 'genesisbankingacr', 'passwordSecretRef': 'uat-registry-pull'}])
                self.assertEqual(bank['properties']['configuration']['secrets'][-1], {'name': 'uat-registry-pull', 'value': SECRET_VALUES[3]})
                self.assertEqual(bank['identity'], {'type': 'SystemAssigned'})

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
                    self.assertEqual(body['properties']['workloadProfileName'], 'Consumption')
                    self.assertIn('Put back: ' + ('job ' if name.endswith('migrate') else 'app ') + name + ' runs in genesis-banking-uat-env as before.', text)
                self.assertEqual(dict(backs)['genesis-fineract-uat']['properties']['configuration']['secrets'],
                                 [{'name': 'db-password', 'value': SECRET_VALUES[0]}, {'name': 'registry-password', 'value': SECRET_VALUES[3]}])
                if failing == move.BANK:
                    # Put back, the bank pulls with the pull identity too: its own old identity went with the old app.
                    self.assertEqual(dict(backs)[move.BANK]['properties']['configuration']['registries'], [{'server': ACR, 'identity': PULL}])
                self.assertIn('Not moved (Azure rest failed: InvalidParameterValueInContainerTemplate): what moved in this run goes back as it was.', text)
                for resource in list(azure.apps.values()) + list(azure.jobs.values()):
                    self.assertEqual(resource['properties']['environmentId'], ENVS + move.OLD_ENV, resource['name'])
                self.assertEqual(set(azure.apps) | set(azure.jobs), set(names))
                self.assertNotIn('Port 8443 open', text)
                self.assertNotIn('DNS for ChatGPT', text)

    def test_a_bank_that_does_not_answer_at_its_new_address_puts_everything_back(self):
        class Starting(Ready):
            def read(self, size=-1):
                return json.dumps({'status': 'starting'}).encode()
        azure = FakeAzure()
        output, summary = io.StringIO(), Path(self.tmp) / 'summary.md'
        with patch.object(move, 'WAIT', 0), patch.object(move.urllib.request, 'urlopen', Starting), patch.object(move, 'az', azure), \
                patch.object(move.time, 'sleep', lambda seconds: None), patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(summary)}), \
                contextlib.redirect_stdout(output), self.assertRaises(SystemExit):
            move.main('apply')
        text = output.getvalue()
        self.assertIn('Port 8443 open to the outside on genesis-banking-uat.', text)
        self.assertIn('Not moved (The bank app did not answer ready at its new address.): what moved in this run goes back as it was.', text)
        for resource in list(azure.apps.values()) + list(azure.jobs.values()):
            self.assertEqual(resource['properties']['environmentId'], ENVS + move.OLD_ENV, resource['name'])
        for value in SECRET_VALUES:
            self.assertNotIn(value, text)

    def test_what_the_move_can_not_carry_over_stops_it_before_any_change(self):
        kept_out = dict(apps=[bank()], jobs=[], pull=None)
        cases = {
            'Not known as part of the test server, so not moved blind: app example-other-app.':
                dict(apps=[bank(), app('example-other-app', True, [], 80)]),
            'genesis-banking-uat pulls its images from ' + ACR + ' with its own identity, and neither genesis-banking-uat-pull nor a registry'
            ' login of the test server may pull from there in its place.': kept_out,
            'genesis-banking-uat has its own Azure identity in use (avispay-db-password); a moved app gets a new identity without those rights.':
                dict(apps=[bank(properties__configuration__secrets=[{'name': 'avispay-db-password', 'keyVaultUrl': 'https://example.vault.azure.net/secrets/x',
                                                                     'identity': 'system'}])]),
            'genesis-banking-uat has its own Azure identity in use (role at example-vault); a moved app gets a new identity without those rights.':
                dict(roles={'bank-principal': [(ACR_PULL, REGISTRY), ('4633458b-17de-408a-b874-0445c86b69e6',
                                                                       GROUP + '/providers/Microsoft.KeyVault/vaults/example-vault')]}),
            'genesis-banking-uat uses the environment storage files, which is not carried over.':
                dict(apps=[bank(properties__template__volumes=[{'name': 'data', 'storageType': 'AzureFile', 'storageName': 'files'}])]),
            'The bank app is not reachable from outside, so its port 8443 can not be either.':
                dict(apps=[bank(properties__configuration__ingress__external=False)]),
            'The database genesis-fineract-uat-example (used by genesis-fineract-uat, genesis-banking-uat) does not let Azure services in: the new'
            ' outgoing address must be allowed first.': dict(firewall=False),
            'genesis-banking-uat runs on workload profile D4, which the new environment does not have.':
                dict(apps=[bank(properties__workloadProfileName='D4')]),
        }
        for problem, setup in cases.items():
            with self.subTest(problem=problem[:50]):
                azure = FakeAzure(**copy.deepcopy(setup))
                text = self.run_move('apply', azure, expect_exit=True)
                self.assertIn('STOP: ' + problem, text)
                self.assertIn('FAILED: Stopped before any change.', text)
                self.assertEqual(azure.writes(), [])

    def test_a_database_named_only_in_a_secret_is_found_by_apply_and_its_password_is_not_shown(self):
        azure = FakeAzure()
        azure.secrets[move.BANK].append({'name': 'other-database-url', 'value': 'postgres://example:' + SECRET_VALUES[4]
                                         + '@genesis-banking-pg-example.postgres.database.azure.com:5432/example'})
        self.assertNotIn('STOP', self.run_move('plan', azure))
        text = self.run_move('apply', azure, expect_exit=True)
        self.assertIn('STOP: The database genesis-banking-pg-example (used by genesis-banking-uat) does not let Azure services in: the new outgoing'
                      ' address must be allowed first.', text)
        self.assertEqual(azure.writes(), [])

    def test_bind_binds_a_custom_domain_on_the_moved_bank_with_a_managed_certificate(self):
        azure = FakeAzure()
        self.assertIn('FAILED: The bank app is not in the new environment yet: run apply first.',
                      self.run_move('bind', azure, expect_exit=True, hostname='banking.example.test'))
        self.assertIn('FAILED: Not a domain name: banking example', self.run_move('bind', azure, expect_exit=True, hostname='banking example'))
        self.assertEqual(azure.writes(), [])
        self.run_move('apply', azure)
        before = len(azure.calls)
        text = self.run_move('bind', azure, hostname='Banking.Example.Test')
        calls = [call for call in azure.calls[before:] if call[0] == 'containerapp']
        self.assertEqual(calls, [('containerapp', 'hostname', 'add', '-g', move.RG, '-n', move.BANK, '--hostname', 'banking.example.test'),
                                 ('containerapp', 'hostname', 'bind', '-g', move.RG, '-n', move.BANK, '--hostname', 'banking.example.test',
                                  '--environment', move.NEW_ENV, '--validation-method', 'CNAME')])
        self.assertIn('Bound: https://banking.example.test on genesis-banking-uat, with a certificate Azure manages.', text)
        # A domain already on the app is only bound.
        before = len(azure.calls)
        self.run_move('bind', azure, hostname='banking.example.test')
        self.assertEqual([call[2] for call in azure.calls[before:] if call[0] == 'containerapp'], ['bind'])

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
