// Admin-only home for the W-Effect trading engine.
export function mountRobotHome({host}) {
 if(!host)return;
 if(!document.querySelector('link[data-w-effect-styles]')){const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./trading-responsive.css',import.meta.url).href;link.dataset.wEffectStyles='';document.head.append(link);}

 host.innerHTML=`<section class="crypto-market w-effect-home" aria-label="W-Effect robot administration" style="padding:20px;margin-bottom:18px">
 <header style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px"><div><p class="crypto-source">AVISPay · Crypto administration</p><h2>W-Effect · Robot Home</h2><p class="crypto-source">Trading engine · INDEX intelligence · Execution · Settlement</p></div><span class="crypto-source">Administration</span></header>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:18px 0">
 <article class="crypto-market" style="padding:16px"><h3>Robot control</h3><p>Strategies, robot profiles, execution permissions and market replay.</p><button type="button" data-robot-section="robots">Open robot controls</button></article>
 <article class="crypto-market" style="padding:16px"><h3>Trading floor</h3><p>Recorded market orders, fills, positions and realised results.</p><button type="button" data-robot-section="floor">Open trading floor</button></article>
 <article class="crypto-market" style="padding:16px"><h3>INDEX intelligence</h3><p>Private instructions, market events and instrument evidence.</p><button type="button" data-robot-section="index">Open INDEX instructions</button></article>
 <article class="crypto-market" style="padding:16px"><h3>Testing laboratory</h3><p>Nautilus market replay and acceptance reports before live entry.</p><button type="button" data-robot-section="tests">Open testing laboratory</button></article>
 </div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">
 <div class="crypto-market" style="padding:14px"><h3>INDEX instruction feeder</h3><p class="crypto-source">Private administration · versioned INDEX instructions</p><button type="button" data-robot-section="index">Manage INDEX</button></div>
 <div class="crypto-market" style="padding:14px"><h3>Trading robot instructions</h3><p class="crypto-source">Private administration · strategy profiles and execution limits</p><button type="button" data-robot-section="robots">Manage robot</button></div>
 </div></section>`;
 const targets={robots:'[data-robot-config]',floor:'[data-execution-monitor]',index:'[data-index-advice]',tests:'[data-trading-testing]'};
 host.querySelectorAll('[data-robot-section]').forEach(button=>button.addEventListener('click',()=>{const target=host.parentElement?.querySelector(targets[button.dataset.robotSection]);if(target){target.scrollIntoView({behavior:'smooth',block:'start'});target.querySelector('button, input, select, textarea')?.focus({preventScroll:true});}}));
}
