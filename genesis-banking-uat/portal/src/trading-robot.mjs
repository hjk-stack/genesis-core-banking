import {engineStatus} from './trading/runtime.mjs';
import {robotWalletAllowance,assertRobotWalletAllowance,ROBOT_WALLET_MESSAGES} from './robot-wallet-allowance.mjs';
import {randomUUID} from 'node:crypto';
import {TradingInstructionsCore} from './trading-instructions.mjs';
import {fault,text,money,decimal} from './core.mjs';
import {securityValue} from './securities-portfolio.mjs';
import {ChainAPI} from './crypto/networks.mjs';
import {BinanceSpot} from './trading/binance.mjs';
const S=10n**18n,U=x=>/^0(?:\.0+)?$/.test(String(x))?0n:money(String(x)),admin=a=>{if(!a?.admin||a.customerUserId)fault('FORBIDDEN',null,403);};
export const ROBOT_MESSAGES={...ROBOT_WALLET_MESSAGES,ROBOT_SYMBOL:'Select the exact market symbol on this venue.',ROBOT_API_KEY:'Enter the configured trading API secret reference.',ROBOT_ACCOUNT:'Select an institution trading account.',ROBOT_INDEX:'The selected security needs a fresh Press INDEX with supporting sources.',ROBOT_LIMIT:'Enter valid order, daily trading and loss limits.',ROBOT_VENUE_RESPONSE:'The venue request could not complete. Check this order in Trading diagnostics.',ROBOT_BUSY:'The previous order is being reconciled.',ROBOT_POSITION:'Close the robot’s position before changing its market settings.'};
export class TradingRobotCore extends TradingInstructionsCore {
 constructor(pool,options={}){super(pool,options);this.venue=options.tradingVenue||new BinanceSpot({env:this.secretEnv});}
 async robotWalletAllowance(robot){return robotWalletAllowance(this.pool,robot);}
 async validateRobotProviders(actor){admin(actor);const env=this.secretEnv;
  const market=async()=>{
   const key=env.COINAPI_MARKET_DATA_API_KEY||env.COINAPI_API_KEY||env.APIBRICKS_COINAPI_KEY;
   if(!key)return {provider:'CoinAPI Market Data',configured:false,verified:false,setting:'COINAPI_API_KEY'};
   try{
    const response=await this.cryptoFetch('https://rest.coinapi.io/v1/exchangerate/BTC/USD',{
     headers:{'X-CoinAPI-Key':key,accept:'application/json'},signal:AbortSignal.timeout(10000),redirect:'error'
    });
    if(!response.ok)return {provider:'CoinAPI Market Data',configured:true,verified:false,code:'MARKET_HTTP_'+response.status};
    const row=await response.json();
    if(row.asset_id_base!=='BTC'||row.asset_id_quote!=='USD'||typeof row.rate!=='number'||!Number.isFinite(row.rate)||row.rate<=0)throw Error('MARKET_SCHEMA');
    return {provider:'CoinAPI Market Data',configured:true,verified:true,capability:'Authenticated reference pricing',checkedAt:new Date().toISOString()};
   }catch(e){return {provider:'CoinAPI Market Data',configured:true,verified:false,code:e.message==='MARKET_SCHEMA'?'MARKET_SCHEMA':'MARKET_TRANSPORT'};}
  };
  const ems=async()=>{const key=env.COINAPI_EMS_API_KEY;if(!key)return {provider:'CoinAPI EMS',configured:false,verified:false,setting:'COINAPI_EMS_API_KEY'};try{const response=await this.cryptoFetch('https://global.ems.coinapi.net/v1/balances',{headers:{'X-CoinAPI-Key':key,accept:'application/json'},signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)throw Error('EMS_HTTP_'+response.status);const rows=await response.json();if(!Array.isArray(rows))throw Error('EMS_SCHEMA');return {provider:'CoinAPI EMS',configured:true,verified:true,accounts:rows.map(r=>r.exchange_id).filter(Boolean),capability:'Execution API account connection',checkedAt:new Date().toISOString()};}catch(e){return {provider:'CoinAPI EMS',configured:true,verified:false,code:/^EMS_/.test(e.message)?e.message:'EMS_TRANSPORT'};}};
  const node=async provider=>{
   // A configured RPC URL can already contain the provider credential. Probe
   // that same endpoint instead of reporting it missing or replacing it.
   const endpoint=env.AVIS_RPC_ETHEREUM||env.CRYPTO_RPC_ETHEREUM;
   let endpointProvider=null;
   try{const host=new URL(endpoint).hostname;endpointProvider=host.endsWith('.alchemy.com')?'Alchemy':host==='ethereum-mainnet.node.coinapi.io'?'CoinAPI NaaS':null;}catch{}
   const matchingEndpoint=endpointProvider===provider?endpoint:null;
   // Use the same dedicated node credential as ChainAPI; market-data keys
   // do not configure a CoinAPI node connection.
   const key=provider==='Alchemy'?env.ALCHEMY_API_KEY:env.COINAPI_NAAS_API_KEY;
   if(!matchingEndpoint&&!key)return {provider,configured:false,verified:false,setting:provider==='Alchemy'?'ALCHEMY_API_KEY':'COINAPI_NAAS_API_KEY'};
   const explicit={...env,AVIS_RPC_ETHEREUM:matchingEndpoint||(provider==='Alchemy'?'https://eth-mainnet.g.alchemy.com/v2/'+key:'https://ethereum-mainnet.node.coinapi.io')};
   try{const chain=new ChainAPI({env:explicit,fetcher:this.cryptoFetch});const [,block]=await Promise.all([chain.check('ETHEREUM'),chain.request('ETHEREUM','eth_blockNumber')]);return {provider,configured:true,verified:true,chainId:1,blockNumber:Number(BigInt(block)),capability:'Ethereum RPC and signed-transaction transport',checkedAt:new Date().toISOString()};}catch{return {provider,configured:true,verified:false,code:'RPC_VALIDATION'};}
  };return {providers:await Promise.all([market(),ems(),node('Alchemy'),node('CoinAPI NaaS')])};
 }
 async configureRobot(actor,input,key){admin(actor);const venue=input.venue,symbol=text(input.symbol,'symbol',80).toUpperCase(),indexId=text(input.indexId,'indexId',80),name=text(input.name,'name',100),max=money(input.maxNotional),daily=money(input.dailyNotional),loss=money(input.maxLoss);
  if(!['AVIS','BINANCE'].includes(venue)||daily<max||!Number.isInteger(input.trailingBps)||input.trailingBps<5||input.trailingBps>2000||!Number.isFinite(input.minimumIndex)||input.minimumIndex< -100||input.minimumIndex>100)fault('ROBOT_LIMIT');
  let market=null;if(venue==='BINANCE'){market=await this.venue.market(symbol);this.venue.credentials(input.keyRef);await this.venue.balance(input.keyRef);}
  return this.operation(actor,'CONFIGURE_W_ROBOT',input,key,async db=>{const user=(await db.query("SELECT * FROM avis_core_v2.sovereign_users WHERE user_id=$1 AND account_role='INSTITUTION'",[input.userId])).rows[0];if(!user)fault('ROBOT_ACCOUNT','userId');let security=null;
   if(venue==='AVIS'){
    security=await this.security(db,input.securityId);
    const a=(await db.query(`SELECT a.* FROM avis_core_v2.ledger_accounts a
     JOIN avis_core_v2.abiq_routing_bridge b ON b.ledger_account_id=a.account_id AND b.status='ACTIVE'
     WHERE a.account_id=$1 AND a.user_id=$2 AND a.network IS NULL AND a.currency_code=$3
      AND a.owner_type='USER' AND a.account_category='LIABILITY' AND a.wallet_scope='FUNDING'`,[input.accountId,input.userId,security.currency_code])).rows[0];
    if(!a)fault('ROBOT_ACCOUNT','accountId');
    market={baseAsset:security.short_name,quoteAsset:security.currency_code,quantityStep:'0.'+'0'.repeat(Math.max(0,security.quantity_decimals-1))+'1',priceTick:'0.01'};if(!security.quantity_decimals)market.quantityStep='1';
   }
   const existing=(await db.query('SELECT * FROM avis_core_v2.trading_robots WHERE venue=$1 AND symbol=$2 AND user_id=$3 FOR UPDATE',[venue,symbol,input.userId])).rows[0];if(existing&&(U(existing.position_quantity)>0n||(await db.query("SELECT 1 FROM avis_core_v2.trading_robot_orders WHERE robot_id=$1 AND status IN('CREATED','DISPATCHING','ACKNOWLEDGED')",[existing.robot_id])).rows.length))fault('ROBOT_POSITION');
   const id=existing?.robot_id||randomUUID();await db.query(`INSERT INTO avis_core_v2.trading_robots(robot_id,name,user_id,venue,symbol,index_id,security_id,account_id,key_ref,max_notional,daily_notional,max_loss,minimum_index,trailing_bps,quantity_step,price_tick,base_asset,quote_asset) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(robot_id) DO UPDATE SET name=$2,index_id=$6,security_id=$7,account_id=$8,key_ref=$9,max_notional=$10,daily_notional=$11,max_loss=$12,minimum_index=$13,trailing_bps=$14,quantity_step=$15,price_tick=$16,base_asset=$17,quote_asset=$18,enabled=false,version=trading_robots.version+1`,[id,name,input.userId,venue,symbol,indexId,security?.security_id||null,input.accountId||null,input.keyRef||null,decimal(max),decimal(daily),decimal(loss),input.minimumIndex,input.trailingBps,market.quantityStep,market.priceTick,market.baseAsset,market.quoteAsset]);return {id};});
 }
 async toggleRobot(actor,input,key){admin(actor);if(typeof input.enabled!=='boolean')fault('INVALID_FIELD','enabled');return this.operation(actor,'TOGGLE_W_ROBOT',input,key,async db=>{const r=(await db.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=$1 FOR UPDATE',[input.robotId])).rows[0];if(!r)fault('ROBOT_SYMBOL');if(input.enabled){await this.assertTradingTestReviewed(db,r);await assertRobotWalletAllowance(db,r,'0');}await db.query('UPDATE avis_core_v2.trading_robots SET enabled=$2,version=version+1 WHERE robot_id=$1',[r.robot_id,input.enabled]);return {id:r.robot_id,enabled:input.enabled};});}
 async robotOrder(actor,input,key){admin(actor);return this.operation(actor,'W_ROBOT_ORDER',input,key,async db=>{
  const r=(await db.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=$1 FOR UPDATE',[input.robotId])).rows[0];if(!r||(!r.enabled&&input.side==='BUY'))fault('ROBOT_SYMBOL');if(!['BUY','SELL'].includes(input.side)||!/^[a-f0-9]{64}$/.test(input.signalId))fault('INVALID_FIELD','signalId');
  const q=money(input.quantity),p=money(input.price);let notional=q*p/S;if(r.venue==='AVIS'){const s=await this.security(db,r.security_id);notional=U(securityValue(input.quantity,s.denomination,input.price,s.quote_basis,s.currency_code));}if(!q||!p||q%U(r.quantity_step)||p%U(r.price_tick))fault('ROBOT_LIMIT');
  if(input.side==='BUY'){
   await this.assertTradingTestReviewed(db,r);
   await assertRobotWalletAllowance(db,r,input.quantity);
   const idx=r.last_index,age=Date.now()-Date.parse(idx?.generatedAt);if(!idx||idx.sequence!==input.indexSequence||idx.instrumentId!==r.index_id||!Number.isFinite(idx.score)||idx.score<Number(r.minimum_index)||!Number.isFinite(idx.confidence)||idx.confidence<.2||!Number.isInteger(idx.sourceCount)||idx.sourceCount<2||!Number.isFinite(Date.parse(idx.validUntil))||!Number.isFinite(age)||age<0||age>180000||Date.parse(idx.validUntil)<=Date.now())fault('ROBOT_INDEX');
   if(U(r.position_quantity)>0n||notional>U(r.max_notional)||Number(r.realized_pnl)<=-Number(r.max_loss))fault('ROBOT_LIMIT');
   const spent=(await db.query("SELECT COALESCE(sum(notional),0)::text AS value FROM avis_core_v2.trading_robot_orders WHERE robot_id=$1 AND side='BUY' AND status<>'REJECTED' AND created_at>=date_trunc('day',now())",[r.robot_id])).rows[0].value;if(U(spent)+notional>U(r.daily_notional))fault('ROBOT_LIMIT');
   const w=input.pattern;if(!w||!['zScore','sellVolumeL2','sellVolumeL1','imbalance','spread','l1','l2','neckline'].every(k=>Number.isFinite(w[k]))||w.l1<=0||w.l2<=0||w.sellVolumeL1<=0||w.sellVolumeL2<0||w.spread<0||!Number.isFinite(input.tickTime)||input.tickTime>Date.now()*1000+1000000||w.zScore>=-2.2||w.sellVolumeL2>=w.sellVolumeL1||w.imbalance<1.65||w.spread>.0035||Math.abs(w.l2-w.l1)/w.l1>.0035||w.l2<w.l1*.998||(w.neckline-w.l1)/w.l1<.004||Date.now()*1000-input.tickTime>5000000)fault('ROBOT_LIMIT');
  }else if(q>U(r.position_quantity))fault('ROBOT_POSITION');
  const old=(await db.query('SELECT * FROM avis_core_v2.trading_robot_orders WHERE robot_id=$1 AND signal_id=$2',[r.robot_id,input.signalId])).rows[0];if(old)return {id:old.id,status:old.status};
  if((await db.query("SELECT 1 FROM avis_core_v2.trading_robot_orders WHERE robot_id=$1 AND status IN('CREATED','DISPATCHING','ACKNOWLEDGED')",[r.robot_id])).rows.length)fault('ROBOT_BUSY');
  const eventAdvice=await this.indexOrderEvidence(db,actor,r,input),tradingInstructions=await this.robotInstructionEvidence(db,r);
  const id=randomUUID(),client='AVIS'+id.replaceAll('-','');await db.query('INSERT INTO avis_core_v2.trading_robot_orders(id,robot_id,signal_id,client_order_id,side,quantity,price,instruction,notional) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,r.robot_id,input.signalId,client,input.side,decimal(q),decimal(p),JSON.stringify({...input,eventAdvice,tradingInstructions}),decimal(notional)]);return {id,status:'CREATED'};
 });}
 async entryDispatchRejection(db,robot,order){
  if(order.side!=='BUY')return null;
  try{await assertRobotWalletAllowance(db,robot,order.quantity,order.id);}catch(error){if(['CRYPTO_TRADING_SELECTION_REQUIRED','CRYPTO_TRADING_ALLOWANCE_LIMIT'].includes(error.code))return error.code;throw error;}
  try{await this.assertTradingTestReviewed(db,robot);}catch(error){if(error.code==='TRADING_TEST_REVIEW_REQUIRED')return error.code;throw error;}
  const index=robot.last_index,age=Date.now()-Date.parse(order.created_at),indexAge=Date.now()-Date.parse(index?.generatedAt),expiry=Date.parse(index?.validUntil);
  return !robot.enabled||!Number.isFinite(age)||age<0||age>5000||!Number.isFinite(indexAge)||indexAge<0||indexAge>180000||!Number.isFinite(expiry)||expiry<=Date.now()||index?.sequence!==order.instruction.indexSequence?'ROBOT_ENTRY_EXPIRED':null;
 }
 async claimRobotDispatch(id){
  const db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   const robot=(await db.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=(SELECT robot_id FROM avis_core_v2.trading_robot_orders WHERE id=$1) FOR UPDATE',[id])).rows[0];
   const order=(await db.query('SELECT * FROM avis_core_v2.trading_robot_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!robot||!order||order.status!=='CREATED'){await db.query('COMMIT');return false;}
   const rejection=await this.entryDispatchRejection(db,robot,order);
   if(rejection){await db.query("UPDATE avis_core_v2.trading_robot_orders SET status='REJECTED',response=$2,updated_at=now() WHERE id=$1",[id,JSON.stringify({code:rejection})]);await db.query('COMMIT');return false;}
   await db.query("UPDATE avis_core_v2.trading_robot_orders SET status='DISPATCHING',updated_at=now() WHERE id=$1",[id]);
   await db.query('COMMIT');return true;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async executeAvisRobot(actor,order){return this.operation(actor,'W_ROBOT_AVIS_FILL',{id:order.id},'robot-fill:'+order.id,async(db,k)=>{
  const r=(await db.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=$1 FOR UPDATE',[order.robot_id])).rows[0],o=(await db.query('SELECT * FROM avis_core_v2.trading_robot_orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0];if(['SETTLED','REJECTED'].includes(o.status))return o.response;
  const rejection=await this.entryDispatchRejection(db,r,o);
  if(rejection){const response={code:rejection};await db.query("UPDATE avis_core_v2.trading_robot_orders SET status='REJECTED',response=$2,updated_at=now() WHERE id=$1",[o.id,JSON.stringify(response)]);return response;}
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['securities:'+r.security_id]);const s=await this.security(db,r.security_id);
  // The existing AVIS book accepts all-or-none maker lots. IOC consumes compatible whole lots and cancels the remainder.
  const offers=(await db.query(`SELECT * FROM avis_core_v2.securities_orders WHERE security_id=$1 AND status='OPEN' AND user_id<>$2 AND side<>$3 AND (($3='BUY' AND price<=$4) OR ($3='SELL' AND price>=$4)) ORDER BY CASE WHEN $3='BUY' THEN price ELSE -price END,submitted_at FOR UPDATE`,[r.security_id,r.user_id,o.side,o.price])).rows;
  let remaining=U(o.quantity),filled=0n,cost=0n;const executions=[];
  for(const maker of offers){if(U(maker.quantity)>remaining)continue;const total=securityValue(maker.quantity,s.denomination,maker.price,s.quote_basis,s.currency_code),id=randomUUID(),v={securityId:s.security_id,name:s.name,shortName:s.short_name,isin:s.isin,cusip:s.cusip,currency:s.currency_code,denomination:s.denomination,quoteBasis:s.quote_basis,side:o.side,quantity:maker.quantity,price:maker.price,total,paymentMethod:'ACCOUNT',accountId:r.account_id,userId:String(r.user_id),reference:'W-'+o.id};
   await this.orderSource(db,actor,v,s);await db.query(`INSERT INTO avis_core_v2.securities_orders(order_id,user_id,security_id,side,instruction,review_hash,quantity,price,total,cash_account_id,source_account_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`,[id,r.user_id,s.security_id,o.side,JSON.stringify(v),o.signal_id,maker.quantity,maker.price,total,r.account_id,actor.id]);
   let taker=(await db.query('SELECT * FROM avis_core_v2.securities_orders WHERE order_id=$1',[id])).rows[0];taker=await this.reserveOrder(db,actor,taker,k+':'+id);executions.push(await this.executePair(db,actor,o.side==='BUY'?taker:maker,o.side==='SELL'?taker:maker,k+':'+id));remaining-=U(maker.quantity);filled+=U(maker.quantity);cost+=U(total);if(!remaining)break;
  }
  const response={status:remaining?'EXPIRED':'FILLED',executedQty:decimal(filled),cummulativeQuoteQty:decimal(cost),fills:[],executions};await this.settleRobotState(db,o,r,response);return response;
 });}
 async settleRobotState(db,o,r,response){const qty=U(response.executedQty||'0'),cost=U(response.cummulativeQuoteQty||'0'),buy=o.side==='BUY',position=U(r.position_quantity),basis=U(r.cost_basis),fees=(response.fills||[]);
  let baseFee=0n,quoteFee=0n;for(const f of fees){if(f.commissionAsset===r.base_asset)baseFee+=U(f.commission);if(f.commissionAsset===r.quote_asset)quoteFee+=U(f.commission);}
  const newPosition=buy?position+qty-baseFee:position-qty-baseFee;if(newPosition<0n)fault('ROBOT_POSITION');const usedBasis=!buy&&position?basis*(qty+baseFee)/position:0n,newBasis=buy?basis+cost+quoteFee:basis-usedBasis,pnl=buy?0n:cost-quoteFee-usedBasis;
  await db.query('UPDATE avis_core_v2.trading_robots SET position_quantity=$2,cost_basis=$3,realized_pnl=realized_pnl+$4,stop_price=$5,peak_price=$6 WHERE robot_id=$1',[r.robot_id,decimal(newPosition),decimal(newBasis),decimal(pnl),newPosition?String(o.instruction.stopPrice||r.stop_price):'0',newPosition?String(Math.max(Number(r.peak_price),Number(o.price))):'0']);
  await db.query("UPDATE avis_core_v2.trading_robot_orders SET status='SETTLED',response=$2,updated_at=now() WHERE id=$1",[o.id,JSON.stringify(response)]);
 }
 async dispatchRobotOrder(actor,id){admin(actor);let o=(await this.pool.query('SELECT o.*,r.venue,r.symbol,r.key_ref,r.enabled,r.last_index FROM avis_core_v2.trading_robot_orders o JOIN avis_core_v2.trading_robots r USING(robot_id) WHERE id=$1',[id])).rows[0];if(!o||['SETTLED','REJECTED'].includes(o.status))return o;
  // A queued entry must still have reviewed test evidence at the dispatch boundary.
  // Already submitted orders continue reconciliation; existing-position exits remain available.
  if(o.status==='CREATED'&&o.side==='BUY'){
   const robot=(await this.pool.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=$1',[o.robot_id])).rows[0];
   try{await this.assertTradingTestReviewed(this.pool,robot);}catch(error){
    if(error.code!=='TRADING_TEST_REVIEW_REQUIRED')throw error;
    await this.pool.query("UPDATE avis_core_v2.trading_robot_orders SET status='REJECTED',response=$2,updated_at=now() WHERE id=$1 AND status='CREATED'",[id,JSON.stringify({code:error.code})]);return;
   }
  }
  if(o.status==='CREATED'&&o.side==='BUY'&&(!o.enabled||Date.now()-Date.parse(o.created_at)>5000||Date.parse(o.last_index?.validUntil)<=Date.now()||o.last_index?.sequence!==o.instruction.indexSequence)){await this.pool.query("UPDATE avis_core_v2.trading_robot_orders SET status='REJECTED',response=$2,updated_at=now() WHERE id=$1 AND status='CREATED'",[id,JSON.stringify({code:'ROBOT_ENTRY_EXPIRED'})]);return;}
  if(o.venue==='AVIS'){try{await this.executeAvisRobot(actor,o);}catch(e){if(['INSUFFICIENT_FUNDS','INSUFFICIENT_SECURITIES','ACCOUNT_NOT_FOUND'].includes(e.code))await this.pool.query("UPDATE avis_core_v2.trading_robot_orders SET status='REJECTED',response=$2,updated_at=now() WHERE id=$1 AND status='CREATED'",[id,JSON.stringify({code:e.code})]);throw e;}return;}
  let result;if(o.status==='CREATED'){
   const balances=await this.venue.balance(o.key_ref),r=(await this.pool.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=$1',[o.robot_id])).rows[0],needed=o.side==='BUY'?U(o.quantity)*U(o.price)/S:U(o.quantity),asset=o.side==='BUY'?r.quote_asset:r.base_asset;if(U(balances.find(b=>b.asset===asset)?.free||'0')<needed)fault('INSUFFICIENT_FUNDS');
   if(!await this.claimRobotDispatch(id))return;
   try{result=await this.venue.submit(o,o.key_ref);}catch(e){if(e.status>=400&&e.status<500&&![408,429].includes(e.status)){await this.pool.query("UPDATE avis_core_v2.trading_robot_orders SET status='REJECTED',response=$2 WHERE id=$1",[id,JSON.stringify({code:e.venueCode})]);}throw e;}
  }else result=await this.venue.order(o.symbol,o.client_order_id,o.key_ref);
  if(!['FILLED','EXPIRED','CANCELED','REJECTED','EXPIRED_IN_MATCH'].includes(result.status)){await this.pool.query("UPDATE avis_core_v2.trading_robot_orders SET status='ACKNOWLEDGED',response=$2 WHERE id=$1",[id,JSON.stringify(result)]);return;}
  if(!result.fills&&U(result.executedQty||'0')>0n)result.fills=await this.venue.trades(o.symbol,result.orderId,o.key_ref);
  return this.operation(actor,'W_ROBOT_VENUE_FILL',{id},'robot-venue:'+id,async db=>{const r=(await db.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=$1 FOR UPDATE',[o.robot_id])).rows[0];o=(await db.query('SELECT * FROM avis_core_v2.trading_robot_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];if(o.status==='SETTLED')return o.response;if(result.clientOrderId!==o.client_order_id||result.symbol!==r.symbol||result.side!==o.side||U(result.executedQty)>U(o.quantity))fault('ROBOT_VENUE_RESPONSE');await this.settleRobotState(db,o,r,result);return result;});
 }
 async list(actor,view){if(view==='tradingengine'){admin(actor);return [{...engineStatus}];}if(view==='tradingrobots'||view==='robotorders'){admin(actor);return (await this.pool.query(view==='tradingrobots'?'SELECT * FROM avis_core_v2.trading_robots ORDER BY created_at':'SELECT * FROM avis_core_v2.trading_robot_orders ORDER BY created_at DESC LIMIT 100')).rows;}return super.list(actor,view);}
}
