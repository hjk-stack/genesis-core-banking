#!/usr/bin/env python3
"""The banking test server on its own Azure network, so peer banks reach the FinTerminal's port 8443.

Requested by the bank owner: "Yes prepare port 8443 for azure", "we must be operative and live interacting".
Azure Container Apps opens a TCP port to the outside only in an environment with its own virtual network, and an
environment can't be given one later ("After you create an environment ... you can't change the network type").
So a new environment is made on a new network, with one fixed outgoing address (a NAT gateway), and the apps and
job of the test server move into it under their own names, with their settings and secrets. The databases and
the old environment stay as they are; the DNS of a custom domain is ChatGPT's (the bank owner: "ChatGPT does the
DNS").

  plan   reads the test server and says what apply would do; changes nothing.
  apply  makes the network and the environment, moves the apps one by one and opens port 8443 on the bank's app.
         If an app does not come up in the new environment, or the bank does not answer there, everything moved
         in that run is put back in the old environment as it was. It ends with the DNS records ChatGPT sets for
         each custom domain.
  bind   binds a custom domain to the bank's app in the new environment, with a certificate Azure manages, once its
         DNS points there.

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
# An app that pulls its images with an identity of its own gets a new one when it moves, without the old one's right
# to pull (the plan's finding): it pulls with the test server's own pull identity (deploy-uat.sh) where that one may
# pull from the registry, or else with the registry login the test server's other apps pull with (deploy-uat.sh's
# fallback), kept as a secret of its own.
PULL_IDENTITY = 'genesis-banking-uat-pull'
PULL_SECRET = 'uat-registry-pull'
# Azure's built-in roles that may pull from a registry: AcrPull, AcrPush, Contributor, Owner.
PULL_ROLES = frozenset({'7f951dda-4ed3-4680-a7ca-43fe172d538d', '8311e382-0749-4cb8-b61a-304f252e45ec',
                        'b24988ac-6180-42a0-ab88-20f7382dd24c', '8e3af657-a8ff-443c-a75c-2fe8c4bcb635'})
# The test server as deploy-uat.sh and deploy-sovereign.py know it. Anything else in its environment is not moved
# blind: the plan names it and apply stops.
APPS = ('genesis-iso-sandbox-uat', 'genesis-fineract-uat', 'genesis-mifos-uat', BANK)
JOBS = ('genesis-fineract-migrate',)
ARM = 'https://management.azure.com'
DATABASE_API, ROLES_API, REGISTRY_API, IDENTITY_API = '2022-12-01', '2022-04-01', '2023-07-01', '2023-01-31'
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


def own_identity(entry):
    return str((entry or {}).get('identity') or '').lower() == 'system'


def apex(hostname):
    """A domain's own name (example.com), not one of its subdomains: Azure reaches it by an A record to the
    environment's address and checks it over HTTP; a subdomain by a CNAME to the app (review finding)."""
    labels = hostname.split('.')
    return len(labels) == 2 or (len(labels) == 3 and len(labels[-1]) == 2 and labels[-2] in ('ac', 'co', 'com', 'edu', 'gov', 'net', 'org'))


def database_servers(text):
    """The Azure PostgreSQL servers a setting names (only their names are ever kept or shown)."""
    return set(re.findall(r'([a-z0-9][a-z0-9-]{1,62})\.postgres\.database\.azure\.com', str(text or '').lower()))


