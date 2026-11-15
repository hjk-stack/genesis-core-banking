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
 return `<svg class="trading-robot-art" viewBox="0 0 260 310" aria-hidden="true" focusable="false"><defs><linearGradient id="${id}-metal" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fcfeff"/><stop offset=".32" stop-color="#b9c9d7"/><stop offset=".55" stop-color="#f1f6fa"/><stop offset="1" stop-color="#71879b"/></linearGradient><linearGradient id="${id}-dark" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#243b51"/><stop offset="1" stop-color="#0d1b2c"/></linearGradient></defs><ellipse cx="130" cy="292" rx="77" ry="8" fill="#061321" opacity=".45"/><g class="trading-robot-frame" fill="url(#${id}-metal)" stroke="#71899c" stroke-width="1.5"><path d="M99 244h25v35l-31 1z"/><path d="M136 244h25l6 36-31-1z"/><path d="M91 276h35v10H82q0-10 9-10M134 276h35q9 0 9 10h-44z"/><g data-robot-arm="BUY"><path d="M69 149 44 161 29 209l16 8 19-40 18-9z"/><circle cx="46" cy="165" r="11"/><path d="m29 207-8 27 10 13 15-5 4-19-8-11z"/><path d="m32 226 6 4"/></g><g data-robot-arm="SELL"><path d="m191 149 25 12 15 48-16 8-19-40-18-9z"/><circle cx="214" cy="165" r="11"/><path d="m231 207 8 27-10 13-15-5-4-19 8-11z"/><path d="m228 226-6 4"/></g><rect x="113" y="121" width="34" height="25" rx="10"/><path d="M77 143q53-16 106 0l-8 94q-45 20-90 0z"/><path d="M91 151q39-10 78 0l-7 75q-32 10-64 0z" fill="url(#${id}-dark)"/><rect x="62" y="47" width="136" height="82" rx="32"/><path d="M79 60q51-17 102 0v43q-51 19-102 0z" fill="url(#${id}-dark)"/><path d="M130 45V27" fill="none"/><circle cx="130" cy="23" r="5" fill="#b9f5e4"/><path d="M92 119q38 13 76 0" fill="none"/><path d="M68 76H57v22h10M192 76h11v22h-10"/></g><g class="trading-robot-eyes" fill="#a8f0e0"><rect x="91" y="78" width="25" height="7" rx="3.5"/><rect x="144" y="78" width="25" height="7" rx="3.5"/></g><path class="trading-robot-w" d="m103 178 13 29 14-19 14 19 13-29" fill="none" stroke="#a8f0e0" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><g fill="#96acbe"><circle cx="99" cy="162" r="2"/><circle cx="161" cy="162" r="2"/><circle cx="103" cy="219" r="2"/><circle cx="157" cy="219" r="2"/></g><path class="trading-robot-signal" d="M130 143v17m-29 80-4 26m62-26 4 26" fill="none" stroke="#67d7bf" stroke-width="2"/></svg>`;
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
 host.innerHTML=`<section class="trading-live" aria-labelledby="trading-live-title"><div class="trading-live-heading"><div><p class="eyebrow">W-EFFECT · MARKET & EXECUTION</p><h3 id="trading-live-title">Live trading view</h3></div><button type="button" data-live-refresh>Refresh view</button></div><label class="trading-live-select">Robot & market<select aria-label="Robot & market" data-live-profile><option value="">Select a saved robot</option></select></label><div class="trading-live-workspace"><aside class="trading-live-robot" data-robot-activity=""><div class="trading-robot-name"><strong data-live-robot-name>W-effect</strong><span data-live-robot-state>—</span></div><button type="button" class="trading-robot-focus" data-focus-execution aria-label="Focus latest execution" disabled>${robotArtwork()}</button><div class="trading-robot-latest" data-live-latest><strong>Executed trades</strong><span>—</span></div><div class="trading-robot-filters" aria-label="Execution filter"><button type="button" data-live-side="ALL" aria-pressed="true">All</button><button type="button" data-live-side="BUY" aria-pressed="false">Buy executions</button><button type="button" data-live-side="SELL" aria-pressed="false">Sell executions</button></div></aside><div class="trading-live-screen"><div class="trading-market-heading"><strong data-live-symbol>—</strong><span data-live-source>—</span></div><div data-live-quote></div><div class="trading-live-chart" data-live-chart></div><p class="trading-chart-caption"><span><i class="quote-bid-key"></i> Bid <i class="quote-ask-key"></i> Ask</span><span data-live-samples>0 recorded quotes</span></p><p class="crypto-source" data-live-market-time></p><div class="trading-live-audit" data-live-audit></div></div></div><p class="form-error" role="alert" data-live-error></p><div data-live-executions></div><details class="trading-live-liquidity" data-live-liquidity hidden><summary>AVIS order book & security backing</summary><div data-live-book></div><div class="crypto-inline-actions"><button type="button" data-read-backing disabled>Read security backing</button><span data-backing-progress role="status"></span></div><p class="form-error" data-backing-error role="alert"></p><div data-live-backing></div></details><details class="trading-live-orders"><summary>Orders & execution audit</summary><div data-live-orders></div><div data-live-reconciliation></div></details></section>`;
 const selector=query('[data-live-profile]'),refreshButton=query('[data-live-refresh]'),issue=query('[data-live-error]'),robot=query('.trading-live-robot'),focusButton=query('[data-focus-execution]');
 function clearActivity(){clearTimeout(activityTimer);robot.dataset.robotActivity='';}
 function clearSelected(){
  clearActivity();liquidityEpoch++;liquidityBusy=false;backingBinding=null;query('[data-live-liquidity]').hidden=true;query('[data-live-book]').innerHTML='';query('[data-live-backing]').innerHTML='';query('[data-backing-error]').textContent='';query('[data-backing-progress]').textContent='';focused=null;focusButton.disabled=true;query('[data-live-latest]').innerHTML='<strong>Executed trades</strong><span>—</span>';query('[data-live-robot-name]').textContent='W-effect';query('[data-live-robot-state]').textContent='—';query('[data-live-symbol]').textContent='—';query('[data-live-source]').textContent='—';query('[data-live-market-time]').textContent='';query('[data-live-quote]').innerHTML=details([['Bid','—'],['Ask','—'],['Bid size','—'],['Ask size','—']]);query('[data-live-chart]').innerHTML=chart([]);query('[data-live-samples]').textContent='0 recorded quotes';query('[data-live-audit]').innerHTML='';query('[data-live-executions]').innerHTML='';query('[data-live-orders]').innerHTML='';query('[data-live-reconciliation]').innerHTML='';
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
