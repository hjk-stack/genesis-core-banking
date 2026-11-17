"""Live acceptance for the owner-requested Portfolio/Crypto links; no value transfers."""
from decimal import Decimal
import re

ASSETS = (
    ('AG', 'avis-green', '0x713d3a1785219aeb37e52260ff8f96660851842b'),
    ('AGi', 'avis-green-investment', '0x0482213c1e5a9fefdee36d9b01c044938403a9af'),
)

def verify_portfolio_wallets(request, release):
    owners = [r for r in request('/api/views/customers')['rows']
              if r.get('full_name') == 'AVISPay PLC' and r.get('account_role') == 'INSTITUTION']
    if len(owners) != 1:
        raise RuntimeError('Portfolio wallet owner could not be resolved uniquely')
    owner = str(owners[0]['user_id'])
    before = request('/api/views/portfolio')['rows']
    wallets_before = request('/api/views/cryptowallets')['rows']
    for code, asset, contract in ASSETS:
        position = next((p for p in before if p['currency_code'] == code and p['network'] == 'ETHEREUM'), None)
        routed = [w for w in wallets_before if str(w['user_id']) == owner and w['currency_code'] == code
                  and w['network'] == 'ETHEREUM' and w['wallet_scope'] == 'FUNDING']
        if not position or not routed or not position.get('historical_proof'):
            raise RuntimeError('Historical Portfolio asset metadata is absent: ' + code)
        historical = {str(w.get('historical_wallet_address', '')).lower() for w in routed}
        if len(historical) != 1 or not re.fullmatch(r'0x[0-9a-f]{40}', next(iter(historical))):
            raise RuntimeError('Historical Portfolio receiver is not unique: ' + code)
        address = next(iter(historical))
        if any(str(w.get('contract_address', '')).lower() != contract for w in routed):
            raise RuntimeError('Historical asset contract differs from registered contract: ' + code)
        if not any(p['contractAddress'].lower() == contract and p['walletAddress'].lower() == address
                   for p in position['historical_proof']):
            raise RuntimeError('Portfolio proof and wallet route differ: ' + code)
        result = request('/api/crypto/activate', {'userId': owner, 'assetId': asset, 'network': 'ETHEREUM'},
                         'portfolio-wallet-release-' + release[:12] + '-' + asset)
        if result['address'].lower() != address:
            raise RuntimeError('Currency selector did not preserve historical receiver: ' + code)
        qr = request('/api/crypto/wallet', {'addressId': result['addressId']})
        if qr['public_address'].lower() != address or not qr.get('qr', '').startswith('data:image/png;base64,'):
            raise RuntimeError('Historical receiving QR response mismatch: ' + code)
        current = request('/api/views/cryptowallets')['rows']
        selected = [w for w in current if str(w['account_id']) == str(result['accountId'])]
        if len(selected) != 1 or selected[0].get('wallet_visible') is not True:
            raise RuntimeError('Booked asset is not visible in the currency scroller: ' + code)
        if Decimal(selected[0]['available_balance']) != sum(Decimal(w['available_balance']) for w in routed):
            raise RuntimeError('Selected wallet differs from the existing booked holding: ' + code)
    after = request('/api/views/portfolio')['rows']
    def balances(rows):
        return sorted((r['currency_code'], r['network'], Decimal(r['available_balance']), Decimal(r['locked_balance']))
                      for r in rows)
    if balances(before) != balances(after):
        raise RuntimeError('Wallet selection changed Portfolio balances')
    cards = request('/api/views/cryptosecurities')['rows']
    plc = [c for c in cards if c['symbol'] == 'aAVISP']
    if len(plc) != 1 or len(cards) < 10:
        raise RuntimeError('AVISPay and nine securities cards were not retained')
    detail = request('/api/crypto/securities/' + plc[0]['card_id'])
    source = detail.get('sourceHolding')
    if not source or str(source['userId']) != owner:
        raise RuntimeError('AVISPay converter is not linked to the Portfolio holder')
    # The requested receiving wallet is separate from payment wallets. It creates
    # an encrypted key/address only; no token deployment, mint or ledger entry.
    wallet = request('/api/crypto/securities/wallet',
                     {'cardId': plc[0]['card_id'], 'userId': owner, 'network': detail.get('network') or 'ETHEREUM'},
                     'portfolio-security-wallet-' + plc[0]['card_id'])
    if not re.fullmatch(r'0x[0-9a-fA-F]{40}', wallet.get('public_address', '')):
        raise RuntimeError('Security receiving address was not returned')
    refreshed = request('/api/crypto/securities/' + plc[0]['card_id'])
    if refreshed.get('wallet_public_address') != wallet['public_address']:
        raise RuntimeError('Security converter and security wallet address differ')
    if balances(before) != balances(request('/api/views/portfolio')['rows']):
        raise RuntimeError('Security wallet creation changed Portfolio balances')
    print('Verified Portfolio-linked AG/AGi: original receiver routes, funded account selection, QR responses and unchanged balances')
    print('Verified securities converter: Portfolio source, dedicated receiving wallet and ten retained security cards; no token issuance submitted')
