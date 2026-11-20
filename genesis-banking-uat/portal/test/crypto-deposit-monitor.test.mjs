import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Interface,zeroPadValue} from 'ethers';
import {scanFinalizedEthereumDeposits} from '../src/crypto-deposit-monitor.mjs';

const transferTopic=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']).getEvent('Transfer').topicHash;
const receiver='0x1111111111111111111111111111111111111111';
const token='0x2222222222222222222222222222222222222222';
const tokenHash='0x'+'a'.repeat(64),nativeHash='0x'+'b'.repeat(64);
const account='a1b2c3d4-0000-4000-8000-000000000001';

function fixture({failOnce=false}={}){
 let nextBlock=null,locked=false,failed=false;
 const booked=new Set(),calls=[],cursorWrites=[];
 const wallets=[{account_id:account,address_id:'7',public_address:receiver,contract_address:token,currency_code:'USDT'},
  {account_id:'a1b2c3d4-0000-4000-8000-000000000002',address_id:'7',public_address:receiver,contract_address:null,currency_code:'ETH'}];
 const client={
  async query(sql,args=[]){
   if(sql.includes('pg_try_advisory_lock')){locked=true;return {rows:[{locked:true}]};}
   if(sql.includes('pg_advisory_unlock')){locked=false;return {rows:[]};}
   if(sql.includes('INSERT INTO avis_core_v2.crypto_deposit_scan_cursor')){nextBlock??=args[1];return {rows:[]};}
   if(sql.includes('SELECT next_block'))return {rows:[{next_block:nextBlock}]};
   if(sql.includes('FROM avis_core_v2.ledger_accounts'))return {rows:wallets};
   if(sql.includes('UPDATE avis_core_v2.crypto_deposit_scan_cursor')){nextBlock=args[1];cursorWrites.push(nextBlock);return {rows:[]};}
   throw Error('Unexpected query: '+sql);
  },
  release(){assert.equal(locked,false);}
 };
 const provider={
  async getBlock(n){
   if(n==='finalized')return {number:25};
   return {number:n,transactions:n===24?[nativeHash]:[],getPrefetchedTransaction(){
    return {to:receiver,value:2n};
   }};
  },
  async getLogs({fromBlock,topics}){
   assert.equal(topics[0],transferTopic);
   return fromBlock===24?[{address:token,topics:[transferTopic,zeroPadValue('0x'+'3'.repeat(40),32),zeroPadValue(receiver,32)],transactionHash:tokenHash,removed:false}]:[];
  },
  destroy(){}
 };
 const core={
  pool:{connect:async()=>client},
  chain:{check:async()=>({}),provider:()=>provider},
  async reconcileCryptoDeposit(actor,input,key){
   assert.equal(actor.admin,true);assert.match(key,/^auto-deposit:/);
   calls.push({...input});
   if(failOnce&&!failed){failed=true;throw Error('CRYPTO_CONNECTOR');}
   const id=input.accountId+':'+input.txHash,alreadyBooked=booked.has(id);
   booked.add(id);return {status:'CONFIRMED',alreadyBooked};
  }
 };
 return {core,calls,cursorWrites,getCursor:()=>nextBlock,booked};
}

test('automatic receipts credit the existing asset accounts and advance cursor after successful finality',async()=>{
 const f=fixture();
 const result=await scanFinalizedEthereumDeposits(f.core,{lookback:1,maxBlocks:4});
 assert.equal(result.booked,2);
 assert.equal(result.blocks,2);
 assert.equal(result.candidates,2);
 assert.equal(f.getCursor(),26);
 assert.deepEqual(f.calls.map(c=>c.txHash).sort(),[tokenHash,nativeHash].sort());
 assert.equal(f.booked.size,2);
 const retry=await scanFinalizedEthereumDeposits(f.core,{lookback:1,maxBlocks:4});
 assert.equal(retry.booked,0);
 assert.equal(retry.candidates,0);
});

test('a connector failure leaves the block pending and a retry does not create duplicate credits',async()=>{
 const f=fixture({failOnce:true});
 await assert.rejects(scanFinalizedEthereumDeposits(f.core,{lookback:1,maxBlocks:4}),/CRYPTO_CONNECTOR/);
 assert.equal(f.getCursor(),24);
 const retry=await scanFinalizedEthereumDeposits(f.core,{lookback:1,maxBlocks:4});
 assert.equal(retry.booked,2);
 assert.equal(f.booked.size,2);
 assert.equal(f.getCursor(),26);
});
