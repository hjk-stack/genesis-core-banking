"""Application-only release. Never creates/deletes infrastructure or resets a database."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import http.cookiejar
import hashlib
import json
import os
import re
import subprocess
import pty
import select
import fcntl
import struct
import termios
import time
import urllib.request
import urllib.error

RG = 'genesis-banking-rg'
APP = 'genesis-banking-uat'
IDENTITY_APP = 'genesis-fineract-uat'
CRYPTO_SOURCE_RG = 'genesis-email-automation-rg'
CRYPTO_SOURCE_APP = 'genesis-email-bd74cf8'
CRYPTO_NETWORKS = ('ETHEREUM', 'BSC', 'POLYGON', 'ARBITRUM', 'BASE', 'AVALANCHE',
                   'GNOSIS', 'TRON', 'XRPL', 'SOLANA', 'BITCOIN')
CRYPTO_PROVIDER_SETTINGS = {
    'COINAPI_EMS_API_KEY', 'COINAPI_NAAS_API_KEY', 'COINAPI_API_KEY', 'COINAPI_MARKET_DATA_API_KEY',
    'APIBRICKS_COINAPI_KEY', 'ALCHEMY_API_KEY', 'TRONGRID_API_KEY', 'COINGECKO_API_KEY',
} | {prefix + network for prefix in ('AVIS_RPC_', 'CRYPTO_RPC_') for network in CRYPTO_NETWORKS}
AZURE_ERROR_CODES = frozenset({
    'AuthorizationFailed', 'AuthorizationPermissionMismatch', 'Forbidden', 'Unauthorized',
    'AuthenticationFailed', 'InvalidAuthenticationToken', 'ExpiredAuthenticationToken',
    'InvalidAuthenticationTokenTenant', 'ResourceNotFound', 'ResourceGroupNotFound',
    'ParentResourceNotFound', 'SubscriptionNotFound', 'SubscriptionDisabled',
    'InvalidSubscriptionId', 'MissingSubscriptionRegistration', 'NoRegisteredProviderFound',
    'RequestDisallowedByPolicy', 'OperationNotAllowed', 'TooManyRequests',
    'ServiceUnavailable', 'InternalServerError', 'GatewayTimeout',
})


class AzureOperationError(RuntimeError):
    """Expose a known Azure error code without retaining credentials or raw stderr."""

    def __init__(self, args, stderr):
        candidates = re.findall(
            r'\(([A-Za-z][A-Za-z0-9]+)\)|"code"\s*:\s*"([A-Za-z][A-Za-z0-9]+)"'
            r'|^\s*Code:\s*([A-Za-z][A-Za-z0-9]+)\s*$', stderr or '', re.MULTILINE)
        self.azure_code = next((code for match in candidates for code in match
                                if code in AZURE_ERROR_CODES), 'AZURE_CLI_ERROR')
        operation = []
        for arg in args:
            if not re.fullmatch(r'[a-z][a-z0-9-]*', arg) or len(operation) == 4:
                break
            operation.append(arg)
        super().__init__('Azure operation failed: ' + ' '.join(operation or ['command'])
                         + '; code=' + self.azure_code)


def az(*args):
    result = subprocess.run(['az', *args, '--only-show-errors', '-o', 'json'], capture_output=True, text=True)
    if result.returncode:
        # Azure errors can echo secret command arguments. Do not print raw stderr or command lines.
        raise AzureOperationError(args, result.stderr)
    return json.loads(result.stdout) if result.stdout.strip() else None

def app(name):
    return az('containerapp', 'show', '-g', RG, '-n', name)

def secret(name, key):
    value = az('containerapp', 'secret', 'show', '-g', RG, '-n', name, '--secret-name', key).get('value')
    if not value:
        raise RuntimeError('Required existing application secret has no value')
    return value

def api(opener, base, path, body=None, csrf=None, idempotency_key=None):
    headers = {'Origin': base}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    if csrf:
        headers['X-CSRF-Token'] = csrf
    if idempotency_key:
        headers['Idempotency-Key'] = idempotency_key
    request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    with opener.open(request, timeout=30) as response:
        return json.load(response)

def verify_deployed_frontend(opener, base, sha):
    """Refuse a release whose served Crypto Suite differs from checked-out source."""
    from pathlib import Path
    portal = Path(__file__).resolve().parent.parent / 'portal'
    assets = {
        '/': 'index.html',
        '/app.mjs': 'public/app.mjs',
        '/crypto-workspace.mjs': 'public/crypto-workspace.mjs',
        '/trading-panel.mjs': 'public/trading-panel.mjs',
        '/trading-live.mjs': 'public/trading-live.mjs',
        '/index-advice.mjs': 'public/index-advice.mjs',
        '/crypto.css': 'public/crypto.css',
    }
    for route, relative in assets.items():
        request = urllib.request.Request(
            base + route + ('?' if '?' not in route else '&') + 'release=' + sha,
            headers={'Cache-Control': 'no-cache'})
        with opener.open(request, timeout=20) as response:
            data = response.read(2_000_000)
            if response.status != 200 or response.headers.get('x-avispay-release') != sha:
                raise RuntimeError('UAT frontend release identity mismatch: ' + route)
            if 'no-store' not in response.headers.get('cache-control', '').lower():
                raise RuntimeError('UAT frontend cache policy mismatch: ' + route)
        expected = (portal / relative).read_bytes()
        if hashlib.sha256(data).digest() != hashlib.sha256(expected).digest():
            raise RuntimeError('UAT frontend source checksum mismatch: ' + route)
    print('Verified served UAT frontend release and source checksums: ' +
          str(len(assets)) + ' files including Crypto Suite, trading and INDEX')


def verify_index_access(opener, base, csrf):
    """Read the private policy and verify workspace boundaries without trading."""
    policy = api(opener, base, '/api/crypto/trading/index-policy')
    expected = {prefix + str(i).zfill(2) for prefix, count in
                [('EQ', 18), ('CM', 6), ('CR', 10), ('MA', 4)] for i in range(1, count + 1)}
    instructions = policy.get('instructions')
    if (policy.get('schemaVersion') != 1
            or type(policy.get('policyVersion')) is not int or policy['policyVersion'] < 0
            or not isinstance(instructions, str) or not instructions.strip()
            or not re.fullmatch(r'[a-f0-9]{64}', policy.get('policyHash', ''))
            or hashlib.sha256(instructions.encode()).hexdigest() != policy['policyHash']
            or len(policy.get('taxonomy', [])) != 38
            or {row.get('id') for row in policy['taxonomy']} != expected):
        raise RuntimeError('Private INDEX instruction schema mismatch')
    delivery = api(opener, base, '/api/crypto/trading/index-delivery')
    if delivery.get('schemaVersion') != 1 or delivery.get('policyHash') != policy['policyHash']:
        raise RuntimeError('Private INDEX delivery diagnostics mismatch')
    accepted = delivery.get('lastAccepted')
    if accepted is not None and (accepted.get('authentication') not in ('ED25519_JWS', 'BEARER')
                                 or not re.fullmatch(r'[a-f0-9]{64}', accepted.get('batchId', ''))):
        raise RuntimeError('Private INDEX accepted delivery receipt mismatch')

    def denied(client, path, status):
        try:
            api(client, base, path)
        except urllib.error.HTTPError as error:
            if error.code == status:
                return
            raise RuntimeError('INDEX access boundary returned an unexpected status') from None
        raise RuntimeError('Private INDEX data crossed an access boundary')

    anonymous = urllib.request.build_opener()
    for path in ['/api/crypto/trading/index-policy', '/api/crypto/trading/index-delivery']:
        denied(anonymous, path, 401)
    try:
        api(opener, base, '/api/workspace', {'userId': '2'}, csrf)
        for path in ['/api/crypto/trading/index-policy', '/api/crypto/trading/index-delivery',
                     '/api/views/indexpolicies', '/api/views/indexcandidates']:
            denied(opener, path, 403)
    finally:
        api(opener, base, '/api/workspace', {'userId': None}, csrf)
    # Never log the instruction, candidate text, portfolio or service credentials.
    print('Verified private INDEX policy: 38 categories; version ' + str(policy['policyVersion'])
          + '; customer and anonymous access denied; accepted delivery=' + str(accepted is not None))

def verify_trading_tests(opener, base, csrf, release):
    """Run the isolated reference suite; never review a robot or enable real trading."""
    state = api(opener, base, '/api/crypto/trading/testing')
    engine = state.get('engine', {})
    if (engine.get('name') != 'NautilusTrader' or engine.get('version') != '1.231.0'
            or not re.fullmatch(r'[a-f0-9]{64}', engine.get('fingerprint', ''))
            or not isinstance(state.get('profiles'), list)
            or not isinstance(state.get('runs'), list)):
        raise RuntimeError('Trading test installation metadata mismatch')
    submitted = api(opener, base, '/api/crypto/trading/tests',
                    {'mode': 'ACCEPTANCE', 'initialCash': '10000', 'feeBps': 10, 'slippageBps': 5},
                    csrf, 'release-trading-acceptance:' + release)
    run_id = submitted.get('runId')
    if not isinstance(run_id, str) or not re.fullmatch(r'[0-9a-f-]{36}', run_id):
        raise RuntimeError('Trading acceptance run was not recorded')
    for attempt in range(40):
        state = api(opener, base, '/api/crypto/trading/testing')
        run = next((item for item in state.get('runs', []) if item.get('runId') == run_id), None)
        if run and run.get('status') in ('PASSED', 'FAILED'):
            break
        time.sleep(2)
    else:
        raise RuntimeError('Trading acceptance run did not finish')
    report = run.get('report') or {}
    checks = report.get('checks') or []
    if (run.get('status') != 'PASSED' or run.get('mode') != 'ACCEPTANCE'
            or run.get('robotId') is not None or run.get('reviewEligible') is not False
            or run.get('reviewedAt') is not None
            or run.get('engineFingerprint') != engine['fingerprint']
            or report.get('engine') != 'NautilusTrader' or report.get('engineVersion') != '1.231.0'
            or report.get('complete') is not True or report.get('status') != 'PASSED'
            or len(checks) < 5 or any(item.get('passed') is not True for item in checks)):
        raise RuntimeError('Isolated trading acceptance checks did not pass')
    print('Verified isolated trading acceptance: NautilusTrader 1.231.0; '
          + str(len(checks)) + ' checks passed; no live trading approval')

def verify_live_trading(opener, base):
    """Read the mounted live feed, instructions and security registration; never trade or review."""
    path = '/api/crypto/trading/live'
    state = api(opener, base, path)
    profiles = state.get('profiles')
    if state.get('schemaVersion') != 1 or not isinstance(profiles, list):
        raise RuntimeError('Live trading installation metadata mismatch')
    selected = state.get('selectedRobotId')
    if selected is not None:
        if not re.fullmatch(r'[0-9a-f-]{36}', selected) or not any(p.get('robotId') == selected for p in profiles):
            raise RuntimeError('Live trading selected profile mismatch')
        path += '?robotId=' + selected
    elif profiles or state.get('audit') is not None or state.get('liquidity') is not None:
        raise RuntimeError('Live reference market created a trading profile')
    market = state.get('market') or {}
    provider = market.get('provider')
    if provider not in ('CoinAPI', 'Binance', 'AVIS'):
        raise RuntimeError('Live trading market source mismatch')
    if provider == 'AVIS':
        book = state.get('liquidity') or {}
        if book.get('kind') != 'AVIS_ORDER_BOOK' or not isinstance(book.get('bids'), list) or not isinstance(book.get('asks'), list):
            raise RuntimeError('Live AVIS order book was not read')
        source_proof = 'current reserved order book'
    else:
        if selected is None and market.get('reference') is not True:
            raise RuntimeError('Live reference market identity mismatch')
        for attempt in range(20):
            market = state.get('market') or {}
            quote = market.get('quote') or {}
            try:
                bid, ask = Decimal(str(quote.get('bid'))), Decimal(str(quote.get('ask')))
                fresh = (bid.is_finite() and ask.is_finite() and 0 < bid <= ask
                         and quote.get('stale') is False
                         and isinstance(quote.get('ageMs'), (int, float)) and 0 <= quote['ageMs'] <= 15000
                         and market.get('connection', {}).get('state') == 'OPEN')
            except Exception:
                fresh = False
            if fresh:
                break
            time.sleep(2)
            state = api(opener, base, path)
        else:
            raise RuntimeError('Live market stream did not deliver a current quote')
        if market.get('provider') != provider or state.get('selectedRobotId') != selected:
            raise RuntimeError('Live trading source changed during verification')
        source_proof = 'current timestamped quote'
    if selected:
        policy = api(opener, base, '/api/crypto/trading/robot-instructions?robotId=' + selected)
        try:
            rules = json.loads(policy.get('instructions', ''))
        except Exception:
            rules = None
        if (policy.get('robotId') != selected or not isinstance(policy.get('version'), int)
                or not re.fullmatch(r'[a-f0-9]{64}', policy.get('policyHash', ''))
                or not isinstance(rules, dict)
                or not {'maxNotional', 'dailyNotional', 'maxLoss', 'minimumIndex', 'trailingBps'}.issubset(rules)):
            raise RuntimeError('Trading instruction field was not mounted')
    cards = api(opener, base, '/api/views/cryptosecurities').get('rows')
    if not isinstance(cards, list):
        raise RuntimeError('Security registration audit was not read')
    real_cards = [c for c in cards if c.get('mode') == 'REAL']
    registered_contracts = sum(bool(c.get('contract_address') and c.get('hub_address')) for c in real_cards)
    # Counts and provider names only. Never print account values, instructions,
    # venue credentials or institution wallet/contract addresses into CI logs.
    print('Verified live trader: provider=' + provider + '; ' + source_proof
          + '; saved profiles=' + str(len(profiles)) + '; real security registrations=' + str(len(real_cards))
          + '; registered contract pairs=' + str(registered_contracts) + '; no trading activation')

def apply_authorized_opening(revision, container):
    """Run the fixed, idempotent UAT request inside the existing application."""
    replicas = az('containerapp', 'replica', 'list', '-g', RG, '-n', APP, '--revision', revision)
    if not replicas:
        raise RuntimeError('No running UAT replica for opening entries')
    args = ['az', 'containerapp', 'exec', '-g', RG, '-n', APP, '--revision', revision,
            '--replica', replicas[0]['name'], '--container', container,
            '--command', 'node /app/src/uat-opening.mjs', '--only-show-errors']
    # Azure CLI's console requires a terminal. No credential is placed in the
    # command or copied out of the container; output is limited to its receipt.
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
    process = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave,
                               env={**os.environ, 'TERM': 'xterm'}, start_new_session=True)
    os.close(slave)
    output = ''
    receipt = None
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            ready = select.select([master], [], [], 1)[0]
            if ready:
                try:
                    chunk = os.read(master, 8192)
                except OSError:
                    break
                if not chunk:
                    break
                output = (output + chunk.decode('utf-8', errors='replace'))[-65536:]
                match = re.search(r'AVIS_UAT_OPENING_OK (\{[^\r\n]+\})', output)
                if match:
                    receipt = json.loads(match.group(1))
                    break
            if not ready and process.poll() is not None:
                break
        if not receipt or receipt.get('creditedAccounts') != 7 or receipt.get('requestId') != 'uat-opening-2026-11-14-seven-accounts':
            code = re.search(r'AVIS_UAT_OPENING_FAILED ([A-Z0-9_]+)', output)
            raise RuntimeError('UAT opening entries not confirmed' + (': ' + code.group(1) if code else ''))
        if not re.fullmatch(r'[0-9a-f-]{36}', receipt.get('journalId', '')):
            raise RuntimeError('Invalid UAT opening receipt')
        print('Authorized UAT opening journal: ' + receipt['journalId'] + '; seven accounts credited once')
        return receipt
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        os.close(master)

def apply_treasury_opening(revision, container):
    """Post the four owner-authorised opening positions in the existing UAT container."""
    replicas = az('containerapp', 'replica', 'list', '-g', RG, '-n', APP, '--revision', revision)
    if not replicas:
        raise RuntimeError('No running UAT replica for Treasury opening')
    args = ['az', 'containerapp', 'exec', '-g', RG, '-n', APP, '--revision', revision,
            '--replica', replicas[0]['name'], '--container', container,
            '--command', 'node /app/src/treasury-opening.mjs', '--only-show-errors']
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
    process = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave,
                               env={**os.environ, 'TERM': 'xterm'}, start_new_session=True)
    os.close(slave)
    output = ''
    receipt = None
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            ready = select.select([master], [], [], 1)[0]
            if ready:
                try:
                    chunk = os.read(master, 8192)
                except OSError:
                    break
                if not chunk:
                    break
                output = (output + chunk.decode('utf-8', errors='replace'))[-65536:]
                match = re.search(r'AVISPAY_TREASURY_BOOKING_OK (\{[^\r\n]+\})', output)
                if match:
                    receipt = json.loads(match.group(1))
                    break
            if not ready and process.poll() is not None:
                break
        if not receipt or receipt.get('requestId') != 'avispay-treasury-registered-inventory-2026-11-16':
            code = re.search(r'AVISPAY_TREASURY_BOOKING_FAILED ([A-Z0-9_]+)', output)
            raise RuntimeError('Treasury opening posting failed' + (': ' + code.group(1) if code else ''))
        if receipt.get('booked') != 4:
            raise RuntimeError('Treasury opening count mismatch')
        print('Authorized Treasury opening recorded: four booking references')
        return receipt
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        os.close(master)

def existing_crypto_settings(current_env, known_secrets=()):
    """Reuse only named crypto connectors from the existing AVIS application.

    Values never leave Azure/GitHub's deployment process or appear in output.
    Existing UAT configuration always takes precedence.
    """
    missing = CRYPTO_PROVIDER_SETTINGS - {item['name'] for item in current_env}
    if not missing:
        return []
    result = []
    secret_names = {item['name'] for item in known_secrets}
    # A previous import may have created a secret before its env binding was
    # saved. Reuse that target secret; never overwrite it with a source value.
    for setting in sorted(missing):
        name = 'avispay-provider-' + setting.lower().replace('_', '-')
        if name in secret_names:
            result.append(setting + '=secretref:' + name)
    missing -= {binding.split('=', 1)[0] for binding in result}
    if result:
        print('Reused existing UAT crypto secret bindings: ' + str(len(result)))
    if not missing:
        return result
    # Deployment-scoped GitHub secrets provide an independent, least-privilege
    # route when the Azure OIDC identity cannot read the other resource group.
    # Existing UAT bindings always win; no values are committed to the repo.
    direct = {setting: os.environ['AVISPAY_PROVIDER_' + setting]
              for setting in sorted(missing)
              if os.environ.get('AVISPAY_PROVIDER_' + setting)
              and not os.environ['AVISPAY_PROVIDER_' + setting].startswith('@Microsoft.KeyVault(')}
    if direct:
        values = ['avispay-provider-' + setting.lower().replace('_', '-') + '=' + value
                  for setting, value in sorted(direct.items())]
        az('containerapp', 'secret', 'set', '-g', RG, '-n', APP, '--secrets', *values)
        result.extend(setting + '=secretref:avispay-provider-' + setting.lower().replace('_', '-')
                      for setting in sorted(direct))
        missing -= set(direct)
        print('Installed UAT provider connections from protected release secrets: ' + str(len(direct)))
    if not missing:
        return result
    try:
        settings = az('webapp', 'config', 'appsettings', 'list', '-g',
                      CRYPTO_SOURCE_RG, '-n', CRYPTO_SOURCE_APP)
    except RuntimeError as error:
        print('Crypto provider source read failed: ' + getattr(error, 'azure_code', 'AZURE_CLI_ERROR')
              + '; source=' + CRYPTO_SOURCE_RG + '/' + CRYPTO_SOURCE_APP
              + '; existing UAT configuration preserved')
        return result
    if not isinstance(settings, list):
        print('Crypto provider source response: INVALID_SETTINGS_LIST; existing UAT configuration preserved')
        return result
    additions = {}
    for item in settings:
        if not isinstance(item, dict) or item.get('name') not in missing:
            continue
        value = item.get('value')
        if not isinstance(value, str) or not value:
            continue
        # Key Vault references require their own configured identity; never store a reference as an API key.
        if value.startswith('@Microsoft.KeyVault('):
            print('Crypto provider source uses Key Vault reference: ' + item['name'])
            continue
        additions[item['name']] = value
    if additions:
        values = ['avispay-provider-' + setting.lower().replace('_', '-') + '=' + value
                  for setting, value in sorted(additions.items())]
        az('containerapp', 'secret', 'set', '-g', RG, '-n', APP,
           '--secrets', *values)
        result.extend(setting + '=secretref:avispay-provider-' + setting.lower().replace('_', '-')
                      for setting in sorted(additions))
    print('Reused existing AVIS crypto connector settings: ' + str(len(additions)))
    return result


def main():
    sha = os.environ['GITHUB_SHA']
    image = os.environ['AVISPAY_IMAGE']
    if not re.fullmatch(r'[0-9a-f]{40}', sha) or not image.endswith('/avispay-sovereign:' + sha):
        raise RuntimeError('Release image and source SHA must match')
    before = app(APP)
    identity = app(IDENTITY_APP)
    containers = before['properties']['template']['containers']
    if len(containers) != 1:
        raise RuntimeError('Expected exactly one application container')
    if before['properties']['managedEnvironmentId'] != identity['properties']['managedEnvironmentId']:
        raise RuntimeError('Existing applications are in different environments')
    if image.split('/')[0] != containers[0]['image'].split('/')[0]:
        raise RuntimeError('Image must use the existing registry')
    source = {item['name']: item for item in identity['properties']['template']['containers'][0]['env']}
    pg_host = source['FINERACT_DEFAULT_TENANTDB_HOSTNAME']['value']
    pg_user = source['FINERACT_DEFAULT_TENANTDB_UID']['value']
    database = source['FINERACT_DEFAULT_TENANTDB_NAME']['value']
    if database != 'fineract_default':
        raise RuntimeError('Unexpected existing UAT database')
    password_ref = source['FINERACT_DEFAULT_TENANTDB_PWD']['secretRef']
    password = secret(IDENTITY_APP, password_ref)
    port = before['properties']['configuration']['ingress']['targetPort']
    az('containerapp', 'secret', 'set', '-g', RG, '-n', APP, '--secrets', 'avispay-db-password=' + password)
    del password
    known_secrets = az('containerapp', 'secret', 'list', '-g', RG, '-n', APP)
    if not any(item['name'] == 'avispay-offline-key' for item in known_secrets):
        generated = subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519'], capture_output=True, text=True, check=True)
        az('containerapp', 'secret', 'set', '-g', RG, '-n', APP, '--secrets', 'avispay-offline-key=' + generated.stdout)
        del generated
    env = [f'PGHOST={pg_host}', 'PGPORT=5432', f'PGUSER={pg_user}', f'PGDATABASE={database}',
           'PGPASSWORD=secretref:avispay-db-password', 'FINERACT_URL=http://genesis-fineract-uat',
           'AVIS_OFFLINE_SIGNING_KEY=secretref:avispay-offline-key', f'PORT={port}', f'RELEASE_SHA={sha}']
    env += existing_crypto_settings(containers[0].get('env', []), known_secrets)
    stage = 'application update'
    try:
        az('containerapp', 'update', '-g', RG, '-n', APP, '--image', image,
           '--container-name', containers[0]['name'], '--set-env-vars', *env,
           '--revision-suffix', 'bank-' + sha[:12])
        after = app(APP)
        stage = 'configuration preservation'
        for field in ['managedEnvironmentId', 'workloadProfileName']:
            if before['properties'].get(field) != after['properties'].get(field):
                raise RuntimeError('Deployment changed an environment property')
        for field in ['ingress', 'registries', 'activeRevisionsMode']:
            if before['properties']['configuration'].get(field) != after['properties']['configuration'].get(field):
                raise RuntimeError('Deployment changed an unrelated application setting')
        if before['identity'] != after['identity'] or containers[0]['resources'] != after['properties']['template']['containers'][0]['resources']:
            raise RuntimeError('Deployment changed identity or resource allocation')
        base = 'https://' + after['properties']['configuration']['ingress']['fqdn']
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        stage = 'application readiness'
        for attempt in range(60):
            try:
                health = api(opener, base, '/readyz')
                if health.get('release') == sha and health.get('status') == 'ready':
                    break
            except Exception:
                pass
            time.sleep(5)
        else:
            raise RuntimeError('New application did not become ready')
        stage = 'live frontend asset integrity and cache verification'
        verify_deployed_frontend(opener, base, sha)
        # Existing administrator sign-in; read records only. Never create or fund test customers here.
        stage = 'administrator authentication'
        login = api(opener, base, '/api/login', {'username': 'mifos', 'password': secret('genesis-mifos-uat', 'admin-password')})
        for view in ['accounts', 'accountsummaries', 'customers', 'issuer', 'ledger', 'backofficeaccounts', 'portfolio', 'cryptocatalogue', 'cryptomarkets', 'cryptosecurities', 'cryptowallets', 'cryptonetworks', 'cryptorobots', 'cryptoactions', 'tradingrobots', 'robotorders', 'tradingengine', 'securities', 'securitypositions', 'securityorders', 'exchangebook', 'cardaccounts', 'cryptoholdings', 'cryptooffers', 'transfercards', 'externalcards', 'codedcards', 'transferalerts', 'paymentregister', 'transferrequests', 'bankpayments', 'bankroutes', 'clearing', 'offlinegrants', 'fxrates', 'fxquotes', 'audit']:
            stage = 'authenticated read ' + view
            result = api(opener, base, '/api/views/' + view)
            if not isinstance(result.get('rows'), list):
                raise RuntimeError('Authenticated banking read failed')
        stage = 'ABIQ issuer and account verification'
        catalogue = api(opener, base, '/api/views/cryptocatalogue')['rows']
        securities = api(opener, base, '/api/views/cryptosecurities')['rows']
        if len(catalogue) < 200 or len(securities) != 10 or securities[0]['symbol'] != 'aAVISP':
            raise RuntimeError('Crypto catalogue or security scroller mismatch')
        engine = api(opener, base, '/api/views/tradingengine')['rows'][0]
        if not engine.get('ready') or engine.get('version') != '1.231.0':
            raise RuntimeError('Nautilus trading process did not start')
        print('Verified crypto catalogue, ten security wallets and running NautilusTrader 1.231.0')
        stage = 'isolated trading test installation verification'
        verify_trading_tests(opener, base, login['csrf'], sha)
        stage = 'live trading feed and instruction installation verification'
        verify_live_trading(opener, base)
        stage = 'private INDEX instruction and access verification'
        verify_index_access(opener, base, login['csrf'])
        providers = api(opener, base, '/api/crypto/trading/validate-providers', {}, login['csrf'])['providers']
        for provider in providers:
            print('Provider validation: ' + provider['provider'] + '; configured=' + str(provider['configured']) + '; verified=' + str(provider['verified']))
        issuer = api(opener, base, '/api/views/issuer')['rows']
        if not any(row['abiq_code'] == 'AVIPTN64XXX' and row['country_code'] == 'TN' for row in issuer):
            raise RuntimeError('ABIQ issuer mismatch')
        holders = {str(row['user_id']): row for row in api(opener, base, '/api/views/customers')['rows']}
        if holders.get('1', {}).get('full_name') != 'AVISPay PLC' or holders.get('1', {}).get('account_role') != 'INSTITUTION':
            raise RuntimeError('Corporate account identity mismatch')
        if holders.get('2', {}).get('full_name') != 'Frontend user':
            raise RuntimeError('Frontend account identity mismatch')
        accounts = api(opener, base, '/api/views/accounts')['rows']
        for uid in ['1', '2']:
            suite = [a for a in accounts if str(a['user_id']) == uid and a['participant_code'] == 'AVIP']
            if not {'EUR', 'USD', 'GBP'}.issubset(a['currency_code'] for a in suite):
                raise RuntimeError('ABIQ currency accounts missing')
            for account in suite:
                identifier = account['abiq_iban']
                if not re.fullmatch(r'TN[0-9]{2}AVIP000[0-9]{15}', identifier) or account['abiq_bic'] != 'AVIPTN64XXX':
                    raise RuntimeError('ABIQ account format mismatch')
                if identifier[-7:] != holders[uid]['customer_number'] or identifier[-12:] != account['account_number']:
                    raise RuntimeError('ABIQ customer number mismatch')
                expanded = ''.join(str(ord(c) - 55) if c.isalpha() else c for c in identifier[4:] + identifier[:4])
                if int(expanded) % 97 != 1:
                    raise RuntimeError('ABIQ checksum mismatch')
        print('Verified ABIQ issuer, corporate user 1, frontend user 2 and EUR/USD/GBP customer numbering and checksums')
        stage = 'ledger account details verification'
        ledger = api(opener, base, '/api/views/ledger')['rows']
        for uid in ['1', '2']:
            for currency in ['EUR', 'USD', 'GBP']:
                account = next(a for a in accounts if str(a['user_id']) == uid and a['currency_code'] == currency and a['participant_code'] == 'AVIP')
                scopes = [row for row in ledger if str(row['user_id']) == uid and row['currency_code'] == currency and row['sub_account_code'] == 'ABIQ:AVIP' and row['network'] is None]
                if {row['wallet_scope'] for row in scopes} != {'FUNDING', 'MARGIN', 'CUSTODY'} or len(scopes) != 3:
                    raise RuntimeError('Ledger account scopes mismatch')
                for row in scopes:
                    if row['account_reference'] != account['abiq_iban'] or row['owner_class'] != holders[uid]['account_role'] or row['account_holder'] != holders[uid]['full_name']:
                        raise RuntimeError('Ledger account details mismatch')
        print('Verified ABIQ references, institution/customer roles and all three ledger scopes')
        stage = 'published FX data verification'
        expected_fx = {'EUR', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'USD', 'SGD', 'JPY'}
        # Startup refresh is asynchronous. Read public price metadata only; never submit a conversion.
        for attempt in range(16):
            rates = api(opener, base, '/api/views/fxrates')['rows']
            by_currency = {row['currency_code']: row for row in rates}
            today = datetime.now(timezone.utc).date()
            if expected_fx.issubset(by_currency) and all(
                row['source'] == 'ECB reference rates'
                and Decimal(row['units_per_eur']).is_finite()
                and Decimal(row['units_per_eur']) > 0
                and today - timedelta(days=7) <= date.fromisoformat(row['source_date'][:10]) <= today
                for row in (by_currency[currency] for currency in expected_fx)
            ):
                break
            time.sleep(2)
        else:
            raise RuntimeError('Published FX data did not pass source, coverage and date verification')
        dates = sorted({row['source_date'][:10] for row in rates})
        print('Verified ECB reference data: ' + str(len(rates)) + ' currencies; publication ' + ', '.join(dates))
        stage = 'authorized UAT opening balances'
        receipt = apply_authorized_opening(APP + '--bank-' + sha[:12], containers[0]['name'])
        # Verify the immutable posting rather than replenishing balances on
        # future deployments after users have spent or transferred their funds.
        entries = api(opener, base, '/api/views/transactions')['rows']
        opening = [row for row in entries if row['journal_id'] == receipt['journalId']]
        if len(opening) == 11:
            for currency in ['EUR', 'USD', 'GBP', 'CHF']:
                group = [row for row in opening if row['currency_code'] == currency]
                debit = sum(Decimal(row['amount']) for row in group if row['direction'] == 'DEBIT')
                credit = sum(Decimal(row['amount']) for row in group if row['direction'] == 'CREDIT')
                expected_opening = Decimal('1000') if currency == 'CHF' else Decimal('2000')
                if debit != expected_opening or credit != expected_opening:
                    raise RuntimeError('Opening journal currency totals mismatch')
        print('Verified the authorized UAT opening request; existing balances are never reset on replay')
        stage = 'authorized Treasury opening positions'
        treasury = apply_treasury_opening(APP + '--bank-' + sha[:12], containers[0]['name'])
        booked = api(opener, base, '/api/views/treasurypositions')['rows']
        expected = {'USU3712QAA05': Decimal('500000'),
                    'AVISPAY-PLC-SHARES': Decimal('100000000'),
                    'AG': Decimal('10000000000'),
                    'AGi': Decimal('10000000000')}
        for asset, quantity in expected.items():
            matching = [row for row in booked if row['asset_code'] == asset
                        and Decimal(row['quantity']) == quantity
                        and str(row.get('owner_user_id')) == '1']
            if len(matching) != 1:
                raise RuntimeError('Treasury opening position readback mismatch: ' + asset)
            if asset in ('AG', 'AGi') and not matching[0].get('journal_id'):
                raise RuntimeError('Treasury crypto journal readback mismatch: ' + asset)
        print('Verified four authorised AVISPay Treasury opening-position records')

        api(opener, base, '/api/logout', {}, login['csrf'])
        print('Verified application release ' + sha)
        print('Authenticated account, ledger, payment, routing, clearing, offline, FX and audit reads passed')
        print('Existing application URL: ' + base)
        with open(os.environ.get('GITHUB_STEP_SUMMARY', os.devnull), 'a') as summary:
            summary.write(f'AVISPay application release `{sha}` verified on [{APP}]({base}).\n\n')
            summary.write('Existing resources preserved. Authenticated reads passed. The authorized UAT opening request is recorded once; no external payment was submitted.\n')
    except Exception as error:
        print('Release verification stage: ' + stage)
        print('Error type: ' + type(error).__name__ + '; HTTP status: ' + str(getattr(error, 'code', 'n/a')))
        if isinstance(error, RuntimeError):
            print(str(error))  # Only this module's fixed, credential-free diagnostics.
        # Additive migrations remain; restoring the old image never rolls back financial data.
        az('containerapp', 'update', '-g', RG, '-n', APP, '--image', containers[0]['image'])
        raise RuntimeError('Release verification failed; previous application image restored') from None

if __name__ == '__main__':
    main()
