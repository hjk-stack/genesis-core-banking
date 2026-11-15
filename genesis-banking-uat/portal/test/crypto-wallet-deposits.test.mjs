import {test,before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import ganache from 'ganache';
import solc from 'solc';
import {JsonRpcProvider,ContractFactory,Wallet,parseEther,parseUnits} from 'ethers';
import {migrate} from '../src/migrate.mjs';
import {EvmWalletDeposits} from '../src/crypto-wallet-deposits.mjs';
import {CustomerAccess} from '../src/customer-access.mjs';
import {cryptoLedgerAccount} from '../src/crypto/rolling-ledger.mjs';
import {encryptKey} from '../src/crypto/networks.mjs';

const admin={id:'deposit-fixture-operator',admin:true};
const customer={id:'deposit-fixture-owner',admin:true,customerUserId:'1'};
const env={AVIS_OFFLINE_SIGNING_KEY:'isolated-deposit-fixture-key-not-used-in-production'};
const key=()=>randomUUID(),hooks={};
let engine,url,provider,chain,pool,db,core,eth,usdc,custody,addressId,otherAddressId,owner,other,sender,external,token,security,senderSigner;
const one=async(sql,args=[]) => (await pool.query(sql,args)).rows[0];
const funds=async accountId=>parseEther((await one('SELECT available_balance::text AS value FROM avis_core_v2.ledger_accounts WHERE account_id=$1',[accountId])).value);
const journals=async()=>Number((await one('SELECT count(*)::int AS n FROM avis_core_v2.ledger_journals')).n);
const claim=async txHash=>one('SELECT * FROM avis_core_v2.crypto_wallet_deposits WHERE tx_hash=$1',[txHash]);
const input=(accountId,txHash,address=addressId)=>({accountId,addressId:String(address),txHash});
const receive=(account,txHash,k=key(),actor=customer,instance=core,address=addressId)=>instance.reconcileCryptoDeposit(actor,input(account,txHash,address),k);
const backing=async currency=>(await one("SELECT account_id FROM avis_core_v2.ledger_accounts WHERE owner_type='HOT_WALLET' AND sub_account_code='CHAIN_CUSTODY' AND currency_code=$1 AND network='ETHEREUM'",[currency]))?.account_id;
async function mine(){for(let i=0;i<12;i++)await provider.send('evm_mine',[]);}
async function native(value='0.001',signer=senderSigner,to=owner){const tx=await signer.sendTransaction({to,value:parseEther(value)});await tx.wait();return tx.hash;}
async function transfer(amount='1.000001',contract=token){const tx=await contract.transfer(owner,parseUnits(amount,contract===token?6:18));await tx.wait();return tx.hash;}
function connection(){
 const p=new JsonRpcProvider(url,1,{staticNetwork:true,cacheTimeout:-1});
 const block=p.getBlock.bind(p),receipt=p.getTransactionReceipt.bind(p),transaction=p.getTransaction.bind(p),code=p.getCode.bind(p);
 p.getTransactionReceipt=async h=>{const r=await receipt(h);return hooks.receipt?hooks.receipt(r):r;};
 p.getTransaction=async h=>{const t=await transaction(h);return hooks.transaction?hooks.transaction(t):t;};
 p.getBlock=async tag=>{
  const b=await block(tag==='finalized'?(hooks.finalizedHeight??'latest'):tag);
  return hooks.block?hooks.block(b,tag):b;
 };
 p.getCode=async(...args)=>hooks.code??code(...args);
 return p;
}
before(async()=>{
 engine=ganache.server({logging:{quiet:true},chain:{chainId:1,hardfork:'shanghai'},wallet:{totalAccounts:4}});
 await engine.listen(0,'127.0.0.1');url='http://127.0.0.1:'+engine.address().port;
 provider=new JsonRpcProvider(url,1,{staticNetwork:true,cacheTimeout:-1});provider.pollingInterval=10;
 const accounts=Object.entries(engine.provider.getInitialAccounts());
 [owner,other,sender,external]=accounts.map(([,a])=>new Wallet(a.secretKey).address);senderSigner=await provider.getSigner(2);
 if(process.env.TEST_DATABASE_URL){
  const target=new URL(process.env.TEST_DATABASE_URL);assert.equal(target.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:target.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
 }else{
  db=new PGlite();let queued=Promise.resolve();
  pool={query:(...args)=>db.query(...args),connect:async()=>{
   const prior=queued;let release;queued=new Promise(resolve=>{release=resolve;});await prior;
   return {query:(...args)=>db.query(...args),exec:sql=>db.exec(sql),release};
  }};
 }
 const client=await pool.connect();try{await migrate(client);}finally{client.release();}
 chain={check:async network=>{assert.equal(network,'ETHEREUM');assert.equal(await provider.send('eth_chainId',[]),'0x1');return {chainId:1};},provider:connection};
 core=new EvmWalletDeposits(pool,{secretEnv:env,chain});
 const source=`pragma solidity ^0.8.20; contract ReceiptToken {
  uint8 public decimals; mapping(address=>uint256) public balanceOf;
  event Transfer(address indexed from,address indexed to,uint256 value); event Marker(uint256 value);
  constructor(uint8 d){decimals=d;}
  function mint(address to,uint256 n) external {balanceOf[to]+=n;emit Transfer(address(0),to,n);}
  function move(address from,address to,uint256 n) internal {balanceOf[from]-=n;balanceOf[to]+=n;emit Transfer(from,to,n);}
  function transfer(address to,uint256 n) external returns(bool){move(msg.sender,to,n);return true;}
  function batch(address to,uint256 a,uint256 b) external {emit Marker(1);move(msg.sender,to,a);emit Marker(2);move(msg.sender,to,b);}
  function feeTransfer(address to,uint256 gross,uint256 fee,address sink) external {move(msg.sender,to,gross);move(to,sink,fee);}
 }`;
 const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'ReceiptToken.sol':{content:source}},settings:{evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
 assert.equal((output.errors||[]).filter(e=>e.severity==='error').length,0);
 const compiled=output.contracts['ReceiptToken.sol'].ReceiptToken;
 const deploy=async decimals=>{const c=await new ContractFactory(compiled.abi,'0x'+compiled.evm.bytecode.object,senderSigner).deploy(decimals);await c.waitForDeployment();return c;};
 token=await deploy(6);security=await deploy(18);
 await (await token.mint(sender,parseUnits('1000000',6))).wait();await (await security.mint(sender,parseEther('1000000'))).wait();
 await pool.query("UPDATE avis_core_v2.crypto_asset_networks SET approved=true,verified_at=now() WHERE asset_id='ethereum' AND network='ETHEREUM'");
 await pool.query("UPDATE avis_core_v2.crypto_asset_networks SET contract_address=$1,decimals=6,approved=true,verified_at=now() WHERE asset_id='usd-coin' AND network='ETHEREUM'",[token.target]);
 await pool.query("INSERT INTO avis_core_v2.crypto_assets(asset_id,currency_code,name,source) VALUES('security:deposit','aAVISP','Deposit fixture security','SECURITY')");
 await pool.query("INSERT INTO avis_core_v2.crypto_asset_networks(asset_id,network,contract_address,decimals,approved,verified_at) VALUES('security:deposit','ETHEREUM',$1,18,true,now())",[security.target]);
 addressId=(await one("INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address) VALUES(1,'ETHEREUM',$1) RETURNING address_id",[owner])).address_id;
 otherAddressId=(await one("INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address) VALUES(2,'ETHEREUM',$1) RETURNING address_id",[other])).address_id;
 await pool.query('INSERT INTO avis_core_v2.crypto_wallet_keys(address_id,encrypted_key) VALUES($1,$2)',[addressId,JSON.stringify(encryptKey({privateKey:accounts[0][1].secretKey},'wallet:1:ETHEREUM',env))]);
 await pool.query("UPDATE avis_core_v2.crypto_security_cards SET mode='REAL',state='BOOKED',user_id=1,network='ETHEREUM',wallet_address_id=$1,contract_address=$2,token_quantity=1000000 WHERE sort_order=1",[addressId,security.target]);
 eth=await cryptoLedgerAccount(pool,{userId:'1',currency:'ETH',network:'ETHEREUM'});
 usdc=await cryptoLedgerAccount(pool,{userId:'1',currency:'USDC',network:'ETHEREUM'});
 custody=await cryptoLedgerAccount(pool,{userId:'1',currency:'aAVISP',network:'ETHEREUM',scope:'CUSTODY'});
});
after(async()=>{await provider?.destroy();await engine?.close();if(db)await db.close();else await pool?.end();});
afterEach(()=>{for(const name of Object.keys(hooks))delete hooks[name];});

test('native deposit waits for twelve confirmations and finality, then books only its exact value once',async()=>{
 const originalChain=await provider.getBalance(owner),txHash=await native('0.123456789012345678'),idempotency=key(),before=await journals();
 assert.equal(await funds(eth),0n);
 const pending=await receive(eth,txHash,idempotency);assert.equal(pending.status,'PENDING');assert.ok(pending.confirmations<12);
 assert.equal(await journals(),before);assert.equal(await claim(txHash),undefined);
 await mine();const receipt=await provider.getTransactionReceipt(txHash);hooks.finalizedHeight=receipt.blockNumber-1;
 const waiting=await receive(eth,txHash,idempotency);assert.equal(waiting.status,'PENDING');assert.ok(waiting.confirmations>=12);assert.equal(await journals(),before);
 delete hooks.finalizedHeight;
 const completed=await receive(eth,txHash,idempotency);assert.equal(completed.status,'CONFIRMED');assert.equal(completed.finalized,true);assert.ok(completed.journalId);
 const value=parseEther('0.123456789012345678');assert.equal(await funds(eth),value);assert.equal(await funds(await backing('ETH')),value);
 assert.equal(await provider.getBalance(owner),originalChain+value);assert.equal(await journals(),before+1);
 const recorded=await claim(txHash);assert.equal(recorded.event_proofs[0].ordinal,null);assert.equal(recorded.event_proofs[0].rawQuantity,value.toString());assert.equal(recorded.block_hash,receipt.blockHash);
 const restarted=new EvmWalletDeposits(pool,{secretEnv:env,chain});
 const repeat=await receive(eth,txHash,key(),admin,restarted);assert.equal(repeat.journalId,completed.journalId);assert.equal(repeat.alreadyBooked,true);
 await receive(eth,txHash,idempotency);assert.equal(await journals(),before+1);assert.equal(await funds(eth),value);
 const lines=(await pool.query('SELECT direction,amount::text FROM avis_core_v2.ledger_entries WHERE journal_id=$1 ORDER BY direction',[completed.journalId])).rows;
 assert.deepEqual(lines.map(l=>l.direction),['CREDIT','DEBIT']);assert.equal(lines[0].amount,lines[1].amount);
});

test('approved ERC20 deposit preserves exact decimals and each transaction-relative log ordinal',async()=>{
 const tx=await token.batch(owner,parseUnits('12.345678',6),parseUnits('0.000001',6));await tx.wait();await mine();
 const before=await journals(),result=await receive(usdc,tx.hash),saved=await claim(tx.hash);
 assert.equal(result.status,'CONFIRMED');assert.equal(parseEther(result.amount),parseEther('12.345679'));
 assert.equal(await funds(usdc),parseEther('12.345679'));assert.equal(await funds(await backing('USDC')),parseEther('12.345679'));
 assert.deepEqual(saved.event_proofs.map(e=>e.ordinal),[1,3]);assert.deepEqual(saved.event_proofs.map(e=>e.rawQuantity),['12345678','1']);
 const rows=(await pool.query('SELECT event_index,asset_contract,amount::text FROM avis_core_v2.onchain_transactions WHERE tx_hash=$1 ORDER BY event_index',[tx.hash])).rows;
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.asset_contract.toLowerCase()===token.target.toLowerCase()));
 await receive(usdc,tx.hash);assert.equal(await journals(),before+1);
});

