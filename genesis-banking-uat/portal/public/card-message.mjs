const encode=new TextEncoder(),decode=new TextDecoder();
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))),bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function messageKey(password,salt,usage){
 if(typeof password!=='string'||password.length<12||password.length>256)throw new Error('Use a delivery password of at least 12 characters.');
 const material=await crypto.subtle.importKey('raw',encode.encode(password),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:600000},material,{name:'AES-GCM',length:256},false,[usage]);
}
export async function encryptCardMessage(payload,password){
 const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await messageKey(password,salt,'encrypt');
 const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encode.encode('AVISPAY_CARD_V1')},key,encode.encode(JSON.stringify(payload)));
 return {format:'AVISPAY_CARD_V1',cipher:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:600000,salt:b64(salt),iv:b64(iv),data:b64(data)};
}
export async function decryptCardMessage(message,password){
 if(message?.format!=='AVISPAY_CARD_V1'||message.cipher!=='AES-256-GCM'||message.kdf!=='PBKDF2-SHA256'||message.iterations!==600000||typeof message.data!=='string'||message.data.length>32000)throw new Error('Select an AVISPay encrypted card message.');
 try{
  const salt=bytes(message.salt),iv=bytes(message.iv);if(salt.length!==16||iv.length!==12)throw new Error();
  const key=await messageKey(password,salt,'decrypt');
  return JSON.parse(decode.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encode.encode('AVISPAY_CARD_V1')},key,bytes(message.data))));
 }catch{throw new Error('Check the delivery password and encrypted message.');}
}
export function downloadMessage(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function openCardMessage(){
 const dialog=document.createElement('dialog');dialog.className='card-message-dialog';dialog.setAttribute('aria-label','Open encrypted card');
 dialog.innerHTML='<div class="dialog-heading"><h2>Open encrypted card</h2><button type="button" class="close" aria-label="Close encrypted card">×</button></div><form class="card-message-form"><label>Encrypted message<input name="file" type="file" accept=".json,application/json" required></label><label>Delivery password<input name="password" type="password" autocomplete="off" required></label><p class="form-error" role="alert"></p><button class="primary">Open message</button><pre class="card-delivery"></pre></form>';
 document.body.append(dialog);const close=()=>{dialog.close();dialog.remove();};dialog.querySelector('.close').onclick=close;dialog.oncancel=e=>{e.preventDefault();close();};
 dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,error=form.querySelector('.form-error');error.textContent='';try{const file=form.elements.file.files[0];if(!file||file.size>65536)throw new Error('Select an AVISPay encrypted card message.');const value=await decryptCardMessage(JSON.parse(await file.text()),form.elements.password.value);form.elements.password.value='';form.querySelector('pre').textContent=JSON.stringify(value,null,2);}catch(err){error.textContent=err.message;}};
 dialog.showModal();
}
if(typeof document!=='undefined')document.getElementById('open-encrypted-card')?.addEventListener('click',openCardMessage);
