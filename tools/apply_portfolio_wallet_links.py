"""Apply the reviewed portfolio/wallet UI corrections on the isolated release branch."""
from pathlib import Path
import hashlib
import re
import urllib.request

ROOT=Path('genesis-banking-uat/portal')

def replace(path,old,new,count=1):
    p=ROOT/path
    data=p.read_text()
    if data.count(old)!=count:
        raise RuntimeError(f'Patch anchor count mismatch: {path}: {old[:80]!r}: {data.count(old)}')
    p.write_text(data.replace(old,new))

def block(path,start,end,new):
    p=ROOT/path
    data=p.read_text()
    a=data.index(start)
    b=data.index(end,a)
    p.write_text(data[:a]+new+data[b:])

replace('src/crypto-workspace.mjs',"import QRCode from 'qrcode';","import QRCode from 'qrcode';\nimport {assetReceivingWallet,existingFundingAccount,cryptoWalletRows} from './crypto-asset-routing.mjs';")
replace('src/crypto-workspace.mjs'," CRYPTO_NETWORK:'Select a registered blockchain.'", " CRYPTO_ACCOUNT_AMBIGUOUS:'Select the booked asset account in Portfolio Management.',\n CRYPTO_NETWORK:'Select a registered blockchain.'")
replace('src/crypto-workspace.mjs',"let wallet=(await db.query('SELECT * FROM avis_core_v2.user_deposit_addresses WHERE user_id=$1 AND network=$2',[userId,network])).rows[0];", "let wallet=await assetReceivingWallet(db,userId,network,input.assetId);")
replace('src/crypto-workspace.mjs',"const accountId=await this.networkAccount(db,'USER',asset.currency_code,network,'CRYPTO',userId);", "const accountId=await existingFundingAccount(this,db,userId,asset);")
replace('src/crypto-workspace.mjs',"INSERT INTO avis_core_v2.crypto_activations(user_id,asset_id,network,account_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", "INSERT INTO avis_core_v2.crypto_activations(user_id,asset_id,network,account_id) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,asset_id,network) DO UPDATE SET account_id=EXCLUDED.account_id")
p=ROOT/'src/crypto-workspace.mjs'
data=p.read_text()
lines=data.splitlines()
assert sum("if(view==='cryptowallets')" in line for line in lines)==1
lines=["  if(view==='cryptowallets')return cryptoWalletRows(this.pool,actor);" if "if(view==='cryptowallets')" in line else line for line in lines]
p.write_text('\n'.join(lines)+'\n')

# Enrich the existing Portfolio rows, retaining its unchanged aggregate balances.
replace('src/account-management.mjs',"import {fault,text} from './core.mjs';", "import {fault,text} from './core.mjs';\nimport {enrichPortfolioHistory} from './crypto-asset-routing.mjs';")
replace('src/account-management.mjs',"return (await this.pool.query(`SELECT a.currency_code,a.network,", "const rows=(await this.pool.query(`SELECT a.currency_code,a.network,")
replace('src/account-management.mjs',"GROUP BY a.currency_code,a.network ORDER BY a.currency_code,a.network`,[actor.customerUserId||null])).rows;", "GROUP BY a.currency_code,a.network ORDER BY a.currency_code,a.network`,[actor.customerUserId||null])).rows;\n  return enrichPortfolioHistory(this.pool,actor,rows);")

