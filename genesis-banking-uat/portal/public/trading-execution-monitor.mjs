// W-Effect execution monitor: renders only server-recorded trades and robot state.
// No browser-side order placement or synthetic market data.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const numeric = value => {const n=Number(value);return Number.isFinite(n)?n:0;};
export function mountExecutionMonitor({api,host,isCurrent,intervalMs=5000}) {
  let closed=false, timer=null, busy=false;
  const alive=()=>!closed&&host?.isConnected&&(!isCurrent||isCurrent());
  host.innerHTML='<section class="crypto-market w-effect-floor" aria-label="W-Effect real execution monitor" style="padding:16px"><header style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h3>W-Effect · Trading floor</h3><span data-trade-updated aria-live="polite">Loading recorded executions…</span></header><div data-trade-robots></div><h4>Recorded BUY / SELL activity</h4><div data-trade-orders-wrap><table><thead><tr><th>Time</th><th>Robot</th><th>Venue</th><th>Side</th><th>Quantity</th><th>Executed</th><th>Order state</th><th>Reference</th></tr></thead><tbody data-trade-orders></tbody></table></div><div data-trade-audit aria-live="polite"></div><p class="crypto-source">Execution records from AVISPay. Market quotes and fees appear only when confirmed by the connected venue.</p></section>';
  async function update(){
    if(!alive()||busy)return;busy=true;
    try {
      const [rr,oo]=await Promise.all([api('views/tradingrobots'),api('views/robotorders')]);
      if(!alive())return;
      const robots=Array.isArray(rr?.rows)?rr.rows:[],orders=Array.isArray(oo?.rows)?oo.rows:[];
      const names=new Map(robots.map(r=>[String(r.robot_id),r]));
      host.querySelector('[data-trade-robots]').innerHTML='<div class="crypto-scroller">'+robots.map(r=>'<article class="crypto-market" style="flex-basis:250px"><h4>'+esc(r.name)+'</h4><p>'+esc(r.symbol)+' · '+esc(r.venue)+'</p><dl class="crypto-details"><dt>New entries</dt><dd>'+ (r.enabled?'Enabled':'Paused')+'</dd><dt>Position</dt><dd>'+esc(r.position_quantity)+'</dd><dt>Realised P&L</dt><dd>'+esc(r.realized_pnl)+' '+esc(r.quote_asset)+'</dd><dt>Trailing stop</dt><dd>'+esc(r.stop_price)+'</dd></dl></article>').join('')+'</div>';
      const recent=orders.slice().sort((a,b)=>Date.parse(b.created_at||0)-Date.parse(a.created_at||0)).slice(0,50);
      host.querySelector('[data-trade-orders]').innerHTML=recent.map(o=>{const r=names.get(String(o.robot_id));return '<tr><td>'+esc(o.created_at?new Date(o.created_at).toLocaleString():'—')+'</td><td>'+esc(r?.name||o.robot_id)+'</td><td>'+esc(r?.venue||'—')+'</td><td>'+esc(o.side)+'</td><td>'+esc(o.quantity)+'</td><td>'+esc(o.response?.executedQty??'—')+'</td><td>'+esc(o.status)+'</td><td>'+esc(o.client_order_id)+'</td></tr>';}).join('')||'<tr><td colspan="8">No recorded orders</td></tr>';
      const filled=orders.filter(o=>['FILLED','PARTIALLY_FILLED'].includes(String(o.status).toUpperCase()));
      const executed=filled.reduce((s,o)=>s+numeric(o.response?.executedQty),0);
      host.querySelector('[data-trade-audit]').textContent='Recorded executions: '+filled.length+' · Executed quantity (mixed instruments; not aggregated): '+(filled.length?'see individual orders':'—')+' · Fees: see venue settlement records';
      host.querySelector('[data-trade-updated]').textContent='Updated '+new Date().toLocaleTimeString();
    }catch(e){if(alive())host.querySelector('[data-trade-updated]').textContent='Refresh failed: '+String(e?.message||e);}
    finally{busy=false;if(alive())timer=setTimeout(update,intervalMs);}
  }
  void update();
  return ()=>{closed=true;if(timer!==null)clearTimeout(timer);};
}
