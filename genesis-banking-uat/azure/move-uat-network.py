#!/usr/bin/env python3
"""The banking test server on its own Azure network, so peer banks reach the FinTerminal's port 8443.

Requested by the bank owner: "Yes prepare port 8443 for azure", "we must be operative and live interacting".
Azure Container Apps opens a TCP port to the outside only in an environment with its own virtual network, and an
environment can't be given one later ("After you create an environment ... you can't change the network type").
So a new environment is made on a new network, with one fixed outgoing address (a NAT gateway), and the apps and
job of the test server move into it under their own names, with their settings and secrets. The database, DNS
and the old environment stay as they are.

  plan   reads the test server and says what apply would do; changes nothing.
  apply  makes the network and the environment, moves the apps one by one and opens port 8443 on the bank's app.
         If an app does not come up in the new environment, or the bank does not answer there, everything moved
         in that run is put back in the old environment as it was.

Secret values are read only to carry them over, and are never printed.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

RG = 'genesis-banking-rg'
OLD_ENV = 'genesis-banking-uat-env'
NEW_ENV = 'genesis-banking-uat-net'
VNET, SUBNET = 'genesis-banking-uat-vnet', 'container-apps'
VNET_PREFIX, SUBNET_PREFIX = '10.60.0.0/16', '10.60.0.0/23'
EGRESS_IP, NAT = 'genesis-banking-uat-egress', 'genesis-banking-uat-nat'
PROFILE = 'Consumption'
BANK = 'genesis-banking-uat'
FIN_PORT = 8443
# The test server as deploy-uat.sh and deploy-sovereign.py know it. Anything else in its environment is not moved
# blind: the plan names it and apply stops.
APPS = ('genesis-iso-sandbox-uat', 'genesis-fineract-uat', 'genesis-mifos-uat', BANK)
JOBS = ('genesis-fineract-migrate',)
ARM = 'https://management.azure.com'
DATABASE_API, ROLES_API = '2022-12-01', '2022-04-01'
# What Azure reports about a resource but never takes back.
READ_ONLY = ('provisioningState', 'runningStatus', 'runningState', 'deploymentErrors', 'latestRevisionName',
             'latestReadyRevisionName', 'latestRevisionFqdn', 'customDomainVerificationId', 'outboundIpAddresses',
             'eventStreamEndpoint', 'managedEnvironmentId')
WAIT = 900


class AzureError(RuntimeError):
    """An Azure call failed: its error codes only - a command line or Azure's raw answer can carry a secret."""

    def __init__(self, args, stderr):
        codes = []
        for match in re.findall(r'"code"\s*:\s*"([A-Za-z][A-Za-z0-9]{2,63})"|^\(([A-Za-z][A-Za-z0-9]{2,63})\)'
                                r'|^\s*Code:\s*([A-Za-z][A-Za-z0-9]{2,63})\s*$', stderr or '', re.MULTILINE):
            code = next(item for item in match if item)
            if code not in codes:
                codes.append(code)
        self.codes = codes[:3] or ['AZURE_CLI_ERROR']
        words = [arg for arg in args[:3] if re.fullmatch(r'[a-z][a-z-]*', arg)]
        super().__init__('Azure ' + ' '.join(words) + ' failed: ' + ', '.join(self.codes))


class Refused(RuntimeError):
    """Something on the test server the move would not carry over as it is: nothing is changed."""


def az(*args):
    result = subprocess.run(['az', *args, '--only-show-errors', '-o', 'json'], capture_output=True, text=True)
    if result.returncode:
        raise AzureError(args, result.stderr)
    return json.loads(result.stdout) if result.stdout.strip() else None


