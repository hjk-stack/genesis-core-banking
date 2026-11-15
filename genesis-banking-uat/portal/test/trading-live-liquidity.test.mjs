import {test, before} from 'node:test';
import assert from 'node:assert/strict';
import {Interface, parseUnits} from 'ethers';
import {contractArtifact} from '../src/crypto-chain-actions.mjs';
import {readSecurityLiquidity} from '../src/trading/live-liquidity.mjs';

const address = digit => '0x' + digit.repeat(40);
const token = address('1'), hub = address('2'), operator = address('3'), ag = address('4'), agi = address('5');
const card = {network: 'ETHEREUM', contract_address: token, hub_address: hub, public_address: operator,
  dossier: {isin: 'CH0000000001', currency: 'CHF'}};
const at = Date.parse('2026-11-15T12:00:00Z');
let tokenAbi, hubAbi;
before(async () => {
  tokenAbi = new Interface((await contractArtifact('AVISGreenRollingSecurityToken')).abi);
  hubAbi = new Interface((await contractArtifact('AVISOmniChainMasterHub')).abi);
});
const erc20 = new Interface(['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)']);
function chainFixture(options = {}) {
  const calls = [], block = {number: '0x100', hash: '0x' + 'a'.repeat(64), timestamp: '0x' + (BigInt(at / 1000) - 30n).toString(16)};
  return {calls, connection: () => ({provider: 'Fixture RPC'}), check: async network => { assert.equal(network, 'ETHEREUM'); },
    request: async (network, method, params) => {
      calls.push({network, method, params});
      if (method === 'eth_getBlockByNumber') return options.noFinality ? null :
        {...block, hash: options.changedBlock && params[0] !== 'finalized' ? '0x' + 'b'.repeat(64) : block.hash};
      if (method === 'eth_getCode') return options.noCode && params[0] === token ? '0x' : '0x6000';
      assert.equal(method, 'eth_call');
      const target = params[0].to.toLowerCase(), iface = target === token ? tokenAbi : target === hub ? hubAbi : erc20;
      const parsed = iface.parseTransaction({data: params[0].data});
      let result;
      if (target === hub) result = parsed.name === 'securityByIsin' ? [options.badRegistry ? address('9') : token] :
        [parseUnits(parsed.name === 'custodyCap' ? '100' : '2', 18)];
      else if (target === token) {
        const numbers = {totalSupply: '80', lockedMarginCollateral: '12', committedSecurityAmount: '4',
          committedMarginPower: '250', getAvailableTradingPower: '750'};
        if (parsed.name === 'dossier') result = [options.badIsin ? 'CH0000000002' : card.dossier.isin, '', 'SHARE', 'custody-reference', parseUnits('1', 18), 1500, 10, 0, false];
        else if (parsed.name === 'agStablecoin') result = [ag];
        else if (parsed.name === 'agiToken') result = [agi];
        else if (parsed.name === 'treasuryCashPool') result = [operator];
        else if (numbers[parsed.name]) result = [parseUnits(numbers[parsed.name], 18)];
        else {
          const decimals = parsed.args[0].toLowerCase() === ag ? 18 : 6;
          result = [parseUnits(parsed.name === 'settlementEscrow' ? '7' : '0.5', decimals)];
        }
      } else {
        const decimals = target === ag ? 18 : 6;
        result = parsed.name === 'decimals' ? [decimals] :
          [parseUnits(parsed.name === 'allowance' ? '9' : parsed.args[0].toLowerCase() === token ? '8' : '10', decimals)];
      }
      return iface.encodeFunctionResult(parsed.name, result);
    }};
}

test('security proof pins all balances/capacity to one finalized canonical block and separates asset units', async () => {
  const chain = chainFixture();
  const result = await readSecurityLiquidity(chain, card, () => at);
  assert.deepEqual(result.proof, {finalized: true, blockNumber: 256, blockHash: '0x' + 'a'.repeat(64),
    blockTime: new Date(at - 30_000).toISOString(), canonicalRechecked: true});
  for (const call of chain.calls.filter(c => ['eth_call', 'eth_getCode'].includes(c.method))) assert.equal(call.params[1], '0x100');
  assert.ok(chain.calls.every(c => ['eth_call', 'eth_getCode', 'eth_getBlockByNumber'].includes(c.method)));
  assert.equal(result.security.totalSupply, '80.0'); assert.equal(result.security.supplyWithinCap, true);
  assert.equal(result.security.availableTradingPower, '750.0'); assert.equal(result.security.capacityCurrency, 'CHF');
  assert.equal(result.security.capacityBasis, 'CONFIGURED_COLLATERAL_VALUATION');
  assert.deepEqual(result.settlement.map(s => ({asset: s.asset, decimals: s.decimals, escrow: s.escrow, fees: s.accumulatedFees})),
    [{asset: 'AG', decimals: 18, escrow: '7.0', fees: '0.5'}, {asset: 'AGi', decimals: 6, escrow: '7.0', fees: '0.5'}]);
  assert.ok(result.settlement.every(s => s.escrowCovered));
  assert.equal(result.treasury.isOperator, true); assert.equal(result.liquidityType, 'ROLLING_SETTLEMENT_ESCROW');
});

test('finality, canonical hash, deployed code, hub registry and dossier identity must agree', async () => {
  for (const options of [{noFinality: true}, {changedBlock: true}])
    await assert.rejects(readSecurityLiquidity(chainFixture(options), card), /TRADING_LIQUIDITY_FINALITY/);
  for (const options of [{badRegistry: true}, {badIsin: true}, {noCode: true}])
    await assert.rejects(readSecurityLiquidity(chainFixture(options), card), /TRADING_LIQUIDITY_IDENTITY/);
  await assert.rejects(readSecurityLiquidity(chainFixture(), {...card, network: 'SOLANA'}), /TRADING_LIQUIDITY_NETWORK/);
});