test('incoming and outgoing ERC20 events in one receipt credit only the exact positive net',async()=>{
 const before=await funds(usdc),chainBefore=await token.balanceOf(owner),backingBefore=await funds(await backing('USDC'));
 const tx=await token.feeTransfer(owner,parseUnits('10',6),parseUnits('0.250001',6),external);await tx.wait();await mine();
 hooks.receipt=r=>({...r,logs:r.logs.map((l,i)=>i===1?{...l,data:'0x'}:l)});
 await assert.rejects(receive(usdc,tx.hash),/CRYPTO_RECEIPT/);delete hooks.receipt;
 assert.equal(await funds(usdc),before);
 const result=await receive(usdc,tx.hash),net=parseEther('9.749999');
 assert.equal(parseEther(result.amount),net);assert.equal(await funds(usdc),before+net);assert.equal(await funds(await backing('USDC')),backingBefore+net);
 assert.equal(await token.balanceOf(owner)-chainBefore,parseUnits('9.749999',6));
 const saved=await claim(tx.hash);assert.deepEqual(saved.event_proofs.map(e=>e.direction),['IN','OUT']);
 const rows=(await pool.query('SELECT tx_type FROM avis_core_v2.onchain_transactions WHERE tx_hash=$1 ORDER BY event_index',[tx.hash])).rows;
 assert.deepEqual(rows.map(r=>r.tx_type),['WALLET_DEPOSIT','WALLET_DEPOSIT_OUTFLOW']);
});

