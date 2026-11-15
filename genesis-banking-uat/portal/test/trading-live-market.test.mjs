import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LiveMarketFeed, liveMarketIdentity, marketDecimal} from '../src/trading/live-market.mjs';

const robot = {robot_id: 'profile-one', venue: 'BINANCE', symbol: 'BTCUSDT', base_asset: 'BTC', quote_asset: 'USDT'};
const start = Date.parse('2026-11-15T12:00:00.500Z');
function fixture(t, env = {COINAPI_MARKET_DATA_API_KEY: 'test-market-key'}) {
  let now = start;
  const sockets = [];
  class Socket {
    constructor(url) { this.url = url; this.listeners = new Map(); this.sent = []; sockets.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, value = {}) { this.listeners.get(type)?.(value); }
    message(value) { this.emit('message', {data: JSON.stringify(value)}); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closed = true; this.emit('close'); }
  }
  const feed = new LiveMarketFeed({env, now: () => now, WebSocketClass: Socket});
  t.after(() => feed.close());
  return {feed, sockets, time: value => { now = value; }};
}
const quote = (patch = {}) => ({type: 'quote', symbol_id: 'BINANCE_SPOT_BTC_USDT', sequence: 1,
  time_exchange: '2026-11-15T12:00:00.123456Z', time_coinapi: '2026-11-15T12:00:00.130000Z',
  bid_price: 100, ask_price: 100.01, bid_size: 3, ask_size: 2, ...patch});
const trade = (patch = {}) => ({type: 'trade', symbol_id: 'BINANCE_SPOT_BTC_USDT', sequence: 1,
  time_exchange: '2026-11-15T12:00:00.100000Z', time_coinapi: '2026-11-15T12:00:00.110000Z',
  uuid: 'trade-one', price: 100, size: 0.2, taker_side: 'SELL', ...patch});

test('configured CoinAPI stream binds exact symbol and shares transport between view and strategy', t => {
  const {feed, sockets} = fixture(t);
  const first = feed.snapshot(robot), ticks = [];
  const unsubscribe = feed.subscribe(robot, tick => ticks.push(tick));
  assert.equal(sockets.length, 1);
  assert.equal(first.provider, 'CoinAPI');
  assert.equal(sockets[0].url, 'wss://ws.coinapi.io/v1/');
  sockets[0].emit('open');
  assert.deepEqual(sockets[0].sent[0], {type: 'hello', apikey: 'test-market-key', heartbeat: true,
    subscribe_data_type: ['quote', 'trade'], subscribe_filter_symbol_id: ['BINANCE_SPOT_BTC_USDT$']});
  sockets[0].message(trade()); sockets[0].message(quote());
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].tsMicros, Date.parse('2026-11-15T12:00:00.123Z') * 1000 + 456);
  assert.equal(ticks[0].sellVolume, 0.2);
  const view = feed.snapshot(robot);
  assert.equal(view.usedByStrategy, true);
  assert.equal(view.quote.sourceDelayMs, 377);
  assert.equal(view.quote.exchangeTime, '2026-11-15T12:00:00.123456Z');
  assert.equal(JSON.stringify(view).includes('test-market-key'), false);
  unsubscribe(); assert.equal(feed.snapshot(robot).usedByStrategy, false);
});

test('provider evidence rejects wrong identities, regressing microseconds and unknown executable size', t => {
  const {feed, sockets} = fixture(t), ticks = [];
  feed.subscribe(robot, tick => ticks.push(tick)); sockets[0].emit('open');
  sockets[0].message(quote({symbol_id: 'BINANCE_SPOT_BTC_USDT_PERP'}));
  assert.equal(feed.snapshot(robot).quote, null);
  sockets[0].message(quote({bid_price: '1.000000000000000001', ask_price: '1'}));
  assert.equal(feed.snapshot(robot).quote, null);
  sockets[0].message(quote({bid_size: 0}));
  assert.equal(feed.snapshot(robot).quote.bidSize, null);
  assert.equal(ticks.length, 0);
  sockets[0].message(quote({sequence: 2}));
  sockets[0].message(quote({sequence: 3, time_exchange: '2026-11-15T12:00:00.123400Z', bid_price: 90}));
  assert.equal(ticks.length, 1);
  assert.equal(feed.snapshot(robot).quote.bid, '100');
  sockets[0].message(quote({sequence: 4, time_exchange: '2026-11-15T13:00:00Z'}));
  assert.equal(feed.snapshot(robot).quote.bid, '100');
  assert.equal(feed.snapshot(robot).connection.errorCode, 'TRADING_MARKET_TIMESTAMP');
});

