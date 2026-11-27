import {createHash} from 'node:crypto';
import {isStaffHost} from './staff-workstation.mjs';

// Fetch metadata distinguishes a navigation from a script or asset request.
// Older browsers without that metadata still negotiate a document with text/html.
export function isStaffAccessDocument(req) {
 if(req.method!=='GET'||!isStaffHost(req))return false;
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/api'||path.startsWith('/api/')||['/healthz','/readyz'].includes(path))return false;
 const destination=req.headers['sec-fetch-dest'],mode=req.headers['sec-fetch-mode'];
 if((destination!==undefined||mode!==undefined)&&(destination!=='document'||mode!=='navigate'))return false;
 return String(req.headers.accept||'').split(',').some(item=>{
  const [type,...parameters]=item.trim().toLowerCase().split(';');
  if(type.trim()!=='text/html')return false;
  const quality=parameters.find(value=>/^\s*q\s*=/.test(value));
  if(quality===undefined)return true;
  const value=Number(quality.slice(quality.indexOf('=')+1).trim());
  return Number.isFinite(value)&&value>0&&value<=1;
 });
}

const style=`
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#07162b;color:#f3f7fc}
*{box-sizing:border-box}
body{margin:0}
.access-page{width:100vw;max-width:100%;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;padding:clamp(24px,6vw,88px)}
.brand{font-size:1.5rem;font-weight:700;letter-spacing:.025em}
.brand span{color:#8ac6f8}
.access-message{width:100%;max-width:64rem;margin:auto 0;padding:clamp(48px,9vh,128px) 0}
.eyebrow{margin:0 0 1.5rem;color:#8ac6f8;font-size:.8rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase}
h1{max-width:18ch;margin:0;font-size:clamp(2rem,5.4vw,4.75rem);font-weight:650;line-height:1.1;letter-spacing:-.035em;text-wrap:balance;overflow-wrap:break-word}
.access-description{max-width:42rem;margin:1.5rem 0 2rem;color:#c0cee0;font-size:clamp(1rem,1.8vw,1.25rem);line-height:1.55}
.public-link{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:.75rem 1.125rem;border:1px solid #5e7593;border-radius:8px;color:#f3f7fc;font-weight:600;text-decoration:none}
.public-link:hover{background:#173352}
.public-link:focus-visible{outline:3px solid #8ac6f8;outline-offset:4px}
`;
const styleHash=createHash('sha256').update(style).digest('base64');
const document=`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Access restricted | AVISPay</title>
<style>${style}</style>
</head>
<body>
<main class="access-page" aria-labelledby="access-title">
 <header class="brand">AVIS<span>Pay</span></header>
 <section class="access-message">
  <p class="eyebrow">Private banking platform</p>
  <h1 id="access-title">You are not authorized to access this platform.</h1>
  <p class="access-description">This platform is reserved for approved AVISPay workstations.</p>
  <a class="public-link" href="https://avis.land">Go to AVIS.LAND</a>
 </section>
</main>
</body>
</html>`;

export function sendStaffAccessPage(res) {
 // This response needs only its exact inline stylesheet. The banking UI's CSP
 // remains unchanged, and the denied page cannot load scripts or remote assets.
 res.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
 res.setHeader('Vary','Accept, Sec-Fetch-Dest, Sec-Fetch-Mode');
 res.writeHead(403,{'content-type':'text/html; charset=utf-8'});
 res.end(document);
}