test('ownership, selected address, approval and ledger scope are checked before any credit',async()=>{
 const txHash=await native(),before=await journals();await mine();
 const access=new CustomerAccess(core);
 await assert.rejects(access.invoke({id:'other-customer',customerUserId:'2'},'reconcileCryptoDeposit',input(eth,txHash),key()),/FORBIDDEN/);
 await assert.rejects(receive(eth,txHash,key(),{...customer,customerUserId:'2'}),/FORBIDDEN/);
 await assert.rejects(receive(eth,txHash,key(),customer,core,otherAddressId),/CRYPTO_DEPOSIT_ACCOUNT/);
 await assert.rejects(receive(eth,'0x123'),/CRYPTO_DEPOSIT_HASH/);
 await pool.query("UPDATE avis_core_v2.crypto_asset_networks SET approved=false WHERE asset_id='ethereum' AND network='ETHEREUM'");
 await assert.rejects(receive(eth,txHash),/CRYPTO_APPROVAL_REQUIRED/);
 await pool.query("UPDATE avis_core_v2.crypto_asset_networks SET approved=true WHERE asset_id='ethereum' AND network='ETHEREUM'");
 const wrong=await cryptoLedgerAccount(pool,{userId:'1',currency:'ETH',network:'ETHEREUM',scope:'CUSTODY'});
 await assert.rejects(receive(wrong,txHash),/CRYPTO_DEPOSIT_ACCOUNT/);
 assert.equal(await journals(),before);
});

