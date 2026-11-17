"""Read-only release acceptance for the multi-coin trading row."""
from decimal import Decimal, InvalidOperation


def verify_wallet_allowances(read):
    rows = read('/api/views/tradingallowances').get('rows')
    delegations = read('/api/views/walletdelegations').get('rows')
    if not isinstance(rows, list) or not isinstance(delegations, list):
        raise RuntimeError('Trade allowance API schema mismatch')
    expected = {}
    for item in delegations:
        if item.get('state') != 'ACTIVE':
            continue
        account = item['account_id']
        expected[account] = expected.get(account, Decimal(0)) + Decimal(item['quantity'])
    found = {}
    for row in rows:
        account = row.get('account_id')
        if not account or account in found or not row.get('currency_code') or not row.get('network'):
            raise RuntimeError('Duplicate or incomplete trade allowance wallet identity')
        try:
            quantity = Decimal(row['quantity'])
        except (KeyError, InvalidOperation, TypeError):
            raise RuntimeError('Trade allowance quantity is invalid') from None
        if not quantity.is_finite() or quantity <= 0:
            raise RuntimeError('Trade allowance quantity must be positive')
        if not isinstance(row.get('enabled'), bool) or type(row.get('version')) is not int or row['version'] < 0:
            raise RuntimeError('Trade allowance activation state is invalid')
        found[account] = quantity
    # This pre-existing consent endpoint is limited to 300 rows. Compare exact
    # totals only when it returned an untruncated record set.
    if len(delegations) < 300 and found != {key: value for key, value in expected.items() if value > 0}:
        raise RuntimeError('Trading row does not match the existing accepted wallet allowances')
    print('Verified live multi-coin allowance row: ' + str(len(rows)) +
          ' authorised wallet accounts; ' + str(sum(row['enabled'] for row in rows)) +
          ' selected; read-only verification; no activation or order submitted')
    return {'accounts': len(rows), 'selected': sum(row['enabled'] for row in rows)}
