"""Guarded integration of selected coin permissions into existing robot code."""
from pathlib import Path
root=Path('genesis-banking-uat')
changes={}
def edit(path,old,new,count=1):
    path=root/path
    source=changes.get(path,path.read_text())
    if source.count(old)!=count:
        raise RuntimeError(f'{path}: unexpected source anchor count for {old[:90]}')
    changes[path]=source.replace(old,new)

edit('portal/src/trading-robot.mjs',"import {engineStatus} from './trading/runtime.mjs';",
     "import {engineStatus} from './trading/runtime.mjs';\nimport {robotWalletAllowance,assertRobotWalletAllowance,ROBOT_WALLET_MESSAGES} from './robot-wallet-allowance.mjs';")
edit('portal/src/trading-robot.mjs','export const ROBOT_MESSAGES={',
     'export const ROBOT_MESSAGES={...ROBOT_WALLET_MESSAGES,')
edit('portal/src/trading-robot.mjs',' async validateRobotProviders(actor){',
     ' async robotWalletAllowance(robot){return robotWalletAllowance(this.pool,robot);}\n async validateRobotProviders(actor){')
edit('portal/src/trading-robot.mjs',"if(input.enabled)await this.assertTradingTestReviewed(db,r);",
     "if(input.enabled){await this.assertTradingTestReviewed(db,r);await assertRobotWalletAllowance(db,r,'0');}")
edit('portal/src/trading-robot.mjs',"  if(input.side==='BUY'){\n   await this.assertTradingTestReviewed(db,r);",
     "  if(input.side==='BUY'){\n   await this.assertTradingTestReviewed(db,r);\n   await assertRobotWalletAllowance(db,r,input.quantity);")
edit('portal/src/trading-robot.mjs',"  if(order.side!=='BUY')return null;",
     "  if(order.side!=='BUY')return null;\n  try{await assertRobotWalletAllowance(db,robot,order.quantity,order.id);}catch(error){if(['CRYPTO_TRADING_SELECTION_REQUIRED','CRYPTO_TRADING_ALLOWANCE_LIMIT'].includes(error.code))return error.code;throw error;}")
edit('portal/src/trading/runtime.mjs', 'enabled:r.enabled&&r.test_reviewed===true,',
     'enabled:r.enabled&&r.test_reviewed===true&&r.wallet_selection_allowed!==false,')
edit('portal/src/trading/runtime.mjs',
     'robot.test_reviewed=await this.core.tradingTestReviewed(this.core.pool,robot);if(this.stopped)return;',
     "robot.test_reviewed=await this.core.tradingTestReviewed(this.core.pool,robot);if(this.stopped)return;robot.wallet_selection_allowed=typeof this.core.robotWalletAllowance==='function'?(await this.core.robotWalletAllowance(robot)).allowed:true;if(this.stopped)return;")
edit('portal/src/wallet-trading-selection.mjs', '  const current = (await db.query(',
     "  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['wallet-trading:'+String(account.user_id)+':'+String(account.currency_code).toLowerCase()]);\n  const current = (await db.query(")
edit('portal/src/crypto-workspace.mjs', 'AND (r.enabled OR r.position_quantity>0 OR EXISTS',
     "AND ((r.enabled AND COALESCE((SELECT s.enabled FROM avis_core_v2.wallet_trading_selections s WHERE s.account_id=$3),true)) OR r.position_quantity>0 OR EXISTS")
edit('portal/src/crypto-workspace.mjs', '[d.user_id,d.currency_code])).rows;',
     '[d.user_id,d.currency_code,d.account_id])).rows;')

# The final deployment verification reads the live acceptance row without
# activating coins or creating orders on the user's server.
edit('azure/deploy-sovereign.py', "        stage = 'ABIQ issuer and account verification'",
     "        stage = 'live accepted wallet allowance verification'\n        import importlib.util as allowance_import\n        from pathlib import Path as AllowancePath\n        allowance_spec = allowance_import.spec_from_file_location('live_wallet_allowances', AllowancePath(__file__).with_name('verify_wallet_allowances.py'))\n        allowance_module = allowance_import.module_from_spec(allowance_spec)\n        allowance_spec.loader.exec_module(allowance_module)\n        allowance_module.verify_wallet_allowances(lambda path: api(opener, base, path))\n        stage = 'ABIQ issuer and account verification'")
for path,source in changes.items():
    path.write_text(source)
print('Connected coin selections to robot entry/dispatch checks and read-only release verification')
