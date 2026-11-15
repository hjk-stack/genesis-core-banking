import http from 'node:http';
import {processAbiqRequest} from './src/abiq-interface.mjs';
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {fault,text} from './src/core.mjs';
import {migrate} from './src/migrate.mjs';
import {FxBankingServer} from './src/fx.mjs';
import {TradingRobotCore,ROBOT_MESSAGES} from './src/trading-robot.mjs';
import {TradingRuntime} from './src/trading/runtime.mjs';
import {CRYPTO_MESSAGES} from './src/crypto-workspace.mjs';
import {CustomerAccess} from './src/customer-access.mjs';
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
 if(account.authenticated!==true||account.isTwoFactorAuthenticationRequired===true||!/^\d+$/.test(String(account.userId||'')))fault('OPERATOR_ACCESS_REQUIRED','username',403);
 return {id:'fineract:'+account.userId,username:account.username||username,admin:account.permissions?.includes('ALL_FUNCTIONS')===true};
}
const messages={...ROBOT_MESSAGES,...CRYPTO_MESSAGES,
 SECURITY_CATALOGUE_READ:'The Green Bond catalogue could not be refreshed. Try Refresh catalogue again.',
 SECURITY_TERMS_CHANGED:'The security denomination or currency changed. Select the security again.',
 SECURITY_NOT_FOUND:'Select a registered security.',POSITION_CHANGED:'This holding changed. Reopen it before saving.',
 SECURITY_QUANTITY_PRECISION:'Enter a quantity in the security’s registered unit size.',
 SECURITY_QUANTITY_RESERVED:'The quantity cannot be reduced below the units reserved for sell orders.',
 ORDER_TOTAL_CHANGED:'Check the quantity, price and calculated total.',INSUFFICIENT_SECURITIES:'This portfolio has insufficient available units to sell.',
 ORDER_NOT_FOUND:'Select an existing exchange order.',ORDER_REVIEW_CHANGED:'This order review expired or changed. Review the order again.',
 ORDER_ALREADY_FILLED:'This order has already executed.',
 INVALID_CODE_WINDOW:'Choose a start and end time with a validity of up to 48 hours.',
 CARD_CODE_NOT_STARTED:'This card code is not active yet.',CARD_CODE_BLOCKED:'This card is blocked or expired.',
 INVALID_CARD_PIN:'Enter a PIN containing four to six digits.',IDENTITY_ALREADY_BOUND:'This login is already linked to another account holder.',
 INVALID_CARD_NUMBER:'Check the card number.',INVALID_CARD_EXPIRY:'Enter a valid expiry as MM/YYYY.',
 SELECT_EXTERNAL_CARD:'Select a registered external card.',OFFLINE_INTERNAL_CARD:'Select an AVIS card for offline debit.',
 CRYPTO_HOLDING_REQUIRED:'Select this account holder’s crypto holding.',AG_PURCHASE_REQUIRED:'Purchase AG before transferring it.',
 INVALID_CRYPTO_ADDRESS:'Check the receiving blockchain address.',CARD_DELIVERY_KEY:'Card delivery could not be encrypted. Check the card service in Administration.',
 INVALID_CARD_CODE:'Check the six-digit code.',CARD_CODE_CLOSED:'This code has expired, been used or been locked. Check its card request.',
 TRANSFER_ALREADY_CLAIMED:'Another administrator has picked up this request.',TRANSFER_PICKUP_REQUIRED:'Pick up this request before processing it.',
 SETTLEMENT_ACCOUNT_REQUIRED:'Select the funded settlement account used for this payment.',
 CRYPTO_STOCK_REQUIRED:'Select the institution’s crypto stock and proceeds account.',CRYPTO_OFFER_REQUIRED:'Select an available purchase offer.',CRYPTO_PRICE_CHANGED:'The purchase price changed. Review the current quote.',

 INVALID_RECEIVER_ACCOUNT:'Check the receiving account number and its check digits.',
 INVALID_RECEIVER_BIC:'Enter an 8 or 11 character BIC.',RECEIVER_BIC_MISMATCH:'The BIC does not match this receiving account.',
 RECEIVER_BANK_VALIDATION:'Check the receiving account and bank BIC.',
 PAYMENT_REVIEW_CHANGED:'The payment details or route changed. Go back and build a new message.',
 PAYMENT_REQUEST_NOT_FOUND:'Select an existing payment request.',PAYMENT_REQUEST_CLOSED:'This request is already closed.',
 ABIQ_ACCOUNT_ORDER_COUNT:'Request one identifier when opening a currency account.',
 ABIQ_UNSUPPORTED_CURRENCY:'Select an accepted account currency.',ABIQ_INVALID_CURRENCIES:'Select at least one account currency.',
 ABIQ_CUSTOMER_NOT_FOUND:'Select an existing account holder.',ABIQ_INVALID_CUSTOMER:'Select a valid account holder.',
 ABIQ_ACCOUNT_NOT_ACTIVE:'Select an active account.',ABIQ_IDEMPOTENCY_CONFLICT:'This request reference has already been used for different currencies.',
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
export function createBankServer({pool,authenticate,release='local',secureCookies=true,transferOptions={}}) {
 const core=new TradingRobotCore(pool,transferOptions),customerAccess=new CustomerAccess(core),attempts=new Map();
 const send=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 return http.createServer(async(req,res)=>{
  const requestId=randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id',requestId);res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://assets.coingecko.com https://coin-images.coingecko.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
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
   if(req.method==='GET'&&['/','/card-message','/app.mjs','/payment-wizard.mjs','/card-message.mjs','/cards.mjs','/accounts.mjs','/portfolio.mjs','/exchange-intent.mjs','/crypto-workspace.mjs','/trading-panel.mjs','/crypto.css','/styles.css'].includes(path)){
    const file=path==='/'?'index.html':path==='/card-message'?'public/card-message.html':'public'+path;
    const body=await readFile(new URL(file,import.meta.url));
    res.setHeader('content-type',(path==='/'||path==='/card-message')?'text/html; charset=utf-8':path.endsWith('css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');return res.end(body);
   }
   if(req.method==='GET'&&/^\/api\/exchange\/markets\/[A-Z0-9._-]{1,80}$/.test(path))return send(res,200,await core.publicExchangeMarket(path.split('/').at(-1)));
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
    const actor=await authenticate(username,password);if(!actor?.id)fault('FORBIDDEN',null,403);
    const binding=actor.admin?null:(await pool.query('SELECT user_id FROM avis_core_v2.customer_logins WHERE principal_id=$1',[actor.id])).rows[0];
    if(!actor.admin&&!binding)fault('FORBIDDEN',null,403);
    const token=randomBytes(32).toString('base64url'),csrf=sessionCsrf(token);
    await pool.query('DELETE FROM avis_core_v2.operator_sessions WHERE expires_at<now()');
    await pool.query("INSERT INTO avis_core_v2.operator_sessions(token_hash,csrf_hash,actor_id,username,is_admin,customer_user_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 hour')",[digest(token),digest(csrf),actor.id,actor.username,actor.admin===true,binding?.user_id||null]);
    res.setHeader('Set-Cookie',`avis_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${secureCookies?'; Secure':''}`);
    return send(res,200,{username:actor.username,csrf,admin:actor.admin===true,customerUserId:binding?String(binding.user_id):null,canSwitchWorkspace:actor.admin===true});
   }
   const token=/(?:^|;\s*)avis_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie||'')?.[1];
   if(!token)fault('UNAUTHORIZED',null,401);
   const session=(await pool.query('SELECT * FROM avis_core_v2.operator_sessions WHERE token_hash=$1 AND expires_at>now()',[digest(token)])).rows[0];
   if(!session)fault('UNAUTHORIZED',null,401);
   const holder=session.is_admin?session.workspace_user_id:session.customer_user_id;
   if(!session.is_admin){const binding=(await pool.query('SELECT user_id FROM avis_core_v2.customer_logins WHERE principal_id=$1',[session.actor_id])).rows[0];if(!binding||String(binding.user_id)!==String(holder))fault('FORBIDDEN',null,403);}
   const actor={id:session.actor_id+(session.is_admin&&holder?':customer:'+holder:''),username:session.username,admin:session.is_admin&&!holder,customerUserId:holder?String(holder):null};
   const sessionData=()=>({username:actor.username,csrf:sessionCsrf(token),admin:actor.admin,customerUserId:actor.customerUserId,canSwitchWorkspace:session.is_admin});
   const invoke=(method,input,key,...extra)=>actor.admin?core[method](actor,input,key,...extra):customerAccess.invoke(actor,method,input,key,...extra);
   if(path==='/api/session'&&req.method==='GET'){
    // Restore the same token in every tab. Adopt sessions issued before this
    // release once; new sessions need no write when restoring the workspace.
    const csrf=sessionCsrf(token);
    if(session.csrf_hash!==digest(csrf))await pool.query('UPDATE avis_core_v2.operator_sessions SET csrf_hash=$2 WHERE token_hash=$1',[digest(token),digest(csrf)]);
    return send(res,200,sessionData());
   }
   if(path==='/api/workspaces'&&req.method==='GET'){if(!session.is_admin)fault('FORBIDDEN',null,403);return send(res,200,{rows:(await pool.query("SELECT user_id,full_name FROM avis_core_v2.sovereign_users WHERE account_role='CUSTOMER' ORDER BY user_id")).rows});}
   if(req.method==='GET'&&/^\/api\/portfolio\/orders\/[0-9a-f-]{36}$/.test(path))return send(res,200,await invoke('securityOrderDetails',{orderId:path.split('/').at(-1)}));
   if(req.method==='GET'&&/^\/api\/accounts\/[0-9a-f-]{36}$/.test(path))return send(res,200,await invoke('accountDetails',{accountId:path.split('/').at(-1),before:url.searchParams.get('before')}));
   if(req.method==='GET'&&/^\/api\/accounts\/[0-9a-f-]{36}\/movements\/[0-9]+$/.test(path))return send(res,200,await invoke('movementDetails',{accountId:path.split('/').at(-3),entryId:path.split('/').at(-1)}));
   if(req.method==='GET'&&/^\/api\/backoffice-accounts\/[0-9a-f-]{36}\/statement$/.test(path))return send(res,200,await invoke('accountStatement',{accountId:path.split('/').at(-2),before:url.searchParams.get('before')}));
   if(req.method==='GET'&&/^\/api\/cards\/[0-9a-f-]{36}$/.test(path))return send(res,200,await invoke('managedCardDetails',{cardId:path.split('/').at(-1)}));
   if(req.method==='GET'&&/^\/api\/payment-requests\/[0-9a-f-]{36}$/.test(path))return send(res,200,await (actor.admin?core:customerAccess).paymentRequest(actor,path.split('/').at(-1)));
   if(req.method==='GET'&&/^\/api\/crypto\/securities\/[0-9a-f-]{36}$/.test(path))return send(res,200,await invoke('cryptoSecurityDetails',{cardId:path.split('/').at(-1)}));
   if(req.method==='GET'&&path.startsWith('/api/views/'))return send(res,200,{rows:await (actor.admin?core:customerAccess).list(actor,path.split('/').at(-1))});
   if(req.method!=='POST')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
   if(digest(req.headers['x-csrf-token']||'')!==session.csrf_hash)fault('CSRF',null,403);
   if(path==='/api/logout'){
    await pool.query('DELETE FROM avis_core_v2.operator_sessions WHERE token_hash=$1',[digest(token)]);
    res.setHeader('Set-Cookie',`avis_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies?'; Secure':''}`);return send(res,200,{});
   }
   if(path==='/api/workspace'){
    if(!session.is_admin)fault('FORBIDDEN',null,403);
    const id=body.userId||null;
    if(id&&!(await pool.query("SELECT user_id FROM avis_core_v2.sovereign_users WHERE user_id=$1 AND account_role='CUSTOMER'",[id])).rows.length)fault('ABIQ_CUSTOMER_NOT_FOUND','userId');
    await pool.query('UPDATE avis_core_v2.operator_sessions SET workspace_user_id=$2 WHERE token_hash=$1',[digest(token),id]);
    return send(res,200,{...sessionData(),admin:!id,customerUserId:id?String(id):null});
   }
   if(path==='/api/payments/crypto-receiver'){
    const r=(await pool.query('SELECT full_name FROM avis_core_v2.sovereign_users WHERE user_id=$1',[body.receiverUserId])).rows[0];if(!r)fault('ABIQ_CUSTOMER_NOT_FOUND','receiverUserId');return send(res,200,{receiverName:r.full_name});
   }
   if(path==='/api/payments/card-delivery')return send(res,200,await invoke('cardDelivery',body));
   if(path==='/api/payments/check-receiver')return send(res,200,await invoke('checkReceiver',body));
   if((path==='/api/abiq'||path==='/api/bankpayments/dispatch')&&!actor.admin)fault('FORBIDDEN',null,403);
   if(path==='/api/abiq')return send(res,200,await processAbiqRequest(core,actor,body));
   if(path==='/api/bankpayments/dispatch')return send(res,200,await dispatchPayment(core,actor,body,req.headers['idempotency-key']));
   const routes={'cards/issue':'issueManagedCard','cards/load':'loadManagedCard','cards/status':'setCardStatus','cards/pin':'resetCardPin','cards/delivery':'managedCardDelivery','accounts/suspense':'moveToSuspense','access/customer':'bindCustomerLogin','crypto/sell':'sellCrypto','cards/external':'registerExternalCard','cards/redeem-code':'redeemCode','cards/cancel-code':'cancelCodedDebit','cards/pickup-details':'externalCardDetails','payments/pickup':'pickupTransfer','payments/settle-manual':'settleManualTransfer','crypto/offers':'registerCryptoOffer','crypto/purchase':'purchaseCrypto','payments/review':'preparePayment','payments/transfer':'confirmPayment','payments/cancel':'cancelPayment','customers/profile':'saveCustomerProfile',customers:'openCustomer',currencies:'addCurrencies',transfers:'transfer',shops:'registerShop',
    correspondents:'registerCashAccount',bankprofiles:'registerBankConnector',bankroutes:'linkBankAccount',bankpayments:'initiatePayment','clearing/reconcile':'reconcileStatement',
    'fx/rates/refresh':'refreshFxRates','fx/quote':'quoteFx','fx/execute':'executeFx','fx/cancel':'cancelFx',
    'offline/keys':'configureOffline','offline/allowances':'issueOfflineAllowance','offline/sync':'settleOfflineBatch','offline/close':'closeOfflineAllowance',
    'checkouts/capture':'captureCheckout','checkouts/release':'releaseCheckout','checkouts/refund':'refundCheckout',
    cards:'registerCard',terminals:'registerTerminal','cards/authorize':'authorizeCard','cards/capture':'settleCard','cards/reverse':'settleCard'};
   routes['accounts/open']='openAccount';
   Object.assign(routes,{'portfolio/exchange-security':'resolveExchangeSecurity','portfolio/catalogue/sync':'syncSecurities','portfolio/securities':'addSecurity','portfolio/positions':'recordPosition','portfolio/orders/review':'reviewSecurityOrder','portfolio/orders/submit':'submitSecurityOrder','portfolio/orders/cancel':'cancelSecurityOrder'});
   Object.assign(routes,{'crypto/trading/configure':'configureRobot','crypto/trading/toggle':'toggleRobot','crypto/approve':'approveCrypto','crypto/activate':'activateCrypto','crypto/wallet':'cryptoWallet','crypto/balance':'cryptoChainBalance','crypto/check-network':'checkCryptoNetwork','crypto/markets/refresh':'refreshCryptoMarkets','crypto/securities/demo-convert':'convertDemoSecurity','crypto/securities/prepare':'prepareRealSecurity','crypto/securities/package':'cryptoContractPackage','crypto/robot/channels':'createRollingChannel','crypto/actions/cancel':'cancelCryptoReview','crypto/actions/review':'prepareCryptoAction','crypto/actions/submit':'submitCryptoAction','crypto/actions/broadcast':'broadcastCryptoAction','crypto/actions/confirm':'confirmCryptoAction'});
   const action=path.slice(5),method=routes[action];if(!method)fault('NOT_FOUND',null,404);
   const result=await invoke(method,body,req.headers['idempotency-key'],action==='cards/reverse');
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
 const robotCore=new TradingRobotCore(pool);let recoveringChain=false;const recoverChain=async()=>{if(recoveringChain)return;recoveringChain=true;try{const pending=(await pool.query("SELECT action_id,status,tx_hash FROM avis_core_v2.crypto_chain_actions WHERE status IN('SIGNED','SUBMITTED') ORDER BY created_at LIMIT 20")).rows;for(const a of pending){try{if(a.status==='SIGNED')await robotCore.broadcastCryptoAction({id:'system:chain-recovery',admin:true},{actionId:a.action_id});await robotCore.confirmCryptoAction({id:'system:chain-recovery',admin:true},{actionId:a.action_id},'confirm:'+a.tx_hash);}catch(e){console.error(JSON.stringify({operation:'CHAIN_RECOVERY',code:e.code||'CHAIN_RECEIPT'}));}}}finally{recoveringChain=false;}};void recoverChain();setInterval(recoverChain,15000).unref();const trading=new TradingRuntime(robotCore).start();
 process.once('SIGTERM',()=>{void trading.stop();});
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
