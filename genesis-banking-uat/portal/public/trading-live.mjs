const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=value=>value===null||value===undefined?'—':String(value).replace(/^([+-]?\d+)(.*)$/,(_,whole,tail)=>whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+tail);
const time=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():'—';
const positive=value=>typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)&&/[1-9]/.test(value);

// First reads establish a baseline. Repeated polls, selections and old imports
// cannot impersonate a new execution; animation is only a short view of a new fill.
export function createExecutionActivity({maxSeen=2000,freshMs=30000}={}){
 const robots=new Map();
 return {observe(robotId,fills,now=Date.now()){
  if(!robotId)return null;
  const rows=Array.isArray(fills)?fills:[],ids=new Set(rows.map(fill=>fill.id).filter(Boolean));
  if(!robots.has(robotId)){robots.set(robotId,new Set(ids));return null;}
  const seen=robots.get(robotId),newFills=[];
  for(const fill of rows){
   if(!fill.id||seen.has(fill.id))continue;seen.add(fill.id);
   const observed=Date.parse(fill.executedAt||fill.recordedAt);
   if(['BUY','SELL'].includes(fill.side)&&positive(fill.quantity)&&Number.isFinite(observed)&&observed<=now+1000&&now-observed<=freshMs)newFills.push(fill);
  }
  for(const id of seen){if(seen.size<=maxSeen)break;if(!ids.has(id))seen.delete(id);}
  if(robots.size>50)for(const id of robots.keys()){if(id!==robotId){robots.delete(id);break;}}
  return newFills.sort((a,b)=>Date.parse(b.executedAt||b.recordedAt)-Date.parse(a.executedAt||a.recordedAt))[0]||null;
 }};
}

