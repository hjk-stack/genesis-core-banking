import {test} from 'node:test';
import assert from 'node:assert/strict';
import {address as bitcoinAddress} from 'bitcoinjs-lib';
import {newWallet,validAddress} from '../src/crypto/networks.mjs';

test('Bitcoin address validation accepts legacy, script, SegWit and Taproot receiving formats',()=>{
 for(const address of [
  '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
  '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
  newWallet('BITCOIN').address,
  bitcoinAddress.toBech32(Buffer.alloc(32,1),0,'bc'),
  bitcoinAddress.toBech32(Buffer.alloc(32,2),1,'bc'),
 ])assert.equal(validAddress('BITCOIN',address),true,address);
});

test('Bitcoin address validation rejects checksum failures, other networks and non-address text',()=>{
 for(const address of [
  '1BoatSLRHtKNngkdXEeobR76b53LETtpyU',
  bitcoinAddress.toBech32(Buffer.alloc(20,1),0,'tb'),
  bitcoinAddress.toBech32(Buffer.alloc(32,2),1,'bcrt'),
  '0x1234567890123456789012345678901234567890',
  '',
 ])assert.equal(validAddress('BITCOIN',address),false,address);
});