# Sign exactly the asset's registered receiver, never the generic wallet by accident.
replace('src/crypto-wallet-transfers.mjs',"import {fault,text,money,decimal} from './core.mjs';", "import {fault,text,money,decimal} from './core.mjs';\nimport {assetReceivingWallet} from './crypto-asset-routing.mjs';")
replace('src/crypto-wallet-transfers.mjs',"const wallet=(await db.query('SELECT d.*,k.encrypted_key FROM avis_core_v2.user_deposit_addresses d JOIN avis_core_v2.crypto_wallet_keys k USING(address_id) WHERE d.user_id=$1 AND d.network=$2'+(lock?' FOR SHARE OF d,k':''),[source.user_id,source.network])).rows[0];\n  if(!wallet)fault('CRYPTO_SIGNING_KEY','cryptoAccount');", "const wallet=await assetReceivingWallet(db,source.user_id,source.network,asset.asset_id,{lock});\n  if(wallet)wallet.encrypted_key=(await db.query('SELECT encrypted_key FROM avis_core_v2.crypto_wallet_keys WHERE address_id=$1'+(lock?' FOR SHARE':''),[wallet.address_id])).rows[0]?.encrypted_key;\n  if(!wallet?.encrypted_key)fault('CRYPTO_SIGNING_KEY','cryptoAccount');")
replace('src/crypto-wallet-transfers.mjs',"const r=(await db.query('SELECT u.user_id,u.full_name,d.public_address FROM avis_core_v2.sovereign_users u JOIN avis_core_v2.user_deposit_addresses d USING(user_id) WHERE u.user_id=$1 AND d.network=$2',[clean.receiverUserId,source.network])).rows[0];", "const receiving=await assetReceivingWallet(db,clean.receiverUserId,source.network,asset.asset_id);\n    const owner=(await db.query('SELECT user_id,full_name FROM avis_core_v2.sovereign_users WHERE user_id=$1',[clean.receiverUserId])).rows[0];\n    const r=receiving&&owner?{...owner,public_address:receiving.public_address}:null;")

# Source stock records are read from Portfolio, and result address from the card's own binding.
block('src/crypto-workspace.mjs',' async cryptoSecurityDetails(actor,{cardId}){',' async convertDemoSecurity',r''' async cryptoSecurityDetails(actor,{cardId}){
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
''')
replace('src/crypto-workspace.mjs',"SELECT * FROM avis_core_v2.crypto_security_cards WHERE ($1::bigint IS NULL OR mode='DEMO' OR user_id=$1) ORDER BY sort_order", "SELECT c.*,d.public_address AS wallet_public_address FROM avis_core_v2.crypto_security_cards c LEFT JOIN avis_core_v2.user_deposit_addresses d ON d.address_id=c.wallet_address_id WHERE ($1::bigint IS NULL OR c.mode='DEMO' OR c.user_id=$1) ORDER BY c.sort_order")
# On confirmed issuance, bind the security token to the selected security wallet.
needle="await db.query('INSERT INTO avis_core_v2.crypto_asset_networks(asset_id,network,contract_address,decimals,approved,verified_at) VALUES($1,$2,$3,18,true,now())',['security:'+c.card_id,c.network,c.contract_address]);"
replace('src/crypto-chain-actions.mjs',needle,needle+"\n    await db.query('INSERT INTO avis_core_v2.crypto_asset_wallet_routes(user_id,asset_id,network,address_id) VALUES($1,$2,$3,$4)',[c.user_id,'security:'+c.card_id,c.network,c.wallet_address_id]);")
replace('server.mjs',"'crypto/securities/prepare':'prepareRealSecurity'", "'crypto/securities/prepare':'prepareRealSecurity','crypto/securities/wallet':'createSecurityWallet'")
replace('server.mjs',"'/crypto-icons/ag.png','/crypto-icons/agi.png'", "'/crypto-icons/ag.png','/crypto-icons/agi.png','/crypto-icons/avispay.webp'")
replace('server.mjs',"path.endsWith('.png')?'image/png':", "path.endsWith('.webp')?'image/webp':path.endsWith('.png')?'image/png':")

# Existing Portfolio rows gain exactly two requested evidence columns.
replace('public/app.mjs',"portfolio:[['currency_code','Asset'],['network','Blockchain'],['available_balance','Available holdings'],['locked_balance','Reserved holdings']]", "portfolio:[['currency_code','Asset'],['network','Blockchain'],['available_balance','Available holdings'],['locked_balance','Reserved holdings'],['smart_contract','Historical smart contract'],['historical_wallet_address','Historical wallet address']]")
needle="${k==='request_id'?"
replace('public/app.mjs',needle,"${name==='portfolio'&&['smart_contract','historical_wallet_address'].includes(k)?(r.historical_proof||[]).map(p=>`<a class=\"portfolio-chain-proof\" href=\"${esc(p.url)}\" target=\"_blank\" rel=\"noopener noreferrer\">${esc(k==='smart_contract'?p.contractAddress:p.walletAddress)}</a>`).join('<br>')||'—':k==='request_id'?")

