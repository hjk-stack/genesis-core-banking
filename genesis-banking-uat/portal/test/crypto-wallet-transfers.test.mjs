import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import ganache from 'ganache';
import solc from 'solc';
import {JsonRpcProvider,ContractFactory,Wallet,Transaction,parseEther,parseUnits} from 'ethers';
import {migrate} from '../src/migrate.mjs';
import {EvmWalletTransfers} from '../src/crypto-wallet-transfers.mjs';
import {TransferMethods} from '../src/transfer-methods.mjs';
import {CustomerAccess} from '../src/customer-access.mjs';
import {encryptKey} from '../src/crypto/networks.mjs';
import {cryptoLedgerAccount} from '../src/crypto/rolling-ledger.mjs';

const admin={id:'wallet-integration',admin:true},customer={id:'wallet-owner',admin:false,customerUserId:'1'};
const env={AVIS_OFFLINE_SIGNING_KEY:'isolated-wallet-integration-key-never-used-in-production'};
const key=()=>randomUUID(),hooks={},broadcasts=[];
let engine,url,pool,db,core,provider,sourceAddress,recipient,external,eth,ethBacking,tokenAccount,custody,tokenBacking,custodyBacking,token,security,walletId,chain,finalizedHeight=0;
const one=async(sql,args=[]) => (await pool.query(sql,args)).rows[0];
const balance=async id=>parseEther((await one('SELECT available_balance::text AS value FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[id])).value);
const action=async requestId=>one('SELECT * FROM avis_core_v2.crypto_chain_actions WHERE request_id=$1',[requestId]);
const journalCount=async()=>Number((await one('SELECT count(*)::int AS n FROM avis_core_v2.ledger_journals')).n);
const send=(account,extra={})=>({method:'CRYPTO',cryptoAccount:account,cryptoDestination:'EXTERNAL',cryptoAddress:external,receiverName:'Isolated recipient',amount:'1',reference:'Isolated wallet transfer',...extra});
const confirm=(review,instance=core,k=key())=>instance.confirmPayment(admin,{requestId:review.id,messageHash:review.messageHash},k);
async function mine({finalize=true}={}){for(let n=0;n<12;n++)await provider.send('evm_mine',[]);if(finalize)finalizedHeight=await provider.getBlockNumber();}
async function settle(review,instance=core){await mine();return instance.confirmCryptoAction(admin,{actionId:review.actionId},key());}
function connection(){
 const p=new JsonRpcProvider(url,1,{staticNetwork:true,cacheTimeout:-1});
 const broadcast=p.broadcastTransaction.bind(p),transaction=p.getTransaction.bind(p),receipt=p.getTransactionReceipt.bind(p),block=p.getBlock.bind(p),nonce=p.getTransactionCount.bind(p);
 p.broadcastTransaction=async raw=>{broadcasts.push(raw);return hooks.broadcast?hooks.broadcast(raw,broadcast):broadcast(raw);};
 p.getTransaction=async hash=>hooks.transaction?hooks.transaction(hash,transaction):transaction(hash);
 p.getTransactionReceipt=async hash=>{const r=await receipt(hash);return hooks.receipt?hooks.receipt(r):r;};
 p.getTransactionCount=async(...args)=>hooks.nonce?hooks.nonce(()=>nonce(...args)):nonce(...args);
 // Ganache has no PoS consensus. Only this isolated adapter supplies an explicit
 // observed finalized checkpoint; production never substitutes latest for it.
 p.getBlock=async tag=>{const r=await block(tag==='finalized'?finalizedHeight:tag);return tag==='finalized'&&hooks.finalized?hooks.finalized(r):r;};
 return p;
}
async function seed(currency,amount,scope='FUNDING'){
 const accountId=await cryptoLedgerAccount(pool,{userId:'1',currency,network:'ETHEREUM',scope});
 const backing=await cryptoLedgerAccount(pool,{owner:'HOT_WALLET',currency,network:'ETHEREUM',bucket:'CHAIN_CUSTODY',category:'ASSET'});
 await core.operation(admin,'ISOLATED_WALLET_FIXTURE',{accountId},key(),async(db,k)=>({journalId:await core.post(db,admin,k,'TEST_CHAIN_DEPOSIT','Isolated local-chain fixture',[
  {accountId,direction:'CREDIT',amount},{accountId:backing,direction:'DEBIT',amount}
 ])}));
 return [accountId,backing];
}
before(async()=>{
 // Every RPC call in this suite goes to a newly created local chain.
 engine=ganache.server({logging:{quiet:true},chain:{chainId:1,hardfork:'shanghai'},wallet:{totalAccounts:4}});
 await engine.listen(0,'127.0.0.1');url='http://127.0.0.1:'+engine.address().port;
 provider=new JsonRpcProvider(url,1,{staticNetwork:true,cacheTimeout:-1});provider.pollingInterval=10;
 const accounts=Object.entries(engine.provider.getInitialAccounts());
 sourceAddress=new Wallet(accounts[0][1].secretKey).address;recipient=new Wallet(accounts[1][1].secretKey).address;external=new Wallet(accounts[3][1].secretKey).address;
 if(process.env.TEST_DATABASE_URL){
  const target=new URL(process.env.TEST_DATABASE_URL);assert.equal(target.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:target.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
 }else{
  db=new PGlite();pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release(){}})};
 }
 const client=await pool.connect();try{await migrate(client);}finally{client.release();}
 chain={check:async network=>{assert.equal(network,'ETHEREUM');assert.equal(await provider.send('eth_chainId',[]),'0x1');return {chainId:1};},provider:connection};
 core=new EvmWalletTransfers(pool,{secretEnv:env,chain});
 const source='pragma solidity ^0.8.20; contract Token { uint8 public decimals; bool public fail; mapping(address=>uint256) public balanceOf; event Transfer(address indexed from,address indexed to,uint256 value); constructor(uint8 d){decimals=d;} function mint(address a,uint256 v) external {balanceOf[a]+=v;emit Transfer(address(0),a,v);} function setFail(bool f) external {fail=f;} function transfer(address to,uint256 v) external returns(bool){require(!fail,"REVERT_FIXTURE");balanceOf[msg.sender]-=v;balanceOf[to]+=v;emit Transfer(msg.sender,to,v);return true;} }';
 const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'Token.sol':{content:source}},settings:{evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
 assert.equal((output.errors||[]).filter(e=>e.severity==='error').length,0);
 const compiled=output.contracts['Token.sol'].Token,fixtureSigner=await provider.getSigner(2);
 const deploy=async decimals=>{const c=await new ContractFactory(compiled.abi,'0x'+compiled.evm.bytecode.object,fixtureSigner).deploy(decimals);await c.waitForDeployment();return c;};
 token=await deploy(6);security=await deploy(18);
 await (await token.mint(sourceAddress,parseUnits('1000',6))).wait();await (await security.mint(sourceAddress,parseEther('1000'))).wait();
 await pool.query("UPDATE avis_core_v2.crypto_asset_networks SET approved=true,verified_at=now() WHERE asset_id='ethereum' AND network='ETHEREUM'");
 await pool.query("UPDATE avis_core_v2.crypto_asset_networks SET contract_address=$1,decimals=6,approved=true,verified_at=now() WHERE asset_id='usd-coin' AND network='ETHEREUM'",[token.target]);
 await pool.query("INSERT INTO avis_core_v2.crypto_assets(asset_id,currency_code,name,source) VALUES('security:isolated','aAVISP','Isolated booked security','SECURITY')");
 await pool.query("INSERT INTO avis_core_v2.crypto_asset_networks(asset_id,network,contract_address,decimals,approved,verified_at) VALUES('security:isolated','ETHEREUM',$1,18,true,now())",[security.target]);
 walletId=(await one("INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address) VALUES(1,'ETHEREUM',$1) RETURNING address_id",[sourceAddress])).address_id;
 await pool.query('INSERT INTO avis_core_v2.crypto_wallet_keys(address_id,encrypted_key) VALUES($1,$2)',[walletId,JSON.stringify(encryptKey({privateKey:accounts[0][1].secretKey},'wallet:1:ETHEREUM',env))]);
 await pool.query("INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address) VALUES(2,'ETHEREUM',$1)",[recipient]);
 await pool.query("UPDATE avis_core_v2.crypto_security_cards SET mode='REAL',state='BOOKED',user_id=1,network='ETHEREUM',wallet_address_id=$1,contract_address=$2,token_quantity=1000 WHERE sort_order=1",[walletId,security.target]);
 [eth,ethBacking]=await seed('ETH','100');[tokenAccount,tokenBacking]=await seed('USDC','1000');[custody,custodyBacking]=await seed('aAVISP','1000','CUSTODY');
 finalizedHeight=await provider.getBlockNumber();
});
after(async()=>{await provider?.destroy();await engine?.close();if(db)await db.close();else await pool?.end();});

test('review binds the owned account, token precision and approved contract without reserving money',async()=>{
 const access=new CustomerAccess(core),before=await journalCount(),funds=await balance(eth);
 await assert.rejects(access.invoke({...customer,customerUserId:'2'},'preparePayment',send(eth),key()),/FORBIDDEN/);
 await assert.rejects(core.preparePayment({...admin,customerUserId:'2'},send(eth),key()),/FORBIDDEN/);
 await assert.rejects(core.preparePayment(admin,send(tokenAccount,{amount:'0.0000001'}),key()),/CRYPTO_AMOUNT_PRECISION/);
 await assert.rejects(core.preparePayment(admin,send(eth,{cryptoAddress:sourceAddress}),key()),/SAME_ACCOUNT/);
 await pool.query("UPDATE avis_core_v2.crypto_asset_networks SET decimals=6 WHERE asset_id='ethereum' AND network='ETHEREUM'");
 await assert.rejects(core.preparePayment(admin,send(eth),key()),/CRYPTO_APPROVAL_REQUIRED/);
 await pool.query("UPDATE avis_core_v2.crypto_asset_networks SET decimals=18 WHERE asset_id='ethereum' AND network='ETHEREUM'");
 const review=await core.preparePayment(admin,send(tokenAccount),key());
 assert.equal(review.mode,'BLOCKCHAIN');assert.equal(review.instruction.chainId,1);assert.equal(review.instruction.networkFeeCurrency,'ETH');
 assert.ok(parseEther(review.instruction.networkFeeMaximum)>0n);assert.equal(await journalCount(),before);assert.equal(await balance(eth),funds);
 await pool.query("UPDATE avis_core_v2.crypto_asset_networks SET decimals=7 WHERE asset_id='usd-coin' AND network='ETHEREUM'");
 await assert.rejects(confirm(review),/CRYPTO_REVIEW_CHANGED/);
 await pool.query("UPDATE avis_core_v2.crypto_asset_networks SET decimals=6 WHERE asset_id='usd-coin' AND network='ETHEREUM'");
 await core.cancelPayment(admin,{requestId:review.id},key());assert.equal((await action(review.id)).status,'EXPIRED');
 await assert.rejects(confirm(review),/PAYMENT_REQUEST_CLOSED/);assert.equal(await journalCount(),before);
});

test('native send commits exact signed bytes and conserved reserves before broadcast; confirmation charges actual gas once',async()=>{
 const funds=await balance(eth),backing=await balance(ethBacking),destination=await provider.getBalance(external),before=await journalCount();
 const review=await core.preparePayment(admin,send(eth,{amount:'0.75'}),key()),maximum=parseEther(review.instruction.networkFeeMaximum);
 let observed=false;
 hooks.broadcast=async(raw,broadcast)=>{
  const row=await action(review.id),r=await one('SELECT * FROM avis_core_v2.asset_transfer_requests WHERE request_id=$1',[review.id]);
  assert.equal(row.status,'SIGNED');assert.equal(row.signed_transaction,raw);assert.equal(row.tx_hash,Transaction.from(raw).hash);
  assert.equal(r.status,'OUTGOING');assert.ok(r.reservation_journal_id);assert.equal(await balance(eth),funds-parseEther('0.75')-maximum);
  assert.equal(await balance(ethBacking),backing-parseEther('0.75')-maximum);
  for(const hold of row.reservations){assert.equal(await balance(hold.suspense),parseEther(hold.amount));assert.equal(await balance(hold.reservedAsset),parseEther(hold.amount));}
  observed=true;return broadcast(raw);
 };
 const result=await confirm(review);delete hooks.broadcast;
 assert.ok(observed);assert.equal(result.current_status,'OUTGOING');assert.equal(result.chain_status,'SUBMITTED');assert.ok(result.tx_hash);
 assert.equal(result.confirmations,null);
 assert.equal(result.signed_transaction,undefined);assert.equal(JSON.stringify(result).includes('encrypted_key'),false);
 assert.equal(await journalCount(),before+1);
 await assert.rejects(core.cancelPayment(admin,{requestId:review.id},key()),/PAYMENT_REQUEST_CLOSED/);
 await assert.rejects(core.pickupTransfer(admin,{requestId:review.id},key()),/PAYMENT_REQUEST_CLOSED/);
 await assert.rejects(core.settleManualTransfer(admin,{requestId:review.id,settlementReference:'not a manual payment'},key()),/PAYMENT_REQUEST_CLOSED/);
 const early=await core.confirmCryptoAction(admin,{actionId:review.actionId},key());assert.ok(early.confirmations<12);assert.equal(await journalCount(),before+1);
 await mine();
 hooks.receipt=r=>({...r,hash:'0x'+'11'.repeat(32)});
 await assert.rejects(core.confirmCryptoAction(admin,{actionId:review.actionId},key()),/CRYPTO_RECEIPT/);delete hooks.receipt;
 assert.equal(await journalCount(),before+1);
 const settled=await core.confirmCryptoAction(admin,{actionId:review.actionId},key());assert.equal(settled.status,'CONFIRMED');
 const receipt=await provider.getTransactionReceipt(result.tx_hash),gas=receipt.gasUsed*receipt.gasPrice;
 assert.equal(await balance(eth),funds-parseEther('0.75')-gas);assert.equal(await balance(ethBacking),backing-parseEther('0.75')-gas);
 assert.equal(await provider.getBalance(external),destination+parseEther('0.75'));
 const saved=await action(review.id);for(const hold of saved.reservations){assert.equal(await balance(hold.suspense),0n);assert.equal(await balance(hold.reservedAsset),0n);}
 assert.equal(saved.receipt.finality,'FINALIZED');assert.ok(saved.receipt.finalizedBlockNumber>=receipt.blockNumber);assert.match(saved.receipt.finalizedBlockHash,/^0x[0-9a-f]{64}$/);
 const final=await core.paymentRequest(admin,review.id);assert.equal(final.current_status,'COMPLETED');assert.equal(parseEther(final.gas_fee),gas);assert.ok(final.confirmations>=12);
 await confirm(review);await core.confirmCryptoAction(admin,{actionId:review.actionId},key());assert.equal(await journalCount(),before+2);
 assert.equal(Number((await one('SELECT count(*)::int AS n FROM avis_core_v2.onchain_transactions WHERE tx_hash=$1',[result.tx_hash])).n),1);
});

test('approved ERC20 sends require the exact transfer event and book token and ETH fee separately',async()=>{
 const funds=await balance(tokenAccount),backing=await balance(tokenBacking),gasFunds=await balance(eth),to=await token.balanceOf(external);
 const review=await core.preparePayment(admin,send(tokenAccount,{amount:'12.345678'}),key()),result=await confirm(review);
 assert.equal(await balance(tokenAccount),funds-parseEther('12.345678'));await mine();
 hooks.receipt=r=>({...r,logs:r.logs.map(l=>({...l,address:external}))});
 await assert.rejects(core.confirmCryptoAction(admin,{actionId:review.actionId},key()),/CRYPTO_RECEIPT/);delete hooks.receipt;
 hooks.receipt=r=>({...r,logs:[...r.logs,...r.logs]});
 await assert.rejects(core.confirmCryptoAction(admin,{actionId:review.actionId},key()),/CRYPTO_RECEIPT/);delete hooks.receipt;
 assert.equal((await action(review.id)).status,'SUBMITTED');
 await core.confirmCryptoAction(admin,{actionId:review.actionId},key());
 const receipt=await provider.getTransactionReceipt(result.tx_hash);
 assert.equal(await token.balanceOf(external),to+parseUnits('12.345678',6));
 assert.equal(await balance(tokenAccount),funds-parseEther('12.345678'));assert.equal(await balance(tokenBacking),backing-parseEther('12.345678'));
 assert.equal(await balance(eth),gasFunds-receipt.gasUsed*receipt.gasPrice);
 const recorded=await one('SELECT * FROM avis_core_v2.onchain_transactions WHERE tx_hash=$1',[result.tx_hash]);
 assert.equal(recorded.asset_contract.toLowerCase(),token.target.toLowerCase());assert.equal(recorded.status,'CONFIRMED');assert.equal(recorded.currency_code,'USDC');
});

test('CUSTODY transfer conserves pledged balance and credits the receiving custody account only after chain confirmation',async()=>{
 const funds=await balance(custody),backing=await balance(custodyBacking),gasFunds=await balance(eth),to=await security.balanceOf(recipient);
 await pool.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=available_balance-5 WHERE account_id=$1',[custody]);
 await assert.rejects(core.preparePayment(admin,send(custody,{amount:'6'}),key()),/INSUFFICIENT_FUNDS/);
 const review=await core.preparePayment(admin,send(custody,{cryptoDestination:'INTERNAL',receiverUserId:'2',amount:'3'}),key());
 assert.equal(review.instruction.recipientScope,'CUSTODY');
 await pool.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=available_balance WHERE account_id=$1',[custody]);
 await assert.rejects(confirm(review),/INSUFFICIENT_FUNDS/);
 await pool.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=available_balance-5 WHERE account_id=$1',[custody]);
 const result=await confirm(review);
 const target=await cryptoLedgerAccount(pool,{userId:'2',currency:'aAVISP',network:'ETHEREUM',scope:'CUSTODY'});
 assert.equal(await balance(target),0n);assert.equal(await balance(custody),funds-parseEther('3'));
 assert.equal(await balance(custodyBacking),backing-parseEther('3'));
 assert.equal(parseEther((await one('SELECT locked_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[custody])).locked_balance),funds-parseEther('5'));
 await settle(review);const receipt=await provider.getTransactionReceipt(result.tx_hash);
 assert.equal(await balance(target),parseEther('3'));assert.equal(await balance(custodyBacking),backing);
 assert.equal(await security.balanceOf(recipient),to+parseEther('3'));assert.equal(await balance(eth),gasFunds-receipt.gasUsed*receipt.gasPrice);
 assert.equal((await one('SELECT wallet_scope FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[target])).wallet_scope,'CUSTODY');
 await pool.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=0 WHERE account_id=$1',[custody]);
});

test('reverted ERC20 transaction refunds principal and unused maximum gas while recording its actual gas cost',async()=>{
 const funds=await balance(tokenAccount),backing=await balance(tokenBacking),gasFunds=await balance(eth),gasBacking=await balance(ethBacking),to=await token.balanceOf(external);
 const review=await core.preparePayment(admin,send(tokenAccount,{amount:'4'}),key());
 await (await token.setFail(true)).wait();
 const result=await confirm(review),settled=await settle(review);assert.equal(settled.status,'FAILED');
 const receipt=await provider.getTransactionReceipt(result.tx_hash);assert.equal(receipt.status,0);
 assert.equal(await balance(tokenAccount),funds);assert.equal(await balance(tokenBacking),backing);assert.equal(await token.balanceOf(external),to);
 const gas=receipt.gasUsed*receipt.gasPrice;assert.ok(gas>0n);assert.equal(await balance(eth),gasFunds-gas);assert.equal(await balance(ethBacking),gasBacking-gas);
 assert.equal((await core.paymentRequest(admin,review.id)).status,'FAILED');
 const count=await journalCount();await core.confirmCryptoAction(admin,{actionId:review.actionId},key());await confirm(review);assert.equal(await journalCount(),count);
 await (await token.setFail(false)).wait();
});

test('an external-address send to another managed wallet credits its exact FUNDING scope once',async()=>{
 const target=await cryptoLedgerAccount(pool,{userId:'2',currency:'USDC',network:'ETHEREUM'}),targetBefore=await balance(target);
 const funds=await balance(tokenAccount),backing=await balance(tokenBacking),to=await token.balanceOf(recipient);
 const review=await core.preparePayment(admin,send(tokenAccount,{cryptoAddress:recipient,amount:'2'}),key());
 assert.equal(review.instruction.receiverUserId,'2');assert.equal(review.instruction.recipientScope,'FUNDING');
 const result=await confirm(review);assert.equal(await balance(target),targetBefore);
 await mine();
 hooks.receipt=r=>({...r,logs:[...r.logs,{...r.logs[0],...token.interface.encodeEventLog('Transfer',[recipient,external,parseUnits('2',6)]),index:r.logs[0].index+1}]});
 await assert.rejects(core.confirmCryptoAction(admin,{actionId:review.actionId},key()),/CRYPTO_RECEIPT/);delete hooks.receipt;
 hooks.receipt=r=>({...r,logs:[...r.logs,{...r.logs[0],...token.interface.encodeEventLog('Transfer',[recipient,external,parseUnits('2',6)]),data:'0x01',index:r.logs[0].index+1}]});
 await assert.rejects(core.confirmCryptoAction(admin,{actionId:review.actionId},key()),/CRYPTO_RECEIPT/);delete hooks.receipt;
 hooks.receipt=r=>({...r,logs:[...r.logs,{...r.logs[0],topics:r.logs[0].topics.slice(0,2),index:r.logs[0].index+1}]});
 await assert.rejects(core.confirmCryptoAction(admin,{actionId:review.actionId},key()),/CRYPTO_RECEIPT/);delete hooks.receipt;
 assert.equal(await balance(target),targetBefore);assert.equal((await action(review.id)).status,'SUBMITTED');
 hooks.receipt=r=>({...r,logs:[...r.logs,{...r.logs[0],topics:['0x'+'ab'.repeat(32)],data:'0x01',index:r.logs[0].index+1}]});
 await core.confirmCryptoAction(admin,{actionId:review.actionId},key());delete hooks.receipt;assert.equal(await balance(target),targetBefore+parseEther('2'));
 assert.equal(await balance(tokenAccount),funds-parseEther('2'));assert.equal(await balance(tokenBacking),backing);
 assert.equal(await token.balanceOf(recipient),to+parseUnits('2',6));
 const recorded=await one('SELECT * FROM avis_core_v2.onchain_transactions WHERE tx_hash=$1',[result.tx_hash]);assert.equal(recorded.tx_type,'WALLET_INTERNAL');
 await core.confirmCryptoAction(admin,{actionId:review.actionId},key());assert.equal(await balance(target),targetBefore+parseEther('2'));
});

test('lost broadcast response survives process restart and retries the identical signed transaction',async()=>{
 const before=await journalCount(),funds=await balance(eth),review=await core.preparePayment(admin,send(eth,{amount:'0.1'}),key()),start=broadcasts.length;
 hooks.broadcast=async(raw,broadcast)=>{await broadcast(raw);throw Error('Isolated lost transport response');};hooks.transaction=async()=>null;
 const result=await confirm(review);delete hooks.broadcast;delete hooks.transaction;
 assert.equal(result.chain_status,'SIGNED');assert.equal((await action(review.id)).status,'SIGNED');assert.equal(await journalCount(),before+1);
 const sibling=await core.preparePayment(admin,send(eth,{amount:'0.1'}),key());
 await assert.rejects(confirm(sibling),/CRYPTO_ACTION_ACTIVE/);
 const restarted=new EvmWalletTransfers(pool,{secretEnv:env,chain});
 await restarted.broadcastCryptoAction(admin,{actionId:review.actionId});assert.equal(broadcasts[start],broadcasts[start+1]);
 assert.equal(Transaction.from(broadcasts[start]).hash,result.tx_hash);
 await settle(review,restarted);const receipt=await provider.getTransactionReceipt(result.tx_hash);
 assert.equal(await balance(eth),funds-parseEther('0.1')-receipt.gasUsed*receipt.gasPrice);assert.equal(await journalCount(),before+2);
 await core.cancelPayment(admin,{requestId:sibling.id},key());
});

test('gas and custody backing are checked independently; missing keys cannot fall back to manual debit',async()=>{
 const before=await journalCount();
 await pool.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=available_balance WHERE account_id=$1',[eth]);
 await assert.rejects(core.preparePayment(admin,send(tokenAccount),key()),/CRYPTO_GAS_BALANCE/);
 await pool.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=0 WHERE account_id=$1',[eth]);
 await pool.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=available_balance WHERE account_id=$1',[tokenBacking]);
 await assert.rejects(core.preparePayment(admin,send(tokenAccount),key()),/CRYPTO_CUSTODY_BALANCE/);
 await pool.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=0 WHERE account_id=$1',[tokenBacking]);
 const encrypted=(await one('SELECT encrypted_key FROM avis_core_v2.crypto_wallet_keys WHERE address_id=$1',[walletId])).encrypted_key;
 await pool.query('DELETE FROM avis_core_v2.crypto_wallet_keys WHERE address_id=$1',[walletId]);
 await assert.rejects(core.preparePayment(admin,send(eth),key()),/CRYPTO_SIGNING_KEY/);
 await pool.query('INSERT INTO avis_core_v2.crypto_wallet_keys(address_id,encrypted_key) VALUES($1,$2)',[walletId,JSON.stringify(encrypted)]);
 assert.equal(await journalCount(),before);
});

test('manual settlement cannot consume the locked backing of an in-flight signed wallet send',async()=>{
 const review=await core.preparePayment(admin,send(eth,{amount:'0.02'}),key());await confirm(review);
 const held=(await action(review.id)).reservations.find(h=>h.kind==='PRINCIPAL');
 assert.equal(parseEther((await one('SELECT locked_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[held.reservedAsset])).locked_balance),parseEther('0.02'));
 const legacy=new TransferMethods(pool,{secretEnv:env}),manual=await legacy.preparePayment(admin,send(eth,{amount:'0.01'}),key());
 await confirm(manual);await core.pickupTransfer(admin,{requestId:manual.id},key());
 await assert.rejects(core.settleManualTransfer(admin,{requestId:manual.id,settlementReference:'Isolated attempt to reuse signed backing',settlementAccountId:held.reservedAsset},key()),/SETTLEMENT_ACCOUNT_REQUIRED/);
 await core.cancelPayment(admin,{requestId:manual.id},key());
 await settle(review);assert.equal(await balance(held.reservedAsset),0n);
 assert.equal(parseEther((await one('SELECT locked_balance::text FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[held.reservedAsset])).locked_balance),0n);
});

test('twelve blocks alone cannot settle; finalized proof is rechecked under locks without caching a pending worker result',async()=>{
 const before=await journalCount(),review=await core.preparePayment(admin,send(eth,{amount:'0.02'}),key());await confirm(review);
 const input={actionId:review.actionId},workerKey=key();
 await mine({finalize:false});
 const depthOnly=await core.confirmCryptoAction(admin,input,workerKey);assert.equal(depthOnly.status,'SUBMITTED');assert.ok(depthOnly.confirmations>=12);
 assert.equal(await journalCount(),before+1);assert.equal((await action(review.id)).receipt,null);
 hooks.finalized=()=>null;
 assert.equal((await core.confirmCryptoAction(admin,input,workerKey)).status,'SUBMITTED');delete hooks.finalized;
 finalizedHeight=await provider.getBlockNumber();
 let checks=0;hooks.finalized=block=>++checks===1?block:null;
 const changed=await core.confirmCryptoAction(admin,input,workerKey);delete hooks.finalized;
 assert.equal(checks,2);assert.equal(changed.status,'SUBMITTED');assert.equal(await journalCount(),before+1);
 assert.equal(Number((await one("SELECT count(*)::int AS n FROM avis_core_v2.operation_requests WHERE operation='CONFIRM_WALLET_TRANSFER' AND request->>'actionId'=$1",[review.actionId])).n),0);
 const settled=await core.confirmCryptoAction(admin,input,workerKey);assert.equal(settled.status,'CONFIRMED');
 assert.equal(await journalCount(),before+2);await core.confirmCryptoAction(admin,input,workerKey);assert.equal(await journalCount(),before+2);
 const saved=await action(review.id);assert.equal(saved.receipt.finality,'FINALIZED');assert.equal(saved.receipt.finalizedBlockNumber,finalizedHeight);
});

test('existing manual requests and FUNDING internal transfers retain their original routes',async()=>{
 const legacy=new TransferMethods(pool,{secretEnv:env}),input=send(eth,{amount:'0.01'}),review=await legacy.preparePayment(admin,input,key());
 assert.equal(review.mode,'MANUAL');const result=await confirm(review);assert.equal(result.delivery_mode,'MANUAL');assert.equal(result.status,'OUTGOING');
 assert.equal(await action(review.id),undefined);assert.equal(result.tx_hash,undefined);
 const internal=await core.preparePayment(admin,send(tokenAccount,{cryptoDestination:'INTERNAL',receiverUserId:'2',amount:'1'}),key());
 assert.equal(internal.mode,'INTERNAL');assert.equal((await confirm(internal)).status,'COMPLETED');assert.equal(await action(internal.id),undefined);
});

test('contract-action submission cannot bypass the payment review and cancelling a wallet review closes both records',async()=>{
 const review=await core.preparePayment(admin,send(eth,{amount:'0.01'}),key()),row=await action(review.id);
 await assert.rejects(core.submitCryptoAction(admin,{actionId:review.actionId,reviewHash:row.review_hash},key()),/CRYPTO_ACTION_REQUIRED/);
 await core.cancelCryptoReview(admin,{actionId:review.actionId},key());
 assert.equal((await action(review.id)).status,'EXPIRED');assert.equal((await core.paymentRequest(admin,review.id)).status,'CANCELLED');
});

test('PostgreSQL concurrent confirmations reserve once and serialize different sends from the same signer',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const before=await journalCount(),review=await core.preparePayment(admin,send(eth,{amount:'0.01'}),key());
 const results=await Promise.all([confirm(review),confirm(review)]);
 assert.equal(results[0].tx_hash,results[1].tx_hash);assert.equal(await journalCount(),before+1);
 await settle(review);
 const first=await core.preparePayment(admin,send(eth,{amount:'0.01'}),key()),second=await core.preparePayment(admin,send(eth,{amount:'0.01'}),key());
 const races=await Promise.allSettled([confirm(first),confirm(second)]);
 assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
 assert.match(races.find(r=>r.status==='rejected').reason.message,/CRYPTO_ACTION_ACTIVE/);
 const winner=races[0].status==='fulfilled'?first:second,loser=winner===first?second:first;
 await settle(winner);await core.cancelPayment(admin,{requestId:loser.id},key());
});

test('PostgreSQL approval updates cannot pass the metadata lock between wallet validation and signing',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const review=await core.preparePayment(admin,send(eth,{amount:'0.01'}),key());let observed=false;
 hooks.nonce=async next=>{
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   await assert.rejects(client.query("SELECT asset_id FROM avis_core_v2.crypto_asset_networks WHERE asset_id='ethereum' AND network='ETHEREUM' FOR UPDATE NOWAIT"),error=>error.code==='55P03');
   observed=true;
  }finally{await client.query('ROLLBACK');client.release();}
  return next();
 };
 try{await confirm(review);}finally{delete hooks.nonce;}
 assert.ok(observed);await settle(review);
});
