import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auditTradingFills} from '../src/trading/live-audit.mjs';

const robot = {venue: 'BINANCE', symbol: 'BTCUSDT', base_asset: 'BTC', quote_asset: 'USDT',
  user_id: '1', security_id: 'security-one', position_quantity: '0', cost_basis: '0', realized_pnl: '0'};
function order(id, side, quantity, price, commission = '0', asset = 'USDT') {
  return {id, client_order_id: 'client-' + id, side, quantity, status: 'SETTLED',
    created_at: '2026-11-15T12:00:00Z', updated_at: '2026-11-15T12:00:05Z',
    response: {symbol: 'BTCUSDT', side, clientOrderId: 'client-' + id, executedQty: quantity,
      cummulativeQuoteQty: String(Number(quantity) * Number(price)), transactTime: Date.parse('2026-11-15T12:00:02Z'),
      fills: [{tradeId: id, qty: quantity, price, commission, commissionAsset: asset}]}};
}

test('recorded round trip separates traded volume, quote fees, gross and reconciled net profit', () => {
  const orders = [order('buy', 'BUY', '2', '100', '2'), order('sell', 'SELL', '2', '110', '2.2')];
  const audit = auditTradingFills({robot: {...robot, realized_pnl: '15.8'}, orders});
  assert.deepEqual(audit.reconciliation, {positionMatches: true, costBasisMatches: true, realisedPnlMatches: true});
  assert.equal(audit.totals.baseVolume, '4'); assert.equal(audit.totals.quoteVolume, '420');
  assert.equal(audit.totals.netRealisedPnl, '15.8'); assert.equal(audit.totals.grossRealisedPnl, '20');
  assert.equal(audit.totals.netPnlComplete, true);
  assert.deepEqual(audit.totals.fees, [{asset: 'USDT', amount: '4.2'}]);
  assert.equal(audit.fills[0].id, 'sell:sell');
  assert.equal(audit.fills[0].executedAt, '2026-11-15T12:00:02.000Z');
  assert.equal(audit.fills[0].recordedAt, '2026-11-15T12:00:05.000Z');
});

test('partial exits allocate acquisition fees and inventory basis rather than adding all fees to realised profit', () => {
  const orders = [order('buy', 'BUY', '2', '100', '2'), order('sell', 'SELL', '1', '110', '1.1')];
  const audit = auditTradingFills({robot: {...robot, position_quantity: '1', cost_basis: '101', realized_pnl: '7.9'},
    orders, quote: {bid: '120', stale: false}});
  assert.equal(audit.totals.netRealisedPnl, '7.9'); assert.equal(audit.totals.grossRealisedPnl, '10');
  assert.equal(audit.totals.costBasis, '101'); assert.equal(audit.totals.unrealisedPnl, '19');
});

test('base-asset commissions reduce acquired inventory and use their actual fill price for gross profit', () => {
  const orders = [order('buy', 'BUY', '2', '100', '0.01', 'BTC'), order('sell', 'SELL', '1.99', '110')];
  orders[1].response.cummulativeQuoteQty = '218.9';
  const audit = auditTradingFills({robot: {...robot, realized_pnl: '18.9'}, orders});
  assert.equal(audit.totals.netRealisedPnl, '18.9'); assert.equal(audit.totals.grossRealisedPnl, '19.9');
  assert.deepEqual(audit.totals.fees, [{asset: 'BTC', amount: '0.01'}, {asset: 'USDT', amount: '0'}]);
});

test('third-currency fees never disappear into an invented all-in net profit', () => {
  const orders = [order('buy', 'BUY', '2', '100', '0.001', 'BNB'), order('sell', 'SELL', '2', '110', '0.002', 'BNB')];
  const audit = auditTradingFills({robot: {...robot, realized_pnl: '20'}, orders});
  assert.equal(audit.totals.recordedRealisedPnl, '20'); assert.equal(audit.totals.knownFeeAdjustedPnl, '20');
  assert.equal(audit.totals.netRealisedPnl, null); assert.equal(audit.totals.netPnlComplete, false);
  assert.deepEqual(audit.totals.unpricedFeeAssets, ['BNB']);
  assert.deepEqual(audit.totals.fees, [{asset: 'BNB', amount: '0.003'}]);
});

