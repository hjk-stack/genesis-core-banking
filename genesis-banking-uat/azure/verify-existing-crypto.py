"""Owner-requested AG/AGi activation on existing UAT accounts; no transfers or issuance."""
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
import http.cookiejar
import importlib.util
import json
import os
import re
import urllib.request

_spec = importlib.util.spec_from_file_location('avispay_release', Path(__file__).with_name('deploy-sovereign.py'))
release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release)

ASSETS = (
    ('AG', 'avis-green', '0x713d3a1785219aeb37e52260ff8f96660851842b'),
    ('AGi', 'avis-green-investment', '0x0482213c1e5a9fefdee36d9b01c044938403a9af'),
)


def verify_existing_wallets(request, sha):
    """Compare actual records before/after activation; never synthesize balances or keys."""
    health = request('/readyz')
    if health.get('status') != 'ready' or health.get('release') != sha:
        raise RuntimeError('CRYPTO_RELEASE_MISMATCH')
    customers = request('/api/views/customers')['rows']
    holders = [u for u in customers if u.get('full_name') == 'AVISPay PLC'
               and u.get('account_role') == 'INSTITUTION']
    if len(holders) != 1:
        raise RuntimeError('CRYPTO_TREASURY_OWNER_NOT_UNIQUE')
    uid = str(holders[0]['user_id'])
    before = request('/api/views/cryptowallets')['rows']
    portfolio = request('/api/views/portfolio')['rows']
    catalogue = request('/api/views/cryptocatalogue')['rows']
    securities = request('/api/views/cryptosecurities')['rows']
    if not any(s.get('symbol') == 'aAVISP' for s in securities) or len(securities) < 10:
        raise RuntimeError('CRYPTO_SECURITY_SCROLLER_INCOMPLETE')
    results = []
    for symbol, asset_id, contract in ASSETS:
        rows = [r for r in before if str(r.get('user_id')) == uid
                and r.get('currency_code') == symbol and r.get('network') == 'ETHEREUM'
                and r.get('wallet_scope') == 'FUNDING']
        funded = [r for r in rows if Decimal(r['available_balance']) != 0
                  or Decimal(r['locked_balance']) != 0]
        if len(funded) > 1:
            raise RuntimeError('CRYPTO_EXISTING_FUNDED_ACCOUNT_NOT_UNIQUE:' + symbol)
        # A fully spent position still has a receiving wallet. Use an existing
        # unambiguous route and retain the same account and address on activation.
        candidates = funded or (rows if len(rows) == 1 else [r for r in rows if r.get('wallet_visible') is True])
        if len(candidates) != 1:
            raise RuntimeError('CRYPTO_EXISTING_ACCOUNT_NOT_UNIQUE:' + symbol)
        original = candidates[0]
        historical = original.get('historical_wallet_address', '')
        if not re.fullmatch(r'0x[0-9a-fA-F]{40}', historical):
            raise RuntimeError('CRYPTO_HISTORICAL_RECORD_MISSING:' + symbol)
        if original.get('public_address', '').lower() != historical.lower():
            raise RuntimeError('CRYPTO_HISTORICAL_ROUTE_MISMATCH:' + symbol)
        if original.get('contract_address', '').lower() != contract:
            raise RuntimeError('CRYPTO_CONTRACT_RECORD_MISMATCH:' + symbol)
        if not original.get('historical_transaction_hash') or not original.get('historical_source_url'):
            raise RuntimeError('CRYPTO_HISTORICAL_PROOF_MISSING:' + symbol)
        proofs = [proof for p in portfolio if p.get('currency_code') == symbol
                  and p.get('network') == 'ETHEREUM' for proof in p.get('historical_proof', [])]
        if not any(p.get('contractAddress', '').lower() == contract
                   and p.get('walletAddress', '').lower() == historical.lower() for p in proofs):
            raise RuntimeError('CRYPTO_PORTFOLIO_PROOF_MISMATCH:' + symbol)
        asset = next((a for a in catalogue if a.get('asset_id') == asset_id), None)
        if not asset or not any(n.get('network') == 'ETHEREUM' and n.get('approved')
                                and n.get('verifiedAt') for n in asset.get('networks', [])):
            raise RuntimeError('CRYPTO_REGISTERED_ASSET_NOT_ENABLED:' + symbol)
        activated = request('/api/crypto/activate',
                            {'userId': uid, 'assetId': asset_id, 'network': 'ETHEREUM'},
                            'release-existing-wallet:' + sha + ':' + asset_id)
        if activated.get('accountId') != original['account_id']:
            raise RuntimeError('CRYPTO_ACTIVATION_REPLACED_ACCOUNT:' + symbol)
        if str(activated.get('addressId')) != str(original['address_id']):
            raise RuntimeError('CRYPTO_ACTIVATION_REPLACED_ADDRESS:' + symbol)
        if activated.get('address', '').lower() != historical.lower():
            raise RuntimeError('CRYPTO_ACTIVATION_ROUTE_MISMATCH:' + symbol)
        after = request('/api/views/cryptowallets')['rows']
        updated = [r for r in after if str(r.get('user_id')) == uid
                   and r.get('currency_code') == symbol and r.get('network') == 'ETHEREUM'
                   and r.get('wallet_scope') == 'FUNDING']
        snapshot = lambda rs: {r['account_id']: (Decimal(r['available_balance']), Decimal(r['locked_balance'])) for r in rs}
        if snapshot(rows) != snapshot(updated):
            raise RuntimeError('CRYPTO_ACTIVATION_CHANGED_LEDGER:' + symbol)
        shown = [r for r in updated if r.get('wallet_visible') is not False]
        if len(shown) != 1 or shown[0]['account_id'] != original['account_id']:
            raise RuntimeError('CRYPTO_ACTIVATION_CARD_MISMATCH:' + symbol)
        wallet = request('/api/crypto/wallet', {'addressId': str(original['address_id'])})
        if (str(wallet.get('address_id')) != str(original['address_id'])
                or wallet.get('network') != 'ETHEREUM'
                or wallet.get('public_address', '').lower() != historical.lower()
                or not str(wallet.get('qr', '')).startswith('data:image/png;base64,')):
            raise RuntimeError('CRYPTO_RECEIVING_QR_MISMATCH:' + symbol)
        results.append({'asset': symbol, 'accountId': original['account_id'],
                        'contractAddress': contract, 'historicalWalletAddress': historical,
                        'available': original['available_balance'], 'reserved': original['locked_balance'],
                        'sourceUrl': original['historical_source_url'],
                        'transactionHash': original['historical_transaction_hash'],
                        'visible': True, 'receivingQrVerified': True, 'balancesUnchanged': True})
    return {'release': sha, 'verifiedAt': datetime.now(timezone.utc).isoformat(),
            'wallets': results, 'securityWalletCount': len(securities),
            'scope': 'Existing account activation, historical routing and receiving QR; no transfer or issuance'}