test('only distinct actual recent SELL trades contribute to a new quote; cached source time never refreshes', t => {
  const {feed, sockets, time} = fixture(t), ticks = [];
  feed.subscribe(robot, tick => ticks.push(tick)); sockets[0].emit('open');
  sockets[0].message(trade());
  sockets[0].message(trade({sequence: 2})); // Same stable trade identifier.
  sockets[0].message(trade({sequence: 3, uuid: 'estimated', size: 50, taker_side: 'SELL_ESTIMATED'}));
  sockets[0].message(trade({sequence: 4, uuid: 'old', size: 70, time_exchange: '2026-11-15T11:59:00Z'}));
  sockets[0].message(quote());
  assert.equal(ticks[0].sellVolume, 0.2);
  assert.equal(feed.snapshot(robot).trades.length, 3);
  time(start + 20_000);
  const cached = feed.snapshot(robot);
  assert.equal(cached.quote.stale, true);
  assert.equal(cached.quote.receivedAt, new Date(start).toISOString());
  assert.equal(cached.quote.ageMs, 20_377);
  assert.equal(ticks.length, 1);
});

test('direct Binance fallback accurately distinguishes receipt time from unavailable book exchange time', t => {
  const {feed, sockets} = fixture(t, {COINAPI_EMS_API_KEY: 'not-a-market-data-key', COINAPI_NAAS_API_KEY: 'not-a-market-data-key'}), ticks = [];
  feed.subscribe(robot, tick => ticks.push(tick)); sockets[0].emit('open');
  assert.match(sockets[0].url, /^wss:\/\/stream\.binance\.com:9443\/stream\?streams=btcusdt@bookTicker\/btcusdt@aggTrade$/);
  sockets[0].message({data: {e: 'aggTrade', s: 'BTCUSDT', a: 1, p: '100', q: '0.3', m: true, T: start - 200, E: start - 150}});
  sockets[0].message({data: {s: 'BTCUSDT', u: 2, b: '100', a: '100.01', B: '3', A: '2'}});
  const view = feed.snapshot(robot);
  assert.equal(view.provider, 'Binance'); assert.equal(view.quote.exchangeTime, null);
  assert.equal(view.quote.providerTime, null); assert.equal(view.quote.sourceDelayMs, null);
  assert.equal(view.quote.ageBasis, 'RECEIVED');
  assert.equal(ticks[0].tsMicros, start * 1000); assert.equal(ticks[0].sellVolume, 0.3);
  assert.equal(view.trades[0].exchangeTime, new Date(start - 200).toISOString());
});

test('future SELL observations cannot enter a current quote and remain pending until source and quote time permit', t => {
  const {feed, sockets, time} = fixture(t), ticks = [];
  feed.subscribe(robot, tick => ticks.push(tick)); sockets[0].emit('open');
  sockets[0].message(trade({size: 50, time_exchange: new Date(start + 4000).toISOString(), time_coinapi: new Date(start + 4000).toISOString()}));
  sockets[0].message(quote({time_exchange: new Date(start).toISOString()}));
  assert.equal(ticks[0].sellVolume, 0);
  time(start + 4500);
  sockets[0].message(quote({sequence: 2, time_exchange: new Date(start + 3000).toISOString(), time_coinapi: new Date(start + 4500).toISOString()}));
  assert.equal(ticks[1].sellVolume, 0); // A delayed quote predates the now-valid trade.
  sockets[0].message(quote({sequence: 3, time_exchange: new Date(start + 4500).toISOString(), time_coinapi: new Date(start + 4500).toISOString()}));
  assert.equal(ticks[2].sellVolume, 50);
  sockets[0].message(quote({sequence: 4, time_exchange: new Date(start + 4500).toISOString(), time_coinapi: new Date(start + 4500).toISOString()}));
  assert.equal(ticks[3].sellVolume, 0); // Consumed once.
});