# Wallet grouping chooses the funded row for a network, not the first empty card.
replace('public/crypto-workspace.mjs',"group.network=selectedNetworks.get(group.key);group.holding=group.rows.find(w=>w.network===group.network);return group;", "group.network=selectedNetworks.get(group.key);const sameNetwork=group.rows.filter(w=>w.network===group.network);group.holding=sameNetwork.find(w=>/[1-9]/.test(String(w.available_balance)+String(w.locked_balance)))||sameNetwork[0];return group;")
# Preserve compatibility with form serialization while providing real icon options.
replace('public/crypto-workspace.mjs',"const f=await form('Add accepted currency',holder+select('assetId','Currency',accepted.map(a=>[a.asset_id,a.name+' · '+a.currency_code]),'required')", "const f=await form('Add accepted currency',holder+select('assetId','Currency',accepted.map(a=>[a.asset_id,a.name+' · '+a.currency_code]),'required')")
needle="f.elements.assetId.onchange=()=>{const a=accepted.find(a=>a.asset_id===f.elements.assetId.value);f.querySelector('[data-included-networks]').textContent=a?eligibleNetworks(a).map(n=>networkName(n.network)).join(' · '):'Select a currency.';};"
replace('public/crypto-workspace.mjs',needle,needle+r'''
  const native=f.elements.assetId,label=native.closest('label');label.classList.add('currency-native-control');
  const picker=document.createElement('details');picker.className='currency-icon-picker';picker.innerHTML='<summary aria-label="Select currency"><span data-currency-choice>Select currency</span></summary><div class="currency-icon-options"><input type="search" aria-label="Search currencies" placeholder="Search currency name or code"><div role="listbox" aria-label="Currencies with icons">'+accepted.map(a=>'<button type="button" role="option" aria-selected="false" data-currency-option="'+esc(a.asset_id)+'">'+icon(a)+'<span><strong>'+esc(a.name)+'</strong><small>'+esc(a.currency_code)+'</small></span></button>').join('')+'</div></div>';label.after(picker);
  const sync=native.onchange;native.onchange=()=>{sync();const a=accepted.find(a=>a.asset_id===native.value);picker.querySelector('[data-currency-choice]').innerHTML=a?icon(a)+'<span>'+esc(a.name)+' · '+esc(a.currency_code)+'</span>':'Select currency';picker.querySelectorAll('[data-currency-option]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.currencyOption===native.value)));};
  picker.querySelectorAll('[data-currency-option]').forEach(b=>b.onclick=()=>{native.value=b.dataset.currencyOption;native.onchange();picker.open=false;});
  picker.querySelector('input').oninput=e=>{const term=e.target.value.trim().toLowerCase();picker.querySelectorAll('[data-currency-option]').forEach(b=>b.hidden=!b.textContent.toLowerCase().includes(term));};
''')
# Keep all ten requested security cards in the admin scroller, never mix payment currencies.
replace('public/crypto-workspace.mjs',"data.cryptosecurities.filter(s=>s.mode==='REAL'||s.symbol==='aAVISP').map(s=>", "data.cryptosecurities.filter(s=>s.mode==='REAL'||s.symbol==='aAVISP'||isAdmin()&&/^DEMO(?:0[2-9]|10)$/.test(s.symbol)).map(s=>")
replace('public/crypto-workspace.mjs','class="security-wallet ${selected', 'class="crypto-wallet security-wallet ${selected')
replace('public/crypto-workspace.mjs','<span class="security-symbol">◈</span>', '${s.symbol===\'aAVISP\'?\'<img class="security-brand-logo" src="/crypto-icons/avispay.webp" alt="AVISPay">\':\'<span class="security-symbol">◈</span>\'}')
replace('public/crypto-workspace.mjs',"${esc(s.network)}</span></span><strong>${esc(s.name)}</strong>", "${esc(s.network||'')}</span></span><strong>${esc(s.name)}</strong>")
replace('public/crypto-workspace.mjs',"<span>${esc(s.state==='DRAFT'?'Asset dossier':s.state==='BOOKED'?'Wallet booked':'Contract deployed')} →</span>", "<code class=\"security-wallet-address\">${esc(s.wallet_public_address||'')}</code><span>${esc(s.mode==='DEMO'?(s.symbol==='aAVISP'?'Open converter':'Demo wallet'):s.state==='BOOKED'?'Wallet booked':s.contract_address?'Contract deployed':'Open converter')} →</span>")
# Remove misleading sample status/amounts for the institution stock source. Keep demo controls only on demos.
replace('public/crypto-workspace.mjs',"const d=s.dossier;", "const source=s.sourceHolding;const d=source?{...s.dossier,assetType:source.assetType,isin:source.isin,cusip:source.cusip,currency:source.currency,assetValue:source.assetValue,issuedVolume:source.quantity,faceValue:source.price,collateralHouseRef:source.reference,source:source.source}:s.dossier;")
replace('public/crypto-workspace.mjs',"${s.mode==='DEMO'?'Demo security':esc(s.network)}", "${s.symbol==='aAVISP'?'Portfolio-linked security':s.mode==='DEMO'?'Demo security':esc(s.network)}")
replace('public/crypto-workspace.mjs',"['Asset name',s.name]", "['Asset name',source?.name||s.name]")
replace('public/crypto-workspace.mjs',"fmt(d.assetValue)+' '+d.currency", "d.assetValue==null?'—':fmt(d.assetValue)+' '+(d.currency||'')")
replace('public/crypto-workspace.mjs',"fmt(d.faceValue)+' '+d.currency", "d.faceValue==null?'—':fmt(d.faceValue)+' '+(d.currency||'')")
replace('public/crypto-workspace.mjs','<span class="conversion-arrow" aria-hidden="true">⇄</span>', '<div class="conversion-code-column"><strong>CONVERTER CODE</strong><span class="conversion-arrow" aria-hidden="true">⇄</span><code>${esc(s.conversion_code||\'—\')}</code></div>')
replace('public/crypto-workspace.mjs',"['Settlement','AG / AGi'],", "")
replace('public/crypto-workspace.mjs',"['Token volume',fmt(s.token_quantity)]", "['Token volume',fmt(s.token_quantity)],['Receiving wallet',s.wallet_public_address]")
replace('public/crypto-workspace.mjs',"${isAdmin()&&s.mode==='DEMO'?'<button class=\"primary\" data-demo-convert>Convert demo security</button><button data-real-prepare>Replace with registered security</button>':''}", "${isAdmin()&&s.mode==='DEMO'?(s.symbol==='aAVISP'?'<button class=\"primary\" data-real-prepare>Convert Portfolio security</button>':'<button class=\"primary\" data-demo-convert>Convert demo security</button><button data-real-prepare>Select Portfolio security</button>'):''}${isAdmin()&&!s.wallet_address_id?'<button type=\"button\" data-security-wallet>Create security receiving wallet</button>':''}")
needle="if(q('[data-real-prepare]'))q('[data-real-prepare]').onclick=()=>prepareReal(s);"
replace('public/crypto-workspace.mjs',needle,needle+r'''
  if(q('[data-security-wallet]'))q('[data-security-wallet]').onclick=async()=>{
   const users=data.customers.filter(u=>u.account_role==='INSTITUTION'),nets=data.cryptonetworks.filter(n=>n.kind==='EVM');
   const f=await form('Security receiving wallet',select('userId','Portfolio holder',users.map(u=>[u.user_id,u.full_name]),'required')+select('network','Blockchain',nets.map(n=>[n.code,n.name]),'required'),(v,k)=>api('crypto/securities/wallet',{...v,cardId:s.card_id},k),'Create receiving wallet');
   if(source?.userId)f.elements.userId.value=String(source.userId);if(s.network)f.elements.network.value=s.network;
  };
''')
# Dedicated card wallet is selectable without a fabricated funded account.
replace('public/crypto-workspace.mjs',"async function prepareReal(s){const positions=data.securitypositions.filter", "async function prepareReal(s){const cardWallet=s.wallet_address_id&&s.wallet_public_address?[{address_id:s.wallet_address_id,public_address:s.wallet_public_address,user_id:s.user_id,full_name:s.name,account_role:'INSTITUTION',network:s.network}]:[];const conversionWallets=[...data.cryptowallets,...cardWallet];const positions=data.securitypositions.filter")
replace('public/crypto-workspace.mjs',"data.cryptowallets.filter(w=>w.account_role==='INSTITUTION'", "conversionWallets.filter(w=>w.account_role==='INSTITUTION'")
replace('public/crypto-workspace.mjs',"const w=data.cryptowallets.find(w=>String(w.address_id)===v.addressId);return api('crypto/securities/prepare'", "const w=conversionWallets.find(w=>String(w.address_id)===v.addressId);return api('crypto/securities/prepare'")

