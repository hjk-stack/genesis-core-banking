import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const workspace=readFileSync(new URL('../public/crypto-workspace.mjs',import.meta.url),'utf8');
const trader=readFileSync(new URL('../public/trading-panel.mjs',import.meta.url),'utf8');
const live=readFileSync(new URL('../src/trading-live.mjs',import.meta.url),'utf8');

test('crypto navigation mounts wallets first and the INDEX trading robot before security and market desks',()=>{
 for(const id of ['crypto-wallet-desk','crypto-trading-desk','crypto-security-desk','crypto-market-desk'])
  assert.ok(workspace.includes('id="'+id+'"'),id);
 const positions=['crypto-wallet-desk','crypto-trading-desk','crypto-security-desk','crypto-market-desk']
  .map(id=>workspace.indexOf('id="'+id+'"'));
 assert.deepEqual([...positions].sort((a,b)=>a-b),positions);
 assert.doesNotMatch(workspace,/crypto-suite-navigation|data-crypto-jump/, 'the five redundant header rows are removed');
 assert.match(workspace,/data-trading-panel/);
 assert.match(workspace,/mountTradingPanel\(\{api,host:q\('\[data-trading-panel\]'\)/);
});
test('trading desk reuses the actual robot, INDEX instructions, tests and live fills instead of a decorative panel',()=>{
 for(const marker of ['mountTradingLive','mountRobotInstructions','mountIndexAdvice','mountTradingTesting',
  'crypto/trading/validate-providers','data-toggle','data-new-robot'])
  assert.ok(trader.includes(marker),marker);
});
test('unselected public reference source does not impersonate an active CoinAPI robot market',()=>{
 assert.match(live,/publicReference: true/);
 assert.match(live,/usedByStrategy: false/);
});
