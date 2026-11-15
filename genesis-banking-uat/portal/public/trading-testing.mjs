const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const amount=value=>value===null||value===undefined?'—':String(value).replace(/^([+-]?\d+)(.*)$/,(_,whole,tail)=>whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+tail);
const date=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():'—';
const modeName=mode=>mode==='ACCEPTANCE'?'Acceptance suite':'Market replay';
const active=run=>['QUEUED','RUNNING'].includes(run?.status);
const statusName=value=>({QUEUED:'Queued',RUNNING:'Running',PASSED:'Passed',FAILED:'Failed'}[value]||'—');
const MAX_BYTES=2097152,MAX_ROWS=10000;
const fail=message=>{throw new Error(message);};
const exactKeys=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const timestamp=value=>Number.isSafeInteger(value)&&value>0;

// The browser validates data only. The server and runner validate it again;
// uploaded text is never imported, evaluated or fetched as a URL.
export function validateReplayDataset(dataset){
 if(!exactKeys(dataset,['ticks','indices'])||!Array.isArray(dataset.ticks)||!Array.isArray(dataset.indices))fail('Use a JSON object containing ticks and indices arrays.');
 if(!dataset.ticks.length||dataset.ticks.length>MAX_ROWS||dataset.indices.length>MAX_ROWS)fail('Replay needs 1–10,000 ticks and at most 10,000 INDEX observations.');
 let priorTick=0,priorArrival=0,priorIndex=0;
 for(const [position,tick]of dataset.ticks.entries()){
  const label='Tick '+(position+1);
  if(!exactKeys(tick,['tsMicros','bid','ask','bidSize','askSize','sellVolume','receivedAtMicros']))fail(label+' contains unsupported fields.');
  if(!timestamp(tick.tsMicros)||tick.tsMicros<=priorTick)fail(label+' needs a positive, strictly increasing tsMicros timestamp.');
  const arrival=Object.hasOwn(tick,'receivedAtMicros')?tick.receivedAtMicros:tick.tsMicros;
  if(!timestamp(arrival)||arrival<tick.tsMicros||arrival<priorArrival)fail(label+' has an invalid receivedAtMicros timestamp.');
  if(!['bid','ask','bidSize','askSize','sellVolume'].every(key=>finite(tick[key]))||Math.min(tick.bid,tick.ask,tick.bidSize,tick.askSize)<=0||tick.sellVolume<0||tick.bid>tick.ask)fail(label+' needs finite positive prices and sizes, bid ≤ ask, and nonnegative sellVolume.');
  priorTick=tick.tsMicros;priorArrival=arrival;
 }
 for(const [position,observation]of dataset.indices.entries()){
  const label='INDEX observation '+(position+1),index=observation?.index;
  if(!exactKeys(observation,['atMicros','index'])||!timestamp(observation.atMicros)||observation.atMicros<=priorIndex)fail(label+' needs a positive, strictly increasing atMicros timestamp.');
  if(!exactKeys(index,['instrumentId','score','confidence','sourceCount','generatedAtMs','validUntilMs','sequence']))fail(label+' contains unsupported fields.');
  if(typeof index.instrumentId!=='string'||!index.instrumentId.trim()||index.instrumentId.length>80||typeof index.sequence!=='string'||!index.sequence.trim()||index.sequence.length>128)fail(label+' needs an instrumentId and sequence.');
  if(!finite(index.score)||index.score< -100||index.score>100||!finite(index.confidence)||index.confidence<0||index.confidence>1||!Number.isSafeInteger(index.sourceCount)||index.sourceCount<0||index.sourceCount>10000)fail(label+' has invalid score, confidence or sourceCount.');
  if(![index.generatedAtMs,index.validUntilMs].every(value=>Number.isSafeInteger(value)&&value>=0)||index.generatedAtMs>Math.floor(observation.atMicros/1000))fail(label+' has invalid or future generation timestamps.');
  priorIndex=observation.atMicros;
 }
 return dataset;
}

