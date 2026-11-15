import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('initialize_crypto', Path(__file__).with_name('initialize-crypto.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class TreasuryInitializationTests(unittest.TestCase):
    def fixture(self, name='AVISPay PLC', chain=1, split=False, mode='DEMO', stale=False):
        calls=[]
        approved={}
        def request(path, body=None, key=None):
            calls.append((path, body, key))
            if path.endswith('/customers'):
                return {'rows':[{'user_id':'1','full_name':name,'account_role':'INSTITUTION'}]}
            if path.endswith('/check-network'):
                return {'chainId':chain}
            if path.endswith('/cryptocatalogue'):
                return {'rows':[{'asset_id':a,'currency_code':c,'networks':[{'network':'ETHEREUM','approved':approved.get(a,False),'verifiedAt':'2026-11-15T12:00:00Z' if approved.get(a) else None}]} for a,c in [('avis-green','AG'),('avis-green-investment','AGi')]]}
            if path.endswith('/approve'):
                if not stale:
                    approved[body['assetId']]=True
                return {'approved':True}
            if path.endswith('/activate'):
                return {'addressId': '2' if split and body['assetId']=='avis-green-investment' else '1', 'address':'0x'+'1'*40}
            if path.endswith('/wallet'):
                return {'public_address':'0x'+'1'*40,'qr':'data:image/png;base64,fixture'}
            if path.endswith('/balance'):
                return {'balance':'0','observedAt':'2026-11-15T12:00:00Z'}
            if path.endswith('/cryptosecurities'):
                return {'rows':[{'card_id':'card','symbol':'aAVISP','mode':mode,'state':'DRAFT'}]}
            return {}
        return calls, request

    def test_creates_only_treasury_wallet_and_metadata_without_financial_booking(self):
        calls, request=self.fixture()
        result=module.initialize(request)
        self.assertTrue(result['qrVerified'])
        self.assertEqual(result['assets'],['AG','AGi'])
        self.assertEqual(len([c for c in calls if c[0].endswith('/activate')]),2)
        self.assertTrue(all(c[1]['userId']=='1' and c[2] for c in calls if c[0].endswith('/activate')))
        self.assertFalse(any('transfer' in c[0] or 'actions/' in c[0] or 'portfolio/positions' in c[0] for c in calls))

    def test_rejects_wrong_institution_before_mutation(self):
        calls, request=self.fixture(name='Different holder')
        with self.assertRaisesRegex(RuntimeError,'Treasury holder'):
            module.initialize(request)
        self.assertTrue(all(body is None for _,body,_ in calls))

    def test_rejects_wrong_chain_and_split_addresses(self):
        _, request=self.fixture(chain=56)
        with self.assertRaisesRegex(RuntimeError,'mainnet'):
            module.initialize(request)
        _, request=self.fixture(split=True)
        with self.assertRaisesRegex(RuntimeError,'reuse'):
            module.initialize(request)

    def test_old_approval_receipts_cannot_hide_a_later_disabled_mapping(self):
        _, request=self.fixture(stale=True)
        with self.assertRaisesRegex(RuntimeError,'remains disabled'):
            module.initialize(request)

    def test_existing_real_security_is_never_replaced_with_demo_content(self):
        calls, request=self.fixture(mode='REAL')
        module.initialize(request)
        self.assertFalse(any(c[0].endswith('/demo-convert') for c in calls))


if __name__ == '__main__':
    unittest.main()