def main():
    sha = os.environ['GITHUB_SHA']
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise RuntimeError('CRYPTO_RELEASE_SHA_INVALID')
    application = release.app(release.APP)
    base = 'https://' + application['properties']['configuration']['ingress']['fqdn']
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    login = release.api(opener, base, '/api/login',
                        {'username': 'mifos', 'password': release.secret('genesis-mifos-uat', 'admin-password')})
    def request(path, body=None, key=None):
        return release.api(opener, base, path, body, login['csrf'] if body is not None else None, key)
    evidence = verify_existing_wallets(request, sha)
    evidence['url'] = base
    destination = Path(os.environ.get('RUNNER_TEMP', '/tmp')) / 'avispay-crypto-wallet-evidence.json'
    destination.write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
    print('Verified existing AG/AGi activation, Portfolio proof, receiving QR and unchanged balances: ' + sha)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as output:
            output.write('### Existing AG/AGi wallets verified\n\nRelease: `' + sha + '`\n\n')
            for wallet in evidence['wallets']:
                output.write('- ' + wallet['asset'] + ': existing account `' + wallet['accountId']
                             + '` visible; historical address and receiving QR verified; balances unchanged.\n')
            output.write('\nNo blockchain transfer, issuance or robot order was submitted.\n')


if __name__ == '__main__':
    main()