function robotArtwork(){
 const id='trader-'+crypto.randomUUID();
 return \`<svg class="trading-robot-art" viewBox="0 0 260 310" aria-hidden="true" focusable="false">
 <defs>
  <linearGradient id="\${id}-chrome" x1=".08" y1="0" x2=".9" y2="1"><stop stop-color="#fafffd"/><stop offset=".13" stop-color="#d5e7e1"/><stop offset=".33" stop-color="#ffffff"/><stop offset=".55" stop-color="#94aaa6"/><stop offset=".77" stop-color="#edf5f1"/><stop offset="1" stop-color="#677c78"/></linearGradient>
  <linearGradient id="\${id}-black" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#132c29"/><stop offset=".56" stop-color="#203e39"/><stop offset="1" stop-color="#091d1c"/></linearGradient>
  <linearGradient id="\${id}-glass" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#103d38"/><stop offset=".4" stop-color="#0a2726"/><stop offset="1" stop-color="#1d594c"/></linearGradient>
  <linearGradient id="\${id}-mint" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#a1f5d9"/><stop offset=".5" stop-color="#f4fff4"/><stop offset="1" stop-color="#6abda6"/></linearGradient>
  <linearGradient id="\${id}-gold" x1="0" y1="0" x2=".75" y2="1"><stop stop-color="#faeec2"/><stop offset=".55" stop-color="#aa9567"/><stop offset="1" stop-color="#e7dac0"/></linearGradient>
  <filter id="\${id}-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
 </defs>
 <ellipse cx="130" cy="293" rx="77" ry="10" fill="#274e4438"/>
 <g class="trading-robot-frame" stroke="#65827b" stroke-linejoin="round">
  <path d="M103 224 L99 267 L122 274 L129 232Z" fill="url(#\${id}-black)" stroke-width="2"/>
  <path d="M133 232 L141 274 L161 267 L157 224Z" fill="url(#\${id}-black)" stroke-width="2"/>
  <path d="M99 260 L122 265 L119 286 L85 287 Q82 277 90 271Z" fill="url(#\${id}-chrome)"/>
  <path d="M140 265 L161 260 L169 271 Q177 277 174 287 L142 286Z" fill="url(#\${id}-chrome)"/>
  <path d="M103 235 L119 240 M143 240 L156 235" stroke="#b1edcf" stroke-width="2"/>
  <path d="M113 124 L149 124 L155 148 L108 148Z" fill="url(#\${id}-black)"/>
  <path d="M67 152 L89 132 L169 132 L193 152 L181 222 Q129 245 80 222Z" fill="url(#\${id}-chrome)" stroke-width="2"/>
  <path d="M87 149 Q130 134 172 149 L166 211 Q130 224 92 211Z" fill="url(#\${id}-black)" stroke-width="1.4"/>
  <path d="M98 154 Q129 146 161 154 L155 197 Q129 207 103 197Z" fill="url(#\${id}-glass)" stroke="#659b89"/>
  <path d="M105 217 Q131 225 156 217 L150 238 Q129 249 109 238Z" fill="url(#\${id}-chrome)"/>
  <path d="M108 225 L151 225" stroke="#fff" stroke-opacity=".8"/>
  <path d="M92 147 L102 148 L105 210 L96 207 M159 148 L168 147 L164 207 L156 210" fill="#d4f0e8" stroke-width="1"/>
  <path d="M124 123 L124 134 M138 123 L138 134" stroke="url(#\${id}-gold)" stroke-width="2"/>
  <g data-robot-arm="BUY">
   <path d="M75 144 L58 147 L41 179 L51 194 L69 171 L82 166Z" fill="url(#\${id}-chrome)" stroke-width="2"/>
   <circle cx="62" cy="153" r="11" fill="url(#\${id}-black)"/><circle cx="62" cy="153" r="5" fill="url(#\${id}-gold)"/>
   <path d="M43 183 L31 213 L43 231 L58 224 L58 207 L54 188Z" fill="url(#\${id}-chrome)" stroke-width="2"/>
   <path d="M40 220 L39 247 L50 254 L60 240 L56 225Z" fill="url(#\${id}-black)"/>
   <path d="M34 213 L51 222 M41 235 L54 241" stroke="#b0f1d8" stroke-width="2"/>
  </g>
  <g data-robot-arm="SELL">
   <path d="M184 144 L201 147 L219 179 L209 194 L191 171 L178 166Z" fill="url(#\${id}-chrome)" stroke-width="2"/>
   <circle cx="198" cy="153" r="11" fill="url(#\${id}-black)"/><circle cx="198" cy="153" r="5" fill="url(#\${id}-gold)"/>
   <path d="M217 183 L229 213 L217 231 L202 224 L202 207 L206 188Z" fill="url(#\${id}-chrome)" stroke-width="2"/>
   <path d="M220 220 L221 247 L210 254 L200 240 L204 225Z" fill="url(#\${id}-black)"/>
   <path d="M226 213 L209 222 M219 235 L206 241" stroke="#b0f1d8" stroke-width="2"/>
  </g>
  <path d="M79 62 L93 42 L169 42 L181 62 L187 95 L176 124 L149 135 L111 135 L84 124 L73 95Z" fill="url(#\${id}-chrome)" stroke-width="2.5"/>
  <path d="M92 63 Q129 52 168 63 L175 91 L163 112 Q131 127 96 113 L85 91Z" fill="url(#\${id}-glass)" stroke="#4b8578" stroke-width="2"/>
  <path d="M89 58 L103 50 L159 50 L172 58 M81 98 L98 121 L161 121 L180 98" fill="none" stroke="#f4fffa" stroke-width="2"/>
  <path d="M110 119 L150 119 L143 127 L117 127Z" fill="url(#\${id}-gold)" stroke-width=".5"/>
  <path d="M73 78 L66 84 L67 99 L79 108 M187 78 L194 84 L193 99 L181 108" fill="url(#\${id}-black)" stroke-width="2"/>
  <path d="M130 42 L130 27" stroke="#b9ddce" stroke-width="3"/>
  <circle cx="130" cy="24" r="6" fill="url(#\${id}-gold)" stroke="#e9fffa" stroke-width="1"/>
 </g>
 <g class="trading-robot-eyes" fill="url(#\${id}-mint)" filter="url(#\${id}-glow)">
  <path d="M97 79 L118 80 L120 88 L98 88Z"/>
  <path d="M142 80 L163 79 L162 88 L140 88Z"/>
  <path d="M120 104 Q130 108 140 104" fill="none" stroke="#9bedd2" stroke-width="2"/>
 </g>
 <path class="trading-robot-w" d="M108 169 L118 194 L130 179 L143 194 L153 169" fill="none" stroke="url(#\${id}-mint)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" filter="url(#\${id}-glow)"/>
 <path d="M110 158 L150 158 M111 201 L149 201" stroke="#b7c5b2" stroke-width=".7"/>
 <g fill="url(#\${id}-gold)"><circle cx="93" cy="143" r="2"/><circle cx="167" cy="143" r="2"/><circle cx="110" cy="219" r="2"/><circle cx="152" cy="219" r="2"/></g>
 <path class="trading-robot-signal" d="M129 142v10m-30 83-2 16m64-16 2 16" fill="none" stroke="#70c3a9" stroke-width="2"/>
 </svg>\`;
}

const details=rows=>'<dl class="trading-live-details">'+rows.map(([label,value])=>'<div><dt>'+escape(label)+'</dt><dd>'+escape(value??'—')+'</dd></div>').join('')+'</dl>';
const unit=(value,currency)=>value===null||value===undefined?'—':amount(value)+(currency?' '+currency:'');
const table=(columns,rows)=>'<div class="trading-live-table"><table><thead><tr>'+columns.map(([,label])=>'<th scope="col">'+escape(label)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr data-execution-id="'+escape(row.id||'')+'" tabindex="-1">'+columns.map(([key,,format])=>'<td>'+escape(format?format(row[key],row):row[key]??'—')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
const fees=rows=>Array.isArray(rows)&&rows.length?rows.map(row=>unit(row.amount,row.asset)).join(' · '):'—';
const fillColumns=[['side','Side'],['quantity','Executed quantity',amount],['price','Price',amount],['quoteValue','Quote value',amount],['fees','Fees',fees],['executedAt','Executed',time],['recordedAt','Recorded',time],['evidence','Evidence'],['id','Execution reference']];
const orderColumns=[['side','Side'],['status','State'],['requestedQuantity','Requested',amount],['executedQuantity','Executed',amount],['averagePrice','Average price',amount],['quoteValue','Quote value',amount],['createdAt','Created',time],['recordedAt','Recorded',time],['id','Order reference']];
const yesNo=value=>value===true?'Yes':value===false?'No':'—';
const levelColumns=[['price','Price',amount],['quantity','Quantity',amount],['quoteValue','Quote value',amount],['orders','Orders']];
const lotColumns=[['side','Side'],['quantity','Whole-lot quantity',amount],['price','Price',amount],['quoteValue','Quote value',amount],['reservationConsistent','Reservation check',yesNo],['submittedAt','Submitted',time],['orderId','Order reference']];

function backingReport(result){
 return '<p class="crypto-source">Audit response at '+escape(time(result.observedAt))+'</p>'+result.cards.map(card=>{
  const chain=card.chain,security=chain?.security,proof=chain?.proof;
  return '<article class="trading-security-proof"><h4>'+escape(card.name)+' · '+escape(card.network)+'</h4>'+(chain?details([['Proof observed',time(chain.observedAt)],['Finalized checkpoint',yesNo(proof?.finalized)],['Canonical checkpoint rechecked',yesNo(proof?.canonicalRechecked)],['Block',proof?.blockNumber],['Block hash',proof?.blockHash],['Checkpoint time',time(proof?.blockTime)],['Contract',chain.identity?.contractAddress],['Registered ISIN',chain.identity?.isin],['Total supply',unit(security?.totalSupply,card.symbol)],['Custody cap',unit(security?.custodyCap,card.symbol)],['Bridged supply',unit(security?.bridgedOutSupply,card.symbol)],['Locked margin collateral',unit(security?.lockedMarginCollateral,card.symbol)],['Committed security amount',unit(security?.committedSecurityAmount,card.symbol)],['Committed margin power',unit(security?.committedMarginPower,security?.capacityCurrency)],['Available trading power',unit(security?.availableTradingPower,security?.capacityCurrency)],['Capacity basis',security?.capacityBasis==='CONFIGURED_COLLATERAL_VALUATION'?'Configured collateral valuation':security?.capacityBasis]])+'<h5>Settlement assets</h5>'+table([['asset','Asset'],['escrow','Escrow',amount],['accumulatedFees','Accumulated fees',amount],['contractBalance','Contract balance',amount],['operatorBalance','Operator balance',amount],['operatorAllowance','Operator allowance',amount],['escrowCovered','Escrow covered',yesNo]],chain.settlement||[]):'<p class="form-error">'+escape(card.errorCode||'The security state could not be read.')+'</p>')+'</article>';
 }).join('');
}

function chart(samples){
 const width=620,height=136,padding=12;
 if(!samples.length)return '<svg viewBox="0 0 620 136" role="img" aria-label="Recorded bid and ask prices"><text x="310" y="72" text-anchor="middle">Market observations will appear here.</text></svg>';
 const values=samples.flatMap(sample=>[Number(sample.bid),Number(sample.ask)]),low=Math.min(...values),high=Math.max(...values),range=high-low||Math.max(Math.abs(low)*.001,.00001),first=samples[0].stamp,last=samples.at(-1).stamp;
 const point=(sample,key)=>[(last===first?width/2:padding+(sample.stamp-first)/(last-first)*(width-padding*2)).toFixed(2),(height-padding-(Number(sample[key])-low)/range*(height-padding*2)).toFixed(2)].join(',');
 return '<svg viewBox="0 0 620 136" role="img" aria-label="Recorded bid and ask prices">'+['bid','ask'].map(key=>'<polyline class="quote-'+key+'" points="'+samples.map(sample=>point(sample,key)).join(' ')+'"/><circle class="quote-'+key+'" cx="'+point(samples.at(-1),key).split(',')[0]+'" cy="'+point(samples.at(-1),key).split(',')[1]+'" r="3"/>').join('')+'</svg>';
}

export async function mountTradingLive({api,host,isCurrent=()=>host?.isConnected,onSelection=()=>{},selectedRobotId=null,pollMs=2000}){
 const current=()=>host?.isConnected&&isCurrent();if(!current())return;
 let selected=selectedRobotId,snapshot=null,profiles=[],epoch=0,liquidityEpoch=0,liquidityBusy=false,backingBinding=null,loading=false,closed=false,pollTimer=null,activityTimer=null,side='ALL',focused=null;
 const live=()=>!closed&&current(),activity=createExecutionActivity(),samplesByRobot=new Map(),document=host.ownerDocument;
 const query=selector=>host.querySelector(selector);
 host.innerHTML=`<section class="trading-live" aria-labelledby="trading-live-title"><div class="trading-live-heading"><div><p class="eyebrow">W-EFFECT · MARKET & EXECUTION</p><h3 id="trading-live-title">Live trading view</h3></div><button type="button" data-live-refresh>Refresh view</button></div><label class="trading-live-select">Robot & market<select aria-label="Robot & market" data-live-profile><option value="">Select a saved robot</option></select></label><div class="trading-live-workspace"><aside class="trading-live-robot" data-robot-activity=""><div class="trading-robot-name"><strong data-live-robot-name>W-effect</strong><span data-live-robot-state>—</span></div><button type="button" class="trading-robot-focus" data-focus-execution aria-label="Focus latest execution" disabled>${robotArtwork()}</button><div class="trading-robot-latest" data-live-latest><strong>Executed trades</strong><span>—</span></div><div class="trading-robot-filters" aria-label="Execution filter"><button type="button" data-live-side="ALL" aria-pressed="true">All</button><button type="button" data-live-side="BUY" aria-pressed="false">Buy executions</button><button type="button" data-live-side="SELL" aria-pressed="false">Sell executions</button></div></aside><section class="terminal-live-trades"><h4>Last Trades <span>Live</span></h4><div data-live-trades class="terminal-scroll-tape"></div></section><section class="terminal-live-book"><h4>Order Book</h4><div data-live-depth class="terminal-scroll-tape"></div></section><div class="trading-live-screen terminal-price-screen"><div class="trading-market-heading"><strong data-live-symbol>—</strong><span data-live-source>—</span></div><div data-live-quote></div><div class="trading-live-chart" data-live-chart></div><p class="trading-chart-caption"><span><i class="quote-bid-key"></i> Bid <i class="quote-ask-key"></i> Ask</span><span data-live-samples>0 recorded quotes</span></p><p class="crypto-source" data-live-market-time></p><div class="trading-live-audit" data-live-audit></div></div></div><div class="terminal-trading-actions"><button type="button" class="terminal-buy" data-trading-buy>BUY / LONG</button><button type="button" class="terminal-sell" data-trading-sell>SELL / SHORT</button><label class="terminal-auto"><span>Auto Trading</span><input type="checkbox" data-trading-auto><span class="terminal-switch"></span></label></div><div class="terminal-action-feedback" data-terminal-action-feedback role="status"></div><div class="terminal-live-metrics" data-live-financial-metrics></div><p class="form-error" role="alert" data-live-error></p><div data-live-executions></div><details class="trading-live-liquidity" data-live-liquidity hidden><summary>AVIS order book & security backing</summary><div data-live-book></div><div class="crypto-inline-actions"><button type="button" data-read-backing disabled>Read security backing</button><span data-backing-progress role="status"></span></div><p class="form-error" data-backing-error role="alert"></p><div data-live-backing></div></details><details class="trading-live-orders"><summary>Orders & execution audit</summary><div data-live-orders></div><div data-live-reconciliation></div></details></section>`;
 const selector=query('[data-live-profile]'),refreshButton=query('[data-live-refresh]'),issue=query('[data-live-error]'),robot=query('.trading-live-robot'),focusButton=query('[data-focus-execution]');
 function clearActivity(){clearTimeout(activityTimer);robot.dataset.robotActivity='';}
 function clearSelected(){
  clearActivity();liquidityEpoch++;liquidityBusy=false;backingBinding=null;query('[data-live-liquidity]').hidden=true;query('[data-live-book]').innerHTML='';query('[data-live-backing]').innerHTML='';query('[data-backing-error]').textContent='';query('[data-backing-progress]').textContent='';focused=null;focusButton.disabled=true;query('[data-live-latest]').innerHTML='<strong>Executed trades</strong><span>—</span>';query('[data-live-robot-name]').textContent='W-effect';query('[data-live-robot-state]').textContent='—';query('[data-live-symbol]').textContent='—';query('[data-live-source]').textContent='—';query('[data-live-market-time]').textContent='';query('[data-live-trades]').innerHTML='';query('[data-live-depth]').innerHTML='';query('[data-live-financial-metrics]').innerHTML='';query('[data-trading-auto]').checked=false;query('[data-trading-auto]').disabled=true;query('[data-live-quote]').innerHTML=details([['Bid','—'],['Ask','—'],['Bid size','—'],['Ask size','—']]);query('[data-live-chart]').innerHTML=chart([]);query('[data-live-samples]').textContent='0 recorded quotes';query('[data-live-audit]').innerHTML='';query('[data-live-executions]').innerHTML='';query('[data-live-orders]').innerHTML='';query('[data-live-reconciliation]').innerHTML='';
 }
 function renderExecutions(){
  const rows=(snapshot?.audit?.fills||[]).filter(fill=>side==='ALL'||fill.side===side);
  query('[data-live-executions]').innerHTML='<div class="trading-execution-heading"><h4>Recorded executions</h4><span>'+escape(side==='ALL'?'All sides':side==='BUY'?'Buy executions':'Sell executions')+' · '+rows.length+'</span></div>'+(rows.length?table(fillColumns,rows):'<p class="crypto-source">No recorded executions in this selection.</p>');
  host.querySelectorAll('[data-live-side]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.liveSide===side)));
  for(const row of query('[data-live-executions]').querySelectorAll('[data-execution-id]')){
   row.classList.toggle('is-focused',row.dataset.executionId===focused);row.onclick=()=>{focused=row.dataset.executionId;renderExecutions();};
  }
 }
 function render(data){
  const profile=data.profiles.find(profile=>profile.robotId===data.selectedRobotId),market=data.market,quote=market?.quote,audit=data.audit,totals=audit?.totals,base=profile?.baseAsset??market?.baseAsset,quoteAsset=profile?.quoteAsset??market?.quoteAsset,priceUnit=data.liquidity?.quoteBasis==='PERCENT'?'%':quoteAsset;
  query('[data-live-robot-name]').textContent=profile?.name||'W-effect';query('[data-live-robot-state]').textContent=profile?(profile.enabled&&profile.testReviewed?'Entries enabled':'Entries paused'):'—';query('[data-live-symbol]').textContent=profile?profile.symbol+' · '+profile.venue:market?.reference?[base,quoteAsset].filter(Boolean).join('/')+' · Reference market':'—';
  query('[data-live-source]').textContent=market?[market.provider,market.symbolId,({CONNECTING:'Connecting',OPEN:'Open',CLOSED:'Closed',ERROR:'Connection error'})[market.connection?.state]].filter(Boolean).join(' · '):'—';
  query('[data-live-quote]').innerHTML=details([['Bid',unit(quote?.bid,priceUnit)],['Ask',unit(quote?.ask,priceUnit)],['Bid size',unit(quote?.bidSize,base)],['Ask size',unit(quote?.askSize,base)]]);
  const trades=Array.isArray(market?.trades)?market.trades.filter(t=>t&&t.price&&t.quantity):[];
  query('[data-live-trades]').innerHTML=trades.length?'<table><thead><tr><th>Time</th><th>Price</th><th>Size</th></tr></thead><tbody>'+trades.slice(0,25).map(t=>'<tr class="'+(t.takerSide==='BUY'?'terminal-up':'terminal-down')+'"><td>'+escape(Number.isFinite(Date.parse(t.exchangeTime))?new Date(t.exchangeTime).toLocaleTimeString():'—')+'</td><td>'+escape(t.price)+'</td><td>'+escape(t.quantity)+'</td></tr>').join('')+'</tbody></table>':'<p>Awaiting exchange trades</p>';
  const levels=data.liquidity?.kind==='AVIS_ORDER_BOOK'?[...(data.liquidity.asks||[]).slice(0,8).map(row=>({side:'ASK',price:row.price,quantity:row.quantity})),...(data.liquidity.bids||[]).slice(0,8).map(row=>({side:'BID',price:row.price,quantity:row.quantity}))]:quote?[{side:'ASK',price:quote.ask,quantity:quote.askSize},{side:'BID',price:quote.bid,quantity:quote.bidSize}]:[];
  query('[data-live-depth]').innerHTML=levels.length?'<table><thead><tr><th>Side</th><th>Price</th><th>Size</th></tr></thead><tbody>'+levels.map(l=>'<tr class="'+(l.side==='BID'?'terminal-up':'terminal-down')+'"><td>'+escape(l.side)+'</td><td>'+escape(l.price)+'</td><td>'+escape(l.quantity)+'</td></tr>').join('')+'</tbody></table>':'<p>Awaiting live order book</p>';
  query('[data-trading-auto]').checked=Boolean(profile?.enabled);
  query('[data-trading-auto]').disabled=!profile;
  query('[data-live-financial-metrics]').innerHTML=details([['Trading volume',unit(totals?.baseVolume,base)],['Realised trading benefit',unit(totals?.netRealisedPnl,quoteAsset)],['Network gas fees',fees((totals?.fees||[]).filter(f=>/GAS|ETH|BNB|TRX/i.test(f.asset||'')))],['AVIS trading fees',fees((totals?.fees||[]).filter(f=>/AVIS|AGI?/i.test(f.asset||'')))]]);

  query('[data-live-market-time]').textContent=quote?(quote.stale?'Last recorded quote':'Quote')+' · Exchange '+time(quote.exchangeTime)+' · Received '+time(quote.receivedAt):'';
  const sampleKey=[selected,market?.provider,market?.symbolId].join(':'),samples=samplesByRobot.get(sampleKey)||[],stamp=Date.parse(quote?.exchangeTime||quote?.receivedAt);
  if(quote&&Number.isFinite(stamp)&&[quote.bid,quote.ask].every(value=>typeof value==='string'&&Number.isFinite(Number(value))&&Number(value)>0)&&(!samples.length||stamp>samples.at(-1).stamp)){
   samples.push({stamp,bid:quote.bid,ask:quote.ask});if(samples.length>90)samples.shift();samplesByRobot.set(sampleKey,samples);if(samplesByRobot.size>50)samplesByRobot.delete(samplesByRobot.keys().next().value);
  }
  query('[data-live-chart]').innerHTML=chart(samples);query('[data-live-samples]').textContent=samples.length+' recorded quote'+(samples.length===1?'':'s')+' in this view';
  query('[data-live-audit]').innerHTML=details([['Executed base volume',unit(totals?.baseVolume,base)],['Executed quote volume',unit(totals?.quoteVolume,quoteAsset)],['Gross realised profit',unit(totals?.grossRealisedPnl,quoteAsset)],['Net realised profit',unit(totals?.netRealisedPnl,quoteAsset)],['Recorded realised P&L',unit(totals?.recordedRealisedPnl,quoteAsset)],['Unrealised P&L',unit(totals?.unrealisedPnl,quoteAsset)],['Open position',unit(totals?.positionQuantity,base)],['Cost basis',unit(totals?.costBasis,quoteAsset)],['Executed orders',totals?.executedOrders],['Fees by currency',fees(totals?.fees)]])+(totals?.unpricedFeeAssets?.length?'<p class="crypto-source">Fees awaiting quote-currency valuation: '+escape(totals.unpricedFeeAssets.join(', '))+'.</p>':'');
  const latest=audit?.fills?.find(fill=>positive(fill.quantity));focusButton.disabled=!latest;
  query('[data-live-latest]').innerHTML=latest?'<strong>'+escape(latest.side)+' · '+escape(unit(latest.quantity,base))+'</strong><span>'+escape(latest.executedAt?'Executed '+time(latest.executedAt):'Recorded '+time(latest.recordedAt))+'</span>':'<strong>Executed trades</strong><span>—</span>';
  const next=activity.observe(selected,audit?.fills);
  if(next){clearActivity();robot.dataset.robotActivity=next.side;activityTimer=setTimeout(()=>{if(live())robot.dataset.robotActivity='';},1800);activityTimer.unref?.();}
  const book=data.liquidity,bookSection=query('[data-live-liquidity]'),backingButton=query('[data-read-backing]');bookSection.hidden=book?.kind!=='AVIS_ORDER_BOOK';
  const binding=book?.kind==='AVIS_ORDER_BOOK'?JSON.stringify([selected,book.securityId,(book.securityTokens||[]).map(card=>[card.cardId,card.network,card.contractAddress,card.hubAddress,card.registeredAt])]):null;
  if(binding!==backingBinding){backingBinding=binding;liquidityEpoch++;liquidityBusy=false;query('[data-live-backing]').innerHTML='';query('[data-backing-error]').textContent='';query('[data-backing-progress]').textContent='';}
  if(book?.kind==='AVIS_ORDER_BOOK'){
   const lotsOpen=query('[data-live-lots]')?.open,registered=book.securityTokens||[];
   query('[data-live-book]').innerHTML='<p class="crypto-source">'+escape(book.lots?.length||0)+' of '+escape(book.totalOrders)+' open orders · '+escape(book.wholeLotsOnly?'Whole-lot execution':'')+' · '+escape(book.baseAsset)+' / '+escape(book.quoteAsset)+'</p><div class="trading-book-levels"><section><h4>Bids</h4>'+table(levelColumns,book.bids||[])+'</section><section><h4>Asks</h4>'+table(levelColumns,book.asks||[])+'</section></div><details data-live-lots '+(lotsOpen?'open':'')+'><summary>Whole lots · '+(book.lots?.length||0)+'</summary>'+table(lotColumns,book.lots||[])+'<p class="crypto-source">'+escape(book.reservationBasis||'')+'</p></details><h4>Registered security tokens</h4>'+(registered.length?table([['name','Security'],['network','Blockchain'],['state','State'],['registeredTokenQuantity','Registered token quantity',amount],['reservedSourceQuantity','Reserved source quantity',amount],['contractAddress','Contract']],registered):'<p class="crypto-source">No token registration recorded for this security.</p>');
   backingButton.disabled=liquidityBusy||!registered.some(card=>card.contractAddress&&card.hubAddress);
  }
  renderExecutions();const orders=audit?.orders||[],coverage=audit?.coverage;
  query('[data-live-orders]').innerHTML=(orders.length?table(orderColumns,orders):'<p class="crypto-source">No recorded orders in this selection.</p>')+(coverage?'<p class="crypto-source">'+escape(coverage.scope==='ALL_RECORDED_ORDERS'?'All recorded orders':'Recent recorded orders')+' · '+escape(coverage.ordersIncluded)+' of '+escape(coverage.totalOrders)+' orders included in totals. Showing '+orders.length+' orders and '+(audit.fills?.length||0)+' fills.</p>':'');
  const reconciled=value=>value===true?'Yes':value===false?'No':'—';
  query('[data-live-reconciliation]').innerHTML=details([['Position reconciled',reconciled(audit?.reconciliation?.positionMatches)],['Cost basis reconciled',reconciled(audit?.reconciliation?.costBasisMatches)],['Realised P&L reconciled',reconciled(audit?.reconciliation?.realisedPnlMatches)],['Read at',time(data.observedAt)]])+(audit?.issues?.length?'<p class="crypto-source">'+escape(audit.issues.map(value=>typeof value==='string'?value:JSON.stringify(value)).join(' · '))+'</p>':'');
 }
 function schedule(){clearTimeout(pollTimer);if(!live()||!(pollMs>0))return;pollTimer=setTimeout(()=>{if(!live())return;if(document.visibilityState==='hidden')schedule();else void refresh();},pollMs);pollTimer.unref?.();}
 async function refresh(){
  if(!live())return;const serial=++epoch,requested=selected;loading=true;refreshButton.disabled=true;
  try{
   const data=await api('crypto/trading/live'+(requested?'?robotId='+encodeURIComponent(requested):''));if(!live()||serial!==epoch)return;
   if(data?.schemaVersion!==1||!Array.isArray(data.profiles)||requested&&data.selectedRobotId!==requested||data.selectedRobotId&&!data.profiles.some(profile=>profile.robotId===data.selectedRobotId))throw Error('The selected market view could not be read. Refresh to try again.');
   snapshot=data;profiles=data.profiles;selected=data.selectedRobotId||null;selector.innerHTML=profiles.length?profiles.map(profile=>'<option value="'+escape(profile.robotId)+'">'+escape(profile.name+' · '+profile.venue+' · '+profile.symbol)+'</option>').join(''):'<option value="">Select a saved robot</option>';selector.value=selected||'';selector.disabled=!profiles.length;
   issue.textContent='';render(data);onSelection(data.profiles.find(profile=>profile.robotId===selected)||null);
  }catch(error){if(live()&&serial===epoch)issue.textContent=error.message;}finally{if(serial===epoch){loading=false;if(live())refreshButton.disabled=false;schedule();}}
 }
 selector.onchange=()=>{
  if(!live()||!profiles.some(profile=>profile.robotId===selector.value))return;selected=selector.value;snapshot=null;side='ALL';issue.textContent='';clearSelected();onSelection(profiles.find(profile=>profile.robotId===selected));return refresh();
 };
 query('[data-read-backing]').onclick=async()=>{
  if(!live()||!selected||liquidityBusy||query('[data-read-backing]').disabled||snapshot?.liquidity?.kind!=='AVIS_ORDER_BOOK')return;
  const robotId=selected,serial=++liquidityEpoch;liquidityBusy=true;query('[data-read-backing]').disabled=true;query('[data-backing-error]').textContent='';query('[data-backing-progress]').textContent='Reading finalized security state…';
  try{
   const result=await api('crypto/trading/live/liquidity?robotId='+encodeURIComponent(robotId));if(!live()||serial!==liquidityEpoch||selected!==robotId)return;
   if(result?.schemaVersion!==1||result.robotId!==robotId||!Array.isArray(result.cards))throw Error('The selected security audit could not be read.');
   query('[data-live-backing]').innerHTML=backingReport(result);query('[data-backing-progress]').textContent='Security audit read.';
  }catch(error){if(live()&&serial===liquidityEpoch){query('[data-backing-error]').textContent=error.message;query('[data-backing-progress]').textContent='';}}finally{if(live()&&serial===liquidityEpoch){liquidityBusy=false;query('[data-read-backing]').disabled=false;}}
 };
 const actions=query('[data-terminal-action-feedback]');
 const tradeIntent=side=>{
  const profile=profiles.find(p=>p.robotId===selected);
  if(!profile){actions.textContent='Select a saved trading robot before preparing an order.';selector.focus();return;}
  actions.textContent=side+' · '+profile.symbol+' · '+profile.venue+' — use the configured exchange order workflow and current INDEX instructions.';
  host.closest('[data-trading-panel]')?.querySelector('[data-index-advice]')?.scrollIntoView?.({behavior:'smooth',block:'nearest'});
 };
 query('[data-trading-buy]').onclick=()=>tradeIntent('BUY');
 query('[data-trading-sell]').onclick=()=>tradeIntent('SELL');
 query('[data-trading-auto]').onchange=async event=>{
  const profile=profiles.find(p=>p.robotId===selected),checked=event.target.checked;
  if(!profile){event.target.checked=false;return;}
  event.target.disabled=true;
  try{await api('crypto/trading/toggle',{robotId:profile.robotId,enabled:checked},crypto.randomUUID());actions.textContent='Robot '+profile.name+' · '+(checked?'entries enabled':'entries paused');await refresh();}
  catch(error){event.target.checked=!checked;actions.textContent=error.message;event.target.disabled=false;}
 };
 refreshButton.onclick=()=>{if(!loading)void refresh();};
 host.querySelectorAll('[data-live-side]').forEach(button=>button.onclick=()=>{if(!live())return;side=button.dataset.liveSide;renderExecutions();});
 focusButton.onclick=()=>{
  if(!live())return;const latest=snapshot?.audit?.fills?.find(fill=>positive(fill.quantity));if(!latest)return;side='ALL';focused=latest.id;renderExecutions();const row=[...query('[data-live-executions]').querySelectorAll('[data-execution-id]')].find(row=>row.dataset.executionId===focused);row?.scrollIntoView?.({block:'nearest',behavior:'auto'});row?.focus();
 };
 clearSelected();await refresh();
 return {refresh,close(){closed=true;epoch++;liquidityEpoch++;clearTimeout(pollTimer);clearTimeout(activityTimer);}};
}

export function mountRobotInstructions({api,host,isCurrent=()=>host?.isConnected,onSaved=async()=>{}}){
 const current=()=>host?.isConnected&&isCurrent();if(!current())return;
 let selected=null,selectedProfile=null,version=null,epoch=0,loading=false,writing=false,pending=null,closed=false;
 const live=()=>!closed&&current();
 host.innerHTML=`<section class="robot-instructions"><div class="crypto-section-heading"><h3>Trading robot instructions</h3><span data-robot-instruction-version>—</span></div><p class="crypto-source">Execution values feed the W-effect strategy and its limits. Notes accompany the audit.</p><p class="crypto-source" data-robot-instruction-profile>Select a saved robot in the live view.</p><form data-robot-instruction-form><label for="robot-execution-instructions">Execution instructions</label><textarea id="robot-execution-instructions" name="instructions" rows="10" maxlength="24000" spellcheck="false" required disabled></textarea><div class="crypto-inline-actions"><button type="submit" class="primary" disabled>Save robot instructions</button><button type="button" data-reload-robot-instructions disabled>Reload</button><span data-robot-instruction-saved role="status"></span></div><p class="form-error" role="alert" data-robot-instruction-error></p></form></section>`;
 const query=selector=>host.querySelector(selector),form=query('form'),input=form.elements.instructions,save=form.querySelector('[type=submit]'),reload=query('[data-reload-robot-instructions]'),issue=query('[data-robot-instruction-error]'),output=query('[data-robot-instruction-saved]');
 function sync(){if(!live())return;input.disabled=loading||writing||version===null;save.disabled=loading||writing||version===null;reload.disabled=loading||writing||!selected;}
 async function select(profile,{force=false}={}){
  if(!live())return;const id=profile?.robotId||null;if(id===selected&&!force)return;
  selected=id;selectedProfile=profile;version=null;pending=null;const serial=++epoch;input.value='';issue.textContent='';output.textContent='';query('[data-robot-instruction-version]').textContent='—';
  query('[data-robot-instruction-profile]').textContent=profile?profile.name+' · '+profile.venue+' · '+profile.symbol:'Select a saved robot in the live view.';
  loading=!!id;sync();if(!id)return;
  try{
   const policy=await api('crypto/trading/robot-instructions?robotId='+encodeURIComponent(id));if(!live()||serial!==epoch||selected!==id)return;
   if(policy?.robotId!==id||!Number.isSafeInteger(policy.version)||policy.version<0||typeof policy.instructions!=='string')throw Error('The robot instructions could not be read. Reload to try again.');
   version=policy.version;input.value=policy.instructions;query('[data-robot-instruction-version]').textContent='Version '+version;
  }catch(error){if(live()&&serial===epoch)issue.textContent=error.message;}finally{if(serial===epoch){loading=false;sync();}}
 }
 reload.onclick=()=>{if(selected)void select(selectedProfile,{force:true});};
 form.onsubmit=async event=>{
  event.preventDefault();if(!live()||loading||writing||version===null||!selected)return;
  const instructions=input.value,robotId=selected,serial=epoch;let parsed;
  try{parsed=JSON.parse(instructions);}catch{issue.textContent='Use the JSON execution settings shown for this robot.';return;}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).some(key=>!['maxNotional','dailyNotional','maxLoss','minimumIndex','trailingBps','notes'].includes(key))||!['maxNotional','dailyNotional','maxLoss'].every(key=>typeof parsed[key]==='string'&&/^\d+(?:\.\d+)?$/.test(parsed[key])&&/[1-9]/.test(parsed[key]))||typeof parsed.minimumIndex!=='number'||!Number.isFinite(parsed.minimumIndex)||!Number.isInteger(parsed.trailingBps)||parsed.notes!==undefined&&typeof parsed.notes!=='string'){
   issue.textContent='Use maxNotional, dailyNotional and maxLoss as positive decimal strings; minimumIndex and trailingBps as numbers; and notes as text.';return;
  }
  const body={robotId,expectedVersion:version,instructions},fingerprint=JSON.stringify(body);if(pending?.fingerprint!==fingerprint)pending={fingerprint,key:crypto.randomUUID()};
  writing=true;issue.textContent='';output.textContent='';sync();
  try{
   const saved=await api('crypto/trading/robot-instructions',body,pending.key);if(!live()||serial!==epoch||selected!==robotId)return;
   if(saved?.robotId!==robotId||!Number.isSafeInteger(saved.version)||typeof saved.instructions!=='string'||saved.enabled!==false)throw Error('Reload the current robot instruction version.');
   version=saved.version;pending=null;input.value=saved.instructions;query('[data-robot-instruction-version]').textContent='Version '+version;output.textContent='Saved · entries paused. Review a new replay before starting.';await onSaved(saved);
  }catch(error){if(live()&&serial===epoch)issue.textContent=error.message;}finally{writing=false;sync();}
 };
 return {select,close(){closed=true;epoch++;}};
}
