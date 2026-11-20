import {installApprovedRobot} from './approved-robot.mjs';
import {mountIndexAdvice} from './index-advice.mjs';
import {mountTradingTesting} from './trading-testing.mjs';
import {mountTradingLive,mountRobotInstructions} from './trading-live.mjs';
const liveSelections=new WeakMap();
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const field=(n,l,v='',type='text')=>`<label>${l}<input name="${n}" type="${type}" value="${esc(v)}" required></label>`;
const select=(n,l,items)=>`<label>${l}<select name="${n}" required><option value="">Select…</option>${items.map(([v,t])=>`<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select></label>`;
const providerResult=p=>{
 if(!p.verified)return p.configured?p.provider+': '+p.code:p.provider+': set '+p.setting+' in connector administration';
 const detail=p.accounts?.length?p.accounts.join(', '):Number.isFinite(p.blockNumber)?'Ethereum block '+p.blockNumber:p.capability;
 return p.provider+': verified'+(detail?' · '+detail:'');
};
export async function mountTradingPanel({api,host,form,refresh,isAdmin}){
 const current=()=>host?.isConnected&&(typeof isAdmin==='function'?isAdmin():isAdmin);if(!current())return;const [robots,orders,users,securities,cashAccounts]=await Promise.all(['tradingrobots','robotorders','customers','securities','accountsummaries'].map(v=>api('views/'+v).then(r=>r.rows)));if(!current())return;
 host.innerHTML=`<div class="terminal-identity"><div><h3>Multi Assets Algorithmic High Speed Trading Robot · Global INDEX</h3><p>Institutional execution · real market depth · wallet allocation · NautilusTrader 1.231.0</p></div></div><div data-trading-live></div><details class="trading-advanced"><summary>Strategies · INDEX · trading administration</summary><div><div class="crypto-section-heading"><h3>Strategy controls</h3><button data-new-robot>＋ Configure robot</button></div><div class="trading-instructions-grid"><div data-index-advice></div><div data-robot-instructions></div></div><div data-index-evidence></div><details class="crypto-connectors" data-coinapi-benchmarks><summary>CoinAPI Indexes · current values and historical research</summary><div data-index-benchmark-values></div><button type="button" data-refresh-index-benchmarks>Refresh benchmark values</button></details><div data-trading-testing></div><button data-validate-providers>Validate CoinAPI & Alchemy</button><p data-provider-result class="crypto-source" aria-live="polite"></p><a href="https://avis.land/press/data" target="_blank" rel="noopener noreferrer">Open Press news concentrator ↗</a><div class="crypto-scroller">${robots.map(r=>`<article class="crypto-market" style="flex-basis:320px"><h3>${esc(r.name)}</h3><p>${esc(r.symbol)} · ${r.venue}</p><p>${r.enabled?'Entry trading on':'Entry trading off'}</p><dl class="crypto-details"><dt>Position</dt><dd>${esc(r.position_quantity)}</dd><dt>Cost basis</dt><dd>${esc(r.cost_basis)} ${esc(r.quote_asset)}</dd><dt>Realised P&L</dt><dd>${esc(r.realized_pnl)}</dd><dt>Trailing stop</dt><dd>${esc(r.stop_price)}</dd><dt>Press INDEX</dt><dd>${r.last_index?esc(r.last_index.score)+' · '+new Date(r.last_index.generatedAt).toLocaleString():'—'}</dd><dt>Event advice</dt><dd>${(r.last_event_advice||[]).map(c=>esc(c.action)+' · '+esc(c.category)).join(', ')||'—'}</dd><dt>Order limit</dt><dd>${esc(r.max_notional)}</dd><dt>Daily limit</dt><dd>${esc(r.daily_notional)}</dd></dl><button data-toggle="${r.robot_id}" data-enabled="${!r.enabled}" ${r.enabled?'':'disabled'}>${r.enabled?'Pause new entries':'Start live trading'}</button>${r.enabled?'':'<p class="crypto-source" data-live-test="'+esc(r.robot_id)+'">Review a passed market replay in Trading tests.</p>'}<p class="form-error" role="alert"></p></article>`).join('')}</div><details class="crypto-connectors"><summary>Orders & executions</summary><table><thead><tr><th>Time</th><th>Side</th><th>Requested</th><th>Executed</th><th>State</th><th>Reference</th></tr></thead><tbody>${orders.slice(0,30).map(o=>`<tr><td>${new Date(o.created_at).toLocaleString()}</td><td>${o.side}</td><td>${esc(o.quantity)}</td><td>${esc(o.response?.executedQty??'—')}</td><td>${esc(o.status)}</td><td>${esc(o.client_order_id)}</td></tr>`).join('')}</tbody></table></details></div></details>`;
 let testing=null;const toggling=new Set();
 const liveAllowed=id=>{const profile=testing?.profiles?.find(profile=>profile.robotId===id);return profile?.testReviewed===true&&/^[a-f0-9]{64}$/.test(profile.configurationHash||'')&&/^[a-f0-9-]{36}$/i.test(profile.reviewedRunId||'');};
 const syncLive=()=>{if(!current())return;host.querySelectorAll('[data-toggle]').forEach(button=>{const enabled=button.dataset.enabled==='true';button.disabled=toggling.has(button.dataset.toggle)||enabled&&!liveAllowed(button.dataset.toggle);});host.querySelectorAll('[data-live-test]').forEach(element=>{element.textContent=liveAllowed(element.dataset.liveTest)?'Replay reviewed for this saved configuration.':'Review a passed market replay in Trading tests.';});};
 void mountTradingTesting({api,host:host.querySelector('[data-trading-testing]'),isCurrent:current,onMetadata:value=>{if(current()){testing=value;syncLive();}},onReviewed:async()=>{if(current())await refresh();}});
 const selectionScope=host.closest('#view')||host.parentElement;
 const instructions=mountRobotInstructions({api,host:host.querySelector('[data-robot-instructions]'),isCurrent:current,onSaved:async()=>{if(current())await refresh();}});
 const approved=installApprovedRobot({api,host:host.querySelector('[data-trading-live]'),isCurrent:current,onConfigure:()=>host.querySelector('[data-new-robot]')?.click()});
 const liveController=mountTradingLive({api,host:host.querySelector('[data-trading-live]'),isCurrent:current,onSnapshot:data=>approved.update(data),selectedRobotId:liveSelections.get(selectionScope)||null,onSelection:profile=>{if(!current())return;if(profile)liveSelections.set(selectionScope,profile.robotId);else liveSelections.delete(selectionScope);void instructions?.select(profile);}});
 approved.mount();void liveController;
 const benchmarkHost=host.querySelector('[data-index-benchmark-values]'),benchmarkButton=host.querySelector('[data-refresh-index-benchmarks]');
 const benchmarkRefresh=async()=>{
  if(!current())return;benchmarkButton.disabled=true;
  try{
   const data=await api('crypto/trading/index-benchmarks');if(!current())return;
   if(!data||!Array.isArray(data.indices))throw Error('CoinAPI research could not be read');
   const rows=data.indices.map(item=>{
    const name=esc(item.indexId),value=item.value===null?'—':esc(item.value),stamp=esc(item.sourceAt||'—');
    return '<tr><td>'+name+'</td><td>'+value+'</td><td>'+stamp+'</td><td>'+esc(item.history?.length||0)+'</td></tr>';
   }).join('');
   benchmarkHost.innerHTML='<p class="crypto-source">Read-only CoinAPI benchmark evidence; not exchange executions or custody balances.</p><table><thead><tr><th>Index</th><th>Value</th><th>Source time</th><th>Historical days</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(error){if(current())benchmarkHost.textContent=error.message;}finally{if(current())benchmarkButton.disabled=false;}
 };
 benchmarkButton.onclick=()=>void benchmarkRefresh();
 void benchmarkRefresh();
 void mountIndexAdvice({api,host:host.querySelector('[data-index-advice]'),detailsHost:host.querySelector('[data-index-evidence]'),isCurrent:current});
 host.querySelector('[data-validate-providers]').onclick=async()=>{const b=host.querySelector('[data-validate-providers]'),out=host.querySelector('[data-provider-result]');b.disabled=true;try{const r=await api('crypto/trading/validate-providers',{});out.textContent=r.providers.map(providerResult).join(' | ');}catch(e){out.textContent=e.message;}finally{b.disabled=false;}};
 host.querySelectorAll('[data-toggle]').forEach(b=>b.onclick=async()=>{const id=b.dataset.toggle,enabled=b.dataset.enabled==='true';if(!current()||toggling.has(id)||enabled&&!liveAllowed(id))return;toggling.add(id);syncLive();try{await api('crypto/trading/toggle',{robotId:id,enabled});if(current())await refresh();}catch(e){if(current())b.closest('article').querySelector('.form-error').textContent=e.message;}finally{toggling.delete(id);syncLive();}});
 host.querySelector('[data-new-robot]').onclick=async()=>{
  const f=await form('Configure W-effect trading',field('name','Robot name','W-effect')+select('userId','Institution account',users.filter(u=>u.account_role==='INSTITUTION').map(u=>[u.user_id,u.full_name]))+select('venue','Execution venue',[['AVIS','AVIS exchange'],['BINANCE','Binance spot API']])+field('symbol','Exact venue symbol')+field('indexId','Press security identifier','BTC')+select('securityId','AVIS security',securities.map(s=>[s.security_id,s.name]))+select('accountId','AVIS cash account',[])+field('keyRef','Trading API reference','TRADING_TREASURY')+field('maxNotional','Maximum order value','100')+field('dailyNotional','Maximum daily purchases','1000')+field('maxLoss','Realised loss limit','100')+field('minimumIndex','Minimum INDEX score','0','number')+field('trailingBps','Trailing distance (basis points)','50','number'),(v,k)=>api('crypto/trading/configure',{...v,trailingBps:Number(v.trailingBps),minimumIndex:Number(v.minimumIndex)},k),'Save configuration');
  const syncAccounts=()=>{
   const account=f.elements.accountId,selected=account.value,user=f.elements.userId.value,security=securities.find(s=>s.security_id===f.elements.securityId.value);
   const eligible=cashAccounts.filter(a=>a.wallet_scope==='FUNDING'&&a.status==='ACTIVE'&&!a.network&&String(a.user_id)===user&&a.currency_code===security?.currency_code);
   account.innerHTML='<option value="">Select…</option>'+eligible.map(a=>`<option value="${esc(a.account_id)}">${esc(a.full_name+' · '+a.currency_code+' · '+a.account_reference)}</option>`).join('');
   account.value=eligible.some(a=>a.account_id===selected)?selected:'';
  };
  const toggle=()=>{
   const native=f.elements.venue.value==='AVIS';
   for(const n of ['securityId','accountId']){f.elements[n].required=native;f.elements[n].disabled=!native;f.elements[n].closest('label').hidden=!native;}
   f.elements.keyRef.required=!native;f.elements.keyRef.disabled=native;f.elements.keyRef.closest('label').hidden=native;syncAccounts();
  };
  f.elements.userId.onchange=syncAccounts;f.elements.securityId.onchange=syncAccounts;f.elements.venue.onchange=toggle;toggle();
 };
}
