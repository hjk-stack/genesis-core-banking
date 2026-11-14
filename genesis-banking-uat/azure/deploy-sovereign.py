"""Application-only release. Never creates/deletes infrastructure or resets a database."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import http.cookiejar
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

RG = 'genesis-banking-rg'
APP = 'genesis-banking-uat'
IDENTITY_APP = 'genesis-fineract-uat'

def az(*args):
    result = subprocess.run(['az', *args, '--only-show-errors', '-o', 'json'], capture_output=True, text=True)
    if result.returncode:
        # Azure errors can echo secret command arguments. Do not print raw stderr or command lines.
        raise RuntimeError('Azure operation failed: ' + ' '.join(args[:3]))
    return json.loads(result.stdout) if result.stdout.strip() else None

def app(name):
    return az('containerapp', 'show', '-g', RG, '-n', name)

def secret(name, key):
    value = az('containerapp', 'secret', 'show', '-g', RG, '-n', name, '--secret-name', key).get('value')
    if not value:
        raise RuntimeError('Required existing application secret has no value')
    return value

def api(opener, base, path, body=None, csrf=None):
    headers = {'Origin': base}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    if csrf:
        headers['X-CSRF-Token'] = csrf
    request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    with opener.open(request, timeout=30) as response:
        return json.load(response)

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
        if not receipt or receipt.get('creditedAccounts') != 6 or receipt.get('requestId') != 'uat-opening-2026-11-14-six-accounts':
            code = re.search(r'AVIS_UAT_OPENING_FAILED ([A-Z0-9_]+)', output)
            raise RuntimeError('UAT opening entries not confirmed' + (': ' + code.group(1) if code else ''))
        if not re.fullmatch(r'[0-9a-f-]{36}', receipt.get('journalId', '')):
            raise RuntimeError('Invalid UAT opening receipt')
        print('Authorized UAT opening journal: ' + receipt['journalId'] + '; six accounts credited once')
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
        # Existing administrator sign-in; read records only. Never create or fund test customers here.
        stage = 'administrator authentication'
        login = api(opener, base, '/api/login', {'username': 'mifos', 'password': secret('genesis-mifos-uat', 'admin-password')})
        for view in ['accounts', 'customers', 'issuer', 'ledger', 'paymentregister', 'transferrequests', 'bankpayments', 'bankroutes', 'clearing', 'offlinegrants', 'fxrates', 'fxquotes', 'audit']:
            stage = 'authenticated read ' + view
            result = api(opener, base, '/api/views/' + view)
            if not isinstance(result.get('rows'), list):
                raise RuntimeError('Authenticated banking read failed')
        stage = 'ABIQ issuer and account verification'
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
        if len(opening) == 9:
            for currency in ['EUR', 'USD', 'GBP']:
                group = [row for row in opening if row['currency_code'] == currency]
                debit = sum(Decimal(row['amount']) for row in group if row['direction'] == 'DEBIT')
                credit = sum(Decimal(row['amount']) for row in group if row['direction'] == 'CREDIT')
                if debit != Decimal('2000') or credit != Decimal('2000'):
                    raise RuntimeError('Opening journal currency totals mismatch')
        print('Verified the authorized UAT opening request; existing balances are never reset on replay')
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
