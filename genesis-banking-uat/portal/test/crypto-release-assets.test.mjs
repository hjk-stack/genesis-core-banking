import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const source = relative => readFile(new URL(relative, import.meta.url), 'utf8');

test('operational Crypto Suite excludes the removed duplicate-wallet restoration strip', async () => {
 const [controller, css] = await Promise.all([
  source('../public/crypto-workspace.mjs'), source('../public/crypto.css')
 ]);
 for (const marker of ['data-archived-wallets', 'data-restore-wallet', 'Removed wallet cards']) {
  assert.equal(controller.includes(marker), false, marker + ' must not reappear in the operational interface');
 }
 assert.equal(css.includes('.crypto-wallet-archive'), false);
 assert.ok(controller.includes('data-archive-wallet'), 'retain the requested remove button on a selected wallet');
 assert.ok(controller.includes("api('crypto/activate'"), 'currency activation remains connected');
 assert.ok(controller.includes('holdingAt(group,network)'), 'Receive resolves the booked account used by the card');
});

test('the deployed robot asset is exactly the owner-approved image and has a first-party route', async () => {
 const image = await readFile(new URL('../public/crypto-icons/robot-approved.jpg', import.meta.url));
 assert.equal(createHash('sha256').update(image).digest('hex'),
  '085f7dee99acb6ee9b15f34f42642bc53f269b5aad03a8b09d854cf2af0b9fa1');
 const [server, panel] = await Promise.all([source('../server.mjs'), source('../public/trading-panel.mjs')]);
 assert.ok(server.includes("'/crypto-icons/robot-approved.jpg'"));
 assert.ok(server.includes("'/approved-robot.mjs'"));
 assert.ok(panel.includes("from './approved-robot.mjs'"));
 assert.ok(panel.includes('onSnapshot:data=>approved.update(data)'), 'presentation receives authenticated runtime observations');
});
