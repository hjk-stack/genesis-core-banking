import {createHash,randomUUID} from 'node:crypto';
import {walletTradingAllowances,setWalletTradingSelection,WALLET_SELECTION_MESSAGES} from './wallet-trading-selection.mjs';
import {SecuritiesPortfolio,securityValue} from './securities-portfolio.mjs';
import {fault,text,money,decimal} from './core.mjs';
import {NETWORKS,PLATFORM_NETWORKS,ChainAPI,newWallet,encryptKey,networkInfo,validAddress} from './crypto/networks.mjs';
import QRCode from 'qrcode';
import {assetReceivingWallet,existingFundingAccount,cryptoWalletRows} from './crypto-asset-routing.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const actualAdmin=a=>{if(!a?.admin||a.customerUserId)fault('FORBIDDEN',null,403);};
const access=(a,u)=>{if(!a?.admin||(a.customerUserId&&String(a.customerUserId)!==String(u)))fault('FORBIDDEN',null,403);};
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/.test(v);
const units=v=>/^0(?:\.0+)?$/.test(String(v))?0n:money(String(v));
export const CRYPTO_MESSAGES={
 ...WALLET_SELECTION_MESSAGES,
 CRYPTO_ACCOUNT_AMBIGUOUS:'Select the booked asset account in Portfolio Management.',
 CRYPTO_NETWORK:'Select a registered blockchain.',CRYPTO_CONNECTOR:'The blockchain request could not be completed. Retry this action.',
 CRYPTO_WRONG_CHAIN:'The selected endpoint returned a different blockchain. Check its connector setting.',
 CRYPTO_KEY_CONFIGURATION:'Configure the wallet encryption key in Administration.',CRYPTO_EVM_REQUIRED:'Select an EVM network for this Solidity contract.',
 CRYPTO_CONTRACT_CODE:'Check the registered token contract on this blockchain.',CRYPTO_DECIMALS:'This token has an unsupported decimal precision.',
 CRYPTO_APPROVAL_REQUIRED:'Select an asset and blockchain enabled by the administrator.',CRYPTO_WALLET_REQUIRED:'Create or select this holder’s blockchain wallet.',
 CRYPTO_CATALOGUE:'The currency catalogue could not be refreshed. Existing selections are retained.',CRYPTO_SECURITY:'Select a security wallet.',
 CRYPTO_DEMO_REQUIRED:'Select a demo security for this conversion.',CRYPTO_SOURCE_REQUIRED:'Select the institution’s registered security holding and custody reference.',
 CRYPTO_DOSSIER_CHANGED:'The asset or conversion terms changed. Review the conversion again.',CRYPTO_ACTION_REQUIRED:'Select the next contract action.',
 CRYPTO_REVIEW_CHANGED:'This transaction review expired or changed. Review it again.',CRYPTO_GAS:'The blockchain could not estimate this transaction. Check its wallet balance and contract terms.',
 CRYPTO_SIGNING_KEY:'This address has no signing key in the wallet engine. Select a managed wallet.',CRYPTO_TX_FAILED:'The blockchain rejected this transaction. Its wallet booking was not posted.',
 CRYPTO_RECEIPT:'The transaction receipt does not match the selected wallet and asset.',CRYPTO_CONFIRMATIONS:'The transaction is waiting for blockchain confirmations.',
 CRYPTO_ACTION_ACTIVE:'Complete the existing contract action before starting another.',CRYPTO_SETTLEMENT_ASSET:'Verify and enable AG and AGi contracts on the selected blockchain.',
 CRYPTO_CHANNEL:'Select a rolling channel with valid security quantity and settlement amount.',
 CRYPTO_TRADING_CONSENT:'Confirm the amount and trading authorization before allocating funds.',
 CRYPTO_TRADING_POSITION:'Close the active robot position and pending orders before releasing these funds.'
};
export class CryptoWorkspace extends SecuritiesPortfolio {
 constructor(pool,options={}){super(pool,options);this.chain=options.chain||new ChainAPI({env:this.secretEnv,fetcher:options.cryptoFetch||fetch});this.cryptoFetch=options.cryptoFetch||fetch;}
 async cryptoNetworks(actor){if(!actor?.admin)fault('FORBIDDEN',null,403);return Object.entries(NETWORKS).map(([code,n])=>({code,name:n.name,kind:n.kind,chainId:n.chainId,native:n.native,explorer:n.explorer}));}
 async approveCrypto(actor,input,key){actualAdmin(actor);if(typeof input.approved!=='boolean')fault('INVALID_FIELD','approved');
  const row=(await this.pool.query('SELECT * FROM avis_core_v2.crypto_asset_networks WHERE asset_id=$1 AND network=$2',[input.assetId,input.network])).rows[0];if(!row)fault('CRYPTO_APPROVAL_REQUIRED','assetId');
  // Disabling is immediate and does not delete existing holdings or addresses.
  const inspected=input.approved?await this.chain.inspectAsset(row.network,row.contract_address):null;
  return this.operation(actor,'CRYPTO_APPROVAL',input,key,async db=>{const current=(await db.query('SELECT * FROM avis_core_v2.crypto_asset_networks WHERE asset_id=$1 AND network=$2 FOR UPDATE',[input.assetId,input.network])).rows[0];if(current.contract_address!==row.contract_address)fault('CRYPTO_DOSSIER_CHANGED','assetId');await db.query('UPDATE avis_core_v2.crypto_asset_networks SET approved=$3,decimals=COALESCE($4,decimals),verified_at=CASE WHEN $3 THEN now() ELSE verified_at END WHERE asset_id=$1 AND network=$2',[input.assetId,input.network,input.approved,inspected?.decimals??null]);return {assetId:input.assetId,network:input.network,approved:input.approved};});
 }
 async activateCrypto(actor,input,key){access(actor,input.userId);if(!/^\d+$/.test(String(input.userId)))fault('INVALID_FIELD','userId');
  const allNetworks=input.network===undefined;
  if(!allNetworks)networkInfo(input.network);
  const networks=allNetworks?Object.keys(NETWORKS).sort():[input.network];
  return this.operation(actor,'CRYPTO_ACTIVATE',input,key,async db=>{
   const assets=(await db.query('SELECT a.currency_code,n.* FROM avis_core_v2.crypto_assets a JOIN avis_core_v2.crypto_asset_networks n USING(asset_id) WHERE a.asset_id=$1 AND n.network=ANY($2::varchar[]) AND n.approved AND n.verified_at IS NOT NULL ORDER BY n.network FOR SHARE OF a,n',[input.assetId,networks])).rows;
   if(!assets.length)fault('CRYPTO_APPROVAL_REQUIRED','assetId');
   const user=(await db.query('SELECT user_id FROM avis_core_v2.sovereign_users WHERE user_id=$1',[input.userId])).rows[0];
   if(!user)fault('ABIQ_CUSTOMER_NOT_FOUND','userId');
   const userId=String(user.user_id),wallets=[];
   // Every currency uses the same per-holder/network locks. Acquire the full
   // sorted set before creating anything so overlapping currency batches agree.
   for(const asset of assets)await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['wallet:'+userId+':'+asset.network]);
   for(const asset of assets){
    const network=asset.network;
    let wallet=await assetReceivingWallet(db,userId,network,input.assetId);
    if(!wallet){const created=newWallet(network);const encrypted=encryptKey(created.key,'wallet:'+userId+':'+network,this.secretEnv);wallet=(await db.query('INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address) VALUES($1,$2,$3) RETURNING *',[userId,network,created.address])).rows[0];await db.query('INSERT INTO avis_core_v2.crypto_wallet_keys(address_id,encrypted_key) VALUES($1,$2)',[wallet.address_id,JSON.stringify(encrypted)]);}
    const accountId=await existingFundingAccount(this,db,userId,asset);
    await db.query('INSERT INTO avis_core_v2.crypto_activations(user_id,asset_id,network,account_id) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,asset_id,network) DO UPDATE SET account_id=EXCLUDED.account_id',[userId,input.assetId,network,accountId]);
    wallets.push({addressId:String(wallet.address_id),accountId,address:wallet.public_address,network,assetId:input.assetId});
   }
   return allNetworks?{userId,assetId:input.assetId,currency:assets[0].currency_code,wallets}:wallets[0];
  });
 }
 async setCryptoWalletVisibility(actor,input,key){
  actualAdmin(actor);
  if(!uuid(input.accountId)||typeof input.visible!=='boolean')fault('INVALID_FIELD','accountId');
  return this.operation(actor,'CRYPTO_WALLET_VISIBILITY',input,key,async db=>{
   const row=(await db.query(`SELECT l.account_id,l.user_id,l.currency_code,l.network,l.wallet_scope,l.wallet_visible
     FROM avis_core_v2.ledger_accounts l
     WHERE l.account_id=$1 AND l.owner_type='USER' AND l.network IS NOT NULL
       AND l.wallet_scope IN ('FUNDING','CUSTODY') AND l.account_category='LIABILITY'
     FOR UPDATE`,[input.accountId])).rows[0];
   if(!row)fault('CRYPTO_WALLET_REQUIRED','accountId');
   if(row.wallet_visible!==input.visible)
    await db.query('UPDATE avis_core_v2.ledger_accounts SET wallet_visible=$2,updated_at=now() WHERE account_id=$1',[row.account_id,input.visible]);
   return {accountId:row.account_id,currency:row.currency_code,network:row.network,visible:input.visible};
  });
 }
 async selectWalletTrading(actor,input,key){return setWalletTradingSelection(this,actor,input,key);}
 async delegateWalletTrading(actor,input,key){
  const amount=decimal(money(input.amount));
  if(input.consent!==true)fault('CRYPTO_TRADING_CONSENT','consent');
  if(!uuid(input.accountId))fault('CRYPTO_WALLET_REQUIRED','accountId');
  const disclosure='By confirming below, I expressly instruct and authorize automated algorithmic trading using the designated portion of assets from this wallet. I acknowledge that cryptocurrency markets are volatile and that algorithmic trading carries a substantial risk of loss, up to and including the total loss of the allocated funds.';
  const consentHash=createHash('sha256').update(disclosure).digest('hex');
  return this.operation(actor,'CRYPTO_ROBOT_DELEGATE',{accountId:input.accountId,amount,consent:true},key,async db=>{
   const wallet=(await db.query(`SELECT account_id,user_id,currency_code,network,wallet_scope,account_category,owner_type,available_balance::text,locked_balance::text
    FROM avis_core_v2.ledger_accounts WHERE account_id=$1 FOR UPDATE`,[input.accountId])).rows[0];
   if(!wallet||wallet.owner_type!=='USER'||wallet.wallet_scope!=='FUNDING'||wallet.account_category!=='LIABILITY'||!wallet.network)
    fault('CRYPTO_WALLET_REQUIRED','accountId');
   access(actor,wallet.user_id);
   if(units(wallet.available_balance)-units(wallet.locked_balance)<units(amount))fault('INSUFFICIENT_FUNDS','amount');
   const updated=await db.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=locked_balance+$2::numeric,updated_at=now() WHERE account_id=$1 AND available_balance-locked_balance>=$2::numeric RETURNING available_balance::text,locked_balance::text',[wallet.account_id,amount]);
   if(updated.rows.length!==1)fault('INSUFFICIENT_FUNDS','amount');
   const row=(await db.query(`INSERT INTO avis_core_v2.wallet_trading_delegations(account_id,user_id,currency_code,network,quantity,consent_text_hash)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING delegation_id,consent_at`,[wallet.account_id,wallet.user_id,wallet.currency_code,wallet.network,amount,consentHash])).rows[0];
   return {delegationId:row.delegation_id,accountId:wallet.account_id,currency:wallet.currency_code,network:wallet.network,
    delegated:amount,available:decimal(units(updated.rows[0].available_balance)-units(updated.rows[0].locked_balance)),
    frozen:updated.rows[0].locked_balance,consentAt:new Date(row.consent_at).toISOString(),state:'ACTIVE'};
  });
 }
 async revokeWalletTrading(actor,input,key){
  if(!uuid(input.delegationId))fault('CRYPTO_WALLET_REQUIRED','delegationId');
  return this.operation(actor,'CRYPTO_ROBOT_REVOKE',{delegationId:input.delegationId},key,async db=>{
   const d=(await db.query(`SELECT delegation_id,account_id,user_id,currency_code,network,quantity::text,state
     FROM avis_core_v2.wallet_trading_delegations WHERE delegation_id=$1 FOR UPDATE`,[input.delegationId])).rows[0];
   if(!d||d.state!=='ACTIVE')fault('CRYPTO_WALLET_REQUIRED','delegationId');
   access(actor,d.user_id);
   const active=(await db.query(`SELECT 1 FROM avis_core_v2.trading_robots r
     WHERE r.user_id=$1 AND (r.base_asset=$2 OR r.quote_asset=$2)
     AND ((r.enabled AND COALESCE((SELECT s.enabled FROM avis_core_v2.wallet_trading_selections s WHERE s.account_id=$3),true)) OR r.position_quantity>0 OR EXISTS
       (SELECT 1 FROM avis_core_v2.trading_robot_orders o WHERE o.robot_id=r.robot_id
        AND o.status IN ('CREATED','DISPATCHING','ACKNOWLEDGED'))) LIMIT 1`,
    [d.user_id,d.currency_code,d.account_id])).rows;
   if(active.length)fault('CRYPTO_TRADING_POSITION','delegationId');
   const wallet=await db.query(`UPDATE avis_core_v2.ledger_accounts SET locked_balance=locked_balance-$2::numeric,updated_at=now()
     WHERE account_id=$1 AND locked_balance>=$2::numeric RETURNING available_balance::text,locked_balance::text`,[d.account_id,d.quantity]);
   if(wallet.rows.length!==1)fault('CRYPTO_WALLET_REQUIRED','accountId');
   await db.query(`UPDATE avis_core_v2.wallet_trading_delegations SET state='REVOKED',released_at=now()
    WHERE delegation_id=$1`,[d.delegation_id]);
   return {delegationId:d.delegation_id,accountId:d.account_id,state:'REVOKED',
    available:decimal(units(wallet.rows[0].available_balance)-units(wallet.rows[0].locked_balance)),
    frozen:wallet.rows[0].locked_balance};
  });
 }
 async cryptoWallet(actor,input){const r=(await this.pool.query('SELECT address_id,user_id,network,public_address,destination_tag FROM avis_core_v2.user_deposit_addresses WHERE address_id=$1',[input.addressId])).rows[0];if(!r)fault('CRYPTO_WALLET_REQUIRED','addressId');access(actor,r.user_id);return {...r,qr:await QRCode.toDataURL(r.public_address,{margin:2,width:256,errorCorrectionLevel:'M'})};}
 async cryptoChainBalance(actor,input){const wallet=await this.cryptoWallet(actor,input),asset=(await this.pool.query('SELECT * FROM avis_core_v2.crypto_asset_networks WHERE asset_id=$1 AND network=$2',[input.assetId,wallet.network])).rows[0];if(!asset)fault('CRYPTO_APPROVAL_REQUIRED','assetId');return {...await this.chain.balance(wallet.network,wallet.public_address,asset.contract_address,asset.decimals),observedAt:new Date().toISOString()};}
 async checkCryptoNetwork(actor,input){actualAdmin(actor);return {...await this.chain.check(input.network),checkedAt:new Date().toISOString()};}
 async refreshCryptoMarkets(actor,input,key){actualAdmin(actor);const requests=['usd','eur','chf'].map(async currency=>{const base=this.secretEnv.COINGECKO_API_KEY?'https://pro-api.coingecko.com':'https://api.coingecko.com',r=await this.cryptoFetch(base+'/api/v3/coins/markets?vs_currency='+currency+'&order=market_cap_desc&per_page=200&page=1&sparkline=false&price_change_percentage=24h',{headers:this.secretEnv.COINGECKO_API_KEY?{'x-cg-pro-api-key':this.secretEnv.COINGECKO_API_KEY}:{},signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)fault('CRYPTO_CATALOGUE');const rows=await r.json();if(!Array.isArray(rows)||!rows.length)fault('CRYPTO_CATALOGUE');return {currency,rows};});let feeds;try{feeds=await Promise.all(requests);}catch{fault('CRYPTO_CATALOGUE');}
  return this.operation(actor,'CRYPTO_MARKET_REFRESH',input,key,async db=>{let updated=0;for(const feed of feeds)for(const r of feed.rows){if(!r.id||!Number.isFinite(r.current_price)||r.current_price<0)continue;const patch={[feed.currency]:String(r.current_price),observedAt:r.last_updated,change24h:r.price_change_percentage_24h};const result=await db.query('UPDATE avis_core_v2.crypto_assets SET market_data=market_data||$2::jsonb,market_rank=$3,observed_at=now() WHERE asset_id=$1',[r.id,JSON.stringify(patch),r.market_cap_rank]);updated+=result.rowCount||0;}return {updated};});
 }
 async cryptoSecurityDetails(actor,{cardId}){
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  const r=(await this.pool.query(`SELECT c.*,d.public_address AS wallet_public_address
   FROM avis_core_v2.crypto_security_cards c LEFT JOIN avis_core_v2.user_deposit_addresses d ON d.address_id=c.wallet_address_id
   WHERE c.card_id=$1`,[cardId])).rows[0];
  if(!r)fault('CRYPTO_SECURITY','cardId');
  if(actor.customerUserId&&r.mode!=='DEMO')access(actor,r.user_id);
  const actions=actor.customerUserId?[]:(await this.pool.query('SELECT action_id,action_type,status,tx_hash,created_at,receipt,journal_id FROM avis_core_v2.crypto_chain_actions WHERE card_id=$1 ORDER BY created_at DESC LIMIT 30',[cardId])).rows;
  let sourceHolding=null;
  if(!actor.customerUserId||r.mode==='REAL'){
   const positions=await super.list(actor,'securitypositions');
   const candidates=positions.filter(p=>r.position_id?p.position_id===r.position_id:
    r.symbol==='aAVISP'&&p.account_role==='INSTITUTION'&&['AVISPay PLC','AVISPay PLC shares'].includes(p.name));
   if(candidates.length===1){const p=candidates[0];sourceHolding={positionId:p.position_id,userId:p.user_id,name:p.name,
    quantity:p.quantity,currency:p.currency_code,isin:p.isin,cusip:p.cusip,assetType:'STOCK',
    assetValue:p.portfolio_value,price:p.market_price,reference:p.reference||p.position_id,source:'Portfolio Management'};}
   else if(!actor.customerUserId&&r.symbol==='aAVISP'){
    const sources=(await this.pool.query(`SELECT p.* FROM avis_core_v2.treasury_opening_positions p
      JOIN avis_core_v2.sovereign_users u ON u.user_id=p.owner_user_id
      WHERE p.asset_code='AVISPAY-PLC-SHARES' AND p.asset_class='SECURITY' AND u.account_role='INSTITUTION'`)).rows;
    if(sources.length===1){const p=sources[0];sourceHolding={positionId:null,userId:p.owner_user_id,name:p.asset_name,
     quantity:String(p.quantity),currency:null,isin:p.isin,cusip:null,assetType:'STOCK',assetValue:null,price:null,
     reference:p.source_reference,source:'Portfolio Management / Treasury register'};}
   }
  }
  return {...r,sourceHolding,actions,contract:'AVISGreenRollingSecurityToken',
   sourceSpecification:'Rolling Trade-Loop Security Token & Omni-Chain Spec v3.0',
   contractFunctions:['lockSecurityForMargin','executeRollingTradeStep','executeParallelRollingBatch','closeRollingChannel','releaseMarginCollateral','redeemForPhysicalGold']};
 }
 async createSecurityWallet(actor,input,key){
  actualAdmin(actor);if(!uuid(input.cardId)||!/^\d+$/.test(String(input.userId)))fault('INVALID_FIELD','cardId');
  if(networkInfo(input.network).kind!=='EVM')fault('CRYPTO_EVM_REQUIRED','network');
  return this.operation(actor,'SECURITY_RECEIVING_WALLET',input,key,async db=>{
   const card=(await db.query('SELECT * FROM avis_core_v2.crypto_security_cards WHERE card_id=$1 FOR UPDATE',[input.cardId])).rows[0];
   const owner=(await db.query("SELECT user_id FROM avis_core_v2.sovereign_users WHERE user_id=$1 AND account_role='INSTITUTION'",[input.userId])).rows[0];
   if(!card||!owner)fault('CRYPTO_SECURITY','cardId');
   if(card.user_id&&String(card.user_id)!==String(owner.user_id)||card.network&&card.network!==input.network)fault('CRYPTO_DOSSIER_CHANGED','cardId');
   if(card.wallet_address_id)return this.cryptoWallet(actor,{addressId:card.wallet_address_id});
   const created=newWallet(input.network),sealed=encryptKey(created.key,'wallet:'+owner.user_id+':'+input.network,this.secretEnv);
   const wallet=(await db.query('INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address,is_primary) VALUES($1,$2,$3,false) RETURNING address_id,user_id,network,public_address',[owner.user_id,input.network,created.address])).rows[0];
   await db.query('INSERT INTO avis_core_v2.crypto_wallet_keys(address_id,encrypted_key) VALUES($1,$2)',[wallet.address_id,JSON.stringify(sealed)]);
   await db.query('UPDATE avis_core_v2.crypto_security_cards SET user_id=$2,network=$3,wallet_address_id=$4,version=version+1 WHERE card_id=$1',[card.card_id,owner.user_id,input.network,wallet.address_id]);
   return wallet;
  });
 }
 async convertDemoSecurity(actor,input,key){actualAdmin(actor);return this.operation(actor,'CONVERT_DEMO_SECURITY',input,key,async db=>{const r=(await db.query('SELECT * FROM avis_core_v2.crypto_security_cards WHERE card_id=$1 FOR UPDATE',[input.cardId])).rows[0];if(!r||r.mode!=='DEMO')fault('CRYPTO_DEMO_REQUIRED','cardId');const code='0x'+hash({cardId:r.card_id,dossier:r.dossier,contract:'AVISGreenRollingSecurityToken:v3'});await db.query("UPDATE avis_core_v2.crypto_security_cards SET state='CONVERTED',conversion_code=$2,token_quantity=$3,version=version+1,updated_at=now() WHERE card_id=$1",[input.cardId,code,r.dossier.issuedVolume]);return {id:r.card_id,mode:'DEMO',conversionCode:code,quantity:r.dossier.issuedVolume};});}
 async prepareRealSecurity(actor,input,key){actualAdmin(actor);const quantity=money(input.quantity),tokens=money(input.tokenQuantity),reference=text(input.custodyReference,'custodyReference',128);if(!uuid(input.cardId)||!uuid(input.positionId))fault('CRYPTO_SOURCE_REQUIRED','positionId');if(!Number.isInteger(input.marginHaircutBps)||input.marginHaircutBps<0||input.marginHaircutBps>=10000||!Number.isInteger(input.tradingFeeBps)||input.tradingFeeBps<0||input.tradingFeeBps>10000)fault('INVALID_FIELD','marginHaircutBps');if(input.greenHighTechVerified!==true)fault('CRYPTO_SOURCE_REQUIRED','greenHighTechVerified');if(networkInfo(input.network).kind!=='EVM')fault('CRYPTO_EVM_REQUIRED','network');
  return this.operation(actor,'PREPARE_ROLLING_SECURITY',input,key,async db=>{
   const card=(await db.query('SELECT * FROM avis_core_v2.crypto_security_cards WHERE card_id=$1 FOR UPDATE',[input.cardId])).rows[0];if(!card||card.mode==='REAL')fault('CRYPTO_DOSSIER_CHANGED','cardId');
   const settlement=(await db.query("SELECT a.currency_code,n.contract_address FROM avis_core_v2.crypto_asset_networks n JOIN avis_core_v2.crypto_assets a USING(asset_id) WHERE a.currency_code IN ('AG','AGi') AND n.network=$1 AND n.approved AND n.verified_at IS NOT NULL FOR SHARE OF n",[input.network])).rows;if(!['AG','AGi'].every(code=>settlement.some(a=>a.currency_code===code&&validAddress(input.network,a.contract_address))))fault('CRYPTO_SETTLEMENT_ASSET','network');
   const p=(await db.query(`SELECT p.*,s.name,s.short_name,s.isin,s.cusip,s.currency_code,s.denomination,s.kind,s.quote_basis,s.quantity_decimals,u.account_role FROM avis_core_v2.portfolio_positions p JOIN avis_core_v2.portfolio_securities s USING(security_id) JOIN avis_core_v2.sovereign_users u USING(user_id) WHERE position_id=$1 FOR UPDATE OF p`,[input.positionId])).rows[0];
   if(!p||p.account_role!=='INSTITUTION'||!p.isin||units(p.quantity)-units(p.reserved_quantity)<quantity)fault('CRYPTO_SOURCE_REQUIRED','positionId');
   const wallet=(await db.query('SELECT * FROM avis_core_v2.user_deposit_addresses WHERE address_id=$1 AND user_id=$2 AND network=$3',[input.addressId,p.user_id,input.network])).rows[0];if(!wallet)fault('CRYPTO_WALLET_REQUIRED','addressId');
   if(quantity%(10n**BigInt(18-p.quantity_decimals))!==0n)fault('SECURITY_QUANTITY_PRECISION','quantity');
   const assetValue=money(securityValue(decimal(quantity),p.denomination,p.market_price,p.quote_basis,p.currency_code)),faceValue=assetValue*10n**18n/tokens;if(faceValue<=0n||faceValue*tokens/10n**18n!==assetValue)fault('INVALID_AMOUNT','tokenQuantity');
   const dossier={isin:p.isin,cusip:p.cusip||'',assetType:p.kind==='share'?'STOCK':p.kind.toUpperCase(),collateralHouseRef:reference,currency:p.currency_code,faceValue:decimal(faceValue),assetValue:decimal(assetValue),issuedVolume:decimal(tokens),marginHaircutBps:input.marginHaircutBps,tradingFeeBps:input.tradingFeeBps,goldGramsPerToken1e6:0,greenHighTechVerified:true,sourceQuantity:decimal(quantity),sourceSecurityId:p.security_id,sourcePositionId:p.position_id,source:'Green Bond / registered securities',demo:false};
   if((await db.query('SELECT 1 FROM avis_core_v2.crypto_assets WHERE currency_code=$1',[card.symbol])).rows.length)fault('DUPLICATE_RECORD','cardId');
   const code='0x'+hash({cardId:card.card_id,dossier,network:input.network});
   await db.query('UPDATE avis_core_v2.portfolio_positions SET reserved_quantity=reserved_quantity+$2,version=version+1 WHERE position_id=$1',[p.position_id,decimal(quantity)]);
   await db.query("UPDATE avis_core_v2.crypto_security_cards SET mode='REAL',state='DRAFT',name=$2,dossier=$3,conversion_code=$4,security_id=$5,position_id=$6,user_id=$7,network=$8,wallet_address_id=$9,token_quantity=$10,source_quantity=$11,version=version+1,updated_at=now() WHERE card_id=$1",[card.card_id,p.name,JSON.stringify(dossier),code,p.security_id,p.position_id,p.user_id,input.network,wallet.address_id,decimal(tokens),decimal(quantity)]);
   return {id:card.card_id,conversionCode:code,quantity:decimal(tokens),dossier};
  });
 }
 async createRollingChannel(actor,input,key){actualAdmin(actor);const amount=decimal(money(input.securityAmount)),gross=decimal(money(input.grossValue));if(!['AG','AGi'].includes(input.settlementAsset)||!/^\d{1,18}$/.test(String(input.channel)))fault('CRYPTO_CHANNEL','channel');return this.operation(actor,'ROLLING_CHANNEL',input,key,async db=>{const card=(await db.query('SELECT * FROM avis_core_v2.crypto_security_cards WHERE card_id=$1',[input.cardId])).rows[0];if(!card)fault('CRYPTO_SECURITY','cardId');const user=card.user_id||(await db.query("SELECT user_id FROM avis_core_v2.sovereign_users WHERE account_role='INSTITUTION' ORDER BY user_id LIMIT 1")).rows[0]?.user_id;if(!user)fault('CRYPTO_SOURCE_REQUIRED','userId');const id=randomUUID();await db.query('INSERT INTO avis_core_v2.crypto_rolling_channels(channel_id,card_id,user_id,chain_channel,settlement_asset,security_amount,gross_value) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,card.card_id,user,String(input.channel),input.settlementAsset,amount,gross]);return {id};});}
 async list(actor,view){
  if(!actor?.admin)fault('FORBIDDEN',null,403);
  if(view==='tradingallowances')return walletTradingAllowances(this.pool,actor);
  if(view==='walletdelegations')return (await this.pool.query(`SELECT delegation_id,account_id,user_id,currency_code,network,quantity::text,consent_at,state
   FROM avis_core_v2.wallet_trading_delegations WHERE ($1::bigint IS NULL OR user_id=$1) ORDER BY consent_at DESC LIMIT 300`,[actor.customerUserId||null])).rows;
  if(view==='treasurypositions'){
   if(actor.customerUserId)fault('FORBIDDEN',null,403);
   return (await this.pool.query(`SELECT booking_id,source_system,source_reference,owner_user_id,asset_class,
    asset_code,asset_name,isin,quantity::text,destination,ledger_account_id,journal_id,booking_reference,booked_by,booked_at
    FROM avis_core_v2.treasury_opening_positions ORDER BY asset_class,asset_code`)).rows;
  }
  if(view==='cryptomarkets')return (await this.pool.query('SELECT * FROM avis_core_v2.crypto_assets WHERE market_rank IS NOT NULL ORDER BY market_rank LIMIT 200')).rows;
  if(view==='cryptocatalogue')return (await this.pool.query(`SELECT a.*,COALESCE(jsonb_agg(jsonb_build_object('network',n.network,'contractAddress',n.contract_address,'decimals',n.decimals,'approved',n.approved,'verifiedAt',n.verified_at) ORDER BY n.network) FILTER(WHERE n.network IS NOT NULL),'[]'::jsonb) AS networks FROM avis_core_v2.crypto_assets a LEFT JOIN avis_core_v2.crypto_asset_networks n ON n.asset_id=a.asset_id AND ($1::boolean OR n.approved) WHERE $1::boolean OR n.approved GROUP BY a.asset_id ORDER BY a.market_rank NULLS LAST,a.name`,[!actor.customerUserId])).rows;
  if(view==='cryptowallets')return cryptoWalletRows(this.pool,actor);
  if(view==='cryptosecurities')return (await this.pool.query("SELECT c.*,d.public_address AS wallet_public_address FROM avis_core_v2.crypto_security_cards c LEFT JOIN avis_core_v2.user_deposit_addresses d ON d.address_id=c.wallet_address_id WHERE ($1::bigint IS NULL OR c.mode='DEMO' OR c.user_id=$1) ORDER BY c.sort_order",[actor.customerUserId||null])).rows;
  if(view==='cryptonetworks')return this.cryptoNetworks(actor);
  if(view==='cryptorobots'){if(actor.customerUserId)return [];return (await this.pool.query('SELECT r.*,c.name,c.mode,c.contract_address FROM avis_core_v2.crypto_rolling_channels r JOIN avis_core_v2.crypto_security_cards c USING(card_id) ORDER BY r.updated_at DESC')).rows;}
  if(view==='cryptoactions'){if(actor.customerUserId)return [];return (await this.pool.query('SELECT action_id,card_id,user_id,network,action_type,status,tx_hash,receipt,journal_id,created_at FROM avis_core_v2.crypto_chain_actions ORDER BY created_at DESC LIMIT 100')).rows;}
  return super.list(actor,view);
 }
}
