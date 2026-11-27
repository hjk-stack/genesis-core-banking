import {generatorOptions,availableGeneratorNumbers,issueGeneratorNumber,assignGeneratorNumber} from './src/abiq-generator.mjs';
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
import {TradingRuntime,engineStatus} from './src/trading/runtime.mjs';
import {IndexServiceAuthenticator} from './src/index-service-auth.mjs';
import {CheckoutPosAuthenticator,CheckoutIpHandlerAuthenticator,WorkstationAdmissionAuthenticator} from './src/checkout-pos-auth.mjs';
import {registerHandlerDraft,handlerDraftPdf} from './src/ip-handler-drafts.mjs';
import {IP_PROOF_MAX_BYTES} from './src/checkout-ip-processing.mjs';
import {CheckoutPosControl} from './src/checkout-pos.mjs';
import {CheckoutIpControl} from './src/checkout-ip.mjs';
import {NostroStatements} from './src/nostro-statements.mjs';
import {INDEX_ADVICE_MESSAGES} from './src/index-event-advice.mjs';
import {TRADING_TEST_MESSAGES} from './src/trading-testing.mjs';
import {TRADING_INSTRUCTION_MESSAGES} from './src/trading-instructions.mjs';
import {TRADING_LIVE_MESSAGES} from './src/trading-live.mjs';
import {LiveMarketFeed} from './src/trading/live-market.mjs';
import {CoinApiIndexResearch,readCoinApiIndexResearch} from './src/trading/coinapi-index-research.mjs';
import {scanFinalizedEthereumDeposits} from './src/crypto-deposit-monitor.mjs';
import {CRYPTO_MESSAGES} from './src/crypto-workspace.mjs';
import {CustomerAccess} from './src/customer-access.mjs';
import {processAvis8583} from './src/pos-switch.mjs';
import {StoreWallet} from './src/checkout-store-wallet.mjs';
import {CryptoBasket,BASKET_MESSAGES} from './src/crypto-basket.mjs';
import {StripeWebPos} from './src/stripe-pos.mjs';
import {authenticateMessage,connectorCredentials,dispatchPayment,recoverPaymentDeliveries} from './src/payment-transport.mjs';
import {buildPacs002,readIso20022} from './src/iso20022.mjs';
import {FinTerminal} from './src/fin-terminal.mjs';
import {FinPeers} from './src/fin-peer.mjs';
import {FinListener} from './src/fin-listener.mjs';

