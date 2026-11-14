import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {fault,text} from './src/core.mjs';
import {migrate} from './src/migrate.mjs';
import {FxBankingServer} from './src/fx.mjs';
import {processAvis8583} from './src/pos-switch.mjs';
import {authenticateMessage,connectorCredentials,dispatchPayment,recoverPaymentDeliveries} from './src/payment-transport.mjs';
import {buildPacs002,readIso20022} from './src/iso20022.mjs';

const digest=v=>createHash('sha256').update(v).digest('hex');
// A session-bound token stays valid across tabs and is renewed at every login.
// The random HttpOnly session secret cannot be recovered from this digest.
const sessionCsrf=token=>digest('avispay:csrf:v1:'+token);
export async function authenticateFineract(username,password,baseUrl,fetcher=fetch) {
 if(!baseUrl||!/^https?:\/\//.test(baseUrl))fault('SIGN_IN_SERVICE',null,503);
 const base=new URL(baseUrl);
 if(base.protocol!=='https:'&&!(base.protocol==='http:'&&base.hostname==='genesis-fineract-uat'))fault('SIGN_IN_SERVICE',null,503);
 const response=await fetcher(new URL('/fineract-provider/api/v1/authentication',base),{
  method:'POST',headers:{'content-type':'application/json','fineract-platform-tenantid':'default'},
  body:JSON.stringify({username,password}),signal:AbortSignal.timeout(15000),redirect:'error'});
 if(response.status===401||response.status===403)fault('SIGN_IN_FAILED','password',401);
 if(!response.ok)fault('SIGN_IN_SERVICE',null,503);
 const account=await response.json();
 if(account.authenticated!==true||account.isTwoFactorAuthenticationRequired===true||!account.permissions?.includes('ALL_FUNCTIONS'))fault('OPERATOR_ACCESS_REQUIRED','username',403);
 return {id:'fineract:'+account.userId,username:account.username||username,admin:true};
}
const messages={
 FX_ACCOUNT_PAIR:'Select two different currency accounts belonging to the same customer.',FX_RATE_REQUIRED:'Refresh rates or select a currency with a current quote.',
 FX_LIQUIDITY_REQUIRED:'The treasury has insufficient available funds in the receiving currency.',FX_QUOTE_CLOSED:'Request a new quote for this conversion.',
 FX_QUOTE_EXPIRED:'This quote expired. Its treasury reservation has been released; request a new quote.',FX_SOURCE_DATE:'The reference-rate publication date is outside the accepted range.',
 CONNECTOR_NOT_FOUND:'Select a configured bank connector.',BANK_ROUTE_REQUIRED:'Link the selected ABIQ account to its bank account.',
 INSUFFICIENT_CLEARING_FUNDS:'The selected clearing account has insufficient unreserved funds.',
 TRANSFER_NOT_FOUND:'Select an existing bank payment.',TRANSFER_ALREADY_CLOSED:'This payment has already been settled or rejected.',
 PAYMENT_ALREADY_DISPATCHED:'This payment has already been submitted. Check its bank reference.',
 CONNECTOR_CONFIGURATION:'Check the credential reference in connector administration.',
 STATEMENT_TOTAL_MISMATCH:'The statement entries do not reconcile with its opening and closing balances.',
 STATEMENT_MATCH_FAILED:'Check the amount, currency, direction and bank reference of this statement entry.',
 MESSAGE_AUTHENTICATION:'Message authentication failed.',MESSAGE_REPLAY:'This message nonce has already been received.',
 INVALID_FIELD:'Check this field.',INVALID_AMOUNT:'Enter a positive amount using digits and a decimal point.',
 INSUFFICIENT_FUNDS:'The selected account has insufficient available funds.',ACCOUNT_NOT_FOUND:'Select an existing account in this currency.',
 ABIQ_INVALID_IDENTIFIER:'Check the ABIQ account number.',ABIQ_CURRENCY_MISMATCH:'The account currency does not match.',
 BUSINESS_ACCOUNT_REQUIRED:'Select a business account for this shop.',SHOP_NOT_FOUND:'Select an active shop.',
 SIGN_IN_FAILED:'Check your username and password.',OPERATOR_ACCESS_REQUIRED:'Use an administrator account.',
 SIGN_IN_SERVICE:'Sign-in could not be completed. Please try again.',UNAUTHORIZED:'Sign in to continue.',
 IDEMPOTENCY_CONFLICT:'This request reference was already used for different details.',SAME_ACCOUNT:'Select a different receiving account.',
 CHECKOUT_ALREADY_CLOSED:'This checkout has already been completed.',CHECKOUT_NOT_IN_ESCROW:'Select a checkout whose funds are still held in escrow.',
 AUTHORIZATION_ALREADY_CLOSED:'This authorization has already been captured or reversed.',
 SELECT_AVIS_CARD:'Select an active AVIS proprietary card.',CURRENCY_MISMATCH:'Select the card account currency.',
 TERMINAL_NOT_FOUND:'Select an active terminal.',SELECT_BANK_ACCOUNT:'Select AVIS Bank for this account-funded checkout.',
 DUPLICATE_RECORD:'This reference is already registered.',INVALID_REFERENCE:'Select a valid record.',
 FORBIDDEN:'You do not have access to this action.',REQUEST_FAILED:'This action could not be completed. Reference this request in Administration.',
 CSRF:'Refresh the page and submit again.',TOO_MANY_ATTEMPTS:'Please wait before trying to sign in again.'
};
export function createBankServer({pool,authenticate,release='local',secureCookies=true}) {
 const core=new FxBankingServer(pool),attempts=new Map();
 const send=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 return http.createServer(async(req,res)=>{
  const requestId=randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id',requestId);res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
   const url=new URL(req.url,'http://localhost'),path=url.pathname;
   if(req.method==='GET'&&path==='/healthz')return send(res,200,{status:'ok',release});
   if(req.method==='GET'&&path==='/readyz'){await pool.query('SELECT 1');return send(res,200,{status:'ready',release});}
   const ingress=/^\/network\/([A-Z0-9_]{1,35})\/(iso20022|iso8583|offline-batch)$/.exec(path);
   if(ingress&&req.method==='POST'){
    const contentType={iso20022:'application/xml',iso8583:'application/octet-stream','offline-batch':'application/json'}[ingress[2]];
    if(!req.headers['content-type']?.startsWith(contentType))fault('INVALID_FIELD',null,415);
    const parts=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>65535)fault('INVALID_FIELD',null,413);parts.push(chunk);}
    const raw=Buffer.concat(parts),p=await core.profile(pool,ingress[1]),credentials=connectorCredentials(p.credential_reference);
    await authenticateMessage(pool,p.profile_id,req.method,path+url.search,raw,req.headers,credentials.hmacSecret);
    if(ingress[2]==='iso8583'){
     const response=await processAvis8583(core,{id:'connector:'+p.profile_id,admin:true},raw,{allowedTerminals:credentials.allowedTerminals||[]});
     res.setHeader('content-type','application/octet-stream');return res.end(response);
    }
    if(ingress[2]==='offline-batch'){
     const batch=JSON.parse(raw.toString('utf8'));if(!credentials.allowedTerminals?.includes(batch.terminalId))fault('TERMINAL_NOT_FOUND','terminalId');
     return send(res,200,await core.settleOfflineBatch({id:'connector:'+p.profile_id,admin:true},batch,batch.batchId));
    }
    const receipt=await core.receive(p.profile_id,raw.toString('utf8')),original=await readIso20022(raw.toString('utf8'));
    const reply=await buildPacs002({messageId:randomBytes(16).toString('hex'),uetr:original.uetr,senderBic:p.local_bic,receiverBic:p.peer_bic,status:receipt.status,bankReference:receipt.id.replaceAll('-','')});
    res.setHeader('content-type','application/xml');return res.end(reply);
   }
   if(req.method==='GET'&&['/','/app.mjs','/styles.css'].includes(path)){
    const file=path==='/'?'index.html':'public'+path;
    const body=await readFile(new URL(file,import.meta.url));
    res.setHeader('content-type',path==='/'?'text/html; charset=utf-8':path.endsWith('css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');return res.end(body);
   }
   if(!path.startsWith('/api/'))return send(res,404,{code:'NOT_FOUND'});
   let body={};
   if(req.method==='POST'){
    // Same-origin browser mutations only; payment-network APIs have separate authentication.
    const origin=req.headers.origin;
    const host=req.headers.host;
    if(!origin||new URL(origin).host!==host||!['same-origin','none',undefined].includes(req.headers['sec-fetch-site']))fault('CSRF',null,403);
    if(!req.headers['content-type']?.startsWith('application/json'))fault('INVALID_FIELD',null,415);
    let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536)fault('INVALID_FIELD',null,413);}
    try{body=JSON.parse(raw);}catch{fault('INVALID_FIELD',null,400);}
    if(!body||typeof body!=='object'||Array.isArray(body))fault('INVALID_FIELD',null,400);
   }
   if(path==='/api/login'&&req.method==='POST'){
    const username=text(body.username,'username',100);text(body.password,'password',256);const password=body.password;
    // Bound the map and throttle by account, independently of spoofable proxy headers.
    const bucket=digest(username.toLowerCase()),now=Date.now(),previous=attempts.get(bucket);
    if(previous&&now-previous.since<60000&&previous.count>=8)fault('TOO_MANY_ATTEMPTS',null,429);
    if(attempts.size>10000)for(const[k,v]of attempts)if(now-v.since>60000)attempts.delete(k);
    if(attempts.size>=10000&&!previous)fault('TOO_MANY_ATTEMPTS',null,429);
    attempts.set(bucket,previous&&now-previous.since<60000?{since:previous.since,count:previous.count+1}:{since:now,count:1});
    const actor=await authenticate(username,password);if(!actor?.admin)fault('FORBIDDEN',null,403);
    const token=randomBytes(32).toString('base64url'),csrf=sessionCsrf(token);
    await pool.query('DELETE FROM avis_core_v2.operator_sessions WHERE expires_at<now()');
    await pool.query("INSERT INTO avis_core_v2.operator_sessions(token_hash,csrf_hash,actor_id,username,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[digest(token),digest(csrf),actor.id,actor.username]);
    res.setHeader('Set-Cookie',`avis_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${secureCookies?'; Secure':''}`);
    return send(res,200,{username:actor.username,csrf});
   }
   const token=/(?:^|;\s*)avis_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie||'')?.[1];
   if(!token)fault('UNAUTHORIZED',null,401);
   const session=(await pool.query('SELECT * FROM avis_core_v2.operator_sessions WHERE token_hash=$1 AND expires_at>now()',[digest(token)])).rows[0];
   if(!session)fault('UNAUTHORIZED',null,401);
   const actor={id:session.actor_id,username:session.username,admin:true};
   if(path==='/api/session'&&req.method==='GET'){
    // Restore the same token in every tab. Adopt sessions issued before this
    // release once; new sessions need no write when restoring the workspace.
    const csrf=sessionCsrf(token);
    if(session.csrf_hash!==digest(csrf))await pool.query('UPDATE avis_core_v2.operator_sessions SET csrf_hash=$2 WHERE token_hash=$1',[digest(token),digest(csrf)]);
    return send(res,200,{username:actor.username,csrf});
   }
   if(req.method==='GET'&&path.startsWith('/api/views/'))return send(res,200,{rows:await core.list(actor,path.split('/').at(-1))});
   if(req.method!=='POST')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
   if(digest(req.headers['x-csrf-token']||'')!==session.csrf_hash)fault('CSRF',null,403);
   if(path==='/api/logout'){
    await pool.query('DELETE FROM avis_core_v2.operator_sessions WHERE token_hash=$1',[digest(token)]);
    res.setHeader('Set-Cookie',`avis_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies?'; Secure':''}`);return send(res,200,{});
   }
   if(path==='/api/bankpayments/dispatch')return send(res,200,await dispatchPayment(core,actor,body,req.headers['idempotency-key']));
   const routes={customers:'openCustomer',currencies:'addCurrencies',transfers:'transfer',shops:'registerShop',
    correspondents:'registerCashAccount',bankprofiles:'registerBankConnector',bankroutes:'linkBankAccount',bankpayments:'initiatePayment','clearing/reconcile':'reconcileStatement',
    'fx/rates/refresh':'refreshFxRates','fx/quote':'quoteFx','fx/execute':'executeFx','fx/cancel':'cancelFx',
    'offline/keys':'configureOffline','offline/allowances':'issueOfflineAllowance','offline/sync':'settleOfflineBatch','offline/close':'closeOfflineAllowance',
    'checkouts/capture':'captureCheckout','checkouts/release':'releaseCheckout','checkouts/refund':'refundCheckout',
    cards:'registerCard',terminals:'registerTerminal','cards/authorize':'authorizeCard','cards/capture':'settleCard','cards/reverse':'settleCard'};
   const action=path.slice(5),method=routes[action];if(!method)fault('NOT_FOUND',null,404);
   const result=await core[method](actor,body,req.headers['idempotency-key'],action==='cards/reverse');
   if(action==='fx/execute'&&result.status==='EXPIRED')fault('FX_QUOTE_EXPIRED','quoteId',409);
   return send(res,200,result);
  }catch(e){
   const code=e.code==='23505'?'DUPLICATE_RECORD':['23503','22P02'].includes(e.code)?'INVALID_REFERENCE':messages[e.code]?e.code:messages[e.message]?e.message:'REQUEST_FAILED';
   console.error(JSON.stringify({requestId,code,diagnosticCode:e.code||e.message?.slice(0,100)}));
   send(res,e.status||(['DUPLICATE_RECORD','IDEMPOTENCY_CONFLICT'].includes(code)?409:code==='REQUEST_FAILED'?500:422),{code,field:e.field,message:messages[code],requestId});
  }
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const pool=new pg.Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT||5432),database:process.env.PGDATABASE,
  user:process.env.PGUSER,password:process.env.PGPASSWORD,max:8,connectionTimeoutMillis:10000,
  ssl:process.env.PGHOST==='localhost'?false:{rejectUnauthorized:true}});
 const client=await pool.connect();try{await migrate(client);}finally{client.release();}
 createBankServer({pool,authenticate:(u,p)=>authenticateFineract(u,p,process.env.FINERACT_URL),release:process.env.RELEASE_SHA||'local'})
  .listen(Number(process.env.PORT||8080),'0.0.0.0');
 const housekeeping=new FxBankingServer(pool);let expiring=false;
 let recovering=false;
 const recoverDeliveries=async()=>{if(recovering)return;recovering=true;try {
  await recoverPaymentDeliveries(housekeeping,{id:'system:payment-delivery',admin:true});
 }catch(e){console.error(JSON.stringify({operation:'PAYMENT_DELIVERY_RECOVERY',code:e.code||'DELIVERY_RECOVERY_FAILED'}));}finally{recovering=false;}};
 void recoverDeliveries();setInterval(recoverDeliveries,10000).unref();

 const refreshRates=()=>housekeeping.refreshFxRates({id:'system:fx-rates',admin:true},{},'ecb:'+new Date().toISOString().slice(0,13)).catch(e=>console.error(JSON.stringify({operation:'FX_RATE_REFRESH',code:e.code||'RATE_REFRESH_FAILED'})));
 void refreshRates();setInterval(refreshRates,3600000).unref();
 setInterval(async()=>{if(expiring)return;expiring=true;try{
  if((await pool.query("SELECT 1 FROM avis_core_v2.fx_quotes WHERE status='OPEN' AND expires_at<=now() LIMIT 1")).rows.length)
   await housekeeping.operation({id:'system:fx-expiry',admin:true},'EXPIRE_FX_QUOTES',{},'expiry:'+Math.floor(Date.now()/30000),async db=>{await housekeeping.expireFxQuotes(db,{id:'system:fx-expiry'});return {expired:true};});
 }catch(e){console.error(JSON.stringify({operation:'FX_EXPIRY',code:e.code||'EXPIRY_FAILED'}));}finally{expiring=false;}},30000).unref();

}
