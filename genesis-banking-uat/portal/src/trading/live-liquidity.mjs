import {Interface, formatUnits, getAddress} from 'ethers';
import {contractArtifact} from '../crypto-chain-actions.mjs';
import {networkInfo} from '../crypto/networks.mjs';

const erc20 = new Interface([
  'function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)', 'function totalSupply() view returns(uint256)',
]);
const validHash = value => /^0x[a-f0-9]{64}$/i.test(value || '');
const validBlock = block => block && /^0x[0-9a-f]+$/i.test(block.number || '') && validHash(block.hash) && /^0x[0-9a-f]+$/i.test(block.timestamp || '');

/** Read proof for an existing exact card/wallet/contract binding. Never signs or sends a transaction. */
export async function readSecurityLiquidity(chain, card, now = Date.now) {
  if (networkInfo(card.network).kind !== 'EVM') throw Error('TRADING_LIQUIDITY_NETWORK');
  const token = getAddress(card.contract_address), hub = getAddress(card.hub_address), operator = getAddress(card.public_address);
  const tokenInterface = new Interface((await contractArtifact('AVISGreenRollingSecurityToken')).abi);
  const hubInterface = new Interface((await contractArtifact('AVISOmniChainMasterHub')).abi);
  await chain.check(card.network);
  const block = await chain.request(card.network, 'eth_getBlockByNumber', ['finalized', false]);
  if (!validBlock(block)) throw Error('TRADING_LIQUIDITY_FINALITY');
  const tag = block.number;
  const call = async (address, iface, method, args = []) => {
    const result = await chain.request(card.network, 'eth_call', [{to: address, data: iface.encodeFunctionData(method, args)}, tag]);
    return iface.decodeFunctionResult(method, result);
  };
  const [tokenCode, hubCode, registry, dossier, supply, cap, bridged, locked, committed, power, available, ag, agi, treasury] = await Promise.all([
    chain.request(card.network, 'eth_getCode', [token, tag]), chain.request(card.network, 'eth_getCode', [hub, tag]),
    call(hub, hubInterface, 'securityByIsin', [card.dossier.isin]), call(token, tokenInterface, 'dossier'),
    call(token, erc20, 'totalSupply'), call(hub, hubInterface, 'custodyCap', [token]),
    call(hub, hubInterface, 'bridgedOutSupply', [token]), call(token, tokenInterface, 'lockedMarginCollateral', [operator]),
    call(token, tokenInterface, 'committedSecurityAmount', [operator]), call(token, tokenInterface, 'committedMarginPower', [operator]),
    call(token, tokenInterface, 'getAvailableTradingPower', [operator]), call(token, tokenInterface, 'agStablecoin'),
    call(token, tokenInterface, 'agiToken'), call(token, tokenInterface, 'treasuryCashPool'),
  ]);
  if (!/^0x[0-9a-f]+$/i.test(tokenCode || '') || tokenCode === '0x' || !/^0x[0-9a-f]+$/i.test(hubCode || '') || hubCode === '0x' ||
      getAddress(registry[0]) !== token || dossier.isin !== card.dossier.isin) throw Error('TRADING_LIQUIDITY_IDENTITY');
  const settlement = await Promise.all([['AG', ag[0]], ['AGi', agi[0]]].map(async ([asset, rawAddress]) => {
    const address = getAddress(rawAddress);
    const [code, decimals, escrow, accumulatedFees, contractBalance, operatorBalance, operatorAllowance] = await Promise.all([
      chain.request(card.network, 'eth_getCode', [address, tag]), call(address, erc20, 'decimals'),
      call(token, tokenInterface, 'settlementEscrow', [address]), call(token, tokenInterface, 'accumulatedCashBenefitByToken', [address]),
      call(address, erc20, 'balanceOf', [token]), call(address, erc20, 'balanceOf', [operator]),
      call(address, erc20, 'allowance', [operator, token]),
    ]);
    const scale = Number(decimals[0]);
    if (!/^0x[0-9a-f]+$/i.test(code || '') || code === '0x' || !Number.isInteger(scale) || scale < 0 || scale > 18) throw Error('TRADING_LIQUIDITY_ASSET');
    return {asset, address, decimals: scale, escrow: formatUnits(escrow[0], scale),
      accumulatedFees: formatUnits(accumulatedFees[0], scale), contractBalance: formatUnits(contractBalance[0], scale),
      operatorBalance: formatUnits(operatorBalance[0], scale), operatorAllowance: formatUnits(operatorAllowance[0], scale),
      escrowCovered: contractBalance[0] >= escrow[0]};
  }));
  const canonical = await chain.request(card.network, 'eth_getBlockByNumber', [tag, false]);
  if (!validBlock(canonical) || canonical.hash.toLowerCase() !== block.hash.toLowerCase()) throw Error('TRADING_LIQUIDITY_FINALITY');
  const observedAt = new Date(now()).toISOString();
  return {observedAt, provider: chain.connection(card.network).provider,
    proof: {finalized: true, blockNumber: Number(BigInt(block.number)), blockHash: block.hash,
      blockTime: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(), canonicalRechecked: true},
    identity: {contractAddress: token, hubAddress: hub, operator, isin: dossier.isin, registryMatches: true},
    security: {totalSupply: formatUnits(supply[0], 18), custodyCap: formatUnits(cap[0], 18),
      bridgedOutSupply: formatUnits(bridged[0], 18), supplyWithinCap: supply[0] + bridged[0] <= cap[0],
      lockedMarginCollateral: formatUnits(locked[0], 18), committedSecurityAmount: formatUnits(committed[0], 18),
      committedMarginPower: formatUnits(power[0], 18), availableTradingPower: formatUnits(available[0], 18),
      capacityCurrency: card.dossier.currency || null, capacityBasis: 'CONFIGURED_COLLATERAL_VALUATION'},
    settlement, treasury: {address: getAddress(treasury[0]), isOperator: getAddress(treasury[0]) === operator},
    liquidityType: 'ROLLING_SETTLEMENT_ESCROW',
  };
}