def arm(method, path, version, body=None):
    """One Azure Resource Manager call. A body (it can hold secret values) goes through a private file, never
    through the command line, and the file is gone when the call returns."""
    url = (path if path.startswith('https://') else ARM + path) + ('&' if '?' in path else '?') + 'api-version=' + version
    if body is None:
        return az('rest', '--method', method, '--url', url)
    folder = tempfile.mkdtemp(prefix='uat-network-')
    file = os.path.join(folder, 'body.json')
    try:
        with open(os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as handle:
            json.dump(body, handle)
        return az('rest', '--method', method, '--url', url, '--body', '@' + file,
                  '--headers', 'Content-Type=application/json')
    finally:
        if os.path.exists(file):
            os.remove(file)
        os.rmdir(folder)


def missing(error):
    return bool({'ResourceNotFound', 'NotFound', 'ManagedEnvironmentNotFound', 'ResourceGroupNotFound'} & set(error.codes))


def versions():
    """The newest stable Azure API of each kind, so that reading an app and writing it back loses no setting."""
    newest = {}
    for item in az('provider', 'show', '-n', 'Microsoft.App', '--query',
                   'resourceTypes[].{type:resourceType,versions:apiVersions}'):
        stable = sorted(v for v in item.get('versions') or [] if re.fullmatch(r'\d{4}-\d{2}-\d{2}', v))
        if stable:
            newest[item['type']] = stable[-1]
    return {kind: newest[kind] for kind in ('containerApps', 'jobs', 'managedEnvironments')}


def listing(path, version):
    page, items = arm('get', path, version), []
    while True:
        items += page.get('value') or []
        if not page.get('nextLink'):
            return items
        page = az('rest', '--method', 'get', '--url', page['nextLink'])


def properties_of(resource):
    return resource.get('properties') or {}


def configuration_of(resource):
    return properties_of(resource).get('configuration') or {}


def ingress_of(resource):
    return configuration_of(resource).get('ingress') or {}


def environment_of(resource):
    properties = properties_of(resource)
    return (properties.get('environmentId') or properties.get('managedEnvironmentId') or '').lower()


def body_for(resource, secrets, environment_id, profile, port=None):
    """The resource as Azure takes it back: in the given environment, with its secrets, without what Azure only
    reports. A custom domain's certificate belongs to its environment, so the domain is left out and bound again;
    the traffic goes to the latest revision, as the old revisions go with the old app."""
    properties = {key: value for key, value in properties_of(resource).items() if key not in READ_ONLY}
    # The first revision gets a name of its own: the old app's revision names may still be taken.
    if properties.get('template'):
        properties['template'] = {key: value for key, value in properties['template'].items() if key != 'revisionSuffix'}
    configuration = dict(properties.get('configuration') or {})
    configuration['secrets'] = [{key: item[key] for key in ('name', 'keyVaultUrl', 'identity') if item.get(key)}
                                if item.get('keyVaultUrl') else {'name': item['name'], 'value': item.get('value') or ''}
                                for item in secrets]
    ingress = configuration.get('ingress')
    if ingress:
        ingress = {key: value for key, value in ingress.items() if key not in ('fqdn', 'customDomains')}
        if ingress.get('traffic'):
            ingress['traffic'] = [{'latestRevision': True, 'weight': 100}]
        if port:
            mappings = [item for item in ingress.get('additionalPortMappings') or [] if item.get('exposedPort') != port]
            ingress['additionalPortMappings'] = mappings + [{'external': True, 'targetPort': port, 'exposedPort': port}]
        configuration['ingress'] = ingress
    properties.update(configuration=configuration, environmentId=environment_id)
    if profile:
        properties['workloadProfileName'] = profile
    else:
        properties.pop('workloadProfileName', None)
    body = {key: resource[key] for key in ('location', 'tags', 'kind', 'extendedLocation') if resource.get(key)}
    identity = resource.get('identity') or {}
    if identity.get('type') and identity['type'].lower() != 'none':
        body['identity'] = {'type': identity['type']}
        if identity.get('userAssignedIdentities'):
            body['identity']['userAssignedIdentities'] = {key: {} for key in identity['userAssignedIdentities']}
    body['properties'] = properties
    return body


def describe(kind, resource):
    """What the plan says about an app or a job: never a value, only what it is and how it is reached."""
    ingress, secrets = ingress_of(resource), configuration_of(resource).get('secrets') or []
    reach = (('external' if ingress.get('external') else 'internal') + ' ' + str(ingress.get('transport') or 'auto')
             + ' port ' + str(ingress.get('targetPort'))) if ingress else 'no ingress'
    extra = [str(item.get('exposedPort')) for item in ingress.get('additionalPortMappings') or []]
    return (kind + ' ' + resource['name'] + ': ' + reach + (' + ports ' + ', '.join(extra) if extra else '')
            + '; identity ' + str((resource.get('identity') or {}).get('type') or 'None')
            + '; secrets ' + str(len(secrets)) + ' (' + str(sum(1 for item in secrets if item.get('keyVaultUrl'))) + ' from Key Vault)'
            + '; IP rules ' + str(len(ingress.get('ipSecurityRestrictions') or []))
            + '; profile ' + str(properties_of(resource).get('workloadProfileName') or 'none'))


class Move:
    def __init__(self, mode, out=print):
        self.mode, self.out, self.report = mode, out, []
        self.subscription = az('account', 'show', '--query', 'id')
        self.api = versions()
        self.group = '/subscriptions/' + self.subscription + '/resourceGroups/' + RG
        self.environments = self.group + '/providers/Microsoft.App/managedEnvironments/'

    def say(self, line):
        self.report.append(line)
        self.out(line)

    def path(self, kind, name):
        return self.group + '/providers/Microsoft.App/' + ('jobs/' if kind == 'job' else 'containerApps/') + name

    def version(self, kind):
        return self.api['jobs' if kind == 'job' else 'containerApps']

    def environment(self, name):
        try:
            return arm('get', self.environments + name, self.api['managedEnvironments'])
        except AzureError as error:
            if missing(error):
                return None
            raise

    def rights(self, resource):
        """What the app's own Azure identity is used for: secrets or a registry read with it, roles it holds."""
        identity = resource.get('identity') or {}
        if 'systemassigned' not in str(identity.get('type') or '').lower().replace(',', '').replace(' ', ''):
            return []
        uses = [item['name'] for item in configuration_of(resource).get('secrets') or [] if str(item.get('identity') or '').lower() == 'system']
        uses += ['registry ' + str(item.get('server')) for item in configuration_of(resource).get('registries') or []
                 if str(item.get('identity') or '').lower() == 'system']
        if identity.get('principalId'):
            try:
                roles = arm('get', '/subscriptions/' + self.subscription + '/providers/Microsoft.Authorization/roleAssignments'
                            '?$filter=principalId%20eq%20%27' + identity['principalId'] + '%27', ROLES_API).get('value') or []
            except AzureError as error:
                return uses + ['its rights could not be read: ' + ', '.join(error.codes)]
            uses += ['role at ' + str(item['properties'].get('scope', '')).rsplit('/', 1)[-1] for item in roles]
        return uses

    def databases(self):
        """The database stays as it is: it must let Azure's own addresses in, the new outgoing one among them."""
        found = []
        for server in listing(self.group + '/providers/Microsoft.DBforPostgreSQL/flexibleServers', DATABASE_API):
            rules = listing(server['id'] + '/firewallRules', DATABASE_API)
            azure = any(properties_of(rule).get('startIpAddress') == '0.0.0.0' and properties_of(rule).get('endIpAddress') == '0.0.0.0'
                        for rule in rules)
            found.append((server['name'], azure))
        return found

    def survey(self):
        """The test server as it is: its environment, what runs in it, and whatever the move can't carry over."""
        old = self.environment(OLD_ENV)
        if not old:
            raise Refused('The test server environment ' + OLD_ENV + ' was not found.')
        new = self.environment(NEW_ENV)
        old_id, new_id = old['id'].lower(), (new or {}).get('id', '').lower()
        resources = [('job', item) for item in listing(self.group + '/providers/Microsoft.App/jobs', self.api['jobs'])] \
            + [('app', item) for item in listing(self.group + '/providers/Microsoft.App/containerApps', self.api['containerApps'])]
        here = [(kind, item) for kind, item in resources if environment_of(item) == old_id]
        moved = [(kind, item) for kind, item in resources if new_id and environment_of(item) == new_id]
        known = {('job', name) for name in JOBS} | {('app', name) for name in APPS}
        problems = []
        if (properties_of(old).get('vnetConfiguration') or {}).get('infrastructureSubnetId'):
            problems.append('The test server environment has its own network already: the port can be opened there.')
        strangers = sorted(kind + ' ' + item['name'] for kind, item in here + moved if (kind, item['name']) not in known)
        if strangers:
            problems.append('Not known as part of the test server, so not moved blind: ' + ', '.join(strangers) + '.')
        if BANK not in {item['name'] for kind, item in here + moved if kind == 'app'}:
            problems.append('The bank app ' + BANK + ' is not in the test server environment.')
        for kind, item in here:
            profile = properties_of(item).get('workloadProfileName')
            if profile not in (None, PROFILE):
                problems.append(item['name'] + ' runs on workload profile ' + str(profile) + ', which the new environment does not have.')
            for volume in (properties_of(item).get('template') or {}).get('volumes') or []:
                if volume.get('storageName'):
                    problems.append(item['name'] + ' uses the environment storage ' + str(volume['storageName']) + ', which is not carried over.')
            uses = self.rights(item)
            if uses:
                problems.append(item['name'] + ' has its own Azure identity in use (' + ', '.join(uses)
                                + '); a moved app gets a new identity without those rights.')
            if item['name'] == BANK and not ingress_of(item).get('external'):
                problems.append('The bank app is not reachable from outside, so its port ' + str(FIN_PORT) + ' can not be either.')
        components = listing(self.environments + OLD_ENV + '/daprComponents', self.api['managedEnvironments'])
        if components:
            problems.append('The environment has ' + str(len(components)) + ' Dapr component(s), which are not carried over.')
        if new and not (properties_of(new).get('vnetConfiguration') or {}).get('infrastructureSubnetId'):
            problems.append('An environment ' + NEW_ENV + ' exists already, without its own network.')
        databases = self.databases()
        for name, azure in databases:
            if not azure:
                problems.append('The database ' + name + ' does not let Azure services in: the new outgoing address must be allowed first.')
        # The job first (nothing runs then), the bank's own app last: what it calls is in place when it comes up.
        order = sorted(here, key=lambda pair: (pair[0] != 'job', pair[1]['name'] == BANK, bool(ingress_of(pair[1]).get('external')), pair[1]['name']))
        absent = [name for name in JOBS + APPS if name not in {item['name'] for _, item in here + moved}]
        return {'old': old, 'new': new, 'here': order, 'moved': moved, 'problems': problems, 'databases': databases, 'absent': absent}

    def plan(self, state):
        old = properties_of(state['old'])
        self.say('Test server environment ' + OLD_ENV + ': ' + ('own network' if (old.get('vnetConfiguration') or {}).get('infrastructureSubnetId')
                 else "Azure's default network, where no TCP port opens to the outside") + '; addresses *.' + str(old.get('defaultDomain')))
        self.say('New environment ' + NEW_ENV + ' (' + ('exists' if state['new'] else 'to be made') + '): network ' + VNET + ' ' + VNET_PREFIX
                 + ', subnet ' + SUBNET_PREFIX + ', one fixed outgoing address (NAT gateway ' + NAT + ')')
        for kind, item in state['here']:
            self.say('Moves: ' + describe(kind, item) + ('; opens port ' + str(FIN_PORT) + ' to the outside' if item['name'] == BANK else ''))
            for domain in ingress_of(item).get('customDomains') or []:
                self.say('Custom domain ' + str(domain.get('name')) + ' on ' + item['name'] + ': bound again after the move.')
        for kind, item in state['moved']:
            self.say('Moved already: ' + kind + ' ' + item['name'])
        for name in state['absent']:
            self.say('Not found: ' + name)
        for name, azure in state['databases']:
            self.say('Database ' + name + ': stays as it is' + (' and lets Azure services in.' if azure else '.'))
        if not state['databases']:
            self.say('No database server in ' + RG + '.')
        for problem in state['problems']:
            self.say('STOP: ' + problem)
        if self.mode == 'plan':
            self.say('Nothing was changed.')

    def network(self, location):
        """The network, its fixed outgoing address and the environment on it, in the test server's region; what
        exists already is kept."""
        def show(*args):
            try:
                return az(*args)
            except AzureError as error:
                if missing(error):
                    return None
                raise
        if not show('network', 'vnet', 'show', '-g', RG, '-n', VNET):
            az('network', 'vnet', 'create', '-g', RG, '-n', VNET, '-l', location, '--address-prefixes', VNET_PREFIX,
               '--subnet-name', SUBNET, '--subnet-prefixes', SUBNET_PREFIX)
        if not show('network', 'public-ip', 'show', '-g', RG, '-n', EGRESS_IP):
            az('network', 'public-ip', 'create', '-g', RG, '-n', EGRESS_IP, '-l', location, '--sku', 'Standard', '--allocation-method', 'Static')
        if not show('network', 'nat', 'gateway', 'show', '-g', RG, '-n', NAT):
            az('network', 'nat', 'gateway', 'create', '-g', RG, '-n', NAT, '-l', location, '--public-ip-addresses', EGRESS_IP, '--idle-timeout', '4')
        subnet = az('network', 'vnet', 'subnet', 'update', '-g', RG, '--vnet-name', VNET, '-n', SUBNET,
                    '--delegations', 'Microsoft.App/environments', '--nat-gateway', NAT)
        if not self.environment(NEW_ENV):
            az('containerapp', 'env', 'create', '-g', RG, '-n', NEW_ENV, '-l', location,
               '--infrastructure-subnet-resource-id', subnet['id'], '--enable-workload-profiles', 'true',
               '--internal-only', 'false', '--logs-destination', 'none')
        environment = self.settled(self.environments + NEW_ENV, self.api['managedEnvironments'])
        egress = az('network', 'public-ip', 'show', '-g', RG, '-n', EGRESS_IP, '--query', 'ipAddress')
        return environment, egress

    def settled(self, path, version, ready=lambda resource: True):
        """Waits until Azure has finished with a resource; one that fails or takes too long stops the move."""
        end = time.monotonic() + WAIT
        while True:
            resource = arm('get', path, version)
            state = properties_of(resource).get('provisioningState')
            if state == 'Succeeded' and ready(resource):
                return resource
            if state in ('Failed', 'Canceled') or time.monotonic() > end:
                raise RuntimeError(path.rsplit('/', 1)[-1] + ' did not come up (' + str(state) + ')')
            time.sleep(10)

    @staticmethod
    def running(kind):
        """A job is in place once Azure has it; an app once its newest revision is ready - or, for an app that
        scales to nothing without requests, once Azure has it."""
        def ready(resource):
            properties = properties_of(resource)
            if kind == 'job' or ((properties.get('template') or {}).get('scale') or {}).get('minReplicas') == 0:
                return True
            return bool(properties.get('latestRevisionName')) and properties.get('latestReadyRevisionName') == properties.get('latestRevisionName') \
                and properties.get('runningStatus') not in ('Stopped', 'Suspended')
        return ready

    def carry(self, kind, resource, environment, done):
        """One app or job into the new environment under its own name. Its body for there - and the one to put it
        back with, kept in done - is made before anything is deleted."""
        name, path, version = resource['name'], self.path(kind, resource['name']), self.version(kind)
        secrets = (arm('post', path + '/listSecrets', version, {}) or {}).get('value') or []
        target = body_for(resource, secrets, environment['id'], PROFILE, FIN_PORT if kind == 'app' and name == BANK else None)
        back = body_for(resource, secrets, properties_of(resource).get('environmentId') or properties_of(resource).get('managedEnvironmentId'),
                        properties_of(resource).get('workloadProfileName'))
        done.append((kind, name, back))
        az(*self.delete(kind, name))
        arm('put', path, version, target)
        moved = self.settled(path, version, self.running(kind))
        self.say('Moved: ' + kind + ' ' + name + (' at ' + str(ingress_of(moved).get('fqdn')) if ingress_of(moved).get('fqdn') else ''))
        for domain in ingress_of(resource).get('customDomains') or []:
            self.say('Custom domain ' + str(domain.get('name')) + ' on ' + name + ': to be bound again on the new environment.')
        return moved

    @staticmethod
    def delete(kind, name):
        return ['containerapp', *(['job'] if kind == 'job' else []), 'delete', '-g', RG, '-n', name, '--yes']

    def restore(self, done):
        """Everything moved in this run goes back to the old environment as it was, the last first: the apps call one
        another by their short names (the bank calls http://genesis-fineract-uat), which reach only within one
        environment (review finding), so the test server is whole again where it was."""
        failed = []
        for kind, name, back in reversed(done):
            path, version = self.path(kind, name), self.version(kind)
            try:
                try:
                    az(*self.delete(kind, name))
                except AzureError as error:
                    if not missing(error):
                        raise
                arm('put', path, version, back)
                self.settled(path, version, self.running(kind))
                self.say('Put back: ' + kind + ' ' + name + ' runs in ' + OLD_ENV + ' as before.')
            except Exception as error:
                failed.append(name)
                self.say('NOT put back: ' + kind + ' ' + name + ' (' + str(error) + ').')
        if failed:
            raise RuntimeError('Could not put back: ' + ', '.join(failed) + '.')

    def open_port(self, resource):
        """Port 8443 on the bank's app (already there when the app was moved in this run)."""
        if any(item.get('exposedPort') == FIN_PORT and item.get('external') for item in ingress_of(resource).get('additionalPortMappings') or []):
            return resource
        path, version = self.path('app', BANK), self.version('app')
        secrets = (arm('post', path + '/listSecrets', version, {}) or {}).get('value') or []
        arm('put', path, version, body_for(resource, secrets, properties_of(resource).get('environmentId'),
                                           properties_of(resource).get('workloadProfileName'), FIN_PORT))
        return self.settled(path, version, self.running('app'))

    def check(self, resource):
        """The bank's app answers ready from its new address."""
        fqdn, end = ingress_of(resource).get('fqdn'), time.monotonic() + WAIT
        while True:
            try:
                with urllib.request.urlopen('https://' + fqdn + '/readyz', timeout=15) as answer:
                    body = json.loads(answer.read(4096) or b'{}')
                    if body.get('status') == 'ready':
                        self.say('Bank app ready at https://' + fqdn + ' (release ' + str(body.get('release')) + ').')
                        return fqdn
            except (urllib.error.URLError, OSError, ValueError):
                pass
            if time.monotonic() > end:
                raise RuntimeError('The bank app did not answer ready at its new address.')
            time.sleep(10)

    def apply(self, state):
        if state['problems']:
            raise Refused('Stopped before any change. ' + ' '.join(state['problems']))
        environment, egress = self.network(state['old']['location'].lower().replace(' ', ''))
        properties = properties_of(environment)
        self.say('Environment ' + NEW_ENV + ' ready: addresses *.' + str(properties.get('defaultDomain'))
                 + ', incoming address ' + str(properties.get('staticIp')) + ', outgoing address ' + str(egress) + '.')
        bank = next((item for kind, item in state['moved'] if kind == 'app' and item['name'] == BANK), None)
        done = []
        try:
            for kind, item in state['here']:
                moved = self.carry(kind, item, environment, done)
                if kind == 'app' and item['name'] == BANK:
                    bank = moved
            bank = self.open_port(bank)
            self.say('Port ' + str(FIN_PORT) + ' open to the outside on ' + BANK + '.')
            self.check(bank)
        except Exception as error:
            # An app that does not come up in the new environment, or a bank that does not answer there: all that
            # moved in this run goes back.
            self.say('Not moved (' + str(error) + '): what moved in this run goes back as it was.')
            self.restore(done)
            raise
        self.say('The old environment ' + OLD_ENV + ' stays, empty, until the owner says to delete it.')


def main(mode):
    if mode not in ('plan', 'apply'):
        raise SystemExit('mode must be plan or apply')
    move = Move(mode)
    try:
        state = move.survey()
        move.plan(state)
        if mode == 'apply':
            move.apply(state)
    except (Refused, AzureError, RuntimeError) as error:
        move.say('FAILED: ' + str(error))
        raise SystemExit(1)
    finally:
        summary = os.environ.get('GITHUB_STEP_SUMMARY')
        if summary:
            with open(summary, 'a') as handle:
                handle.write('### Test server network (' + mode + ')\n\n' + '\n'.join('- ' + line for line in move.report) + '\n')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'plan')