test('native receipt validation rejects altered chain identity, failed execution and non-ordinary wallet code',async()=>{
 const txHash=await native();await mine();const before=await journals();
 hooks.transaction=t=>({...t,chainId:56n});await assert.rejects(receive(eth,txHash),/CRYPTO_RECEIPT/);delete hooks.transaction;
 hooks.receipt=r=>({...r,logs:r.logs,status:0});await assert.rejects(receive(eth,txHash),/CRYPTO_TX_FAILED/);delete hooks.receipt;
 hooks.receipt=r=>({...r,hash:'0x'+'22'.repeat(32)});await assert.rejects(receive(eth,txHash),/CRYPTO_RECEIPT/);delete hooks.receipt;
 hooks.code='0xef0100'+'11'.repeat(20);await assert.rejects(receive(eth,txHash),/CRYPTO_DEPOSIT_EVENT/);delete hooks.code;
 assert.equal(await journals(),before);assert.equal(await claim(txHash),undefined);
});

test('foreign contracts, duplicate logs, removed logs and altered log identities cannot be credited',async()=>{
 const txHash=await transfer();await mine();const before=await journals();
 const corruptions=[
  r=>({...r,logs:r.logs.map(l=>({...l,address:external}))}),
  r=>({...r,logs:[...r.logs,...r.logs]}),
  r=>({...r,logs:r.logs.map(l=>({...l,removed:true}))}),
  r=>({...r,logs:r.logs.map(l=>({...l,transactionHash:'0x'+'33'.repeat(32)}))}),
  r=>({...r,logs:r.logs.map(l=>({...l,blockHash:'0x'+'44'.repeat(32)}))})
 ];
 for(const corrupt of corruptions){hooks.receipt=corrupt;await assert.rejects(receive(usdc,txHash),/CRYPTO_(RECEIPT|DEPOSIT_EVENT)/);}
 delete hooks.receipt;assert.equal(await journals(),before);assert.equal(await claim(txHash),undefined);
});

test('registered security receipts credit CUSTODY and cannot be claimed as FUNDING or as an unbooked mint',async()=>{
 const txHash=await transfer('2.000000000000000001',security);await mine();
 const result=await receive(custody,txHash);assert.equal(result.status,'CONFIRMED');assert.equal(await funds(custody),parseEther('2.000000000000000001'));
 assert.equal((await claim(txHash)).wallet_scope,'CUSTODY');assert.equal(await funds(await backing('aAVISP')),await funds(custody));
 const wrong=await cryptoLedgerAccount(pool,{userId:'1',currency:'aAVISP',network:'ETHEREUM'});await assert.rejects(receive(wrong,txHash),/CRYPTO_DEPOSIT_ACCOUNT/);
 const mint=await security.mint(owner,1n);await mint.wait();await mine();await assert.rejects(receive(custody,mint.hash),/CRYPTO_DEPOSIT_EVENT/);
});

test('untracked managed-wallet senders and net-zero receipts do not create new external backing',async()=>{
 const txHash=await native('0.001',await provider.getSigner(1));await mine();const before=await journals();
 await assert.rejects(receive(eth,txHash),/CRYPTO_DEPOSIT_MANAGED_SOURCE/);
 const zeroNet=await token.feeTransfer(owner,parseUnits('1',6),parseUnits('1',6),external);await zeroNet.wait();await mine();
 await assert.rejects(receive(usdc,zeroNet.hash),/CRYPTO_DEPOSIT_EVENT/);assert.equal(await journals(),before);
});

