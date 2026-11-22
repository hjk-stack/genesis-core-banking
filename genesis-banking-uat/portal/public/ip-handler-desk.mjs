// IP-to-IP banking handler inside a movable AVIS desk surface.
// Opening a request never approves a payment or posts to the ledger.
const ID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function ipHandlerUrl(requestId){
 if(!ID.test(requestId||''))throw new TypeError('Invalid checkout IP request');
 const url=new URL('https://avis.land/admin/bank/quantum/direct-transfer');
 url.searchParams.set('checkoutRequest',requestId);
 return url.href;
}
export function openIpHandlerDesk(requestId,{root=document.body}={}){
 const url=ipHandlerUrl(requestId);
 const existing=root.querySelector('[data-ip-handler-desk]');
 if(existing){
  const frame=existing.querySelector('iframe');
  if(frame.src!==url)frame.src=url;
  existing.hidden=false;
  existing.style.zIndex='2147483000';
  existing.querySelector('[data-ip-handler-close]').focus();
  return existing;
 }
 const desk=document.createElement('section');
 desk.dataset.ipHandlerDesk='';
 desk.className='ip-handler-desk';
 desk.setAttribute('role','dialog');
 desk.setAttribute('aria-modal','false');
 desk.setAttribute('aria-label','IP-to-IP payment server handler');
 const bar=document.createElement('header');
 bar.className='ip-handler-desk-bar';
 const title=document.createElement('strong');
 title.textContent='IP–IP Payment Server · Handler';
 const close=document.createElement('button');
 close.type='button';close.dataset.ipHandlerClose='';
 close.setAttribute('aria-label','Close IP-to-IP handler');
 close.textContent='×';
 const frame=document.createElement('iframe');
 frame.className='ip-handler-desk-frame';
 frame.title='IP-to-IP payment server';
 frame.referrerPolicy='strict-origin-when-cross-origin';
 frame.src=url;
 bar.append(title,close);desk.append(bar,frame);root.append(desk);
 close.onclick=()=>{desk.remove();};
 // Drag only by the title bar; controls and server frame remain interactive.
 let drag=null;
 bar.addEventListener('pointerdown',event=>{
  if(event.target===close||event.button!==0)return;
  const rect=desk.getBoundingClientRect();
  drag={x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};
  bar.setPointerCapture?.(event.pointerId);
 });
 bar.addEventListener('pointermove',event=>{
  if(!drag)return;
  desk.style.left=Math.max(0,Math.min(window.innerWidth-100,drag.left+event.clientX-drag.x))+'px';
  desk.style.top=Math.max(0,Math.min(window.innerHeight-48,drag.top+event.clientY-drag.y))+'px';
  desk.style.transform='none';
 });
 const stop=()=>{drag=null;};
 bar.addEventListener('pointerup',stop);
 bar.addEventListener('pointercancel',stop);
 desk.addEventListener('keydown',event=>{if(event.key==='Escape'){event.stopPropagation();close.click();}});
 close.focus();
 return desk;
}
