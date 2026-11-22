import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ipHandlerUrl} from '../public/ip-handler-desk.mjs';

const requestId='12345678-1234-4234-8234-123456789abc';

test('handler URL contains only a validated request ID',()=>{
 const url=new URL(ipHandlerUrl(requestId));
 assert.equal(url.origin,'https://avis.land');
 assert.equal(url.pathname,'/admin/bank/quantum/direct-transfer');
 assert.equal(url.searchParams.get('checkoutRequest'),requestId);
 assert.equal([...url.searchParams.keys()].length,1);
 for(const invalid of ['','../admin','a&route=other','123',null]){
  assert.throws(()=>ipHandlerUrl(invalid),TypeError);
 }
});

test('banking app serves and imports desk, never uses browser popups for IP handler',()=>{
 const app=readFileSync(new URL('../public/app.mjs',import.meta.url),'utf8');
 const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 assert.match(app,/import \{openIpHandlerDesk\} from '\.\/ip-handler-desk\.mjs'/);
 assert.equal((app.match(/openHandler:record=>openIpHandlerDesk\(record\.requestId\)/g)||[]).length,2);
 assert.doesNotMatch(app,/window\.open\(url,'avispay-ip-transfer-/);
 assert.match(server,/\/ip-handler-desk\.mjs/);
});

test('IP handler only opens a desk and does not trigger payment posting',()=>{
 const code=readFileSync(new URL('../public/ip-handler-desk.mjs',import.meta.url),'utf8');
 assert.match(code,/createElement\('iframe'\)/);
 assert.match(code,/data-ip-handler-desk|dataset\.ipHandlerDesk/);
 assert.match(code,/pointermove/);
 assert.match(code,/desk\.remove\(\)/);
 assert.doesNotMatch(code,/fetch\(|postPayment|settlePayment/);
});