test('incomplete and duplicate fill evidence is visible without fabricated fills or execution timestamps', () => {
  const buy = order('buy', 'BUY', '2', '100', '0.01', 'BTC');
  delete buy.response.transactTime; delete buy.response.fills[0].qty; delete buy.response.fills[0].price;
  const audit = auditTradingFills({robot: {...robot, position_quantity: '1.99', cost_basis: '200'}, orders: [buy]});
  assert.equal(audit.fills.length, 0); assert.equal(audit.orders[0].executedAt, null);
  assert.equal(audit.totals.grossRealisedPnl, null);
  assert.equal(audit.totals.netRealisedPnl, null);
  const duplicate = order('duplicate', 'BUY', '2', '100');
  duplicate.response.fills.push({...duplicate.response.fills[0]});
  const repeated = auditTradingFills({robot, orders: [duplicate]});
  assert.equal(repeated.totals.netRealisedPnl, null); assert.equal(repeated.fills.length, 0);
  assert.equal(repeated.issues[0].code, 'TRADING_AUDIT_DUPLICATE_FILL');
  const noFees = order('no-fees', 'BUY', '2', '100'); noFees.response.fills = [];
  assert.equal(auditTradingFills({robot: {...robot, position_quantity: '2', cost_basis: '200'}, orders: [noFees]}).totals.netRealisedPnl, null);
});

test('wrong response identity, unsubmitted orders and truncated history cannot establish realised performance', () => {
  const wrong = order('wrong', 'BUY', '2', '100'); wrong.response.symbol = 'ETHUSDT';
  const pending = {...order('pending', 'BUY', '2', '100'), status: 'ACKNOWLEDGED'};
  const bad = auditTradingFills({robot, orders: [wrong, pending]});
  assert.equal(bad.totals.baseVolume, '0'); assert.equal(bad.fills.length, 0);
  assert.equal(bad.issues[0].code, 'TRADING_AUDIT_IDENTITY');
  const recent = auditTradingFills({robot, orders: [order('sell', 'SELL', '1', '100')], totalOrders: 2001});
  assert.equal(recent.coverage.scope, 'RECENT_RECORDED_ORDERS'); assert.equal(recent.coverage.complete, false);
  assert.equal(recent.totals.netRealisedPnl, null); assert.equal(recent.reconciliation.positionMatches, null);
});

test('AVIS fills require the exact robot order, owner, security and ledger journal; percentage marks retain denomination', () => {
  const buy = order('buy', 'BUY', '2', '900'); buy.response.executions = [{journalId: 'journal-one'}];
  const avisRobot = {...robot, venue: 'AVIS', quote_basis: 'PERCENT', denomination: '1000',
    position_quantity: '2', cost_basis: '1800'};
  const fill = {robot_order_id: 'buy', order_id: 'book-taker', journal_id: 'journal-one', side: 'BUY', user_id: '1',
    security_id: 'security-one', quantity: '2', price: '90', total: '1800', executed_at: '2026-11-15T12:00:03Z'};
  const audit = auditTradingFills({robot: avisRobot, orders: [buy], avisFills: [fill], quote: {bid: '99', stale: false}});
  assert.equal(audit.fills.length, 1); assert.equal(audit.fills[0].price, '90'); assert.equal(audit.fills[0].quoteValue, '1800');
  assert.equal(audit.fills[0].evidence, 'AVIS_LEDGER'); assert.equal(audit.totals.unrealisedPnl, '180');
  assert.equal(audit.totals.netPnlComplete, true);
  const wrong = auditTradingFills({robot: avisRobot, orders: [buy], avisFills: [{...fill, user_id: '2'}]});
  assert.equal(wrong.fills.length, 0); assert.equal(wrong.totals.netRealisedPnl, null);
});
