"""Idempotent integration of the approved terminal; abort on changed anchors."""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

def replace(path, before, after):
    file = ROOT / path
    source = file.read_text()
    if after in source:
        return
    if source.count(before) != 1:
        raise RuntimeError('Integration anchor changed: ' + path + ': ' + before[:80])
    file.write_text(source.replace(before, after, 1))

replace('server.mjs', "'/trading-panel.mjs','/trading-testing.mjs'", "'/trading-panel.mjs','/approved-robot.mjs','/approved-robot.css','/trading-testing.mjs'")
replace('public/trading-live.mjs', 'selectedRobotId=null,pollMs=2000}){', 'selectedRobotId=null,pollMs=2000,onSnapshot=()=>{}}){')
replace('public/trading-live.mjs', "issue.textContent='';render(data);onSelection(data.profiles.find(profile=>profile.robotId===selected)||null);", "issue.textContent='';render(data);onSelection(data.profiles.find(profile=>profile.robotId===selected)||null);onSnapshot(data);")
replace('public/trading-panel.mjs', "import {mountIndexAdvice} from './index-advice.mjs';", "import {installApprovedRobot} from './approved-robot.mjs';\nimport {mountIndexAdvice} from './index-advice.mjs';")
replace('public/trading-panel.mjs', " void mountTradingLive({api,host:host.querySelector('[data-trading-live]'),isCurrent:current,selectedRobotId:", " const approved=installApprovedRobot({api,host:host.querySelector('[data-trading-live]'),isCurrent:current,onConfigure:()=>host.querySelector('[data-new-robot]')?.click()});\n const liveController=mountTradingLive({api,host:host.querySelector('[data-trading-live]'),isCurrent:current,onSnapshot:data=>approved.update(data),selectedRobotId:")
replace('public/trading-panel.mjs', " void mountIndexAdvice({api,host:host.querySelector('[data-index-advice]'),detailsHost:", " approved.mount();void liveController;\n void mountIndexAdvice({api,host:host.querySelector('[data-index-advice]'),detailsHost:")
replace('public/approved-robot.mjs',
 "const formatted=v=>numeric(v)===null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:8}).format(Number(v));",
 "export const formatted=v=>{if(v===null||v===undefined)return '—';const s=String(v),m=/^([+-]?\\d+)(?:\\.(\\d+))?$/.exec(s);if(!m)return numeric(v)===null?'—':s;const f=(m[2]||'').replace(/0+$/,'');return m[1].replace(/\\B(?=(\\d{3})+(?!\\d))/g,',')+(f?'.'+f:'');};")
replace('public/app.mjs', "window.addEventListener('hashchange',render);", "window.addEventListener('hashchange',()=>{\n try{const intent=readExchangeIntent(location.hash);if(intent){exchangeIntent=intent;if(csrf)void resumeExchange();else $('#login-form h2').textContent=intent.side?'Sign in to '+intent.side.toLowerCase()+' '+intent.symbol:'Sign in to your portfolio';return;}}catch(e){notice(e.message);return;}\n void render();\n});")
replace('test-browser/crypto-layout.mjs', "'/trading-panel.mjs','/trading-testing.mjs'", "'/trading-panel.mjs','/approved-robot.mjs','/approved-robot.css','/trading-testing.mjs'")
replace('test-browser/crypto-layout.mjs', "'/crypto-icons/avispay.webp'].includes(req.url)", "'/crypto-icons/avispay.webp','/crypto-icons/robot-approved.jpg'].includes(req.url)")
replace('test-browser/crypto-layout.mjs', "req.url.endsWith('.webp')?'image/webp':", "req.url.endsWith('.jpg')?'image/jpeg':req.url.endsWith('.webp')?'image/webp':")
replace('test-browser/crypto-layout.mjs', "assert.equal(await live.locator('.trading-robot-art').count(),1);", "assert.equal(await live.locator('.ar-robot-image').count(),1);await page.waitForFunction(()=>document.querySelector('.ar-robot-image')?.naturalWidth===891);")
replace('test-browser/crypto-layout.mjs', "else{assert.ok(layout.robot.bottom<=layout.screen.top,'the live view must stack on smaller screens');assert.ok(layout.fields[0].bottom<=layout.fields[1].top,'instruction fields must stack without overlap');}", "else{assert.ok(layout.robot.right<=layout.screen.left,'the approved trading board retains its left robot and right market panels');const viewport=await live.locator('.ar-viewport').evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth}));assert.ok(viewport.scroll>viewport.client,'tablet and phone scroll the terminal, not the whole page');assert.ok(layout.fields[0].bottom<=layout.fields[1].top,'instruction fields must stack without overlap');}")
replace('test/approved-robot.test.mjs', "reviewedExchangeIntent,installApprovedRobot,CANDLE_INTERVALS", "reviewedExchangeIntent,installApprovedRobot,CANDLE_INTERVALS,formatted")
replace('test/approved-robot.test.mjs', " data.profiles=[];data.selectedRobotId=null;await controllers.at(-1).refresh();host.querySelector('[data-trading-buy]').click();assert.equal(configure,1);", " controllers.at(-1).close();skin.close();data.profiles=[];data.selectedRobotId=null;const fresh=installApprovedRobot({host,api,onConfigure:()=>configure++});controllers.push(fresh);const opening=mountTradingLive({host,api,pollMs:0,onSnapshot:x=>fresh.update(x)});fresh.mount();controllers.push(await opening);host.querySelector('[data-trading-buy]').click();assert.equal(configure,1);")
replace('test/approved-robot.test.mjs', " assert.match(css,/min-width:1010px/);", " assert.equal(formatted('10000000000.123456789012345678'),'10,000,000,000.123456789012345678');assert.equal(formatted('0.000000000000000001'),'0.000000000000000001');\n assert.match(css,/min-width:1010px/);")
print('Approved artwork, terminal and same-session reviewed order routing integrated; exact ledger precision retained.')