# Browser fixtures now assert the explicitly requested ten-card row.
p=ROOT/'test-browser/crypto-layout.mjs'
s=p.read_text()
s=s.replace("count(),1,'only the registered AVISPay PLC stock converter card is retained in the live scroller'", "count(),10,'the AVISPay security and nine requested demo wallets remain in the row'")
s=s.replace("count(),1,'the PLC shares converter is restored without publishing other demo security cards'", "count(),10,'the security scroller retains all ten requested wallets'")
s=s.replace("'/crypto-icons/ag.png','/crypto-icons/agi.png'", "'/crypto-icons/ag.png','/crypto-icons/agi.png','/crypto-icons/avispay.webp'")
s=s.replace("req.url.endsWith('.png')?'image/png':", "req.url.endsWith('.webp')?'image/webp':req.url.endsWith('.png')?'image/png':")
# Native form field is retained for serialization; select it with force in this compatibility test.
s=re.sub(r"(getByLabel\('Currency'(?:,\{exact:true\})?\)\.selectOption\([^;\n]+?)(\);)", lambda m:m.group(1)+', {force:true}'+m.group(2), s)
p.write_text(s)

css=r'''
.portfolio-chain-proof{display:block;font:11px/1.45 ui-monospace,SFMono-Regular,monospace;max-width:26em;overflow-wrap:anywhere;color:#176455}
.currency-native-control{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip-path:inset(50%);white-space:nowrap}
.currency-icon-picker{position:relative;min-width:0;border:1px solid #afc1b8;border-radius:8px;background:#fff;align-self:start}
.currency-icon-picker>summary{list-style:none;cursor:pointer;padding:13px;min-height:25px;font-size:13px}
.currency-icon-picker>summary [data-currency-choice]{display:flex;align-items:center;gap:9px}
.currency-icon-picker .coin-icon{width:26px;height:26px}
.currency-icon-options{padding:10px;border-top:1px solid #d8e2dc}
.currency-icon-options [role=listbox]{max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:3px;margin-top:8px}
.currency-icon-options [role=option]{display:flex;gap:11px;align-items:center;width:100%;text-align:left;padding:9px;background:#fff;color:#173c31;border:1px solid transparent;border-radius:6px;white-space:normal}
.currency-icon-options [role=option][hidden]{display:none}
.currency-icon-options [role=option]>span{display:grid;gap:3px}
.currency-icon-options [role=option]:hover,.currency-icon-options [aria-selected=true]{background:#e8f4ed;border-color:#a8c9b8}
.security-brand-logo{width:125px;height:38px;object-fit:contain;object-position:left center}
.security-wallet-address{font:10px/1.4 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere;white-space:normal;color:#d3eee3;min-height:28px}
.security-conversion{grid-template-columns:minmax(0,1fr) minmax(150px,.55fr) minmax(0,1fr)}
.conversion-code-column{display:flex;flex-direction:column;align-items:center;gap:12px;justify-content:center;min-width:0;align-self:stretch;padding:18px 10px;border-inline:1px solid #e0e7e3}
.conversion-code-column strong{font-size:11px;letter-spacing:.1em;color:#326953}
.conversion-code-column code{font:11px/1.5 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere;text-align:center;max-width:100%}
@media(max-width:720px){.security-conversion{grid-template-columns:1fr}.conversion-code-column{border-inline:0;border-block:1px solid #e0e7e3}.currency-icon-picker{grid-column:1/-1}}
'''
with (ROOT/'public/crypto.css').open('a') as f:f.write(css)

# Copy the owner's existing registered artwork, checking the Git blob identity.
url='https://raw.githubusercontent.com/hjk-stack/genesis-outlook-automation/749d1862b030069ef9b95baba8a7988c604f37c1/src/bank-assets/avispay-logo.webp'
logo=urllib.request.urlopen(url,timeout=30).read(100000)
assert logo[:4]==b'RIFF' and logo[8:12]==b'WEBP'
assert hashlib.sha1(b'blob '+str(len(logo)).encode()+b'\0'+logo).hexdigest()=='5df4c2122ed7c63ab42ddd0ed568a7072ade3150'
(ROOT/'public/crypto-icons/avispay.webp').write_bytes(logo)
print('Applied portfolio history, exact asset routes, booked-account selection, icon picker and securities converter corrections.')
