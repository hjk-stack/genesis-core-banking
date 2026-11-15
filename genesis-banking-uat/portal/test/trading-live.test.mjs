import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {TradingLiveCore} from '../src/trading-live.mjs';
import {migrate} from '../src/migrate.mjs';

const admin = {id: 'live-view-regression', admin: true};
const time = Date.parse('2026-11-15T12:00:00Z');
let pool, database, core, binanceId, avisId, foreignId, securityId, account, marketReads = [], chainReads = 0;
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname, '/avispay_ci');
    pool = new pg.Pool({connectionString: process.env.TEST_DATABASE_URL});
    await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
  } else {
    database = new PGlite();
    pool = {query: (...args) => database.query(...args), connect: async () => ({
      query: (...args) => database.query(...args), exec: sql => database.exec(sql), release() {},
    })};
  }
  const client = await pool.connect(); try { await migrate(client); } finally { client.release(); }
  core = new TradingLiveCore(pool, {secretEnv: {}, liveNow: () => time,
    tradingMarketFeed: {snapshot(robot) { marketReads.push({...robot}); return {provider: 'CoinAPI', symbolId: 'BINANCE_SPOT_BTC_USDT',
      baseAsset: robot.base_asset, quoteAsset: robot.quote_asset, quote: {bid: '110', ask: '111', bidSize: '2', askSize: '3',
        exchangeTime: new Date(time - 100).toISOString(), receivedAt: new Date(time).toISOString(), stale: false},
      trades: [], connection: {state: 'OPEN'}, usedByStrategy: false}; }},
    chain: {async check() { chainReads++; throw Error('secret RPC details must not be returned'); }}});
  account = (await pool.query("SELECT account_id FROM avis_core_v2.ledger_accounts WHERE user_id=1 AND currency_code='EUR' AND account_category='LIABILITY' LIMIT 1")).rows[0].account_id;
});
after(async () => { if (database) await database.close(); else await pool.end(); });

