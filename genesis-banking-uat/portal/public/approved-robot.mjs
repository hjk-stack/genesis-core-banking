// Approved AVISPay terminal: presentation only; balances and execution controls
// remain owned by the authenticated banking/trading controllers.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const numeric=v=>v!==null&&v!==undefined&&String(v).trim()!==''&&Number.isFinite(Number(v))?Number(v):null;
export const formatted=v=>{if(v===null||v===undefined)return '—';const s=String(v),m=/^([+-]?\d+)(?:\.(\d+))?$/.exec(s);if(!m)return numeric(v)===null?'—':s;const f=(m[2]||'').replace(/0+$/,'');return m[1].replace(/\B(?=(\d{3})+(?!\d))/g,',')+(f?'.'+f:'');};
export const CANDLE_INTERVALS=Object.freeze({'1m':60000,'5m':300000,'15m':900000,'1h':3600000,'4h':14400000,'1D':86400000});
export function tradeCandles(trades,interval='15m'){
 if(!Object.hasOwn(CANDLE_INTERVALS,interval))throw new TypeError('Unsupported candle interval');
 const seen=new Set(),rows=[];
 for(const [index,t]of (Array.isArray(trades)?trades:[]).entries()){
  const stamp=Date.parse(t?.exchangeTime),price=numeric(t?.price),quantity=numeric(t?.quantity),id=String(t?.id??t?.tradeId??t?.uuid??'observation:'+index);
  if(!Number.isFinite(stamp)||!(price>0)||!(quantity>0)||seen.has(id))continue;
  seen.add(id);rows.push({stamp,price,quantity,index});
 }
 rows.sort((a,b)=>a.stamp-b.stamp||a.index-b.index);
 const bins=new Map(),step=CANDLE_INTERVALS[interval];
 for(const r of rows){const stamp=Math.floor(r.stamp/step)*step,c=bins.get(stamp);if(c){c.high=Math.max(c.high,r.price);c.low=Math.min(c.low,r.price);c.close=r.price;c.volume+=r.quantity;c.count++;}else bins.set(stamp,{stamp,open:r.price,high:r.price,low:r.price,close:r.price,volume:r.quantity,count:1});}
 return [...bins.values()].slice(-90);
}
export function observedDepth(snapshot){
 const clean=rows=>(Array.isArray(rows)?rows:[]).map(r=>({price:numeric(r.price),quantity:numeric(r.quantity)})).filter(r=>r.price>0&&r.quantity>0);
 if(snapshot?.liquidity?.kind==='AVIS_ORDER_BOOK')return {bids:clean(snapshot.liquidity.bids).sort((a,b)=>b.price-a.price),asks:clean(snapshot.liquidity.asks).sort((a,b)=>a.price-b.price),basis:'AVIS order book'};
 const q=snapshot?.market?.quote;return {bids:clean(q?[{price:q.bid,quantity:q.bidSize}]:[]),asks:clean(q?[{price:q.ask,quantity:q.askSize}]:[]),basis:'Published top of book'};
}
export function reviewedExchangeIntent(profile,side){
 if(!['BUY','SELL'].includes(side)||!profile)return null;
 const symbol=String(profile.symbol||'').toUpperCase();
 if(profile.venue!=='AVIS'||!/^[A-Z0-9._-]{1,80}$/.test(symbol))return null;
 return '#exchange?'+new URLSearchParams({side,symbol}).toString();
}
function candleChart(candles,interval){
 if(!candles.length)return '';
 const W=680,H=310,L=12,R=85,T=16,B=66,plotW=W-L-R,plotH=H-T-B,low=Math.min(...candles.map(c=>c.low)),high=Math.max(...candles.map(c=>c.high)),range=Math.max(high-low,Math.abs(high)*.0001,1e-8),pad=range*.12;
 const y=p=>T+(high+pad-p)/(range+pad*2)*plotH,step=plotW/Math.max(18,candles.length),x=i=>L+(i+.5)*step,maxVolume=Math.max(...candles.map(c=>c.volume),1e-12);
 const grid=Array.from({length:5},(_,i)=>{const price=high+pad-(range+pad*2)*i/4,Y=T+plotH*i/4;return `<path class="ar-grid" d="M${L} ${Y}H${W-R}"/><text x="${W-R+8}" y="${Y+4}">${esc(formatted(price))}</text>`;}).join('');
 const bars=candles.map((c,i)=>{const cls=c.close>=c.open?'ar-up':'ar-down',cw=Math.max(2,Math.min(11,step*.65)),vol=32*c.volume/maxVolume;return `<g class="${cls}"><title>${esc(new Date(c.stamp).toISOString())} · O ${esc(c.open)} H ${esc(c.high)} L ${esc(c.low)} C ${esc(c.close)} V ${esc(c.volume)}</title><path d="M${x(i)} ${y(c.high)}V${y(c.low)}"/><rect x="${x(i)-cw/2}" y="${Math.min(y(c.open),y(c.close))}" width="${cw}" height="${Math.max(1,Math.abs(y(c.close)-y(c.open)))}"/><rect class="ar-volume" x="${x(i)-cw/2}" y="${H-24-vol}" width="${cw}" height="${vol}"/></g>`;}).join('');
 const labels=candles.map((c,i)=>i===0||i===candles.length-1||i%Math.max(1,Math.floor(candles.length/4))===0?`<text x="${x(i)}" y="${H-5}" text-anchor="middle">${esc(new Date(c.stamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</text>`:'').join('');
 return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(interval)} candlesticks from observed exchange trades">${grid}${bars}${labels}</svg>`;
}
function depthChart(snapshot){
 const b=observedDepth(snapshot),levels=[...b.bids,...b.asks];if(!levels.length)return '<p class="ar-empty">No order-book observations in this response.</p>';
 const lo=Math.min(...levels.map(l=>l.price)),hi=Math.max(...levels.map(l=>l.price)),range=hi-lo||1,max=Math.max(b.bids.reduce((s,l)=>s+l.quantity,0),b.asks.reduce((s,l)=>s+l.quantity,0));
 const lines=[['ar-up',b.bids],['ar-down',b.asks]].map(([cls,rows])=>{let quantity=0;const points=rows.map(r=>{quantity+=r.quantity;return (25+(r.price-lo)/range*600)+','+(250-quantity/max*215);});return `<polyline class="ar-depth ${cls}" points="${points.join(' ')}"/>`;}).join('');
 return `<svg viewBox="0 0 680 285" role="img" aria-label="Observed cumulative market depth">${lines}<text x="25" y="278">${esc(formatted(lo))}</text><text x="625" y="278" text-anchor="end">${esc(formatted(hi))}</text></svg><p class="ar-source">${esc(b.basis)} · displayed levels only</p>`;
}
export function installApprovedRobot({host,api,isCurrent=()=>host?.isConnected,onConfigure=()=>{},onOrder=null}){
 const doc=host.ownerDocument,win=doc.defaultView;
 let mounted=false,closed=false,snapshot=null,interval='15m',tab='Chart',identity=null,marketRows=[],timer=null,manualTicker=false;
 const observed=new Map(),cleanup=[];
 const live=()=>!closed&&host.isConnected&&isCurrent(),q=s=>host.querySelector(s);
 const listen=(e,type,fn)=>{e.addEventListener(type,fn);cleanup.push(()=>e.removeEventListener(type,fn));};
 const create=(tag,cls,html='')=>{const e=doc.createElement(tag);e.className=cls;e.innerHTML=html;return e;};
 function mount(){
  if(!live()||mounted)return mounted;
  const board=q('.trading-live-workspace'),rail=q('.trading-live-robot'),price=q('.terminal-price-screen'),focus=q('[data-focus-execution]');if(!board||!rail||!price||!focus)return false;
  if(!doc.querySelector('link[data-approved-robot-style]')){const link=doc.createElement('link');link.rel='stylesheet';link.href='/approved-robot.css';link.dataset.approvedRobotStyle='';doc.head.append(link);}
  mounted=true;host.classList.add('approved-robot');host.closest('[data-trading-panel]')?.classList.add('approved-robot-panel');
  const viewport=create('div','ar-viewport');viewport.tabIndex=0;viewport.setAttribute('aria-label','Trading terminal, horizontally scrollable');board.before(viewport);viewport.append(board);board.classList.add('ar-board');
  focus.replaceChildren();const image=doc.createElement('img');image.src='/crypto-icons/robot-approved.jpg';image.alt='Multi Assets Algorithmic High Speed Trading Robot, feed by Global INDEX';image.width=891;image.height=1536;image.className='ar-robot-image';image.decoding='async';focus.append(image);
  const select=q('.trading-live-select');if(select)rail.append(select);
  const configure=create('button','ar-configure','Configure robot');configure.type='button';configure.dataset.arConfigure='';rail.append(configure);listen(configure,'click',onConfigure);
  const status=create('dl','ar-status');status.dataset.arStatus='';rail.append(status);
  const strip=create('div','ar-market-strip');strip.dataset.arMarkets='';strip.setAttribute('aria-label','Live market reference prices in USD');board.prepend(strip);
  const toolbar=create('div','ar-toolbar',`<div role="tablist" aria-label="Trading display" class="ar-tabs">${['Chart','Depth','Trades','Info'].map(t=>`<button type="button" role="tab" data-ar-tab="${t}" aria-selected="${t==='Chart'}">${t}</button>`).join('')}</div><div class="ar-periods" aria-label="Candle interval">${Object.keys(CANDLE_INTERVALS).map(t=>`<button type="button" data-ar-period="${t}" aria-pressed="${t===interval}">${t}</button>`).join('')}<button type="button" data-ar-expand aria-label="Expand chart">⤢</button><button type="button" data-ar-collapse aria-label="Close expanded chart" hidden>×</button></div>`);price.prepend(toolbar);
  const candles=create('div','ar-candles');candles.dataset.arCandles='';q('[data-live-chart]').after(candles);const other=create('div','ar-other');other.dataset.arOther='';other.hidden=true;candles.after(other);const source=create('p','ar-source');source.dataset.arCoverage='';other.after(source);
  const actions=q('.terminal-trading-actions');if(actions)price.append(actions);const feedback=q('[data-terminal-action-feedback]');if(feedback)price.append(feedback);
  const audit=q('[data-live-audit]');if(audit){const detail=create('details','ar-audit','<summary>Execution details</summary>');audit.before(detail);detail.append(audit);}
  const metrics=q('[data-live-financial-metrics]');if(metrics){metrics.classList.add('ar-metrics');board.append(metrics);}
  const ticker=create('div','ar-ticker','<button type="button" data-ar-scroll="-1" aria-label="Previous market prices">‹</button><div class="ar-ticker-window"><div class="ar-ticker-track" data-ar-ticker></div></div><button type="button" data-ar-scroll="1" aria-label="Next market prices">›</button>');viewport.after(ticker);
  const refresh=q('[data-live-refresh]');if(refresh){refresh.textContent='↻';refresh.setAttribute('aria-label','Refresh trading data');refresh.title='Refresh trading data';toolbar.append(refresh);}
  for(const b of toolbar.querySelectorAll('[data-ar-tab]'))listen(b,'click',()=>{tab=b.dataset.arTab;renderChart();});
  for(const b of toolbar.querySelectorAll('[data-ar-period]'))listen(b,'click',()=>{interval=b.dataset.arPeriod;tab='Chart';renderChart();});
  const collapse=toolbar.querySelector('[data-ar-collapse]');listen(toolbar.querySelector('[data-ar-expand]'),'click',()=>{price.classList.add('ar-expanded');collapse.hidden=false;collapse.focus();});listen(collapse,'click',()=>{price.classList.remove('ar-expanded');collapse.hidden=true;});listen(price,'keydown',e=>{if(e.key==='Escape'&&price.classList.contains('ar-expanded')){e.preventDefault();collapse.click();}});
  for(const b of ticker.querySelectorAll('[data-ar-scroll]'))listen(b,'click',()=>{manualTicker=true;ticker.querySelector('.ar-ticker-track').classList.remove('ar-running');ticker.querySelector('.ar-ticker-window').scrollBy?.({left:Number(b.dataset.arScroll)*300,behavior:'smooth'});});
  // Keep server-side order review and trading limits; a display cannot submit funds.
  for(const [selector,side]of [['[data-trading-buy]','BUY'],['[data-trading-sell]','SELL']]){const button=q(selector);if(!button)continue;const original=button.onclick;button.onclick=()=>{const profile=snapshot?.profiles?.find(p=>p.robotId===snapshot.selectedRobotId);if(!profile){onConfigure();return;}const hash=reviewedExchangeIntent(profile,side);if(hash){if(onOrder)onOrder({hash,profile,side});else win.location.hash=hash;return;}q('[data-terminal-action-feedback]').textContent=side+' · '+profile.symbol+' · '+profile.venue+' — open the configured venue order review.';original?.();};cleanup.push(()=>button.onclick=original);}
  void refreshMarkets();return true;
 }
 async function refreshMarkets(){
  clearTimeout(timer);if(!live())return;
  try{const r=await api('views/cryptomarkets');if(live()){marketRows=Array.isArray(r?.rows)?r.rows:[];renderMarkets();}}catch{/* Keep the last received observations. */}
  if(live()){timer=setTimeout(refreshMarkets,30000);timer.unref?.();}
 }
 function renderMarkets(){
  if(!mounted||!live())return;const rows=marketRows.filter(r=>r.currency_code&&numeric(r.market_data?.usd)>0),priority=['BTC','ETH','AG','AGI'];const top=priority.map(code=>rows.find(r=>String(r.currency_code).toUpperCase()===code)).filter(Boolean);for(const r of rows)if(top.length<4&&!top.includes(r))top.push(r);
  const card=(r,compact=false)=>{const code=String(r.currency_code).toUpperCase(),m=r.market_data,change=numeric(m.change24h),src=code==='AG'?'/crypto-icons/ag.png':code==='AGI'?'/crypto-icons/agi.png':/^https:\/\/(assets|coin-images)\.coingecko\.com\//.test(r.icon_url||'')?r.icon_url:null;return `<div class="ar-market ${compact?'ar-market-small':''}" title="${esc(m.observedAt||'')}">${src?`<img src="${esc(src)}" alt="" width="28" height="28">`:`<span class="ar-coin">${esc(r.currency_code)}</span>`}<div><strong>${esc(r.currency_code)} / USD</strong><span>${esc(formatted(m.usd))} ${change===null?'':`<em class="${change<0?'ar-negative':'ar-positive'}">${change>0?'+':''}${esc(change.toFixed(2))}%</em>`}</span></div></div>`;};
  q('[data-ar-markets]').innerHTML=top.map(r=>card(r)).join('');const items=rows.slice(0,100).map(r=>card(r,true)).join(''),track=q('[data-ar-ticker]');track.innerHTML='<div class="ar-ticker-copy">'+items+'</div><div class="ar-ticker-copy" aria-hidden="true">'+items+'</div>';track.classList.toggle('ar-running',rows.length>4&&!manualTicker);
 }
 function renderChart(){
  if(!mounted||!snapshot||!live())return;
  const recorded=q('[data-live-chart]'),candles=q('[data-ar-candles]'),other=q('[data-ar-other]'),coverage=q('[data-ar-coverage]'),bars=tradeCandles([...observed.values()],interval);
  host.querySelectorAll('[data-ar-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.arTab===tab)));host.querySelectorAll('[data-ar-period]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.arPeriod===interval)));
  recorded.hidden=tab!=='Chart'||bars.length>0;candles.hidden=tab!=='Chart'||!bars.length;other.hidden=tab==='Chart';
  const legend=q('.trading-chart-caption');if(legend)legend.hidden=tab!=='Chart'||bars.length>0;
  if(tab==='Chart'){candles.innerHTML=candleChart(bars,interval);coverage.textContent=bars.length?interval+' · '+observed.size+' observed exchange trades · volume in '+(snapshot.market?.baseAsset||'base asset'):'Recorded bid / ask observations';}
  else if(tab==='Depth'){other.innerHTML=depthChart(snapshot);coverage.textContent='';}
  else if(tab==='Trades'){other.innerHTML=q('[data-live-trades]').innerHTML;coverage.textContent='Exchange trade tape · not account executions';}
  else{const p=snapshot.profiles?.find(p=>p.robotId===snapshot.selectedRobotId),m=snapshot.market;other.innerHTML='<dl class="ar-info">'+[['Market provider',m?.provider],['Market symbol',m?.symbolId],['Execution venue',p?.venue],['Base / quote',[m?.baseAsset,m?.quoteAsset].filter(Boolean).join(' / ')],['Received',m?.quote?.receivedAt],['Robot profile',p?.name]].map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(v||'—')+'</dd>').join('')+'</dl>';coverage.textContent='';}
 }
 function update(data){
  if(!live()||data?.schemaVersion!==1||!Array.isArray(data.profiles)||!mount())return;
  const selected=q('[data-live-profile]')?.value||null;if(selected!==(data.selectedRobotId||null))return;
  snapshot=data;const key=JSON.stringify([data.selectedRobotId,data.market?.provider,data.market?.symbolId]);if(key!==identity){identity=key;observed.clear();}
  const occurrences=new Map();for(const t of data.market?.trades||[]){const fingerprint=[t.exchangeTime,t.price,t.quantity,t.takerSide].join(':'),n=occurrences.get(fingerprint)||0;occurrences.set(fingerprint,n+1);const id=String(t.id??t.tradeId??t.uuid??fingerprint+':'+n);observed.set(id,{...t,id});}while(observed.size>5000)observed.delete(observed.keys().next().value);
  const profile=data.profiles.find(p=>p.robotId===data.selectedRobotId),quote=data.market?.quote,age=Date.now()-Date.parse(quote?.receivedAt),fresh=data.market?.connection?.state==='OPEN'&&quote?.stale===false&&age>=-1000&&age<=30000;
  q('[data-ar-configure]').hidden=!!profile;q('[data-ar-status]').innerHTML=[['Market data',fresh?'Connected':data.market?.connection?.state||'—',fresh],['Execution venue',profile?.venue||'—',false],['Strategy',profile?(profile.enabled&&profile.testReviewed?'Entries enabled':'Entries paused'):'—',profile?.enabled&&profile?.testReviewed],['Account executions',data.audit?.totals?.executedOrders??'—',false]].map(([k,v,ok])=>'<div><dt>'+esc(k)+'</dt><dd'+(ok?' class="ar-positive"':'')+'>'+esc(v)+'</dd></div>').join('');
  const auto=q('[data-trading-auto]');if(auto&&profile&&!profile.enabled&&profile.testReviewed!==true)auto.disabled=true;
  // Fee currency does not prove fee type: show only explicitly typed totals.
  const totals=data.audit?.totals,base=profile?.baseAsset||data.market?.baseAsset||'',currency=profile?.quoteAsset||data.market?.quoteAsset||'',fees=totals?.fees||[],feeText=rows=>Array.isArray(rows)&&rows.length?rows.map(f=>formatted(f.amount)+' '+String(f.asset||'')).join(' / '):'—';
  q('[data-live-financial-metrics]').innerHTML='<dl class="trading-live-details">'+[['Trading volume',totals?.baseVolume==null?'—':formatted(totals.baseVolume)+' '+base],['Trading benefit (realised)',totals?.netRealisedPnl==null?'—':formatted(totals.netRealisedPnl)+' '+currency],['Gas fees (network)',feeText(totals?.networkGasFees||fees.filter(f=>['NETWORK','GAS'].includes(f.kind)))],['AVIS fees',feeText(totals?.avisFees||fees.filter(f=>f.kind==='AVIS'))]].map(([k,v])=>'<div><dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd></div>').join('')+'</dl>';renderChart();
 }
 return {mount,update,close(){closed=true;clearTimeout(timer);cleanup.forEach(fn=>fn());observed.clear();}};
}
