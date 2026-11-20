import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import {BrowserProvider,ContractFactory,Contract,parseEther,id,ZeroAddress} from 'ethers';
import {readFileSync} from 'node:fs';
import solc from 'solc';
const artifact=n=>JSON.parse(readFileSync(new URL('../contracts/artifacts/'+n+'.json',import.meta.url)));
const n=parseEther;let engine,provider,admin,other,treasury,ag,agi,hub,token;
async function receipt(p){return (await p).wait();}
before(async()=>{
 engine=ganache.provider({logging:{quiet:true},chain:{hardfork:'shanghai'},wallet:{totalAccounts:5}});provider=new BrowserProvider(engine);provider.pollingInterval=10;
 [admin,other,treasury]=await Promise.all([0,1,2].map(i=>provider.getSigner(i)));
 const mock='pragma solidity ^0.8.20; contract Cash { string public name="Cash"; uint8 public decimals=18; mapping(address=>uint256) public balanceOf; mapping(address=>mapping(address=>uint256)) public allowance; function mint(address a,uint v) external {balanceOf[a]+=v;} function approve(address a,uint v) external returns(bool){allowance[msg.sender][a]=v;return true;} function transfer(address to,uint v) external returns(bool){balanceOf[msg.sender]-=v;balanceOf[to]+=v;return true;} function transferFrom(address a,address to,uint v) external returns(bool){allowance[a][msg.sender]-=v;balanceOf[a]-=v;balanceOf[to]+=v;return true;} }';
 const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'Cash.sol':{content:mock}},settings:{evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}}))).contracts['Cash.sol'].Cash;
 const f=new ContractFactory(out.abi,'0x'+out.evm.bytecode.object,admin);ag=await f.deploy();await ag.waitForDeployment();agi=await f.deploy();await agi.waitForDeployment();
 const a=artifact('AVISOmniChainMasterHub');hub=await new ContractFactory(a.abi,a.bytecode,admin).deploy(ag.target,agi.target,await treasury.getAddress(),await admin.getAddress(),await admin.getAddress());await hub.waitForDeployment();
 const dossier=['DEMO-AVISPAY-PLC','','STOCK','DEMO-CUSTODY',n('1'),1000,10,0,true];
 await receipt(hub.deployRollingSecurityDeterministic('AVISPay PLC example','aAVISP',dossier));token=new Contract(await hub.securityByIsin(dossier[0]),artifact('AVISGreenRollingSecurityToken').abi,admin);
 await receipt(hub.setCustodyCap(token.target,n('10000'),id('custody')));await receipt(hub.mintCustodiedSecurity(token.target,await admin.getAddress(),n('10000'),id('mint')));
 await receipt(ag.mint(await admin.getAddress(),n('20000')));await receipt(agi.mint(await admin.getAddress(),n('20000')));await receipt(ag.approve(token.target,n('20000')));await receipt(agi.approve(token.target,n('20000')));
 await receipt(token.lockSecurityForMargin(n('4000')));
});
after(async()=>{await provider?.destroy();await engine?.disconnect();});
test('source contract compiles under EIP-170 and factory registers the actual token',async()=>{
 for(const name of ['AVISGreenRollingSecurityToken','AVISOmniChainMasterHub'])assert.ok((artifact(name).deployedBytecode.length-2)/2<=24576);
 assert.equal(await token.name(),'AVISPay PLC example');assert.equal(await token.totalSupply(),n('10000'));assert.equal(await token.getAvailableTradingPower(await admin.getAddress()),n('3600'));
 await assert.rejects(hub.mintCustodiedSecurity(token.target,await admin.getAddress(),1n,id('overflow')));
 await assert.rejects(hub.mintCustodiedSecurity(token.target,await admin.getAddress(),1n,id('mint')));
});
test('Stop-and-Hold N+1 settles N, preserves escrow, and final close returns the last held leg',async()=>{
 const own=await admin.getAddress(),treasuryAddress=await treasury.getAddress(),before=await ag.balanceOf(own);
 await receipt(token.executeRollingTradeStep(1,ag.target,n('1000'),n('1000')));assert.equal((await token.channelTrades(1,1)).status,1n);assert.equal(await ag.balanceOf(token.target),n('1000'));
 await receipt(token.executeRollingTradeStep(1,ag.target,n('1000'),n('1000')));assert.equal((await token.channelTrades(1,1)).status,2n);assert.equal((await token.channelTrades(1,2)).status,1n);assert.equal(await ag.balanceOf(token.target),n('1000'));assert.equal(await ag.balanceOf(treasuryAddress),n('1'));
 await receipt(token.closeRollingChannel(1));assert.equal(await ag.balanceOf(token.target),0n);assert.equal(await ag.balanceOf(own),before-n('2'));assert.equal(await ag.balanceOf(treasuryAddress),n('2'));assert.equal(await token.committedMarginPower(own),0n);await assert.rejects(receipt(token.closeRollingChannel(1)),'closing an already closed rolling channel must revert even when a node accepts the transaction before mining');
});
test('parallel channels reserve aggregate margin; settlement currency and operator cannot be changed',async()=>{
 const owner=await admin.getAddress();await receipt(token.executeParallelRollingBatch([10,11],ag.target,[n('1000'),n('1000')],[n('1500'),n('1500')]));assert.equal(await token.getAvailableTradingPower(owner),n('600'));
 await assert.rejects(token.executeRollingTradeStep(12,ag.target,n('1000'),n('1000')));await assert.rejects(token.releaseMarginCollateral(n('2000')));
 await assert.rejects(token.executeRollingTradeStep(10,agi.target,n('1000'),n('1500')));await assert.rejects(token.executeRollingTradeStep(10,ag.target,n('1000'),n('1000')));
 await receipt(token.grantRole(await token.ALGO_BOT_ROLE(),await other.getAddress()));await assert.rejects(token.connect(other).executeRollingTradeStep(10,ag.target,n('1000'),n('1500')));
 const before=await ag.balanceOf(token.target);await assert.rejects(token.executeParallelRollingBatch([10,10],ag.target,[n('1000'),n('1000')],[n('1500'),n('1500')]));assert.equal(await ag.balanceOf(token.target),before);
 await receipt(token.closeRollingChannel(10));await receipt(token.closeRollingChannel(11));assert.equal(await token.settlementEscrow(ag.target),0n);
});
test('AGi settlement is accounted separately, journal ids are deterministic and pausing affects transfers',async()=>{
 await receipt(token.executeRollingTradeStep(20,agi.target,n('1000'),n('1000')));const r=await receipt(token.closeRollingChannel(20));const event=r.logs.map(l=>{try{return token.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='RollingJournal');assert.ok(event.args.journalId);assert.equal(event.args.settlementToken,agi.target);assert.equal(await token.accumulatedCashBenefitByToken(agi.target),n('1'));
 await receipt(token.pause());await assert.rejects(token.transfer(await treasury.getAddress(),1n));await receipt(token.unpause());
 await receipt(token.setFrozen(await admin.getAddress(),true));await assert.rejects(token.transfer(await treasury.getAddress(),1n));await receipt(token.setFrozen(await admin.getAddress(),false));
});
test('bridge keeps backing reserved, rejects unsupported assets and duplicate source transaction under a new journal',async()=>{
 const owner=await admin.getAddress();await receipt(hub.setRemoteChain('TRON',true));await receipt(hub.bridgeToAnyChain(token.target,n('10'),'TRON','T-test',id('out')));assert.equal(await hub.bridgedOutSupply(token.target),n('10'));
 await assert.rejects(hub.setCustodyCap(token.target,n('9999'),id('cap')));await assert.rejects(hub.completeBridgeFromAnyChain(owner,ZeroAddress,1n,'TRON',id('tx0'),id('in0')));
 await receipt(hub.completeBridgeFromAnyChain(owner,token.target,n('10'),'TRON',id('tx1'),id('in1')));assert.equal(await hub.bridgedOutSupply(token.target),0n);
 await receipt(hub.bridgeToAnyChain(token.target,n('10'),'TRON','T-test',id('out2')));await assert.rejects(hub.completeBridgeFromAnyChain(owner,token.target,n('10'),'TRON',id('tx1'),id('in2')));
 await receipt(hub.completeBridgeFromAnyChain(owner,token.target,n('10'),'TRON',id('tx2'),id('in3')));assert.equal(await token.totalSupply(),n('10000'));
});