async function snapshotFinances() {
  return {
    accounts: (await pool.query('SELECT account_id,available_balance,locked_balance FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows,
    journals: (await pool.query('SELECT journal_id FROM avis_core_v2.ledger_journals ORDER BY journal_id')).rows,
    robots: (await pool.query('SELECT * FROM avis_core_v2.trading_robots ORDER BY robot_id')).rows,
    orders: (await pool.query('SELECT * FROM avis_core_v2.trading_robot_orders ORDER BY id')).rows,
    book: (await pool.query('SELECT * FROM avis_core_v2.securities_orders ORDER BY order_id')).rows,
  };
}
async function insertRobot({venue = 'BINANCE', symbol = 'BTCUSDT', owner = 1, security = null} = {}) {
  const id = randomUUID();
  await pool.query(`INSERT INTO avis_core_v2.trading_robots
    (robot_id,name,user_id,venue,symbol,index_id,security_id,account_id,key_ref,max_notional,daily_notional,max_loss,
     trailing_bps,quantity_step,price_tick,base_asset,quote_asset)
    VALUES($1,'Read-only live profile',$2,$3,$4,'BTC',$5,$6,'PRIVATE_REFERENCE',1000,2000,100,50,0.001,0.01,$7,$8)`,
  [id, owner, venue, symbol, security, account, venue === 'AVIS' ? symbol : 'BTC', venue === 'AVIS' ? 'EUR' : 'USDT']);
  return id;
}
test('only actual admin can read live market, fill audit or security backing', async () => {
  const before = marketReads.length;
  for (const actor of [null, {id: 'customer', customerUserId: '2'}, {...admin, customerUserId: '2'}, {...admin, indexService: true}]) {
    await assert.rejects(core.tradingLiveSnapshot(actor), e => e.code === 'FORBIDDEN');
    await assert.rejects(core.tradingLiveLiquidity(actor, {robotId: randomUUID()}), e => e.code === 'FORBIDDEN');
  }
  assert.equal(marketReads.length, before); assert.equal(chainReads, 0);
});

test('empty installation reads an identified actual reference market without creating a profile, position or order', async () => {
  const before = await snapshotFinances();
  const result = await core.tradingLiveSnapshot(admin);
  assert.equal(result.schemaVersion, 1); assert.deepEqual(result.profiles, []);
  assert.equal(result.selectedRobotId, null); assert.equal(result.market.reference, true);
  assert.equal(result.market.symbol, 'BTCUSDT'); assert.equal(result.audit, null); assert.equal(result.liquidity, null);
  assert.equal(marketReads.at(-1).venue, 'BINANCE'); assert.equal(result.market.usedByStrategy, false);
  assert.deepEqual(await snapshotFinances(), before);
});

test('disabled institution profiles expose their exact market and recorded fills without enabling entries or exposing secrets', async () => {
  binanceId = await insertRobot(); foreignId = await insertRobot({owner: 2});
  const orderId = randomUUID();
  await pool.query(`INSERT INTO avis_core_v2.trading_robot_orders
    (id,robot_id,signal_id,client_order_id,side,quantity,price,notional,status,instruction,response)
    VALUES($1,$2,$3,$4,'BUY',1,100,100,'SETTLED',$5,$6)`, [orderId, binanceId, '1'.repeat(64), 'AVIS' + orderId.replaceAll('-', ''),
    JSON.stringify({privateNote: 'do-not-return'}), JSON.stringify({symbol: 'BTCUSDT', side: 'BUY', clientOrderId: 'AVIS' + orderId.replaceAll('-', ''),
      executedQty: '1', cummulativeQuoteQty: '100', transactTime: time - 1000,
      fills: [{tradeId: 91, qty: '1', price: '100', commission: '0.1', commissionAsset: 'USDT'}]})]);
  await pool.query('UPDATE avis_core_v2.trading_robots SET position_quantity=1,cost_basis=100.1 WHERE robot_id=$1', [binanceId]);
  const before = await snapshotFinances();
  const result = await core.tradingLiveSnapshot(admin, {robotId: binanceId});
  assert.equal(result.profiles.length, 1); assert.equal(result.profiles[0].enabled, false); assert.equal(result.profiles[0].testReviewed, false);
  assert.equal(result.market.reference, false); assert.equal(marketReads.at(-1).robot_id, binanceId);
  assert.equal(result.audit.fills[0].id, orderId + ':91'); assert.equal(result.audit.totals.baseVolume, '1');
  assert.equal(result.audit.totals.unrealisedPnl, '9.9');
  assert.equal(JSON.stringify(result).includes('PRIVATE_REFERENCE'), false); assert.equal(JSON.stringify(result).includes('do-not-return'), false);
  await assert.rejects(core.tradingLiveSnapshot(admin, {robotId: foreignId}), e => e.code === 'TRADING_LIVE_PROFILE');
  await assert.rejects(core.tradingLiveSnapshot(admin, {robotId: binanceId, userId: 2}), e => e.code === 'TRADING_LIVE_PROFILE');
  assert.deepEqual(await snapshotFinances(), before); assert.equal(chainReads, 0);
});

test('AVIS market uses exact security counterpart lots, full percentage consideration and separately linked REAL cards', async () => {
  securityId = randomUUID();
  await pool.query(`INSERT INTO avis_core_v2.portfolio_securities
    (security_id,name,short_name,currency_code,isin,denomination,quote_basis,kind,source,created_by)
    VALUES($1,'Live audit bond','AUDIT','EUR','CH0000000001',1000,'PERCENT','bond','MANUAL',$2)`, [securityId, admin.id]);
  avisId = await insertRobot({venue: 'AVIS', symbol: 'AUDIT', security: securityId});
  await pool.query(`INSERT INTO avis_core_v2.portfolio_positions(user_id,security_id,quantity,reserved_quantity,issuing_price,market_price)
    VALUES(2,$1,20,5,90,99)`, [securityId]);
  const orders = [
    {side: 'BUY', owner: 1, quantity: '10', price: '150', total: '15000'}, // Own orders cannot supply executable counterpart depth.
    {side: 'BUY', owner: 2, quantity: '2', price: '98', total: '1960'},
    {side: 'SELL', owner: 2, quantity: '3', price: '99', total: '2970'},
    {side: 'SELL', owner: 2, quantity: '2', price: '99', total: '1980'},
  ];
  for (const order of orders) await pool.query(`INSERT INTO avis_core_v2.securities_orders
    (user_id,security_id,side,status,instruction,review_hash,quantity,price,total,cash_account_id,source_account_id,created_by,submitted_at)
    VALUES($1,$2,$3,'OPEN','{}',$4,$5,$6,$7,$8,$8,$9,now())`,
  [order.owner, securityId, order.side, '0'.repeat(64), order.quantity, order.price, order.total, account, admin.id]);
  const hold = (await pool.query(`INSERT INTO avis_core_v2.ledger_accounts(owner_type,sub_account_code,currency_code,account_category,available_balance)
    VALUES('MARKETPLACE_ESCROW','live-audit-buy','EUR','LIABILITY',1960) RETURNING account_id`)).rows[0].account_id;
  await pool.query("UPDATE avis_core_v2.securities_orders SET cash_hold_id=$1 WHERE user_id=2 AND security_id=$2 AND side='BUY'", [hold, securityId]);
  await pool.query(`UPDATE avis_core_v2.crypto_security_cards SET mode='REAL',security_id=$1,user_id=1,network='ETHEREUM',
    token_quantity=2,source_quantity=2 WHERE sort_order=1`, [securityId]);
  await pool.query(`UPDATE avis_core_v2.crypto_security_cards SET mode='REAL',security_id=$1,user_id=2 WHERE sort_order=2`, [securityId]);
  const before = await snapshotFinances(), reads = marketReads.length;
  const result = await core.tradingLiveSnapshot(admin, {robotId: avisId});
  assert.equal(result.market.provider, 'AVIS'); assert.equal(result.market.symbolId, 'AVIS:' + securityId);
  assert.equal(result.market.quote.bid, '98'); assert.equal(result.market.quote.ask, '99');
  assert.equal(result.market.quote.bidSize, '2'); assert.equal(result.market.quote.askSize, '5');
  assert.equal(result.liquidity.totalOrders, 3); assert.equal(result.liquidity.wholeLotsOnly, true);
  assert.deepEqual(result.liquidity.asks, [{price: '99', quantity: '5', quoteValue: '4950', orders: 2}]);
  assert.equal(result.liquidity.lots.filter(lot => lot.side === 'SELL').length, 2);
  assert.equal(result.liquidity.securityTokens.length, 1);
  assert.equal(result.liquidity.securityTokens[0].name, 'AVISPay PLC');
  assert.equal(marketReads.length, reads); assert.equal(chainReads, 0);
  assert.deepEqual(await snapshotFinances(), before);
});

test('unfunded shared BUY holds and overcommitted aggregate SELL reservations remain in audit but never quote executable depth', async () => {
  await pool.query('UPDATE avis_core_v2.portfolio_positions SET reserved_quantity=3 WHERE user_id=2 AND security_id=$1', [securityId]);
  const original = (await pool.query("SELECT * FROM avis_core_v2.securities_orders WHERE user_id=2 AND security_id=$1 AND side='BUY'", [securityId])).rows[0];
  await pool.query(`INSERT INTO avis_core_v2.securities_orders
    (user_id,security_id,side,status,instruction,review_hash,quantity,price,total,cash_account_id,source_account_id,cash_hold_id,created_by,submitted_at)
    VALUES(2,$1,'BUY','OPEN','{}',$2,2,98,1960,$3,$3,$4,$5,now())`, [securityId, '0'.repeat(64), account, original.cash_hold_id, admin.id]);
  const view = await core.tradingLiveSnapshot(admin, {robotId: avisId});
  assert.equal(view.market.quote, null); assert.deepEqual(view.liquidity.bids, []); assert.deepEqual(view.liquidity.asks, []);
  assert.equal(view.liquidity.lots.length, 4);
  assert.ok(view.liquidity.lots.filter(lot => lot.side === 'BUY').every(lot => lot.reservationCode === 'CASH_HOLD_SHARED'));
  assert.ok(view.liquidity.lots.filter(lot => lot.side === 'SELL').every(lot => lot.reservationCode === 'SECURITY_RESERVE_SHORTFALL'));
  assert.ok(view.liquidity.lots.every(lot => !lot.reservationConsistent));
});

test('reservation obligations beyond the 500-lot display cap still exclude overcommitted depth', async () => {
  await pool.query("UPDATE avis_core_v2.securities_orders SET status='CANCELLED' WHERE security_id=$1", [securityId]);
  await pool.query('UPDATE avis_core_v2.portfolio_positions SET quantity=1000,reserved_quantity=500 WHERE user_id=2 AND security_id=$1', [securityId]);
  await pool.query(`INSERT INTO avis_core_v2.securities_orders
    (user_id,security_id,side,status,instruction,review_hash,quantity,price,total,cash_account_id,source_account_id,created_by,submitted_at)
    SELECT 2,$1,'SELL','OPEN','{}',$2,1,99,990,$3,$3,$4,now() FROM generate_series(1,501)`,
  [securityId, '0'.repeat(64), account, admin.id]);
  const view = await core.tradingLiveSnapshot(admin, {robotId: avisId});
  assert.equal(view.liquidity.complete, false); assert.equal(view.liquidity.totalOrders, 501);
  assert.equal(view.liquidity.lots.length, 500); assert.deepEqual(view.liquidity.asks, []);
  assert.ok(view.liquidity.lots.every(lot => lot.reservationCode === 'SECURITY_RESERVE_SHORTFALL'));
});

test('security reads require exact card owner/network linkage, stay separate from polls and cache sanitized failures', async () => {
  const wallet = (await pool.query(`INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address)
    VALUES(1,'ETHEREUM',$1) RETURNING address_id`, ['0x' + '3'.repeat(40)])).rows[0].address_id;
  await pool.query(`UPDATE avis_core_v2.crypto_security_cards SET wallet_address_id=$1,contract_address=$2,hub_address=$3
    WHERE sort_order=1`, [wallet, '0x' + '1'.repeat(40), '0x' + '2'.repeat(40)]);
  const before = await snapshotFinances();
  const first = await core.tradingLiveLiquidity(admin, {robotId: avisId});
  const repeat = await core.tradingLiveLiquidity(admin, {robotId: avisId});
  assert.deepEqual(repeat, first); assert.equal(chainReads, 1);
  assert.equal(first.cards.length, 1); assert.equal(first.cards[0].chain, null);
  assert.equal(first.cards[0].errorCode, 'TRADING_LIQUIDITY_READ');
  assert.equal(JSON.stringify(first).includes('secret RPC'), false);
  await core.tradingLiveSnapshot(admin, {robotId: avisId}); assert.equal(chainReads, 1);
  await assert.rejects(core.tradingLiveLiquidity(admin, {robotId: foreignId}), e => e.code === 'TRADING_LIVE_PROFILE');
  assert.deepEqual(await snapshotFinances(), before);
});
