"""Idempotent presentation corrections; never alter account data."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def replace(path,before,after):
 p=ROOT/path;s=p.read_text()
 if after in s:return
 if s.count(before)!=1:raise RuntimeError('Changed integration anchor: '+path+': '+before[:60])
 p.write_text(s.replace(before,after,1))
replace('public/crypto.css','#main:has(> #view > .crypto-section){max-width:1700px;min-width:0}', '#main:has(> #view > .crypto-section){max-width:none;min-width:0}')
replace('test-browser/crypto-layout.mjs',"name:'Refresh view',exact:true","name:'Refresh trading data',exact:true")
replace('test-browser/crypto-layout.mjs',"live.locator('[data-robot-arm=SELL]').evaluate(element=>getComputedStyle(element).animationName)","live.locator('.ar-robot-image').evaluate(element=>getComputedStyle(element).animationName)")
replace('public/approved-robot.mjs',"esc(formatted(price))","esc(formatted(Number(price.toPrecision(8))))")
replace('public/approved-robot.mjs',"  // Fee currency does not prove fee type:","  for(const cell of host.querySelectorAll('.terminal-scroll-tape td'))cell.title=cell.textContent;\n  // Fee currency does not prove fee type:")
replace('public/approved-robot.mjs',"  q('[data-ar-markets]').innerHTML=top.map(r=>card(r)).join('');const items=rows.slice(0,100).map(r=>card(r,true)).join(''),track=q('[data-ar-ticker]');", "  const m=snapshot?.market,quote=m?.quote,observedQuote=quote&&numeric(quote.bid)>0&&numeric(quote.ask)>0;\n  const liveCard=compact=>observedQuote?`<div class=\"ar-market ${compact?'ar-market-small':''}\" data-active-market-quote title=\"${esc(quote.receivedAt||'')}\"><span class=\"ar-coin\">${esc(m.baseAsset)}</span><div><strong>${esc(m.baseAsset)} / ${esc(m.quoteAsset)}</strong><span>Bid ${esc(formatted(quote.bid))} · Ask ${esc(formatted(quote.ask))}</span></div></div>`:'';\n  const references=observedQuote?top.filter(r=>String(r.currency_code).toUpperCase()!==String(m.baseAsset).toUpperCase()).slice(0,3):top;\n  q('[data-ar-markets]').innerHTML=liveCard(false)+references.map(r=>card(r)).join('');const items=liveCard(true)+rows.slice(0,100).map(r=>card(r,true)).join(''),track=q('[data-ar-ticker]');")
replace('public/approved-robot.mjs',"+'</dl>';renderChart();\n }\n return {mount,update", "+'</dl>';renderMarkets();renderChart();\n }\n return {mount,update")
replace('test/approved-robot.test.mjs',"assert.equal(host.querySelectorAll('.ar-ticker-copy:first-child .ar-market').length,6);", "assert.equal(host.querySelectorAll('.ar-ticker-copy:first-child .ar-market').length,7);assert.match(host.querySelector('[data-active-market-quote]').textContent,/aAVISP \\/ CHF/);")
replace('../azure/deploy-sovereign.py',"        '/crypto.css': 'public/crypto.css',", "        '/crypto.css': 'public/crypto.css',\n        '/approved-robot.mjs': 'public/approved-robot.mjs',\n        '/approved-robot.css': 'public/approved-robot.css',\n        '/crypto-icons/robot-approved.jpg': 'public/crypto-icons/robot-approved.jpg',")
replace('../azure/test_deploy_sovereign.py',"'/crypto.css': 'public/crypto.css'}", "'/crypto.css': 'public/crypto.css',\n                 '/approved-robot.mjs': 'public/approved-robot.mjs',\n                 '/approved-robot.css': 'public/approved-robot.css',\n                 '/crypto-icons/robot-approved.jpg': 'public/crypto-icons/robot-approved.jpg'}")
p=ROOT/'public/approved-robot.css';css=p.read_text()
marker='/* Preserve all three tape columns and a horizontal auto-trading switch. */'
if marker not in css:
 css+='\n'+marker+'''
.approved-robot .terminal-scroll-tape table{table-layout:fixed}
.approved-robot .terminal-scroll-tape th,.approved-robot .terminal-scroll-tape td{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.approved-robot .terminal-scroll-tape th:first-child,.approved-robot .terminal-scroll-tape td:first-child{width:36%}
.approved-robot .terminal-scroll-tape th:nth-child(2),.approved-robot .terminal-scroll-tape td:nth-child(2){width:38%}
.approved-robot .terminal-scroll-tape th:nth-child(3),.approved-robot .terminal-scroll-tape td:nth-child(3){width:26%}
.approved-robot .terminal-auto{display:flex;flex-direction:row;align-items:center;gap:5px}
.approved-robot .terminal-auto input{padding:0;box-sizing:border-box;min-height:0;height:20px;min-width:34px;flex:0 0 34px}
'''
 p.write_text(css)
print('Full-width layout, live quote ticker, exact amounts and deployment asset verification integrated.')