test('SELL evidence expires across a quote gap on both CoinAPI source-time and Binance receipt-time books', t => {
  for (const env of [{COINAPI_MARKET_DATA_API_KEY: 'test-market-key'}, {}]) {
    const {feed, sockets, time} = fixture(t, env), ticks = [], coinapi = !!env.COINAPI_MARKET_DATA_API_KEY;
    feed.subscribe(robot, tick => ticks.push(tick)); sockets[0].emit('open');
    if (coinapi) sockets[0].message(trade({size: 50, time_exchange: new Date(start).toISOString()}));
    else sockets[0].message({data: {e: 'aggTrade', s: 'BTCUSDT', a: 1, p: '100', q: '50', m: true, T: start, E: start}});
    time(start + 10000);
    if (coinapi) sockets[0].message(quote({time_exchange: new Date(start + 10000).toISOString(), time_coinapi: new Date(start + 10000).toISOString()}));
    else sockets[0].message({data: {s: 'BTCUSDT', u: 2, b: '100', a: '100.01', B: '3', A: '2'}});
    assert.equal(ticks.length, 1); assert.equal(ticks[0].sellVolume, 0);
    assert.equal(feed.markets.get('BINANCE_SPOT_BTC_USDT').pendingSells.length, 0);
  }
});

test('pending SELL queue is bounded and never silently truncates fresh pressure into a tradable tick', t => {
  const {feed, sockets} = fixture(t), ticks = [];
  feed.subscribe(robot, tick => ticks.push(tick)); sockets[0].emit('open');
  for (let i = 1; i <= 2001; i++) sockets[0].message(trade({sequence: i, uuid: 'volume-' + i}));
  assert.equal(feed.snapshot(robot).connection.errorCode, 'TRADING_MARKET_VOLUME_LIMIT');
  assert.equal(sockets[0].closed, true);
  assert.equal(feed.markets.get('BINANCE_SPOT_BTC_USDT').pendingSells.length, 0);
  sockets[0].message(quote()); assert.equal(ticks.length, 0);
});

test('subscription ownership, retired sockets, bounded channels and sanitized provider errors are enforced', t => {
  const {feed, sockets, time} = fixture(t), one = [], two = [];
  const offOne = feed.subscribe(robot, tick => one.push(tick));
  const second = {...robot, robot_id: 'profile-two'};
  const offTwo = feed.subscribe(second, tick => two.push(tick));
  assert.equal(sockets.length, 1); sockets[0].emit('open'); sockets[0].message(quote());
  offOne(); assert.equal(feed.snapshot(robot).usedByStrategy, false); assert.equal(feed.snapshot(second).usedByStrategy, true);
  sockets[0].message({type: 'error', message: 'key test-market-key private error'});
  assert.equal(feed.snapshot(robot).connection.errorCode, 'TRADING_MARKET_PROVIDER');
  assert.equal(JSON.stringify(feed.snapshot(robot)).includes('private error'), false);
  time(start + 10_001); feed.sweep();
  assert.equal(sockets.length, 2); sockets[1].emit('open');
  sockets[0].message(quote({sequence: 20, bid_price: 80}));
  sockets[1].message(quote({sequence: 1, bid_price: 99}));
  assert.equal(one.length, 1); assert.equal(two.length, 2);
  assert.equal(feed.snapshot(robot).quote.bid, '99');
  offTwo();
  for (let i = 0; i < 7; i++) feed.snapshot({...robot, symbol: 'X' + i + 'USDT', base_asset: 'X' + i});
  assert.throws(() => feed.snapshot({...robot, symbol: 'NEWUSDT', base_asset: 'NEW'}), e => e.code === 'TRADING_LIVE_LIMIT');
  time(start + 41_000); feed.sweep(); assert.equal(feed.markets.size, 0);
});

test('decimal input and exact market identity are bounded before opening a transport', () => {
  assert.equal(marketDecimal(1e-7), '0.0000001'); assert.equal(marketDecimal('1.23000'), '1.23');
  for (const value of [Infinity, '-1', '1e-999999999', '0.0000000000000000001', '<script>']) assert.equal(marketDecimal(value), null);
  assert.throws(() => liveMarketIdentity({...robot, symbol: 'ETHUSDT'}), e => e.code === 'TRADING_LIVE_MARKET');
});