def body_for(resource, secrets, environment_id, profile, port=None, access=None):
    """The resource as Azure takes it back: in the given environment, with its secrets, without what Azure only
    reports. A custom domain's certificate belongs to its environment, so the domain is left out and bound again;
    the traffic goes to the latest revision, as the old revisions go with the old app. With access (by registry
    address), a registry the resource pulled from with its own identity is pulled from with the pull identity or
    the registry login given there."""
    properties = {key: value for key, value in properties_of(resource).items() if key not in READ_ONLY}
    # The first revision gets a name of its own: the old app's revision names may still be taken.
    if properties.get('template'):
        properties['template'] = {key: value for key, value in properties['template'].items() if key != 'revisionSuffix'}
    configuration = dict(properties.get('configuration') or {})
    configuration['secrets'] = [{key: item[key] for key in ('name', 'keyVaultUrl', 'identity') if item.get(key)}
                                if item.get('keyVaultUrl') else {'name': item['name'], 'value': item.get('value') or ''}
                                for item in secrets]
    pull = None
    if access and configuration.get('registries'):
        registries = []
        for entry in configuration['registries']:
            way = access.get(str(entry.get('server', '')).lower()) if own_identity(entry) else None
            if way and way.get('identity'):
                registries.append(dict(entry, identity=way['identity']))
                pull = way['identity']
            elif way:
                registries.append(dict({key: value for key, value in entry.items() if key != 'identity'},
                                       username=way['username'], passwordSecretRef=PULL_SECRET))
                configuration['secrets'] = [item for item in configuration['secrets'] if item['name'] != PULL_SECRET] \
                    + [{'name': PULL_SECRET, 'value': way['value']}]
            else:
                registries.append(entry)
        configuration['registries'] = registries
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
    kinds = [kind.strip() for kind in str(identity.get('type') or '').split(',') if kind.strip() and kind.strip().lower() != 'none']
    users = list(identity.get('userAssignedIdentities') or {})
    if pull:
        users += [] if any(user.lower() == pull.lower() for user in users) else [pull]
        kinds += [] if 'UserAssigned' in kinds else ['UserAssigned']
    if kinds:
        body['identity'] = {'type': ','.join(kinds)}
        if users:
            body['identity']['userAssignedIdentities'] = {key: {} for key in users}
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

    def roles(self, principal):
        """The roles an identity holds, as (role, scope) - or None when they can't be read."""
        try:
            found = arm('get', '/subscriptions/' + self.subscription + '/providers/Microsoft.Authorization/roleAssignments'
                        '?$filter=principalId%20eq%20%27' + principal + '%27', ROLES_API).get('value') or []
        except AzureError:
            return None
        return [(str(item['properties'].get('roleDefinitionId', '')).rsplit('/', 1)[-1].lower(),
                 str(item['properties'].get('scope', '')).lower().rstrip('/')) for item in found]

    def registries(self):
        """The resource group's registries by their address."""
        return {str(properties_of(item).get('loginServer', '')).lower(): item['id'].lower()
                for item in listing(self.group + '/providers/Microsoft.ContainerRegistry/registries', REGISTRY_API)}

    def pull_identity(self, registries):
        """The test server's pull identity and the registries it may pull from; None when it does not exist."""
        try:
            identity = arm('get', self.group + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/' + PULL_IDENTITY, IDENTITY_API)
        except AzureError as error:
            if missing(error):
                return None
            raise
        roles = self.roles(properties_of(identity).get('principalId', '')) or []
        may = {registry for registry in registries.values()
               if any(role in PULL_ROLES and (registry == scope or registry.startswith(scope + '/')) for role, scope in roles)}
        return {'id': identity['id'], 'registries': may}

    def rights(self, resource, registries):
        """What the app's own Azure identity is used for, apart from pulling its images (that moves to the pull
        identity): secrets read with it, roles it holds anywhere but on a registry."""
        identity = resource.get('identity') or {}
        if 'systemassigned' not in str(identity.get('type') or '').lower().replace(',', '').replace(' ', ''):
            return []
        uses = [item['name'] for item in configuration_of(resource).get('secrets') or [] if own_identity(item)]
        if identity.get('principalId'):
            roles = self.roles(identity['principalId'])
            if roles is None:
                return uses + ['its rights could not be read']
            uses += ['role at ' + scope.rsplit('/', 1)[-1] for _, scope in roles if scope not in registries.values()]
        return uses

    def databases(self):
        """The resource group's database servers, each with whether it lets Azure's own addresses in."""
        found = {}
        for server in listing(self.group + '/providers/Microsoft.DBforPostgreSQL/flexibleServers', DATABASE_API):
            rules = listing(server['id'] + '/firewallRules', DATABASE_API)
            found[server['name'].lower()] = any(properties_of(rule).get('startIpAddress') == '0.0.0.0'
                                                and properties_of(rule).get('endIpAddress') == '0.0.0.0' for rule in rules)
        return found

    def used_databases(self, kind, resource):
        """The database servers an app's settings name; apply also reads its secrets for them (names only)."""
        servers = set()
        for container in (properties_of(resource).get('template') or {}).get('containers') or []:
            for item in container.get('env') or []:
                servers |= database_servers(item.get('value'))
        if self.mode == 'apply':
            for item in (arm('post', self.path(kind, resource['name']) + '/listSecrets', self.version(kind), {}) or {}).get('value') or []:
                servers |= database_servers(item.get('value'))
        return servers

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
        problems, pulls, uses = [], {}, {}
        if (properties_of(old).get('vnetConfiguration') or {}).get('infrastructureSubnetId'):
            problems.append('The test server environment has its own network already: the port can be opened there.')
        strangers = sorted(kind + ' ' + item['name'] for kind, item in here + moved if (kind, item['name']) not in known)
        if strangers:
            problems.append('Not known as part of the test server, so not moved blind: ' + ', '.join(strangers) + '.')
        if BANK not in {item['name'] for kind, item in here + moved if kind == 'app'}:
            problems.append('The bank app ' + BANK + ' is not in the test server environment.')
        registries = self.registries()
        pull = self.pull_identity(registries)
        # The registry logins the test server's other apps pull with, by registry address.
        logins = {}
        for kind, item in here:
            for entry in configuration_of(item).get('registries') or []:
                if entry.get('username') and entry.get('passwordSecretRef') and not own_identity(entry):
                    logins.setdefault(str(entry.get('server', '')).lower(),
                                      {'username': entry['username'], 'secret': entry['passwordSecretRef'], 'kind': kind, 'name': item['name']})
        for kind, item in here:
            profile = properties_of(item).get('workloadProfileName')
            if profile not in (None, PROFILE):
                problems.append(item['name'] + ' runs on workload profile ' + str(profile) + ', which the new environment does not have.')
            for volume in (properties_of(item).get('template') or {}).get('volumes') or []:
                if volume.get('storageName'):
                    problems.append(item['name'] + ' uses the environment storage ' + str(volume['storageName']) + ', which is not carried over.')
            # An app that pulls its images with its own identity pulls them with the pull identity, or else with the
            # registry login of the test server's other apps (the plan's finding: a moved app's new identity could
            # not pull, nor could one put back).
            for entry in configuration_of(item).get('registries') or []:
                if not own_identity(entry):
                    continue
                server = str(entry.get('server', '')).lower()
                if pull and registries.get(server) in pull['registries']:
                    pulls.setdefault((kind, item['name']), {})[server] = {'identity': pull['id']}
                elif server in logins:
                    pulls.setdefault((kind, item['name']), {})[server] = dict(logins[server])
                else:
                    problems.append(item['name'] + ' pulls its images from ' + str(entry.get('server')) + ' with its own identity, and neither '
                                    + PULL_IDENTITY + ' nor a registry login of the test server may pull from there in its place.')
            rights = self.rights(item, registries)
            if rights:
                problems.append(item['name'] + ' has its own Azure identity in use (' + ', '.join(rights)
                                + '); a moved app gets a new identity without those rights.')
            if item['name'] == BANK and not ingress_of(item).get('external'):
                problems.append('The bank app is not reachable from outside, so its port ' + str(FIN_PORT) + ' can not be either.')
            for server in self.used_databases(kind, item):
                uses.setdefault(server, []).append(item['name'])
        components = listing(self.environments + OLD_ENV + '/daprComponents', self.api['managedEnvironments'])
        if components:
            problems.append('The environment has ' + str(len(components)) + ' Dapr component(s), which are not carried over.')
        if new and not (properties_of(new).get('vnetConfiguration') or {}).get('infrastructureSubnetId'):
            problems.append('An environment ' + NEW_ENV + ' exists already, without its own network.')
        # Only a database the apps use must let the new outgoing address in (review of the plan).
        databases = self.databases()
        for server in sorted(uses):
            if server in databases and not databases[server]:
                problems.append('The database ' + server + ' (used by ' + ', '.join(uses[server])
                                + ') does not let Azure services in: the new outgoing address must be allowed first.')
        # The job first (nothing runs then), the bank's own app last: what it calls is in place when it comes up.
        order = sorted(here, key=lambda pair: (pair[0] != 'job', pair[1]['name'] == BANK, bool(ingress_of(pair[1]).get('external')), pair[1]['name']))
        absent = [name for name in JOBS + APPS if name not in {item['name'] for _, item in here + moved}]
        return {'old': old, 'new': new, 'here': order, 'moved': moved, 'problems': problems, 'databases': databases,
                'uses': uses, 'pulls': pulls, 'absent': absent}

    def plan(self, state):
        old = properties_of(state['old'])
        self.say('Test server environment ' + OLD_ENV + ': ' + ('own network' if (old.get('vnetConfiguration') or {}).get('infrastructureSubnetId')
                 else "Azure's default network, where no TCP port opens to the outside") + '; addresses *.' + str(old.get('defaultDomain')))
        self.say('New environment ' + NEW_ENV + ' (' + ('exists' if state['new'] else 'to be made') + '): network ' + VNET + ' ' + VNET_PREFIX
                 + ', subnet ' + SUBNET_PREFIX + ', one fixed outgoing address (NAT gateway ' + NAT + ')')
        for kind, item in state['here']:
            self.say('Moves: ' + describe(kind, item) + ('; opens port ' + str(FIN_PORT) + ' to the outside' if item['name'] == BANK else ''))
            for server, way in sorted(state['pulls'].get((kind, item['name']), {}).items()):
                self.say(item['name'] + ' pulls from ' + server + ' with ' + (PULL_IDENTITY if way.get('identity')
                         else 'the registry login ' + way['name'] + ' pulls with') + ' instead of its own identity.')
            for domain in ingress_of(item).get('customDomains') or []:
                self.say('Custom domain ' + str(domain.get('name')) + ' on ' + item['name'] + ': after the move ChatGPT points its DNS to the new'
                         ' address apply gives, then it is bound again (bind).')
        for kind, item in state['moved']:
            self.say('Moved already: ' + kind + ' ' + item['name'])
        for name in state['absent']:
            self.say('Not found: ' + name)
        for server, azure in sorted(state['databases'].items()):
            users = state['uses'].get(server)
            self.say('Database ' + server + ': stays as it is; ' + ('used by ' + ', '.join(users) if users else "not used by the test server's apps")
                     + (' and lets Azure services in.' if azure else '.'))
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

    def carry(self, kind, resource, environment, done, access=None):
        """One app or job into the new environment under its own name. Its body for there - and the one to put it
        back with, kept in done - is made before anything is deleted. Both pull as access says where the app
        pulled with its own identity: the old identity goes with the old app."""
        name, path, version = resource['name'], self.path(kind, resource['name']), self.version(kind)
        secrets = (arm('post', path + '/listSecrets', version, {}) or {}).get('value') or []
        target = body_for(resource, secrets, environment['id'], PROFILE, FIN_PORT if kind == 'app' and name == BANK else None, access)
        back = body_for(resource, secrets, properties_of(resource).get('environmentId') or properties_of(resource).get('managedEnvironmentId'),
                        properties_of(resource).get('workloadProfileName'), None, access)
        done.append((kind, name, back))
        az(*self.delete(kind, name))
        arm('put', path, version, target)
        moved = self.settled(path, version, self.running(kind))
        self.say('Moved: ' + kind + ' ' + name + (' at ' + str(ingress_of(moved).get('fqdn')) if ingress_of(moved).get('fqdn') else ''))
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

    def logins(self, state):
        """The password of each registry login an app pulls with in place of its own identity, read from the app
        that pulls with it now - before anything changes."""
        found = {}
        for ways in state['pulls'].values():
            for way in ways.values():
                if not way.get('secret'):
                    continue
                if (way['kind'], way['name']) not in found:
                    secrets = (arm('post', self.path(way['kind'], way['name']) + '/listSecrets', self.version(way['kind']), {}) or {}).get('value') or []
                    found[(way['kind'], way['name'])] = {item['name']: item.get('value') for item in secrets}
                way['value'] = found[(way['kind'], way['name'])].get(way['secret'])
                if not way['value']:
                    raise Refused('The registry login ' + way['name'] + ' pulls with has no password to carry over.')

    def apply(self, state):
        if state['problems']:
            raise Refused('Stopped before any change. ' + ' '.join(state['problems']))
        self.logins(state)
        environment, egress = self.network(state['old']['location'].lower().replace(' ', ''))
        properties = properties_of(environment)
        self.say('Environment ' + NEW_ENV + ' ready: addresses *.' + str(properties.get('defaultDomain'))
                 + ', incoming address ' + str(properties.get('staticIp')) + ', outgoing address ' + str(egress) + '.')
        bank = next((item for kind, item in state['moved'] if kind == 'app' and item['name'] == BANK), None)
        domains = {item['name']: [str(domain.get('name')) for domain in ingress_of(item).get('customDomains') or []] for _, item in state['here']}
        done, landed = [], {}
        try:
            for kind, item in state['here']:
                landed[item['name']] = moved = self.carry(kind, item, environment, done, state['pulls'].get((kind, item['name'])))
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
        # The bank owner: "ChatGPT does the DNS". What it sets for each custom domain, then bind.
        for name, hostnames in domains.items():
            for hostname in hostnames:
                app = bank if name == BANK else landed[name]
                record = ' A ' + str(properties.get('staticIp')) if apex(hostname) else ' CNAME ' + str(ingress_of(app).get('fqdn'))
                self.say('DNS for ChatGPT: ' + hostname + record + '; asuid.' + hostname + ' TXT '
                         + str(properties_of(app).get('customDomainVerificationId')) + '. Then: bind ' + hostname + '.')
        self.say('The old environment ' + OLD_ENV + ' stays, empty, until the owner says to delete it.')

    def bind(self, hostname):
        """A custom domain bound to the bank's app in the new environment, with a certificate Azure manages - once
        its DNS points to the app's new address (Azure checks it)."""
        if not re.fullmatch(r'(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', hostname or ''):
            raise Refused('Not a domain name: ' + str(hostname)[:80])
        app = arm('get', self.path('app', BANK), self.version('app'))
        new = self.environment(NEW_ENV)
        if not new or environment_of(app) != new['id'].lower():
            raise Refused('The bank app is not in the new environment yet: run apply first.')
        if hostname not in [str(domain.get('name')) for domain in ingress_of(app).get('customDomains') or []]:
            az('containerapp', 'hostname', 'add', '-g', RG, '-n', BANK, '--hostname', hostname)
        az('containerapp', 'hostname', 'bind', '-g', RG, '-n', BANK, '--hostname', hostname, '--environment', NEW_ENV,
           '--validation-method', 'HTTP' if apex(hostname) else 'CNAME')
        self.say('Bound: https://' + hostname + ' on ' + BANK + ', with a certificate Azure manages.')


def main(mode, hostname=''):
    if mode not in ('plan', 'apply', 'bind'):
        raise SystemExit('mode must be plan, apply or bind')
    move = Move(mode)
    try:
        if mode == 'bind':
            move.bind(hostname.strip().lower())
        else:
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
    main(sys.argv[1] if len(sys.argv) > 1 else 'plan', sys.argv[2] if len(sys.argv) > 2 else '')