test('managed internal transfers remain owned by the send outbox before and after recipient settlement',async()=>{
 const target=await cryptoLedgerAccount(pool,{userId:'2',currency:'ETH',network:'ETHEREUM'});
 const review=await core.preparePayment(admin,{method:'CRYPTO',cryptoAccount:eth,cryptoDestination:'EXTERNAL',cryptoAddress:other,receiverName:'Managed receiver',amount:'0.001',reference:'Isolated managed send'},key());
 assert.equal(review.instruction.receiverUserId,'2');
 const sent=await core.confirmPayment(admin,{requestId:review.id,messageHash:review.messageHash},key());
 const actor={id:'recipient',admin:true,customerUserId:'2'},before=await journals();
 const pending=await receive(target,sent.tx_hash,key(),actor,core,otherAddressId);assert.equal(pending.status,'MANAGED');assert.equal(pending.actionId,review.actionId);assert.equal(await funds(target),0n);
 await mine();await core.confirmCryptoAction(admin,{actionId:review.actionId},key());
 assert.equal(await funds(target),parseEther('0.001'));const complete=await receive(target,sent.tx_hash,key(),actor,core,otherAddressId);
 assert.equal(complete.status,'MANAGED');assert.equal(complete.actionStatus,'CONFIRMED');assert.equal(await funds(target),parseEther('0.001'));
 assert.equal(await journals(),before+1);assert.equal(await claim(sent.tx_hash),undefined);
});

test('canonical mismatch before booking waits without posting; parallel retries converge on one stable claim',async()=>{
 const txHash=await native('0.000000000000000001');await mine();const before=await journals(),balance=await funds(eth);
 hooks.block=(b,tag)=>typeof tag==='number'?{...b,hash:'0x'+'55'.repeat(32)}:b;
 assert.equal((await receive(eth,txHash)).status,'PENDING');assert.equal(await journals(),before);delete hooks.block;
 const results=await Promise.all([receive(eth,txHash),receive(eth,txHash,key(),admin)]);
 assert.equal(results[0].journalId,results[1].journalId);assert.equal(await journals(),before+1);assert.equal(await funds(eth),balance+1n);
});

test('two distinct deposits into one account use the canonical ledger lock order',{timeout:15000},async()=>{
 const first=await native('0.003'),second=await native('0.004');await mine();
 const before=await journals(),balance=await funds(eth),original=core.post;
 let arrivals=0,release;const ready=new Promise(resolve=>{release=resolve;});
 // PostgreSQL CI reaches both post_journal calls together. PGlite has one
 // connection, so its transaction wrapper necessarily serializes the calls.
 core.post=async function(...args){
  if(args[3]==='CRYPTO_WALLET_DEPOSIT'&&[first,second].includes(args[4])){
   arrivals++;if(arrivals===2)release();if(process.env.TEST_DATABASE_URL)await ready;
  }
  return original.apply(this,args);
 };
 try{
  const results=await Promise.allSettled([receive(eth,first),receive(eth,second)]);
  assert.equal(arrivals,2);assert.ok(results.every(r=>r.status==='fulfilled'),results.map(r=>r.reason?.message).join(','));
 }finally{core.post=original;}
 assert.equal(await journals(),before+2);assert.equal(await funds(eth),balance+parseEther('0.007'));
});

test('a booked transaction re-mined in a changed block is durably flagged before changed-status validation',async()=>{
 const txHash=await native('0.002');await mine();const settled=await receive(eth,txHash),before=await journals(),balance=await funds(eth);
 hooks.receipt=r=>({...r,blockHash:'0x'+'66'.repeat(32),status:0,logs:[]});
 await assert.rejects(receive(eth,txHash),/CRYPTO_DEPOSIT_REORG/);delete hooks.receipt;
 const saved=await claim(txHash);assert.ok(saved.reorg_detected_at);assert.equal(saved.journal_id,settled.journalId);assert.equal(saved.reorg_evidence.receiptStatus,0);
 await assert.rejects(receive(eth,txHash),/CRYPTO_DEPOSIT_REORG/);assert.equal(await journals(),before);assert.equal(await funds(eth),balance);
});

test('transport failure exposes a fixed connector code without endpoint or credential data',async()=>{
 const txHash=await native();await mine();const before=await journals();
 hooks.receipt=()=>{throw Error('secret-rpc-key-must-not-appear');};
 await assert.rejects(receive(eth,txHash),e=>e.code==='CRYPTO_CONNECTOR'&&!e.message.includes('secret-rpc-key'));
 delete hooks.receipt;assert.equal(await journals(),before);
});