import {isStaffHost, workstationFingerprint, contactIncubator} from './src/staff-workstation.mjs';
import {isStaffAccessDocument,sendStaffAccessPage} from './src/staff-access-page.mjs';
import {WorkstationAdmission,sendWorkstationCompletion} from './src/workstation-admission.mjs';
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
const messages={...BASKET_MESSAGES,...ROBOT_MESSAGES,...CRYPTO_MESSAGES,...INDEX_ADVICE_MESSAGES,...TRADING_TEST_MESSAGES,...TRADING_INSTRUCTION_MESSAGES,...TRADING_LIVE_MESSAGES,
 SECURITY_CATALOGUE_READ:'The Green Bond catalogue could not be refreshed. Try Refresh catalogue again.',
 SECURITY_TERMS_CHANGED:'The security denomination or currency changed. Select the security again.',
 SECURITY_NOT_FOUND:'Select a registered security.',POSITION_CHANGED:'This holding changed. Reopen it before saving.',
 TREASURY_SECURITY_SOURCE:'Select an existing institution Treasury security source.',
 TREASURY_SECURITY_IDENTITY:'Select the security registered for this Treasury source.',
 TREASURY_SECURITY_LINKED:'This Portfolio position is already linked to another Treasury source.',
 TREASURY_SECURITY_QUANTITY:'The existing Portfolio quantity differs from this Treasury source. Select its matching position.',
 SECURITY_QUANTITY_PRECISION:'Enter a quantity in the security’s registered unit size.',
 SECURITY_QUANTITY_RESERVED:'The quantity cannot be reduced below the units reserved for sell orders.',
 ORDER_TOTAL_CHANGED:'Check the quantity, price and calculated total.',INSUFFICIENT_SECURITIES:'This portfolio has insufficient available units to sell.',
 ORDER_NOT_FOUND:'Select an existing exchange order.',ORDER_REVIEW_CHANGED:'This order review expired or changed. Review the order again.',
 ORDER_ALREADY_FILLED:'This order has already executed.',
 INVALID_CODE_WINDOW:'Choose a start and end time with a validity of up to 48 hours.',
 CARD_CODE_NOT_STARTED:'This card code is not active yet.',CARD_CODE_BLOCKED:'This card is blocked or expired.',
 INVALID_CARD_PIN:'Enter a PIN containing four to six digits.',IDENTITY_ALREADY_BOUND:'This login is already linked to another account holder.',
 BUSINESS_IDENTITY_EXISTS:'AVISPay PLC already has a business identity. Add currencies from its existing account.',
 INVALID_CARD_NUMBER:'Check the card number.',INVALID_CARD_EXPIRY:'Enter a valid expiry as MM/YYYY.',
 SELECT_EXTERNAL_CARD:'Select a registered external card.',OFFLINE_INTERNAL_CARD:'Select an AVIS card for offline debit.',
 CRYPTO_HOLDING_REQUIRED:'Select this account holder’s crypto holding.',AG_PURCHASE_REQUIRED:'Purchase AG before transferring it.',
 INVALID_CRYPTO_ADDRESS:'Check the receiving blockchain address.',CARD_DELIVERY_KEY:'Card delivery could not be encrypted. Check the card service in Administration.',
 CRYPTO_SEND_SCOPE:'Select a funding wallet or a registered Ethereum security wallet.',
 CRYPTO_AMOUNT_PRECISION:'Use the selected currency’s supported decimal places.',
 CRYPTO_CHAIN_BALANCE:'The signing wallet has insufficient confirmed funds for this transfer.',
 CRYPTO_GAS_BALANCE:'The signing wallet needs enough ETH to cover the maximum network fee.',
 CRYPTO_CUSTODY_BALANCE:'The selected wallet has insufficient unreserved blockchain backing.',
 CRYPTO_DEPOSIT_HASH:'Enter the Ethereum transaction hash, starting with 0x followed by 64 hexadecimal characters.',
 CRYPTO_DEPOSIT_ACCOUNT:'Select the matching Ethereum wallet for this incoming transfer.',
 CRYPTO_DEPOSIT_EVENT:'This transaction does not contain a confirmed incoming transfer of the selected currency to this wallet.',
 CRYPTO_DEPOSIT_MANAGED_SOURCE:'This transfer originates from another AVISPay wallet. Check its payment receipt.',
 CRYPTO_DEPOSIT_REORG:'The transaction’s block changed. Check its latest blockchain receipt before retrying.',
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
 ABIQ_HOLDER_CODE:'Enter a four-letter ABIQ holder code.',ABIQ_CHECK_DIGITS:'Select the calculated check digits.',
 ABIQ_NUMBER_TAKEN:'That number has been issued. Select another customer number.',ABIQ_NUMBER_EXHAUSTED:'The seven-digit series for this holder is full.',
 ABIQ_ALREADY_ASSIGNED:'This number is already assigned to another account.',
 ABIQ_UNSUPPORTED_CURRENCY:'Select an accepted account currency.',ABIQ_INVALID_CURRENCIES:'Select at least one account currency.',
 ABIQ_CURRENCY_ALREADY_HELD:'This currency already has an account under the business identity.',
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
 BANK_WORKSTATION_REQUIRED:'Use the bank desk on an approved workstation.',
 SIGN_IN_FAILED:'Check your username and password.',OPERATOR_ACCESS_REQUIRED:'Use an administrator account.',
 SIGN_IN_SERVICE:'Sign-in could not be completed. Please try again.',UNAUTHORIZED:'Sign in to continue.',
 IDEMPOTENCY_CONFLICT:'This request reference was already used for different details.',SAME_ACCOUNT:'Select a different receiving account.',
 CHECKOUT_ALREADY_CLOSED:'This checkout has already been completed.',CHECKOUT_NOT_IN_ESCROW:'Select a checkout whose funds are still held in escrow.',
 AUTHORIZATION_ALREADY_CLOSED:'This authorization has already been captured or reversed.',
 SELECT_AVIS_CARD:'Select an active AVIS proprietary card.',CURRENCY_MISMATCH:'Select the card account currency.',
 TERMINAL_NOT_FOUND:'Select an active terminal.',POS_TERMINAL_ID:'Check the POS terminal identifier and checkout reference.',POS_TERMINAL_CONFLICT:'This terminal ID is assigned to a different checkout.',POS_MERCHANT_REQUIRED:'Register the AVISPay Web POS merchant before assigning checkout terminals.',CHECKOUT_IP_NOT_FOUND:'Payment request was not found.',CHECKOUT_IP_STATE:'Payment request has expired or changed.',CHECKOUT_IP_ACCOUNT:'Select a registered receiving account or matching bank.',CHECKOUT_IP_ACCOUNT_CHANGED:'The account selection changed. Refresh this payment row.',POS_SERVICE_AUTH:'The checkout service signature could not be verified.',SELECT_BANK_ACCOUNT:'Select AVIS Bank for this account-funded checkout.',
 STRIPE_CONFIGURATION:'Configure the Stripe merchant connection in Banking Administration.',
 STRIPE_PROVIDER_RESPONSE:'The card checkout request could not complete. Retry from this payment.',
 STRIPE_SIGNATURE:'The Stripe event could not be verified.',STRIPE_EVENT_MISMATCH:'The card payment details did not match the original checkout.',
 DUPLICATE_RECORD:'This reference is already registered.',INVALID_REFERENCE:'Select a valid record.',
 IP_HANDLER_SERVICE_AUTH:'The IP-to-IP handler signature could not be verified.',
 CHECKOUT_IP_COMPLETION:'Complete the settled operation details in the IP-to-IP handler.',
 CHECKOUT_IP_COMPLETED:'This payment operation has already been completed.',
 CHECKOUT_IP_CANCELLED:'This checkout request was cancelled. Create a new checkout request.',
 CHECKOUT_IP_PROCESSING:'This payment has entered settlement processing.',
 CHECKOUT_IP_CLAIM_REQUIRED:'Claim the matched bank settlement before publishing its result.',
 CHECKOUT_IP_SETTLEMENT_AMOUNT:'The booked bank amount must match this checkout request.',
 CHECKOUT_IP_SETTLEMENT_CONFLICT:'Use the retained bank entry and original settlement evidence for this request.',
 CHECKOUT_IP_REVISION:'Refresh the operation before saving its processing report.',
 CHECKOUT_IP_PROCESSING_LINK:'Select the handler operation linked to this checkout request.',
 CHECKOUT_IP_PROOF:'Attach the original proof PDF for this completed operation.',
 CHECKOUT_IP_PROOF_NOT_FOUND:'No proof PDF has been recorded for this payment.',
 CHECKOUT_IP_PROOF_INTEGRITY:'This proof PDF could not be verified. Retrieve its original from the IP-to-IP handler.',
 INTERMEDIARY_NOT_FOUND:'Select an existing intermediary bank entry.',
 NOSTRO_ACCOUNT_NOT_FOUND:'Select a registered NOSTRO clearing account.',
 NOSTRO_STATEMENT_NOT_FOUND:'Select an external statement for this NOSTRO account.',
 NOSTRO_ALREADY_SETTLED:'This external payment reference is already recorded as settled or reconciled.',
 NOSTRO_GATEWAY_NOT_FOUND:'Select a registered card settlement gateway.',
 NOSTRO_GATEWAY_ALREADY_LINKED:'This card gateway is linked to another NOSTRO account.',
 TREASURY_SECURITY_SHARED:'This security is in another portfolio or an open order. Update the shared instrument separately.',
 FORBIDDEN:'You do not have access to this action.',REQUEST_FAILED:'This action could not be completed. Reference this request in Administration.',
 CSRF:'Refresh the page and submit again.',TOO_MANY_ATTEMPTS:'Please wait before trying to sign in again.',
 FIN_UETR_DUPLICATE:'This UETR is already used by another payment or draft. Make a new UETR.',
 FIN_DRAFT_CHANGED:'This draft was saved meanwhile. Open it again before saving.',FIN_DRAFT_NOT_FOUND:'Select an existing FinTerminal draft.',
 FIN_MESSAGE_INVALID:'Write the ISO 20022 message as XML, without a document type.',
 FIN_BOOKING_ACCOUNT:'Select a Common or Suspense account in the message\'s currency.',FIN_NOSTRO_ACCOUNT:'Select an active NOSTRO account in the message\'s currency.',
 FIN_TOKEN_WALLET:'Select a "+" wallet; AG and AGi are not booked here.',
 FIN_BOOKING_MISMATCH:'The debtor\'s IBAN and BIC are not those of the chosen Common or Suspense account.',
 FIN_NOSTRO_MISMATCH:'The receiver, INDA and the settlement account are not those of the chosen NOSTRO account.',
 FIN_CREDITOR_MISMATCH:'The creditor\'s IBAN and BIC and the receiver are not those of the chosen Common or Suspense account.',
 FIN_NOSTRO_SENDER_MISMATCH:'The sender, INGA and the settlement account are not those of the chosen NOSTRO account.',
 FIN_INCOMING_INVALID:'Register a message that passes Validate XML.',FIN_DRAFT_REGISTERED:'This incoming transfer is registered and is not changed any more.',
 FIN_LISTENING:'The listening port is open: close it to connect out.',FIN_SENDING:'A session message is on its way: open the port once it has its answer.',FIN_LISTENER_NO_PEER:'Whitelist a peer bank\'s IP address before opening the port.',
 LISTENER_CONFIGURATION:'The listening certificate (AVIS_CONNECTOR_LISTENER) is not in place in Azure.'
};
export function createBankServer({pool,authenticate,release='local',secureCookies=true,transferOptions={}}) {
 const core=new TradingRobotCore(pool,transferOptions),customerAccess=new CustomerAccess(core),attempts=new Map(),indexService=new IndexServiceAuthenticator(pool,{env:core.secretEnv,fetcher:transferOptions.indexServiceFetcher||core.cryptoFetch});
 const stripePos=transferOptions.stripePos||new StripeWebPos(pool,{env:transferOptions.secretEnv||process.env,fetcher:transferOptions.stripeFetch||fetch});
 const basket=new CryptoBasket(core,stripePos),storeWallet=new StoreWallet(basket);
 const posControl=new CheckoutPosControl(pool),ipControl=new CheckoutIpControl(pool),posAuth=new CheckoutPosAuthenticator(pool,{fetcher:transferOptions.posServiceFetcher||fetch});
 const ipHandlerAuth=new CheckoutIpHandlerAuthenticator(pool,{fetcher:transferOptions.ipHandlerServiceFetcher||transferOptions.posServiceFetcher||fetch});
 const workstationFetcher=transferOptions.workstationFetcher||fetch;
 const workstationAuth=new WorkstationAdmissionAuthenticator(pool,{fetcher:workstationFetcher});
 const workstationAdmission=new WorkstationAdmission(pool,{fetcher:workstationFetcher});
 const nostroStatements=new NostroStatements(pool),finTerminal=new FinTerminal(pool),finPeers=new FinPeers(pool,transferOptions.transport);
 const finListener=new FinListener(pool,finPeers,transferOptions.finListener).watch();
 const send=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 const server=http.createServer(async(req,res)=>{
  const requestId=randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id',requestId);res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://assets.coingecko.com https://coin-images.coingecko.com; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
   const url=new URL(req.url,'http://localhost'),path=url.pathname;
   if(req.method==='GET'&&path==='/healthz')return send(res,200,{status:'ok',release});
   const privateDesk=isStaffHost(req);
   // Only this exact hostname owns the application-access bootstrap. These
   // routes never alter ingress or the authentication of another bank hostname.
   if(['/access/start','/access/complete','/api/services/workstations/handoff'].includes(path)){
    if(!privateDesk)return send(res,404,{code:'NOT_FOUND'});
    res.setHeader('Referrer-Policy','no-referrer');
    if(path==='/access/start'){
     if(req.method!=='GET')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
     if(url.search)fault('BANK_WORKSTATION_REQUIRED',null,403);
     const start=await workstationAdmission.start(req);
     res.setHeader('Set-Cookie',start.cookie);res.writeHead(303,{location:start.location});return res.end();
    }
    if(path==='/access/complete'){
     if(req.method!=='GET')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
     const complete=await workstationAdmission.complete(req,url);
     res.setHeader('Set-Cookie',complete.cookies);return sendWorkstationCompletion(res);
    }
    if(req.method!=='POST')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
    if(!req.headers['content-type']?.startsWith('application/json'))fault('INVALID_FIELD',null,415);
    const parts=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>8192)fault('INVALID_FIELD',null,413);parts.push(chunk);}
    const raw=Buffer.concat(parts),service=await workstationAuth.authenticate(req,raw);
    let input;try{input=JSON.parse(raw.toString('utf8'));}catch{fault('INVALID_FIELD',null,400);}
    return send(res,200,await workstationAdmission.handoff(service,input));
   }
   const deskPolicy=privateDesk || process.env.BANK_DESK_ENFORCE==='1';
   const deviceAdmission=privateDesk ? await workstationAdmission.fromRequest(req) : null;
   const fingerprint=privateDesk&&!deviceAdmission ? workstationFingerprint(req) : null;
   if(privateDesk&&!deviceAdmission) {
    // An approved bank session may open the FinTerminal in a new browser window
    // without the original browser workstation admission (for example after
    // the domain migration). Start the existing one-time device handoff rather
    // than show the generic denial inside that terminal. The handoff itself
    // validates the administrator and device on AVIS.Land.
    try {
     const admission=await contactIncubator('admit',{fp:fingerprint});
     if(admission.approved!==true)fault('BANK_WORKSTATION_REQUIRED',null,403);
    } catch(error) {
     if(req.method==='GET'&&path==='/fin-terminal'&&isStaffAccessDocument(req)&&error?.code==='BANK_WORKSTATION_REQUIRED') {
      res.writeHead(303,{'location':'/access/start','cache-control':'private, no-store','referrer-policy':'no-referrer'});
      return res.end();
     }
     throw error;
    }
   }
   if(req.method==='GET'&&path==='/api/crypto/trading/index-receipt')return send(res,200,engineStatus.indexReceipt||{producer:'AVIS_W_EFFECT_ROBOT',source:'AVIS_PRESS_ROBOT',sequence:null,receivedAt:null});
   if(path==='/api/services/press-index/policy'||path==='/api/services/press-index/candidates'){
    if(path.endsWith('/policy')&&req.method==='GET')return send(res,200,await core.indexPolicy(await indexService.authenticate(req)));
    if(path.endsWith('/candidates')&&req.method==='POST'){
     if(!req.headers['content-type']?.startsWith('application/json'))fault('INVALID_FIELD',null,415);
     const parts=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>262144)fault('INVALID_FIELD',null,413);parts.push(chunk);}
     const raw=Buffer.concat(parts),service=await indexService.authenticate(req,raw);let value;try{value=JSON.parse(raw.toString('utf8'));}catch{fault('INVALID_FIELD',null,400);}
     return send(res,200,await core.ingestIndexCandidates(service,value));
    }
    return send(res,405,{code:'METHOD_NOT_ALLOWED'});
   }
   // Authenticated website-to-bank POS activation; not a customer-facing gateway.
   const posService=/^\/api\/services\/checkout-pos\/(resolve|status|request)$/.exec(path);
   if(posService){
    if(req.method!=='POST')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
    if(!req.headers['content-type']?.startsWith('application/json'))fault('INVALID_FIELD',null,415);
    const parts=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>4096)fault('INVALID_FIELD',null,413);parts.push(chunk);}
    const raw=Buffer.concat(parts),service=await posAuth.authenticate(req,raw);
    let input;try{input=JSON.parse(raw.toString('utf8'));}catch{fault('INVALID_FIELD',null,400);}
    if(!input||typeof input!=='object'||Array.isArray(input))fault('INVALID_FIELD',null,400);
    return send(res,200,await posControl[posService[1]](service,input));
   }
   const ipService=/^\/api\/services\/checkout-ip\/(register|status|cancel)$/.exec(path);
   if(ipService){
    if(req.method!=='POST')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
    if(!req.headers['content-type']?.startsWith('application/json'))fault('INVALID_FIELD',null,415);
    const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>8192)fault('INVALID_FIELD',null,413);chunks.push(chunk);}
    const raw=Buffer.concat(chunks),service=await posAuth.authenticate(req,raw);
    let value;try{value=JSON.parse(raw.toString('utf8'));}catch{fault('INVALID_FIELD',null,400);}
    if(!value||typeof value!=='object'||Array.isArray(value))fault('INVALID_FIELD',null,400);
    return send(res,200,await ipControl[ipService[1]](service,value));
   }
   const ipHandler=/^\/api\/services\/checkout-ip\/(registerDraft|context|processing|claim|receivingAccounts|selectReceivingAccount|selectNostroAccount)$/.exec(path);
   if(ipHandler){
    if(req.method!=='POST')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
    if(!req.headers['content-type']?.startsWith('application/json'))fault('INVALID_FIELD',null,415);
    const limit=['registerDraft','processing'].includes(ipHandler[1])?Math.ceil(IP_PROOF_MAX_BYTES/3)*4+16384:8192;
    const parts=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>limit)fault('INVALID_FIELD',null,413);parts.push(chunk);}
    const raw=Buffer.concat(parts),service=await ipHandlerAuth.authenticate(req,raw);
    let input;try{input=JSON.parse(raw.toString('utf8'));}catch{fault('INVALID_FIELD',null,400);}
    if(!input||typeof input!=='object'||Array.isArray(input))fault('INVALID_FIELD',null,400);
    if(ipHandler[1]==='registerDraft')return send(res,200,await registerHandlerDraft(pool,service,input));
    return send(res,200,await ipControl[ipHandler[1]](service,input));
   }
   if(req.method==='GET'&&path==='/readyz'){await pool.query('SELECT 1');return send(res,200,{status:'ready',release});}
   const bridge=/^\/api\/basket-bridge\/(state|quote|card|transfer|price|store-open|store-quote|store-receipt)$/.exec(path);
   if(bridge&&req.method==='POST'){
    if(!req.headers['content-type']?.startsWith('application/json'))fault('INVALID_FIELD',null,415);
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096)fault('INVALID_FIELD',null,413);chunks.push(chunk);}
    let b;try{b=JSON.parse(Buffer.concat(chunks));}catch{fault('INVALID_FIELD',null,400);}
    if(!b||typeof b!=='object')fault('INVALID_FIELD',null,400);
    const token=(req.headers.authorization||'').replace(/^Bearer /,'');
    if(bridge[1]==='store-open')return send(res,200,await storeWallet.claim(token,b));
    if(bridge[1]==='store-quote')return send(res,200,await storeWallet.quote(token,b));
    if(bridge[1]==='store-receipt')return send(res,200,await storeWallet.receipt(b));
    if(bridge[1]==='price')return send(res,200,await basket.market(token,b));
    if(bridge[1]==='state')return send(res,200,await basket.state(token));
    if(bridge[1]==='quote')return send(res,200,await basket.quote(token,b));
    if(bridge[1]==='transfer')return send(res,200,await basket.transfer(token,b.id));
    return send(res,200,await basket.card(token,b.id));
   }
   // Stripe sends signed raw events without browser cookies or CSRF tokens.
   if(path==='/api/stripe/webpos/webhook'&&req.method==='POST'){
    if(!req.headers['content-type']?.startsWith('application/json'))fault('STRIPE_SIGNATURE',null,415);
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>512*1024)fault('STRIPE_SIGNATURE',null,413);chunks.push(chunk);}
    return send(res,200,await stripePos.receiveWebhook(Buffer.concat(chunks),req.headers['stripe-signature'],event=>basket.event(event)));
   }
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
   if(req.method==='GET'&&['/pdf.min.mjs','/pdf.worker.min.mjs'].includes(path)){
    const script=await readFile(new URL('./node_modules/pdfjs-dist/build'+path,import.meta.url));
    res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=3600'});return res.end(script);
   }
   if(req.method==='GET'&&['/','/card-message','/fin-terminal','/fin-terminal.mjs','/fin-terminal.css','/fin-terminal-switch.mjs','/fin-message.mjs','/fin-composer.mjs','/fin-peer.mjs','/app.mjs','/open-account-register.mjs','/payment-wizard.mjs','/card-message.mjs','/cards.mjs','/accounts.mjs','/abiq-number.mjs','/abiq-generator.mjs','/account-cleanup.mjs','/portfolio.mjs','/nostro-clearing.mjs','/checkout-ip.mjs','/nostro-clearing.mjs','/exchange-intent.mjs','/crypto-workspace.mjs','/crypto-basket.mjs','/treasury-source.mjs','/wallet-trading-scroller.mjs','/wallet-trading-scroller.css','/trading-panel.mjs','/approved-robot.mjs','/approved-robot.css','/trading-testing.mjs','/trading-live.mjs','/index-advice.mjs','/crypto.css','/styles.css','/crypto-icons/ag.png','/crypto-icons/agi.png','/crypto-icons/avispay.webp','/crypto-icons/robot-approved.jpg'].includes(path)){
    const page=['/','/card-message','/fin-terminal'].includes(path),file=path==='/'?'index.html':page?'public'+path+'.html':'public'+path;
    const body=await readFile(new URL(file,import.meta.url));
    // Always present the deployed UAT revision's current application source after an update.
    // Wallet and trading screens must never be held on the previous revision by a cache.
    res.setHeader('cache-control','no-store, max-age=0');
    res.setHeader('x-avispay-release',process.env.RELEASE_SHA||'development');
    res.setHeader('content-type',page?'text/html; charset=utf-8':path.endsWith('.jpg')?'image/jpeg':path.endsWith('.webp')?'image/webp':path.endsWith('.png')?'image/png':path.endsWith('css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');return res.end(body);
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
    const bodyLimit=path==='/api/crypto/trading/tests'?2*1024*1024:65536;
    let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>bodyLimit)fault('INVALID_FIELD',null,413);}
    try{body=JSON.parse(raw);}catch{fault('INVALID_FIELD',null,400);}
    if(!body||typeof body!=='object'||Array.isArray(body))fault('INVALID_FIELD',null,400);
   }
   if(path==='/api/login/mobile'&&req.method==='POST'){
    if(!privateDesk||deviceAdmission)fault('BANK_WORKSTATION_REQUIRED',null,403);
    const ticket=/(?:^|;\s*)__Host-avis_staff_scan=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie||'');
    if(!ticket)fault('BANK_WORKSTATION_REQUIRED',null,403);
    const grant=await contactIncubator('consume',{fp:fingerprint,id:ticket[1],poll:ticket[2]});
    if(grant.pending===true)return send(res,202,{pending:true});
    if(!/^fineract:[0-9]+$/.test(grant.actor)||typeof grant.username!=='string'||!grant.generation)fault('BANK_WORKSTATION_REQUIRED',null,403);
    const token=randomBytes(32).toString('base64url'),csrf=sessionCsrf(token);
    await pool.query("INSERT INTO avis_core_v2.operator_sessions(token_hash,csrf_hash,actor_id,username,is_admin,expires_at,workstation_sha256,workstation_approval) VALUES($1,$2,$3,$4,true,now()+interval '1 hour',$5,$6)",[digest(token),digest(csrf),grant.actor,grant.username,fingerprint,grant.generation]);
    res.setHeader('Set-Cookie',[`avis_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`,'__Host-avis_staff_scan=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0']);
    return send(res,200,{username:grant.username,csrf,admin:true,customerUserId:null,canSwitchWorkspace:true});
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
    if(privateDesk&&!actor.admin)fault('FORBIDDEN',null,403);
    if(privateDesk&&deviceAdmission){
     // Frontend admission proves an approved device, not a bank identity. Only
     // the existing Fineract password/permission check above supplies this actor.
     const token=randomBytes(32).toString('base64url'),csrf=sessionCsrf(token);
     await pool.query('DELETE FROM avis_core_v2.operator_sessions WHERE expires_at<now()');
     await pool.query("INSERT INTO avis_core_v2.operator_sessions(token_hash,csrf_hash,actor_id,username,is_admin,expires_at,workstation_admission_id) VALUES($1,$2,$3,$4,true,now()+interval '1 hour',$5)",[digest(token),digest(csrf),actor.id,actor.username,deviceAdmission.id]);
     res.setHeader('Set-Cookie',`avis_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`);
     return send(res,200,{username:actor.username,csrf,admin:true,customerUserId:null,canSwitchWorkspace:true});
    }
    if(actor.admin&&deskPolicy){
     if(!privateDesk)fault('BANK_WORKSTATION_REQUIRED',null,403);
     const start=await contactIncubator('start',{fp:fingerprint,actor:actor.id,username:actor.username});
     if(![start.id,start.poll].every(value=>/^[A-Za-z0-9_-]{43}$/.test(value))||!start.qr?.startsWith('data:image/png;base64,'))fault('BANK_WORKSTATION_REQUIRED',null,403);
     res.setHeader('Set-Cookie',`__Host-avis_staff_scan=${start.id}.${start.poll}; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=300`);
     return send(res,202,{qr:start.qr,expiresAt:start.expiresAt});
    }
    const binding=actor.admin?null:(await pool.query('SELECT l.user_id,h.user_id AS identity_user_id FROM avis_core_v2.customer_logins l JOIN avis_core_v2.holder_identities h ON h.record_user_id=l.user_id WHERE l.principal_id=$1',[actor.id])).rows[0];
    if(!actor.admin&&!binding)fault('FORBIDDEN',null,403);
    const token=randomBytes(32).toString('base64url'),csrf=sessionCsrf(token);
    await pool.query('DELETE FROM avis_core_v2.operator_sessions WHERE expires_at<now()');
    await pool.query("INSERT INTO avis_core_v2.operator_sessions(token_hash,csrf_hash,actor_id,username,is_admin,customer_user_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 hour')",[digest(token),digest(csrf),actor.id,actor.username,actor.admin===true,binding?.user_id||null]);
    res.setHeader('Set-Cookie',`avis_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${secureCookies?'; Secure':''}`);
    return send(res,200,{username:actor.username,csrf,admin:actor.admin===true,customerUserId:binding?String(binding.identity_user_id):null,canSwitchWorkspace:actor.admin===true});
   }
   const token=/(?:^|;\s*)avis_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie||'')?.[1];
   if(!token)fault('UNAUTHORIZED',null,401);
   const session=(await pool.query(`SELECT s.*,h.user_id AS identity_user_id FROM avis_core_v2.operator_sessions s
    LEFT JOIN avis_core_v2.holder_identities h ON h.record_user_id=CASE WHEN s.is_admin THEN s.workspace_user_id ELSE s.customer_user_id END
    WHERE s.token_hash=$1 AND s.expires_at>now()`,[digest(token)])).rows[0];
   if(!session)fault('UNAUTHORIZED',null,401);
   if(privateDesk&&!session.is_admin)fault('FORBIDDEN',null,403);
   if(session.workstation_admission_id){
    if(!privateDesk||!session.is_admin||!await workstationAdmission.matchesSession(session.workstation_admission_id,deviceAdmission))fault('BANK_WORKSTATION_REQUIRED',null,403);
   }else if(session.is_admin&&(deskPolicy||session.workstation_sha256)){
    if(!privateDesk||!session.workstation_approval||session.workstation_sha256!==fingerprint)fault('BANK_WORKSTATION_REQUIRED',null,403);
    const admission=await contactIncubator('admit',{fp:fingerprint,actor:session.actor_id,generation:session.workstation_approval});
    if(admission.approved!==true)fault('BANK_WORKSTATION_REQUIRED',null,403);
   }
   const holder=session.is_admin?session.workspace_user_id:session.customer_user_id;
   if(!session.is_admin){const binding=(await pool.query('SELECT user_id FROM avis_core_v2.customer_logins WHERE principal_id=$1',[session.actor_id])).rows[0];if(!binding||String(binding.user_id)!==String(holder))fault('FORBIDDEN',null,403);}
   const actor={id:session.actor_id+(session.is_admin&&holder?':customer:'+holder:''),username:session.username,admin:session.is_admin&&!holder,customerUserId:holder?String(holder):null,identityUserId:holder?String(session.identity_user_id):null};
   const sessionData=()=>({username:actor.username,csrf:sessionCsrf(token),admin:actor.admin,customerUserId:actor.identityUserId,canSwitchWorkspace:session.is_admin});
   const invoke=(method,input,key,...extra)=>actor.admin?core[method](actor,input,key,...extra):customerAccess.invoke(actor,method,input,key,...extra);
   const nostroStatement=/^\/api\/nostro\/([^/]+)\/statements(?:\/([^/]+))?$/.exec(path);
   if(nostroStatement){
    if(req.method!=='GET')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
    const input={cashAccountId:nostroStatement[1],before:url.searchParams.get('before')};
    return send(res,200,await (nostroStatement[2]
     ?nostroStatements.read(actor,{...input,statementId:nostroStatement[2]})
     :nostroStatements.list(actor,input)));
   }
   const draftPdf=/^\/api\/ip-handler-drafts\/([0-9a-f-]{36})\/copy\.pdf$/i.exec(path);
   const ipProof=/^\/api\/checkout-ip\/([0-9a-f-]{36})\/proof\.pdf$/i.exec(path);
   if((draftPdf||ipProof)&&req.method==='GET'){
    const proof=draftPdf?await handlerDraftPdf(pool,actor,draftPdf[1]):await ipControl.proof(actor,ipProof[1]);
    res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    res.writeHead(200,{'content-type':'application/pdf','content-length':proof.bytes.length,
     'content-disposition':(url.searchParams.get('download')==='1'?'attachment':'inline')+'; filename="'+proof.fileName+'"',
     'cache-control':'private, no-store','x-content-sha256':proof.sha256||digest(proof.bytes)});
    return res.end(proof.bytes);
   }
   if(path==='/api/session'&&req.method==='GET'){
    // Restore the same token in every tab. Adopt sessions issued before this
    // release once; new sessions need no write when restoring the workspace.
    const csrf=sessionCsrf(token);
    if(session.csrf_hash!==digest(csrf))await pool.query('UPDATE avis_core_v2.operator_sessions SET csrf_hash=$2 WHERE token_hash=$1',[digest(token),digest(csrf)]);
    return send(res,200,sessionData());
   }
   if((path==='/api/abiq/generator'||path.startsWith('/api/abiq/generator/'))&&!session.is_admin)
    fault('FORBIDDEN',null,403);
   if(path==='/api/abiq/cleanup'&&(!session.is_admin||!actor.admin))fault('FORBIDDEN',null,403);
   if(path==='/api/abiq/cleanup'&&req.method==='GET'){
    const rows=(await pool.query('SELECT * FROM avis_core_v2.legacy_account_review ORDER BY user_id,currency_code,wallet_scope,account_id')).rows;
    const totals=(await pool.query(`SELECT count(*) FILTER(WHERE action='RENUMBER')::int AS renumbered,
     count(*) FILTER(WHERE action='DELETE')::int AS removed FROM avis_core_v2.legacy_account_cleanup`)).rows[0];
    return send(res,200,{rows,totals});
   }
   if(path==='/api/abiq/generator/available'&&req.method==='GET')
    return send(res,200,await availableGeneratorNumbers(pool,actor,url.searchParams.get('currency'),url.searchParams.get('after'),url.searchParams.get('accountId')));
   if(path==='/api/abiq/generator'&&req.method==='GET')
    return send(res,200,await generatorOptions(pool,actor,url.searchParams.get('holder')));
   if(path==='/api/workspaces'&&req.method==='GET'){if(!session.is_admin)fault('FORBIDDEN',null,403);return send(res,200,{rows:(await pool.query("SELECT DISTINCT user_id,full_name FROM avis_core_v2.holder_identities WHERE record_role='CUSTOMER' ORDER BY user_id")).rows});}
   if(req.method==='GET'&&/^\/api\/portfolio\/orders\/[0-9a-f-]{36}$/.test(path))return send(res,200,await invoke('securityOrderDetails',{orderId:path.split('/').at(-1)}));
   if(req.method==='GET'&&/^\/api\/accounts\/[0-9a-f-]{36}$/.test(path))return send(res,200,await invoke('accountDetails',{accountId:path.split('/').at(-1),before:url.searchParams.get('before')}));
   if(req.method==='GET'&&/^\/api\/accounts\/[0-9a-f-]{36}\/movements\/[0-9]+$/.test(path))return send(res,200,await invoke('movementDetails',{accountId:path.split('/').at(-3),entryId:path.split('/').at(-1)}));
   if(req.method==='GET'&&/^\/api\/backoffice-accounts\/[0-9a-f-]{36}\/statement$/.test(path))return send(res,200,await invoke('accountStatement',{accountId:path.split('/').at(-2),before:url.searchParams.get('before')}));
   if(req.method==='GET'&&/^\/api\/cards\/[0-9a-f-]{36}$/.test(path))return send(res,200,await invoke('managedCardDetails',{cardId:path.split('/').at(-1)}));
   if(req.method==='GET'&&/^\/api\/payment-requests\/[0-9a-f-]{36}$/.test(path))return send(res,200,await (actor.admin?core:customerAccess).paymentRequest(actor,path.split('/').at(-1)));
   if(req.method==='GET'&&/^\/api\/crypto\/securities\/[0-9a-f-]{36}$/.test(path))return send(res,200,await invoke('cryptoSecurityDetails',{cardId:path.split('/').at(-1)}));
   if(req.method==='GET'&&path==='/api/crypto/trading/index-delivery')return send(res,200,await invoke('indexDelivery'));
   if(req.method==='GET'&&path==='/api/crypto/trading/index-policy')return send(res,200,await invoke('indexPolicy'));
    if(req.method==='GET'&&path==='/api/crypto/trading/index-benchmarks'){
     if(!actor.admin)fault('FORBIDDEN',null,403);
     return send(res,200,await readCoinApiIndexResearch(pool,core.secretEnv));
    }
   if(req.method==='GET'&&path==='/api/crypto/trading/testing')return send(res,200,await invoke('tradingTesting'));
   if(req.method==='GET'&&path==='/api/crypto/trading/live')return send(res,200,await invoke('tradingLiveSnapshot',{robotId:url.searchParams.get('robotId')??undefined}));
   if(req.method==='GET'&&path==='/api/crypto/trading/live/liquidity')return send(res,200,await invoke('tradingLiveLiquidity',{robotId:url.searchParams.get('robotId')}));
   if(req.method==='GET'&&path==='/api/crypto/trading/robot-instructions')return send(res,200,await invoke('robotInstructions',{robotId:url.searchParams.get('robotId')}));
   if(req.method==='GET'&&path.startsWith('/api/crypto/basket/store/'))return send(res,200,await storeWallet.details(actor,path.split('/').at(-1)));
   if(req.method==='GET'&&path.startsWith('/api/crypto/basket/orders/'))return send(res,200,await basket.orderForBuyer(actor,path.split('/').at(-1)));
   if(req.method==='GET'&&path==='/api/stripe/webpos/connection')return send(res,200,await stripePos.connection(actor));
   if(req.method==='GET'&&path==='/api/stripe/webpos/status')return send(res,200,await stripePos.status(actor,url.searchParams.get('sessionId')));
   if(req.method==='GET'&&path.startsWith('/api/views/')){
    if(path==='/api/views/terminals')await posControl.expirePending();
    if(path==='/api/views/checkoutip')return send(res,200,{rows:await ipControl.list(actor)});
    if(path==='/api/views/checkoutipaccounts')return send(res,200,{rows:await ipControl.accounts(actor)});
    if(path==='/api/views/checkouttenders')return send(res,200,{rows:await basket.tender.catalog(actor)});
    if(path==='/api/views/cryptobasketpolicy')return send(res,200,{rows:[await basket.policy(actor)]});
    if(path==='/api/views/stripepayments')return send(res,200,{rows:await stripePos.list(actor)});
    return send(res,200,{rows:await (actor.admin?core:customerAccess).list(actor,path.split('/').at(-1))});
   }
   // The FinTerminal composer's drafts and its schema check (src/fin-terminal.mjs), for bank administrators.
   const finDraft=/^\/api\/fin-terminal\/drafts(?:\/([0-9a-f-]{36}))?$/.exec(path);
   if(req.method==='GET'&&finDraft)return send(res,200,finDraft[1]?{draft:await finTerminal.draft(actor,finDraft[1])}:{rows:await finTerminal.drafts(actor)});
   if(req.method==='GET'&&path==='/api/fin-terminal/accounts')return send(res,200,{accounts:await finTerminal.accounts(actor)});
   // Screen A's peer banks (src/fin-peer.mjs): the IP-to-IP connectors, and the session messages sent to each with its answers.
   const finPeer=/^\/api\/fin-terminal\/peers(?:\/([A-Z0-9_]{1,35})\/messages)?$/.exec(path);
   if(req.method==='GET'&&finPeer)return send(res,200,finPeer[1]?await finPeers.messages(actor,finPeer[1]):{peers:await finPeers.list(actor)});
   // Step 5's listening port (src/fin-listener.mjs) and the peers' whitelisted IP addresses.
   if(req.method==='GET'&&path==='/api/fin-terminal/listener')return send(res,200,await finListener.status(actor));
   if(req.method!=='POST')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
   if(digest(req.headers['x-csrf-token']||'')!==session.csrf_hash)fault('CSRF',null,403);
   if(path==='/api/fin-terminal/drafts')return send(res,200,{draft:await finTerminal.save(actor,body)});
   if(path==='/api/fin-terminal/validate')return send(res,200,await finTerminal.validate(actor,body));
   if(path==='/api/fin-terminal/incoming')return send(res,200,{draft:await finTerminal.register(actor,body)});
   if(finPeer?.[1])return send(res,200,await finPeers.send(actor,finPeer[1],body));
   if(path==='/api/fin-terminal/listener'){
    if(typeof body?.open!=='boolean')fault('INVALID_FIELD','open');
    return send(res,200,body.open?await finListener.open(actor,body):await finListener.close(actor));
   }
   const finAddress=/^\/api\/fin-terminal\/peers\/([A-Z0-9_]{1,35})\/addresses(\/remove)?$/.exec(path);
   if(finAddress){
    const result=finAddress[2]?await finPeers.removeAddress(actor,finAddress[1],body):await finPeers.addAddress(actor,finAddress[1],body);
    await finListener.refresh();return send(res,200,result);
   }
   if(path==='/api/abiq/cleanup'){
    if(!Array.isArray(body.rows)||!body.rows.length||body.rows.length>500)fault('INVALID_FIELD','rows');
    const result=await core.operation(actor,'REPAIR_LEGACY_ACCOUNTS',body,req.headers['idempotency-key'],async db=>{
     await db.query('LOCK TABLE avis_core_v2.portfolio_positions,avis_core_v2.portfolio_securities,avis_core_v2.sovereign_users IN SHARE MODE');
     let removed=0,renumbered=0;
     for(const row of [...body.rows].sort((a,b)=>String(a.account_id).localeCompare(String(b.account_id)))){
      if(!row||!['DELETE','RENUMBER'].includes(row.action)||!/^[a-f0-9-]{36}$/i.test(row.account_id))fault('INVALID_FIELD','rows');
      try{await db.query('SELECT avis_core_v2.repair_legacy_account($1,$2,$3)',[row.account_id,row.action,actor.id]);}
      catch(e){if(e.message==='ACCOUNT_REVIEW_CHANGED')fault('ACCOUNT_REVIEW_CHANGED','rows',409);throw e;}
      if(row.action==='DELETE')removed++;else renumbered++;
     }
     return {removed,renumbered};
    });
    return send(res,200,result);
   }
   if(path==='/api/abiq/generator'||path==='/api/abiq/generator/assign'){
    const scoped=actor.admin?actor:customerAccess.operator(actor);
    const operation=path.endsWith('/assign')?assignGeneratorNumber:issueGeneratorNumber;
    return send(res,200,await operation(core,scoped,body,req.headers['idempotency-key']));
   }
   if(path==='/api/crypto/basket/start')return send(res,200,await basket.start(actor));
   if(path==='/api/crypto/basket/store-confirm')return send(res,200,await storeWallet.confirm(actor,body));
   if(path==='/api/crypto/basket/tender')return send(res,200,await basket.tender.configure(actor,body,req.headers['idempotency-key']));
   if(path==='/api/crypto/basket/procurement')return send(res,200,await basket.procurement(actor,body,req.headers['idempotency-key']));
   if(path==='/api/crypto/basket/price')return send(res,200,await basket.market(null,body,actor));
   if(path==='/api/crypto/basket/confirm')return send(res,200,await basket.confirmAccount(actor,body));
   if(path==='/api/crypto/basket/policy')return send(res,200,await basket.setPolicy(actor,body,req.headers['idempotency-key']));
   if(path==='/api/crypto/basket/lot')return send(res,200,await basket.registerLot(actor,body,req.headers['idempotency-key']));
   if(path==='/api/crypto/basket/card-terms')return send(res,200,await basket.setCard(actor,body,req.headers['idempotency-key']));
   if(path==='/api/logout'){
    await pool.query('DELETE FROM avis_core_v2.operator_sessions WHERE token_hash=$1',[digest(token)]);
    res.setHeader('Set-Cookie',`avis_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies?'; Secure':''}`);return send(res,200,{});
   }
   if(path==='/api/workspace'){
    if(!session.is_admin)fault('FORBIDDEN',null,403);
    const id=body.userId||null;
    const workspace=id?await core.customerWorkspace(pool,id):null;
    if(id&&!workspace)fault('ABIQ_CUSTOMER_NOT_FOUND','userId');
    await pool.query('UPDATE avis_core_v2.operator_sessions SET workspace_user_id=$2 WHERE token_hash=$1',[digest(token),workspace?.record_user_id??null]);
    return send(res,200,{...sessionData(),admin:!id,customerUserId:workspace?String(workspace.user_id):null});
   }
   if(path==='/api/payments/crypto-receiver'){
    const r=(await pool.query('SELECT full_name FROM avis_core_v2.sovereign_users WHERE user_id=$1',[body.receiverUserId])).rows[0];if(!r)fault('ABIQ_CUSTOMER_NOT_FOUND','receiverUserId');return send(res,200,{receiverName:r.full_name});
   }
   if(path==='/api/payments/card-delivery')return send(res,200,await invoke('cardDelivery',body));
   if(path==='/api/payments/check-receiver')return send(res,200,await invoke('checkReceiver',body));
   if((path==='/api/abiq'||path==='/api/bankpayments/dispatch')&&!actor.admin)fault('FORBIDDEN',null,403);
   if(path==='/api/abiq')return send(res,200,await processAbiqRequest(core,actor,body));
   if(path==='/api/bankpayments/dispatch')return send(res,200,await dispatchPayment(core,actor,body,req.headers['idempotency-key']));
   if(path==='/api/checkout-ip/nostro-account')return send(res,200,await ipControl.selectNostroAccount(actor,body));
   if(path==='/api/checkout-ip/activation')return send(res,200,await ipControl.setActive(actor,body));
   if(path==='/api/terminals/activation'){if(!actor.admin)fault('FORBIDDEN',null,403);return send(res,200,await posControl.setActive(actor,body));}
   if(path==='/api/stripe/webpos/checkout')return send(res,200,await stripePos.createCheckout(actor,body,req.headers['idempotency-key']));
   const routes={'cards/issue':'issueManagedCard','cards/load':'loadManagedCard','cards/status':'setCardStatus','cards/pin':'resetCardPin','cards/delivery':'managedCardDelivery','accounts/suspense':'moveToSuspense','access/customer':'bindCustomerLogin','crypto/sell':'sellCrypto','cards/external':'registerExternalCard','cards/redeem-code':'redeemCode','cards/cancel-code':'cancelCodedDebit','cards/pickup-details':'externalCardDetails','payments/pickup':'pickupTransfer','payments/settle-manual':'settleManualTransfer','crypto/offers':'registerCryptoOffer','crypto/purchase':'purchaseCrypto','payments/review':'preparePayment','payments/transfer':'confirmPayment','payments/cancel':'cancelPayment','customers/profile':'saveCustomerProfile',customers:'openCustomer',currencies:'addCurrencies',transfers:'transfer',shops:'registerShop',
    correspondents:'registerCashAccount','correspondents/details':'updateCashAccountDetails','nostro/intermediary':'registerIntermediaryBank','nostro/intermediary/edit':'updateIntermediaryBank','nostro/mirror':'mirrorNostroMovement','nostro/gateway':'linkNostroGateway',bankprofiles:'registerBankConnector',bankroutes:'linkBankAccount',bankpayments:'initiatePayment','clearing/reconcile':'reconcileStatement',
    'fx/rates/refresh':'refreshFxRates','fx/quote':'quoteFx','fx/execute':'executeFx','fx/cancel':'cancelFx',
    'offline/keys':'configureOffline','offline/allowances':'issueOfflineAllowance','offline/sync':'settleOfflineBatch','offline/close':'closeOfflineAllowance',
    'checkouts/capture':'captureCheckout','checkouts/release':'releaseCheckout','checkouts/refund':'refundCheckout',
    cards:'registerCard',terminals:'registerTerminal','cards/authorize':'authorizeCard','cards/capture':'settleCard','cards/reverse':'settleCard'};
   routes['accounts/open']='openAccount';
   Object.assign(routes,{'portfolio/exchange-security':'resolveExchangeSecurity','portfolio/catalogue/sync':'syncSecurities','portfolio/securities':'addSecurity','portfolio/positions':'recordPosition','portfolio/treasury-source':'registerTreasurySecuritySource','portfolio/treasury-source/edit':'editTreasurySecuritySource','portfolio/orders/review':'reviewSecurityOrder','portfolio/orders/submit':'submitSecurityOrder','portfolio/orders/cancel':'cancelSecurityOrder'});
   Object.assign(routes,{'crypto/trading/index-policy':'saveIndexPolicy','crypto/trading/validate-providers':'validateRobotProviders','crypto/trading/configure':'configureRobot','crypto/trading/toggle':'toggleRobot','crypto/trading/delegate-wallet':'delegateWalletTrading','crypto/trading/select-wallet':'selectWalletTrading','crypto/trading/revoke-wallet':'revokeWalletTrading','crypto/approve':'approveCrypto','crypto/activate':'activateCrypto','crypto/wallet/visibility':'setCryptoWalletVisibility','crypto/wallet':'cryptoWallet','crypto/balance':'cryptoChainBalance','crypto/check-network':'checkCryptoNetwork','crypto/markets/refresh':'refreshCryptoMarkets','crypto/securities/demo-convert':'convertDemoSecurity','crypto/securities/prepare':'prepareRealSecurity','crypto/securities/wallet':'createSecurityWallet','crypto/securities/package':'cryptoContractPackage','crypto/robot/channels':'createRollingChannel','crypto/actions/cancel':'cancelCryptoReview','crypto/actions/review':'prepareCryptoAction','crypto/actions/submit':'submitCryptoAction','crypto/actions/broadcast':'broadcastCryptoAction','crypto/actions/confirm':'confirmCryptoAction'});
   routes['crypto/deposits/reconcile']='reconcileCryptoDeposit';
   routes['crypto/trading/tests']='runTradingTest';
   routes['crypto/trading/tests/review']='reviewTradingTest';
   routes['crypto/trading/robot-instructions']='saveRobotInstructions';
   const action=path.slice(5),method=routes[action];if(!method)fault('NOT_FOUND',null,404);
   const result=await invoke(method,body,req.headers['idempotency-key'],action==='cards/reverse');
   if(action==='fx/execute'&&result.status==='EXPIRED')fault('FX_QUOTE_EXPIRED','quoteId',409);
   return send(res,200,result);
  }catch(e){
   const code=e.code==='23505'?'DUPLICATE_RECORD':['23503','22P02'].includes(e.code)?'INVALID_REFERENCE':messages[e.code]?e.code:messages[e.message]?e.message:'REQUEST_FAILED';
   console.error(JSON.stringify({requestId,code,diagnosticCode:e.code||e.message?.slice(0,100)}));
   const status=e.status||(['DUPLICATE_RECORD','IDEMPOTENCY_CONFLICT'].includes(code)?409:code==='REQUEST_FAILED'?500:422);
   if(status===403&&code==='BANK_WORKSTATION_REQUIRED'&&isStaffAccessDocument(req))return sendStaffAccessPage(res);
   send(res,status,{code,field:e.field,message:messages[code],requestId});
  }
 });
 // Expiry is authoritative on each read/write and swept independently so pending
 // requests close even if no checkout or administrator is currently online.
 const ipExpirySweep=setInterval(()=>void ipControl.expire().catch(error=>console.error(JSON.stringify({operation:'IP_REQUEST_EXPIRY',code:error.code||'IP_EXPIRY'}))),30000);
 ipExpirySweep.unref?.();
 const posExpirySweep=setInterval(()=>void posControl.expirePending().catch(error=>
   console.error(JSON.stringify({operation:'POS_REQUEST_EXPIRY',code:error.code||'POS_SWEEP'}))),30000);
 posExpirySweep.unref?.();
 server.once('close',()=>{clearInterval(posExpirySweep);clearInterval(ipExpirySweep);void finListener.stop();});
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const pool=new pg.Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT||5432),database:process.env.PGDATABASE,
  user:process.env.PGUSER,password:process.env.PGPASSWORD,max:8,connectionTimeoutMillis:10000,
  ssl:process.env.PGHOST==='localhost'?false:{rejectUnauthorized:true}});
 const client=await pool.connect();try{await migrate(client);}finally{client.release();}
 const liveMarkets=new LiveMarketFeed({env:process.env});
 createBankServer({pool,authenticate:(u,p)=>authenticateFineract(u,p,process.env.FINERACT_URL),release:process.env.RELEASE_SHA||'local',transferOptions:{tradingMarketFeed:liveMarkets}})
  .listen(Number(process.env.PORT||8080),'0.0.0.0');
 const robotCore=new TradingRobotCore(pool,{tradingMarketFeed:liveMarkets});
 // Independent CoinAPI research ingestion continues while all trading robots are paused.
 // Index values never enter the order dispatcher or ledger.
 const coinapiResearch=new CoinApiIndexResearch({pool,env:process.env});
 const pollCoinApiResearch=()=>coinapiResearch.poll().then(result=>{
  for(const item of result.indices||[])if(item.currentError||item.historyError)
   console.error(JSON.stringify({operation:'COINAPI_INDEX_RESEARCH',indexId:item.id,code:item.currentError||item.historyError}));
 }).catch(error=>console.error(JSON.stringify({operation:'COINAPI_INDEX_RESEARCH',code:error.message||'INDEX_RESEARCH'})));
 void pollCoinApiResearch();setInterval(pollCoinApiResearch,120000).unref();
 const checkoutRecovery=new CryptoBasket(robotCore,new StripeWebPos(pool));const storeRecovery=new StoreWallet(checkoutRecovery);let recoveringCheckout=false;
 const recoverCheckout=async()=>{if(recoveringCheckout)return;recoveringCheckout=true;try{await storeRecovery.notify();await checkoutRecovery.recover();}catch(e){console.error(JSON.stringify({operation:'CRYPTO_BASKET_RECOVERY',code:e.code||'CHECKOUT_RECOVERY'}));}finally{recoveringCheckout=false;}};
 setInterval(recoverCheckout,60000).unref();
 let scanningDeposits=false;
 const scanDeposits=async()=>{if(scanningDeposits)return;scanningDeposits=true;try{
  const outcome=await scanFinalizedEthereumDeposits(robotCore);
  if(outcome.booked)console.info(JSON.stringify({operation:'AUTO_CRYPTO_DEPOSIT',network:outcome.network,booked:outcome.booked}));
 }catch(e){console.error(JSON.stringify({operation:'AUTO_CRYPTO_DEPOSIT',code:e.code||e.message||'DEPOSIT_SCAN_FAILED'}));}
 finally{scanningDeposits=false;}};
 void scanDeposits();setInterval(scanDeposits,30000).unref();
 let recoveringChain=false;const recoverChain=async()=>{if(recoveringChain)return;recoveringChain=true;try{const pending=(await pool.query("SELECT action_id,status,tx_hash FROM avis_core_v2.crypto_chain_actions WHERE status IN('SIGNED','SUBMITTED') ORDER BY created_at LIMIT 20")).rows;for(const a of pending){try{if(a.status==='SIGNED')await robotCore.broadcastCryptoAction({id:'system:chain-recovery',admin:true},{actionId:a.action_id});await robotCore.confirmCryptoAction({id:'system:chain-recovery',admin:true},{actionId:a.action_id},'confirm:'+a.tx_hash);}catch(e){console.error(JSON.stringify({operation:'CHAIN_RECOVERY',code:e.code||'CHAIN_RECEIPT'}));}}}finally{recoveringChain=false;}};void recoverChain();setInterval(recoverChain,15000).unref();const trading=new TradingRuntime(robotCore).start();
 const processTradingTests=()=>robotCore.processTradingTests().catch(error=>console.error(JSON.stringify({operation:'TRADING_TESTS',code:error.code||'TRADING_TEST_PROCESS'})));
 void processTradingTests();setInterval(processTradingTests,10000).unref();
 const refreshMarkets=()=>robotCore.refreshCryptoMarkets({id:'system:crypto-markets',admin:true},{},'markets:'+Math.floor(Date.now()/120000)).catch(e=>console.error(JSON.stringify({operation:'CRYPTO_MARKET_REFRESH',code:e.code||'CRYPTO_CATALOGUE'})));void refreshMarkets();setInterval(refreshMarkets,120000).unref();
 process.once('SIGTERM',()=>{void trading.stop();liveMarkets.close();});
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
