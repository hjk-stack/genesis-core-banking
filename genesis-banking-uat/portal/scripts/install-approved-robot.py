"""Idempotent source integration for the approved AVISPay terminal.

Only exact, inspected call sites are changed. A changed source anchor aborts
instead of applying a partial or speculative replacement.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace(path, before, after):
    file = ROOT / path
    source = file.read_text()
    if after in source:
        return
    if source.count(before) != 1:
        raise RuntimeError('Integration anchor changed: ' + path)
    file.write_text(source.replace(before, after, 1))


replace('server.mjs',
        "'/trading-panel.mjs','/trading-testing.mjs'",
        "'/trading-panel.mjs','/approved-robot.mjs','/approved-robot.css','/trading-testing.mjs'")
replace('public/trading-live.mjs',
        'selectedRobotId=null,pollMs=2000}){',
        'selectedRobotId=null,pollMs=2000,onSnapshot=()=>{}}){')
replace('public/trading-live.mjs',
        "issue.textContent='';render(data);onSelection(data.profiles.find(profile=>profile.robotId===selected)||null);",
        "issue.textContent='';render(data);onSelection(data.profiles.find(profile=>profile.robotId===selected)||null);onSnapshot(data);")
replace('public/trading-panel.mjs',
        "import {mountIndexAdvice} from './index-advice.mjs';",
        "import {installApprovedRobot} from './approved-robot.mjs';\nimport {mountIndexAdvice} from './index-advice.mjs';")
replace('public/trading-panel.mjs',
        " void mountTradingLive({api,host:host.querySelector('[data-trading-live]'),isCurrent:current,selectedRobotId:",
        " const approved=installApprovedRobot({api,host:host.querySelector('[data-trading-live]'),isCurrent:current,onConfigure:()=>host.querySelector('[data-new-robot]')?.click()});\n const liveController=mountTradingLive({api,host:host.querySelector('[data-trading-live]'),isCurrent:current,onSnapshot:data=>approved.update(data),selectedRobotId:")
replace('public/trading-panel.mjs',
        " void mountIndexAdvice({api,host:host.querySelector('[data-index-advice]'),detailsHost:",
        " approved.mount();void liveController;\n void mountIndexAdvice({api,host:host.querySelector('[data-index-advice]'),detailsHost:")
print('Approved artwork, terminal, read-only chart controls and existing reviewed order flow integrated.')
