import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');

test('production server and Chromium banking shell both serve the new allowance module and stylesheet',()=>{
 const server=read('../server.mjs'),fixture=read('../test-browser/crypto-layout.mjs');
 for(const route of ['/wallet-trading-scroller.mjs','/wallet-trading-scroller.css']){
  assert.ok(server.includes("'"+route+"'"),'production static route: '+route);
  assert.ok(fixture.includes("'"+route+"'"),'Chromium static route: '+route);
 }
});
test('accepted allowances mount in the first trading row without removing the market footer',()=>{
 const workspace=read('../public/crypto-workspace.mjs'),approved=read('../public/approved-robot.mjs');
 assert.ok(workspace.includes('mountWalletTradingScroller({api,host:q(\'[data-trading-allowances]\')'));
 assert.ok(workspace.includes('Trade allowance:'));
 assert.ok(!workspace.includes('Frozen for robot:'));
 assert.ok(approved.includes('board.prepend(allowances)'));
 assert.ok(approved.includes('strip.hidden=true'));
 assert.ok(approved.includes('data-ar-ticker'));
});
test('customer selection passes through account ownership checks and the live release verifies exact source files',()=>{
 const access=read('../src/customer-access.mjs'),server=read('../server.mjs'),deploy=read('../../azure/deploy-sovereign.py');
 assert.ok(access.includes("['delegateWalletTrading','selectWalletTrading'].includes(method)"));
 assert.ok(access.includes("'tradingallowances'"));
 assert.ok(server.includes("'crypto/trading/select-wallet':'selectWalletTrading'"));
 assert.ok(deploy.includes("'/wallet-trading-scroller.mjs': 'public/wallet-trading-scroller.mjs'"));
 assert.ok(deploy.includes("'/wallet-trading-scroller.css': 'public/wallet-trading-scroller.css'"));
 assert.ok(deploy.includes('allowance_module.verify_wallet_allowances'));
});
