"""Create the requested institution Ethereum wallet through the existing UAT API."""
import http.cookiejar
import importlib.util
import json
from pathlib import Path
import re
import urllib.request

spec = importlib.util.spec_from_file_location('bank_deployment', Path(__file__).with_name('deploy-sovereign.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


def initialize(request):
    holders = request('/api/views/customers')['rows']
    institution = [u for u in holders if str(u['user_id']) == '1' and u['full_name'] == 'AVISPay PLC' and u['account_role'] == 'INSTITUTION']
    if len(institution) != 1:
        raise RuntimeError('Treasury holder does not match AVISPay PLC')
    chain = request('/api/crypto/check-network', {'network': 'ETHEREUM'})
    if chain.get('chainId') != 1:
        raise RuntimeError('Ethereum mainnet validation did not match')
    catalogue = request('/api/views/cryptocatalogue')['rows']
    wallets = []
    for asset_id, code in [('avis-green', 'AG'), ('avis-green-investment', 'AGi')]:
        asset = next((a for a in catalogue if a['asset_id'] == asset_id and a['currency_code'] == code), None)
        mapping = next((n for n in asset['networks'] if n['network'] == 'ETHEREUM'), None) if asset else None
        if not mapping:
            raise RuntimeError('Treasury asset mapping missing: ' + code)
        if not mapping['approved']:
            request('/api/crypto/approve', {'assetId': asset_id, 'network': 'ETHEREUM', 'approved': True}, 'initial-treasury-approve-' + asset_id)
        wallet = request('/api/crypto/activate', {'userId': '1', 'assetId': asset_id, 'network': 'ETHEREUM'}, 'initial-treasury-wallet-' + asset_id)
        qr = request('/api/crypto/wallet', {'addressId': wallet['addressId']})
        if not re.fullmatch(r'0x[0-9a-fA-F]{40}', wallet['address']) or qr.get('public_address') != wallet['address'] or not qr.get('qr', '').startswith('data:image/png;base64,'):
            raise RuntimeError('Treasury receiving address or QR verification failed')
        observation = request('/api/crypto/balance', {'addressId': wallet['addressId'], 'assetId': asset_id})
        if 'balance' not in observation or 'observedAt' not in observation:
            raise RuntimeError('Treasury blockchain observation did not complete')
        wallets.append(wallet)
    if wallets[0]['addressId'] != wallets[1]['addressId'] or wallets[0]['address'] != wallets[1]['address']:
        raise RuntimeError('AG and AGi did not reuse one Ethereum address')
    # A permanent idempotency receipt must never conceal a later administrator disable.
    accepted = request('/api/views/cryptocatalogue')['rows']
    for asset_id in ['avis-green', 'avis-green-investment']:
        current = next((a for a in accepted if a['asset_id'] == asset_id), None)
        if not current or not any(n['network'] == 'ETHEREUM' and n.get('approved') and n.get('verifiedAt') for n in current['networks']):
            raise RuntimeError('Treasury mapping remains disabled or unverified: ' + asset_id)
    cards = request('/api/views/cryptosecurities')['rows']
    first = next((c for c in cards if c['symbol'] == 'aAVISP'), None)
    if first and first['mode'] == 'DEMO' and first['state'] != 'CONVERTED':
        request('/api/crypto/securities/demo-convert', {'cardId': first['card_id']}, 'initial-avispay-demo-conversion')
    return {'userId': '1', 'network': 'ETHEREUM', 'address': wallets[0]['address'], 'assets': ['AG', 'AGi'], 'qrVerified': True, 'holdingsObserved': 2, 'approvedMappingsVerified': True}


def main():
    existing = deployment.app(deployment.APP)
    base = 'https://' + existing['properties']['configuration']['ingress']['fqdn']
    if base != 'https://genesis-banking-uat.orangemushroom-9faae382.italynorth.azurecontainerapps.io':
        raise RuntimeError('Unexpected banking application')
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    login = deployment.api(opener, base, '/api/login', {'username': 'mifos', 'password': deployment.secret('genesis-mifos-uat', 'admin-password')})
    def request(path, body=None, key=None):
        headers = {'Origin': base, 'X-CSRF-Token': login['csrf']}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if key:
            headers['Idempotency-Key'] = key
        req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        with opener.open(req, timeout=40) as response:
            return json.load(response)
    result = initialize(request)
    print('AVIS_CRYPTO_SETUP_OK ' + json.dumps(result))


if __name__ == '__main__':
    main()
