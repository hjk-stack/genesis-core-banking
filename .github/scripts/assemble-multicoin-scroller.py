"""One-time, guarded source integration on the multi-coin feature branch only."""
from pathlib import Path

root = Path('genesis-banking-uat')
changes = {}
def edit(relative, old, new, count=1):
    path = root / relative
    source = changes.get(path, path.read_text())
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'{relative}: expected {count} integration anchors, found {actual}: {old[:70]}')
    changes[path] = source.replace(old, new)

edit('portal/src/crypto-workspace.mjs',
     "import {createHash,randomUUID} from 'node:crypto';",
     "import {createHash,randomUUID} from 'node:crypto';\nimport {walletTradingAllowances,setWalletTradingSelection,WALLET_SELECTION_MESSAGES} from './wallet-trading-selection.mjs';")
edit('portal/src/crypto-workspace.mjs', 'export const CRYPTO_MESSAGES={',
     'export const CRYPTO_MESSAGES={\n ...WALLET_SELECTION_MESSAGES,')
edit('portal/src/crypto-workspace.mjs', ' async delegateWalletTrading(actor,input,key){',
     " async selectWalletTrading(actor,input,key){return setWalletTradingSelection(this,actor,input,key);}\n async delegateWalletTrading(actor,input,key){")
edit('portal/src/crypto-workspace.mjs', "  if(view==='walletdelegations')return",
     "  if(view==='tradingallowances')return walletTradingAllowances(this.pool,actor);\n  if(view==='walletdelegations')return")
edit('portal/src/customer-access.mjs', "if(method==='delegateWalletTrading')",
     "if(['delegateWalletTrading','selectWalletTrading'].includes(method))")
edit('portal/src/customer-access.mjs', "['walletdelegations','cryptocatalogue'",
     "['walletdelegations','tradingallowances','cryptocatalogue'")
edit('portal/server.mjs', "'crypto/trading/delegate-wallet':'delegateWalletTrading'",
     "'crypto/trading/delegate-wallet':'delegateWalletTrading','crypto/trading/select-wallet':'selectWalletTrading'")
edit('portal/server.mjs', "'/crypto-workspace.mjs','/trading-panel.mjs'",
     "'/crypto-workspace.mjs','/wallet-trading-scroller.mjs','/wallet-trading-scroller.css','/trading-panel.mjs'")
edit('portal/public/crypto-workspace.mjs', "import {mountTradingPanel} from './trading-panel.mjs';",
     "import {mountTradingPanel} from './trading-panel.mjs';\nimport {mountWalletTradingScroller} from './wallet-trading-scroller.mjs';")
edit('portal/public/crypto-workspace.mjs', ' let root,epoch=0,', ' let allowanceScroller=null;\n let root,epoch=0,')
edit('portal/public/crypto-workspace.mjs', ' function close(){epoch++;',
     ' function close(){allowanceScroller?.close();allowanceScroller=null;epoch++;')
edit('portal/public/crypto-workspace.mjs', ' async function mount(target){delegation?.remove();',
     ' async function mount(target){allowanceScroller?.close();allowanceScroller=null;delegation?.remove();')
edit('portal/public/crypto-workspace.mjs', '<div class="crypto-trading-console" data-trading-panel></div>',
     '<div data-trading-allowances></div><div class="crypto-trading-console" data-trading-panel></div>')
edit('portal/public/crypto-workspace.mjs', '  if(isAdmin())void mountTradingPanel({api,',
     "  allowanceScroller=mountWalletTradingScroller({api,host:q('[data-trading-allowances]'),isCurrent:()=>serial===epoch&&currentContext(context,who)});\n  if(isAdmin())void mountTradingPanel({api,")
edit('portal/public/crypto-workspace.mjs', 'Frozen for robot:', 'Trade allowance:')
edit('portal/public/approved-robot.mjs', 'board.prepend(strip);',
     "board.prepend(strip);\n  const allowances=host.closest('#crypto-trading-desk')?.querySelector('[data-trading-allowances]');\n  if(allowances){strip.hidden=true;allowances.classList.add('ar-wallet-strip');board.prepend(allowances);}")

for relative in ['portal/test/crypto-workspace-ui.test.mjs','portal/test-browser/crypto-layout.mjs']:
    path=root/relative
    source=changes.get(path,path.read_text())
    if 'Frozen for robot:' in source:
        changes[path]=source.replace('Frozen for robot:', 'Trade allowance:')

# Extend live-release asset verification so a successful release proves that
# these exact new frontend modules, not only old health endpoints, are served.
for relative in ['azure/deploy-sovereign.py','azure/test_deploy_sovereign.py']:
    path=root/relative
    source=changes.get(path,path.read_text())
    anchor="'/crypto-workspace.mjs': 'public/crypto-workspace.mjs',"
    if anchor in source:
        changes[path]=source.replace(anchor, anchor+"\n        '/wallet-trading-scroller.mjs': 'public/wallet-trading-scroller.mjs',\n        '/wallet-trading-scroller.css': 'public/wallet-trading-scroller.css',")
    else:
        raise RuntimeError(f'{relative}: missing release integrity mapping')

css=root/'portal/public/wallet-trading-scroller.css'
changes[css]=css.read_text()+"\n.crypto-trading-desk .approved-robot .ar-board:has(.ar-wallet-strip){grid-template-rows:minmax(156px,auto) minmax(410px,auto) auto!important}\n"
for path,source in changes.items():
    path.write_text(source)
print('Integrated multi-coin wallet scroller in',len(changes),'source/test files')
