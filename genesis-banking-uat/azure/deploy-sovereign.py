"""Application-only release. Never creates/deletes infrastructure or resets a database."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import http.cookiejar
import json
import os
import re
import subprocess
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
        for view in ['accounts', 'ledger', 'bankpayments', 'bankroutes', 'clearing', 'offlinegrants', 'fxrates', 'fxquotes', 'audit']:
            stage = 'authenticated read ' + view
            result = api(opener, base, '/api/views/' + view)
            if not isinstance(result.get('rows'), list):
                raise RuntimeError('Authenticated banking read failed')
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
        api(opener, base, '/api/logout', {}, login['csrf'])
        print('Verified application release ' + sha)
        print('Authenticated account, ledger, payment, routing, clearing, offline, FX and audit reads passed')
        print('Existing application URL: ' + base)
        with open(os.environ.get('GITHUB_STEP_SUMMARY', os.devnull), 'a') as summary:
            summary.write(f'AVISPay application release `{sha}` verified on [{APP}]({base}).\n\n')
            summary.write('Existing resources preserved. Authenticated read verification passed. No financial transaction was submitted.\n')
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
