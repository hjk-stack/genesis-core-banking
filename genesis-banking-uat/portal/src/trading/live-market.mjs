import {fault} from '../core.mjs';

const MAX_FRAME = 256 * 1024;
const MAX_MARKETS = 8;
const MAX_PENDING_SELLS = 2000;
const SELL_AGE_MICROS = 5_000_000;
const IDLE_MS = 30_000;
const STALE_MS = 15_000;
const iso = value => new Date(value).toISOString();
const quoteUnits = value => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0')); };

export function marketDecimal(value, positive = false) {
  let text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string' || text.length > 100) return null;
  if (/^\d+(?:\.\d+)?e-\d+$/i.test(text)) {
    const [coefficient, exponent] = text.toLowerCase().split('e-');
    if (Number(exponent) > 48) return null;
    const [whole, fraction = ''] = coefficient.split('.');
    const point = whole.length - Number(exponent), digits = whole + fraction;
    text = point <= 0 ? '0.' + '0'.repeat(-point) + digits : digits.slice(0, point) + '.' + digits.slice(point);
  }
  if (!/^\d{1,30}(?:\.\d{1,18})?$/.test(text) || !Number.isFinite(Number(text)) || positive && Number(text) <= 0) return null;
  return text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function eventTime(value, now) {
  const time = typeof value === 'number' && Number.isSafeInteger(value) ? value :
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 && time <= now + 5000 ? (typeof value === 'string' ? value : iso(time)) : null;
}

function eventMicros(value) {
  const fraction = /\.(\d+)Z$/.exec(value)?.[1] || '';
  return Date.parse(value) * 1000 + Number(fraction.padEnd(6, '0').slice(3, 6));
}

export function liveMarketIdentity(robot) {
  const {symbol, base_asset: base, quote_asset: quote} = robot;
  if (robot.venue !== 'BINANCE' || !/^[A-Z0-9]{3,30}$/.test(symbol || '') ||
      !/^[A-Z0-9]{1,25}$/.test(base || '') || !/^[A-Z0-9]{1,25}$/.test(quote || '') || symbol !== base + quote) {
    fault('TRADING_LIVE_MARKET', 'robotId');
  }
  return {symbol, baseAsset: base, quoteAsset: quote, symbolId: 'BINANCE_SPOT_' + base + '_' + quote};
}

/** Bounded read-only market subscriptions. Credentials never leave this server-side object. */
export class LiveMarketFeed {
  constructor({env = process.env, WebSocketClass = globalThis.WebSocket, now = Date.now} = {}) {
    this.env = env;
    this.WebSocketClass = WebSocketClass;
    this.now = now;
    this.markets = new Map();
    this.timer = null;
  }

  key() { return this.env.COINAPI_MARKET_DATA_API_KEY || this.env.COINAPI_API_KEY || this.env.APIBRICKS_COINAPI_KEY || null; }

  channel(robot) {
    const identity = liveMarketIdentity(robot), id = identity.symbolId + (robot.publicReference === true ? ':REFERENCE' : '');
    this.sweep();
    let channel = this.markets.get(id);
    if (!channel) {
      if (this.markets.size >= MAX_MARKETS) fault('TRADING_LIVE_LIMIT', 'robotId', 429);
      channel = {...identity, provider: robot.publicReference === true ? 'Binance' : this.key() ? 'CoinAPI' : 'Binance', quote: null, trades: [], seen: new Set(),
        sequences: new Map(), listeners: new Map(), state: 'CLOSED', errorCode: null, lastMessageAt: null,
        touched: this.now(), retryAt: 0, socket: null, pendingSells: []};
      this.markets.set(id, channel);
    }
    channel.touched = this.now();
    if (!channel.socket && this.now() >= channel.retryAt) this.connect(channel);
    if (!this.timer) { this.timer = setInterval(() => this.sweep(), 10_000); this.timer.unref?.(); }
    return channel;
  }

  connect(channel) {
    channel.state = 'CONNECTING';
    channel.errorCode = null;
    channel.sequences.clear();
    channel.pendingSells = [];
    channel.lastMessageAt = iso(this.now());
    const name = channel.symbol.toLowerCase();
    const url = channel.provider === 'CoinAPI' ? 'wss://ws.coinapi.io/v1/' :
      'wss://stream.binance.com:9443/stream?streams=' + name + '@bookTicker/' + name + '@aggTrade';
    let socket;
    try {
      if (!this.WebSocketClass) throw Error('WebSocket');
      socket = new this.WebSocketClass(url);
    } catch { channel.state = 'ERROR'; channel.errorCode = 'TRADING_MARKET_TRANSPORT'; channel.retryAt = this.now() + 10_000; return; }
    channel.socket = socket;
    const current = () => channel.socket === socket;
    socket.addEventListener('open', () => {
      if (!current()) return;
      channel.state = 'OPEN';
      if (channel.provider === 'CoinAPI') {
        const key = this.key();
        if (typeof key !== 'string' || key.length > 2048 || /[\r\n]/.test(key)) return this.disconnect(channel, 'TRADING_MARKET_AUTH');
        socket.send(JSON.stringify({type: 'hello', apikey: key, heartbeat: true,
          subscribe_data_type: ['quote', 'trade'], subscribe_filter_symbol_id: [channel.symbolId + '$']}));
      }
    });
    socket.addEventListener('message', event => {
      if (!current()) return;
      try {
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_FRAME) return this.disconnect(channel, 'TRADING_MARKET_FRAME');
        const parsed = JSON.parse(event.data);
        if (channel.provider === 'CoinAPI') this.coinapi(channel, parsed);
        else this.binance(channel, parsed.data);
      } catch { channel.errorCode = 'TRADING_MARKET_FRAME'; }
    });
    socket.addEventListener('error', () => { if (current()) this.disconnect(channel, 'TRADING_MARKET_TRANSPORT'); });
    socket.addEventListener('close', () => {
      if (!current()) return;
      channel.socket = null;
      channel.state = 'CLOSED';
      channel.retryAt = this.now() + 5000;
    });
  }

  disconnect(channel, code) {
    const socket = channel.socket;
    channel.socket = null;
    channel.state = code ? 'ERROR' : 'CLOSED';
    channel.errorCode = code || null;
    channel.retryAt = this.now() + 10_000;
    socket?.close();
  }

  sequence(channel, kind, value) {
    if (!Number.isSafeInteger(value) || value < 0 || value <= (channel.sequences.get(kind) ?? -1)) return false;
    channel.sequences.set(kind, value);
    return true;
  }

  coinapi(channel, message) {
    if (message?.type === 'error') return this.disconnect(channel, 'TRADING_MARKET_PROVIDER');
    if (message?.type === 'heartbeat') { channel.lastMessageAt = iso(this.now()); return; }
    if (message?.symbol_id !== channel.symbolId || !['quote', 'trade'].includes(message.type)) return;
    const now = this.now(), exchangeTime = eventTime(message.time_exchange, now), providerTime = eventTime(message.time_coinapi, now);
    if (!exchangeTime || !providerTime) { channel.errorCode = 'TRADING_MARKET_TIMESTAMP'; return; }
    if (message.type === 'quote') {
      const bid = marketDecimal(message.bid_price, true), ask = marketDecimal(message.ask_price, true);
      const bidSize = marketDecimal(message.bid_size), askSize = marketDecimal(message.ask_size);
      if (!bid || !ask || bidSize === null || askSize === null || quoteUnits(bid) > quoteUnits(ask) || !this.sequence(channel, 'quote', message.sequence)) return;
      this.quote(channel, {bid, ask, bidSize: Number(bidSize) === 0 ? null : bidSize,
        askSize: Number(askSize) === 0 ? null : askSize, exchangeTime, providerTime, receivedAt: iso(now)});
    } else {
      const price = marketDecimal(message.price, true), quantity = marketDecimal(message.size);
      if (!price || quantity === null || typeof message.uuid !== 'string' || message.uuid.length > 100 ||
          !['BUY', 'SELL', 'BUY_ESTIMATED', 'SELL_ESTIMATED', 'UNKNOWN'].includes(message.taker_side) ||
          !this.sequence(channel, 'trade', message.sequence)) return;
      this.trade(channel, {id: channel.symbolId + ':' + message.uuid, price, quantity, takerSide: message.taker_side,
        exchangeTime, providerTime, receivedAt: iso(now)});
    }
  }

  binance(channel, message) {
    if (!message || message.s !== channel.symbol) return;
    const now = this.now();
    if (message.e === 'aggTrade') {
      const price = marketDecimal(message.p, true), quantity = marketDecimal(message.q), exchangeTime = eventTime(message.T, now);
      if (!price || quantity === null || !exchangeTime || typeof message.m !== 'boolean' || !this.sequence(channel, 'trade', message.a)) return;
      this.trade(channel, {id: channel.symbolId + ':' + message.a, price, quantity, takerSide: message.m ? 'SELL' : 'BUY',
        exchangeTime, providerTime: eventTime(message.E, now), receivedAt: iso(now)});
    } else {
      const bid = marketDecimal(message.b, true), ask = marketDecimal(message.a, true);
      const bidSize = marketDecimal(message.B), askSize = marketDecimal(message.A);
      if (!bid || !ask || bidSize === null || askSize === null || quoteUnits(bid) > quoteUnits(ask) || !this.sequence(channel, 'quote', message.u)) return;
      // Binance bookTicker has no exchange timestamp. Receipt time is not presented as exchange latency.
      this.quote(channel, {bid, ask, bidSize, askSize, exchangeTime: null, providerTime: null, receivedAt: iso(now)});
    }
  }

  trade(channel, trade) {
    if (channel.seen.has(trade.id)) return;
    channel.seen.add(trade.id);
    if (channel.seen.size > 2000) channel.seen.delete(channel.seen.values().next().value);
    channel.trades.push(trade);
    if (channel.trades.length > 100) channel.trades.shift();
    // Keep source time until emission. An accepted clock-skewed or delayed
    // observation must never become a timestamp-free accumulator.
    const now = this.now() * 1000, tradeTime = eventMicros(trade.exchangeTime);
    const quoteTime = channel.quote?.exchangeTime ? eventMicros(channel.quote.exchangeTime) : null;
    channel.pendingSells = channel.pendingSells.filter(sell => now - sell.sourceTime <= SELL_AGE_MICROS);
    if (trade.takerSide === 'SELL' && now - tradeTime <= SELL_AGE_MICROS &&
        (quoteTime === null || tradeTime >= quoteTime)) {
      if (channel.pendingSells.length >= MAX_PENDING_SELLS) {
        channel.pendingSells = [];
        return this.disconnect(channel, 'TRADING_MARKET_VOLUME_LIMIT');
      }
      channel.pendingSells.push({sourceTime: tradeTime, receivedTime: eventMicros(trade.receivedAt), quantity: Number(trade.quantity)});
    }
    channel.lastMessageAt = trade.receivedAt;
    channel.errorCode = null;
  }

  quote(channel, quote) {
    if (channel.quote?.exchangeTime && quote.exchangeTime && eventMicros(quote.exchangeTime) < eventMicros(channel.quote.exchangeTime)) return;
    channel.quote = quote;
    channel.lastMessageAt = quote.receivedAt;
    channel.errorCode = null;
    if (quote.bidSize === null || quote.askSize === null || Number(quote.bidSize) <= 0 || Number(quote.askSize) <= 0) return;
    const timestamp = eventMicros(quote.exchangeTime || quote.receivedAt);
    const now = this.now() * 1000, receivedTime = eventMicros(quote.receivedAt), pending = [];
    let sellVolume = 0;
    for (const sell of channel.pendingSells) {
      const age = now - sell.sourceTime;
      if (age > SELL_AGE_MICROS) continue;
      // Binance bookTicker supplies only receipt time. It is an observation
      // boundary, never an invented exchange timestamp; trades keep their source time.
      if (age < 0 || sell.sourceTime > timestamp || sell.receivedTime > receivedTime) pending.push(sell);
      else sellVolume += sell.quantity;
    }
    channel.pendingSells = pending;
    const tick = {tsMicros: timestamp, bid: Number(quote.bid), ask: Number(quote.ask),
      bidSize: Number(quote.bidSize), askSize: Number(quote.askSize), sellVolume};
    for (const listener of channel.listeners.keys()) listener({...tick});
  }

  snapshot(robot) {
    const channel = this.channel(robot), now = this.now();
    const quote = channel.quote ? {...channel.quote} : null;
    if (quote) {
      const timestamp = Date.parse(quote.exchangeTime || quote.receivedAt);
      quote.ageMs = Math.max(0, now - timestamp);
      quote.ageBasis = quote.exchangeTime ? 'EXCHANGE' : 'RECEIVED';
      const delay = quote.exchangeTime ? Date.parse(quote.receivedAt) - Date.parse(quote.exchangeTime) : null;
      quote.sourceDelayMs = delay !== null && delay >= 0 ? delay : null;
      quote.stale = quote.ageMs > STALE_MS || channel.state !== 'OPEN';
    }
    return {provider: channel.provider, symbolId: channel.symbolId, baseAsset: channel.baseAsset, quoteAsset: channel.quoteAsset,
      quote, trades: channel.trades.slice(-50).reverse().map(t => ({...t})),
      connection: {state: channel.state, lastMessageAt: channel.lastMessageAt, errorCode: channel.errorCode},
      usedByStrategy: [...channel.listeners.values()].some(id => id === robot.robot_id)};
  }

  subscribe(robot, listener) {
    const channel = this.channel(robot);
    channel.listeners.set(listener, robot.robot_id);
    return () => { channel.listeners.delete(listener); channel.touched = this.now(); };
  }

  sweep() {
    for (const [id, channel] of this.markets) {
      if (!channel.listeners.size && this.now() - channel.touched > IDLE_MS) {
        this.disconnect(channel);
        this.markets.delete(id);
      } else if (channel.socket && this.now() - Date.parse(channel.lastMessageAt) > 30_000) this.disconnect(channel, 'TRADING_MARKET_TIMEOUT');
      else if (channel.listeners.size && !channel.socket && this.now() >= channel.retryAt) this.connect(channel);
    }
  }

  close() { clearInterval(this.timer); this.timer = null; for (const channel of this.markets.values()) this.disconnect(channel); this.markets.clear(); }
}
