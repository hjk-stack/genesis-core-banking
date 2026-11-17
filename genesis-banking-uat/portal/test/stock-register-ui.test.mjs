import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {stockRegisterTable} from '../public/portfolio.mjs';

const source={booking_id:'source-stock',owner_user_id:'1',asset_class:'SECURITY',asset_code:'AVISPAY-PLC-SHARES',asset_name:'AVISPay PLC shares',quantity:'100000000.000000000000000000',source_reference:'existing-source-stock'};
const row=html=>{const dom=new JSDOM(html);try{return [...dom.window.document.querySelectorAll('tbody tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>td.textContent));}finally{dom.window.close();}};

test('Portfolio exposes original stock units with an explicit metadata action and no invented price',()=>{
 const html=stockRegisterTable([source],[]),cells=row(html)[0];
 assert.match(html,/AVISPay PLC stock register/);assert.equal(cells[1],'100,000,000.00');
 assert.deepEqual(cells.slice(2,5),['—','—','—']);assert.equal(cells[5],source.source_reference);
 assert.match(html,/data-register-treasury="source-stock"/);
});

test('linked stock displays its current units and unit price without adding original opening quantity again',()=>{
 const position={position_id:'position-stock',user_id:'1',name:source.asset_name,quantity:'99999990.000000000000000001',market_price:'2.123456789012345678',currency_code:'EUR',portfolio_value:'212345657.67'};
 const html=stockRegisterTable([{...source,position_id:position.position_id}],[position]),cells=row(html);
 assert.equal(cells.length,1);assert.equal(cells[0][1],'99,999,990.000000000000000001');
 assert.equal(cells[0][2],'2.123456789012345678');assert.equal(cells[0][3],'EUR');
 assert.equal(cells[0][4],'212,345,657.67');assert.match(html,/data-position="position-stock"/);
 assert.doesNotMatch(html,/data-register-treasury=/);
});

test('stock register never borrows another holder price or unrelated Treasury crypto inventory',()=>{
 const html=stockRegisterTable([{...source,position_id:'wrong-owner'},{...source,asset_class:'CRYPTO',asset_code:'AG'}],[{position_id:'wrong-owner',user_id:'2',market_price:'999',quantity:'1'}]);
 const cells=row(html);assert.equal(cells.length,1);assert.equal(cells[0][1],'100,000,000.00');assert.equal(cells[0][2],'—');
 assert.equal(stockRegisterTable([{...source,asset_code:'AG'}],[]),'');
});