async function readReplay(file){
 if(!file||!/\.json$/i.test(file.name||''))fail('Choose a local JSON replay file.');
 if(!Number.isFinite(file.size)||file.size<=0||file.size>MAX_BYTES)fail('Choose a JSON replay file no larger than 2 MiB.');
 const source=await file.text();if(new TextEncoder().encode(source).byteLength>MAX_BYTES)fail('Choose a JSON replay file no larger than 2 MiB.');
 let dataset;try{dataset=JSON.parse(source);}catch{fail('The replay file must contain valid JSON.');}
 return validateReplayDataset(dataset);
}

const details=rows=>'<dl class="crypto-details">'+rows.map(([label,value])=>'<dt>'+escape(label)+'</dt><dd>'+escape(value??'—')+'</dd>').join('')+'</dl>';
const dataText=value=>value===null||value===undefined?'—':typeof value==='object'?JSON.stringify(value,null,2):String(value);
const records=(label,rows,columns)=>{
 const items=Array.isArray(rows)?rows:[];
 return '<details><summary>'+escape(label)+' · '+items.length+'</summary>'+(items.length?'<div class="trading-test-table"><table><thead><tr>'+columns.map(([,name])=>'<th scope="col">'+escape(name)+'</th>').join('')+'</tr></thead><tbody>'+items.map(row=>'<tr>'+columns.map(([key])=>'<td>'+escape(row[key]??'—')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>':'<p class="crypto-source">None recorded.</p>')+'</details>';
};
const orderColumns=[['id','Order'],['signalId','Signal'],['tsMicros','Time (µs)'],['side','Side'],['requestedQuantity','Requested'],['limitPrice','Limit price'],['filledQuantity','Filled'],['status','Status'],['reason','Reason'],['type','Type'],['timeInForce','Time in force']];
const fillColumns=[['orderId','Order'],['tsMicros','Time (µs)'],['side','Side'],['quantity','Quantity'],['price','Price'],['notional','Value'],['fee','Fee'],['cashAfter','Cash after'],['positionAfter','Position after']];

export async function mountTradingTesting({api,host,isCurrent=()=>host?.isConnected,onMetadata=()=>{},onReviewed=async()=>{}}){
 const current=()=>host?.isConnected&&isCurrent();if(!current())return;
 let metadata=null,selectedRunId=null,pendingRunId=null,loading=false,working=false,readVersion=0,uploadVersion=0,uploadPending=false,uploaded=null,pendingRequest=null,pollTimer=null,polls=0,closed=false;
 const reviews=new Map(),live=()=>!closed&&current();
 const query=selector=>host.querySelector(selector);
 host.innerHTML=`<section class="trading-testing" aria-labelledby="trading-tests-title"><div class="crypto-section-heading"><h3 id="trading-tests-title">Trading tests</h3><button type="button" data-test-refresh>Refresh tests</button></div><p class="crypto-source">Test the W-effect strategy with virtual funds. Acceptance checks use a fixed reference dataset. Market replay uses your local JSON data and the selected saved configuration.</p><div data-test-engine></div><form data-trading-test-form><fieldset class="trading-test-fields"><label>Test configuration<select name="robotId" aria-label="Test configuration"><option value="">General W-effect configuration</option></select></label><label>Test mode<select name="mode" aria-label="Test mode"><option value="ACCEPTANCE">Acceptance suite</option><option value="REPLAY">Market replay</option></select></label><label>Virtual funds<input name="initialCash" aria-label="Virtual funds" value="10000" inputmode="decimal" required></label><label>Fee (basis points)<input name="feeBps" aria-label="Fee (basis points)" type="number" min="0" max="1000" step="any" value="10" required></label><label>Slippage (basis points)<input name="slippageBps" aria-label="Slippage (basis points)" type="number" min="0" max="1000" step="any" value="5" required></label><label data-replay-upload hidden>Replay JSON<input name="replay" aria-label="Replay JSON" type="file" accept=".json,application/json"><span class="crypto-source">Local JSON only · up to 2 MiB · 10,000 ticks and 10,000 INDEX observations.</span><span data-replay-file role="status"></span></label></fieldset><div class="crypto-inline-actions"><button type="submit" class="primary" data-run-test>Run acceptance suite</button><span data-test-progress role="status" aria-live="polite"></span></div><p class="form-error" role="alert" data-test-error></p></form><div data-test-report aria-live="polite"></div><details class="trading-test-history"><summary>Past runs · <span data-test-history-count>0</span></summary><div data-test-history></div></details></section>`;
 const form=query('[data-trading-test-form]'),fields=form.querySelector('fieldset'),runButton=query('[data-run-test]'),refreshButton=query('[data-test-refresh]'),issue=query('[data-test-error]'),progress=query('[data-test-progress]');
 function syncBusy(){
  if(!live())return;
  const pending=metadata?.runs?.find(run=>run.runId===pendingRunId),busy=loading||working||uploadPending||!!pendingRunId&&(!pending||active(pending));
  fields.disabled=working||!!pendingRunId&&(!pending||active(pending));runButton.disabled=busy;refreshButton.disabled=loading||working;
  for(const name of ['initialCash','feeBps','slippageBps'])form.elements[name].disabled=form.elements.mode.value==='ACCEPTANCE';
  runButton.textContent=form.elements.mode.value==='ACCEPTANCE'?'Run acceptance suite':'Run market replay';
  for(const button of host.querySelectorAll('[data-review-test]'))button.disabled=loading||working;
 }
 function renderEngine(runtime){
  const engine=metadata?.engine;
  query('[data-test-engine]').innerHTML=details([['Test engine',engine?engine.name+' '+engine.version:'—'],['Engine process ready',runtime?.ready===true?'Yes':runtime?.ready===false?'No':'—'],['Process started',date(runtime?.startedAt)]]);
 }
 function renderReport(){
  const run=metadata?.runs?.find(item=>item.runId===selectedRunId),container=query('[data-test-report]');
  if(!run){container.innerHTML='<p class="crypto-source">Run an acceptance suite or select a past result.</p>';return;}
  const report=run.report,metrics=report?.metrics||{},checks=Array.isArray(report?.checks)?report.checks:[];
  const reviewable=run.reviewEligible===true&&run.mode==='REPLAY'&&run.status==='PASSED'&&!!run.robotId&&!run.reviewedAt;
  container.innerHTML=`<article class="trading-test-report"><div class="crypto-section-heading"><h4>${escape(modeName(run.mode))} · ${escape(run.profileName||'General W-effect configuration')}</h4><span class="trading-test-result" data-test-result>${escape(statusName(run.status))}</span></div>${details([['Created',date(run.createdAt)],['Started',date(run.startedAt)],['Completed',date(run.completedAt)],['Run reference',run.runId],['Configuration',run.configurationHash]])}${run.errorCode?'<p class="form-error">'+escape(run.errorCode)+'</p>':''}${report?`<h4>Virtual funds & results</h4>${details([['Initial virtual funds',amount(metrics.initialCash)],['Final cash',amount(metrics.finalCash)],['Final equity',amount(metrics.finalEquity)],['Realised P&L',amount(metrics.realisedPnl)],['Unrealised P&L',amount(metrics.unrealisedPnl)],['Fees',amount(metrics.fees)],['Filled trades',metrics.filledOrders],['Buy fills',metrics.buyFills],['Sell fills',metrics.sellFills],['Final position',amount(metrics.finalPosition)],['Cost basis',amount(metrics.costBasis)],['Maximum drawdown',amount(metrics.drawdown)],['Drawdown fraction',amount(metrics.drawdownFraction)],['Ticks processed',metrics.ticksProcessed],['INDEX observations used',metrics.indexObservationsUsed],['Orders generated',metrics.ordersGenerated],['Rejected orders',metrics.rejectedOrders],['Partial fills',metrics.partialFills],['Open orders',metrics.openOrders],['Duplicate signals ignored',metrics.duplicateSignalsIgnored]])}<h4>Acceptance checks</h4><ul class="trading-test-checks">${checks.map(check=>'<li><strong>'+escape(check.passed===true?'Passed':'Failed')+' · '+escape(check.label||check.id)+'</strong><p>'+escape(dataText(check.detail))+'</p></li>').join('')}</ul><div class="trading-test-records">${records('Virtual orders',report.orders,orderColumns)}${records('Virtual fills',report.fills,fillColumns)}<details><summary>Assumptions & test settings</summary><pre>${escape(JSON.stringify(report.assumptions??{},null,2))}</pre></details></div>`:''}${run.reviewedAt?'<p class="crypto-source" data-test-reviewed>Reviewed '+escape(date(run.reviewedAt))+'. Use the separate Start live trading control when ready.</p>':reviewable?'<div class="crypto-inline-actions"><button type="button" data-review-test="'+escape(run.runId)+'">Mark replay reviewed</button><span class="crypto-source">Review this report to make its saved robot configuration eligible for a separate live start.</span></div>':run.mode==='ACCEPTANCE'?'<p class="crypto-source">Acceptance results verify the reference strategy. A reviewed replay of a saved robot configuration is required for live start.</p>':''}</article>`;
  container.querySelector('[data-review-test]')?.addEventListener('click',async event=>{
   if(!live()||working||loading)return;const id=event.currentTarget.dataset.reviewTest,selected=metadata?.runs?.find(item=>item.runId===id);
   if(!selected||selected.reviewEligible!==true||selected.mode!=='REPLAY'||selected.status!=='PASSED'||!selected.robotId||selected.reviewedAt)return;
   working=true;issue.textContent='';progress.textContent='Saving replay review…';syncBusy();
   const key=reviews.get(id)||crypto.randomUUID();reviews.set(id,key);
   try{const reviewed=await api('crypto/trading/tests/review',{runId:id},key);if(!live())return;reviews.delete(id);progress.textContent='Replay reviewed. Live trading remains a separate action.';await onReviewed(reviewed);if(live())await refresh();}catch(error){if(live()){issue.textContent=error.message;progress.textContent='';}}finally{working=false;syncBusy();}
  });
 }
 function renderHistory(){
  const runs=metadata?.runs||[];query('[data-test-history-count]').textContent=String(runs.length);
  query('[data-test-history]').innerHTML=runs.length?runs.map(run=>'<button type="button" data-open-test-run="'+escape(run.runId)+'" aria-pressed="'+(run.runId===selectedRunId)+'"><strong>'+escape(modeName(run.mode))+' · '+escape(run.profileName||'General W-effect configuration')+'</strong><span>'+escape(statusName(run.status))+' · '+escape(date(run.completedAt||run.createdAt))+'</span></button>').join(''):'<p class="crypto-source">No test runs recorded yet.</p>';
  query('[data-test-history]').querySelectorAll('[data-open-test-run]').forEach(button=>button.onclick=()=>{selectedRunId=button.dataset.openTestRun;renderReport();renderHistory();syncBusy();});
 }
 function schedule(){
  clearTimeout(pollTimer);if(!live()||polls>=120||!pendingRunId&&!metadata?.runs?.some(active))return;
  pollTimer=setTimeout(()=>{if(live()){polls++;void refresh();}},2000);pollTimer.unref?.();
 }
 async function refresh(){
  if(!live())return;const version=++readVersion;loading=true;onMetadata(null);syncBusy();
  const [result,runtime]=await Promise.allSettled([api('crypto/trading/testing'),api('views/tradingengine')]);
  if(!live()||version!==readVersion)return;
  if(result.status==='fulfilled'&&object(result.value)&&Array.isArray(result.value.profiles)&&Array.isArray(result.value.runs)){
   metadata={...result.value,runs:result.value.runs.slice(0,20)};
   const selected=form.elements.robotId.value;form.elements.robotId.innerHTML='<option value="">General W-effect configuration</option>'+metadata.profiles.map(profile=>'<option value="'+escape(profile.robotId)+'">'+escape(profile.name+' · '+profile.venue+' · '+profile.symbol)+'</option>').join('');
   if(metadata.profiles.some(profile=>profile.robotId===selected))form.elements.robotId.value=selected;
   if(!metadata.runs.some(run=>run.runId===selectedRunId))selectedRunId=metadata.runs[0]?.runId||null;
   const pending=metadata.runs.find(run=>run.runId===pendingRunId);
   if(pending){selectedRunId=pending.runId;progress.textContent=active(pending)?modeName(pending.mode)+' · '+statusName(pending.status):modeName(pending.mode)+' completed · '+statusName(pending.status);if(!active(pending))pendingRunId=null;}
   onMetadata(metadata);renderReport();renderHistory();
  }else{onMetadata(null);issue.textContent=result.status==='rejected'?result.reason.message:'The test results could not be read. Refresh tests to try again.';}
  renderEngine(runtime.status==='fulfilled'?runtime.value.rows?.[0]:null);loading=false;syncBusy();schedule();
 }
 form.elements.mode.onchange=()=>{const replay=form.elements.mode.value==='REPLAY';query('[data-replay-upload]').hidden=!replay;form.elements.replay.required=replay;issue.textContent='';syncBusy();};
 form.elements.replay.onchange=async()=>{
  const version=++uploadVersion;uploaded=null;uploadPending=true;issue.textContent='';query('[data-replay-file]').textContent='Reading replay…';syncBusy();
  try{const file=form.elements.replay.files?.[0],dataset=await readReplay(file);if(!live()||version!==uploadVersion)return;uploaded=dataset;query('[data-replay-file]').textContent=file.name+' · '+dataset.ticks.length+' ticks · '+dataset.indices.length+' INDEX observations';}catch(error){if(live()&&version===uploadVersion){query('[data-replay-file]').textContent='';issue.textContent=error.message;}}finally{if(version===uploadVersion){uploadPending=false;syncBusy();}}
 };
 form.onsubmit=async event=>{
  event.preventDefault();if(!live()||working||loading||uploadPending||runButton.disabled)return;
  issue.textContent='';const mode=form.elements.mode.value,initialCash=mode==='ACCEPTANCE'?'10000':form.elements.initialCash.value.trim(),fee=mode==='ACCEPTANCE'?10:Number(form.elements.feeBps.value),slippage=mode==='ACCEPTANCE'?5:Number(form.elements.slippageBps.value),robotId=form.elements.robotId.value;
  if(!/^\d{1,18}(?:\.\d{1,16})?$/.test(initialCash)||!/[1-9]/.test(initialCash)||Number(initialCash)>1e12){issue.textContent='Enter positive virtual funds up to 1,000,000,000,000 with at most 16 decimal places.';return;}
  if(!['ACCEPTANCE','REPLAY'].includes(mode)||mode==='REPLAY'&&(!form.elements.feeBps.value.trim()||!form.elements.slippageBps.value.trim())||![fee,slippage].every(value=>Number.isFinite(value)&&value>=0&&value<=1000)){issue.textContent='Enter fees and slippage between 0 and 1,000 basis points.';return;}
  if(robotId&&!metadata?.profiles?.some(profile=>profile.robotId===robotId)){issue.textContent='Refresh tests and select a current robot configuration.';return;}
  if(mode==='REPLAY'&&!uploaded){issue.textContent='Choose a valid local JSON replay file before running market replay.';return;}
  const input={...(robotId?{robotId}:{}),mode,initialCash,feeBps:fee,slippageBps:slippage,...(mode==='REPLAY'?{dataset:uploaded}:{})},fingerprint=JSON.stringify(input);
  if(pendingRequest?.fingerprint!==fingerprint)pendingRequest={fingerprint,key:crypto.randomUUID()};working=true;progress.textContent='Submitting '+modeName(mode).toLowerCase()+'…';syncBusy();
  try{const result=await api('crypto/trading/tests',input,pendingRequest.key);if(!live())return;if(!result?.runId)fail('The test run reference was not returned. Refresh tests before retrying.');pendingRequest=null;pendingRunId=result.runId;selectedRunId=result.runId;polls=0;progress.textContent=modeName(mode)+' · '+statusName(result.status);await refresh();}catch(error){if(live()){issue.textContent=error.message;progress.textContent='';}}finally{working=false;syncBusy();}
 };
 refreshButton.onclick=()=>{if(!working){issue.textContent='';polls=0;void refresh();}};
 await refresh();
 return {refresh,close(){closed=true;readVersion++;uploadVersion++;clearTimeout(pollTimer);onMetadata(null);}};
}
