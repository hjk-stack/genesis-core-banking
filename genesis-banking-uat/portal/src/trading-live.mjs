import {TradingTestingCore} from './trading-testing.mjs';
import {fault} from './core.mjs';
import {LiveMarketFeed} from './trading/live-market.mjs';
import {auditTradingFills, auditUnits, auditDecimal} from './trading/live-audit.mjs';
import {readSecurityLiquidity} from './trading/live-liquidity.mjs';

export const TRADING_LIVE_MESSAGES = {
  TRADING_LIVE_PROFILE: 'Select an institution trading profile.',
  TRADING_LIVE_MARKET: 'This profile needs an exact supported venue market.',
  TRADING_LIVE_LIMIT: 'Close an unused market view before opening another feed.',
  TRADING_LIQUIDITY_CARD: 'Select a deployed security linked to this trading profile.',
};
const actualAdmin = actor => { if (!actor?.id || !actor.admin || actor.customerUserId || actor.indexService) fault('FORBIDDEN', null, 403); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const date = value => value == null ? null : new Date(value).toISOString();
const selectedInput = input => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'robotId') ||
      input.robotId !== undefined && !uuid.test(input.robotId)) fault('TRADING_LIVE_PROFILE', 'robotId');
};

export class TradingLiveCore extends TradingTestingCore {
  constructor(pool, options = {}) {
    super(pool, options);
    this.liveMarkets = options.tradingMarketFeed || new LiveMarketFeed({env: this.secretEnv,
      WebSocketClass: options.liveMarketWebSocket, now: options.liveNow});
    this.liveNow = options.liveNow || Date.now;
    this.securityLiquidityCache = new Map();
  }

  async liveTradingProfiles(db = this.pool) {
    return (await db.query(`SELECT r.*,s.quote_basis,s.denomination FROM avis_core_v2.trading_robots r
      JOIN avis_core_v2.sovereign_users u USING(user_id) LEFT JOIN avis_core_v2.portfolio_securities s USING(security_id)
      WHERE u.account_role='INSTITUTION' ORDER BY r.created_at,r.robot_id`)).rows;
  }

  async tradingLiveSnapshot(actor, input = {}) {
    actualAdmin(actor); selectedInput(input);
    const db = await this.pool.connect();
    try {
      // The existing review fingerprint takes metadata SHARE locks; all reads here
      // still share one consistent snapshot and perform no financial mutations.
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const result = await this.readTradingLiveSnapshot(db, input);
      await db.query('COMMIT');
      return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  async readTradingLiveSnapshot(db, input) {
    const robots = await this.liveTradingProfiles(db);
    const profiles = [];
    for (const robot of robots) profiles.push({robotId: robot.robot_id, name: robot.name, venue: robot.venue,
      symbol: robot.symbol, indexId: robot.index_id, baseAsset: robot.base_asset, quoteAsset: robot.quote_asset,
      enabled: robot.enabled, testReviewed: await this.tradingTestReviewed(db, robot)});
    const robot = input.robotId ? robots.find(r => r.robot_id === input.robotId) : robots[0];
    if (input.robotId && !robot) fault('TRADING_LIVE_PROFILE', 'robotId', 404);
    const observedAt = new Date(this.liveNow()).toISOString();
    if (!robot) {
      const reference = {venue: 'BINANCE', symbol: 'BTCUSDT', base_asset: 'BTC', quote_asset: 'USDT', publicReference: true};
      return {schemaVersion: 1, observedAt, profiles, selectedRobotId: null,
        market: {...this.liveMarkets.snapshot(reference), reference: true, symbol: reference.symbol, usedByStrategy: false},
        audit: null, liquidity: null};
    }
    const liquidity = robot.venue === 'AVIS' ? await this.liveOrderBook(robot, observedAt, db) : null;
    const market = robot.venue === 'BINANCE' ? this.liveMarkets.snapshot(robot) : this.avisMarket(robot, liquidity, observedAt);
    market.reference = false;
    market.symbol = robot.symbol;
    const rows = (await db.query(`SELECT * FROM (
      SELECT o.*,count(*) OVER()::int AS total_orders FROM avis_core_v2.trading_robot_orders o
      WHERE robot_id=$1 ORDER BY created_at DESC,id DESC LIMIT 2000
      ) history ORDER BY created_at,id`, [robot.robot_id])).rows;
    const journalIds = [...new Set(rows.flatMap(o => (o.response?.executions || []).map(e => e.journalId)).filter(v => uuid.test(v)))];
    let avisFills = [];
    if (robot.venue === 'AVIS' && journalIds.length) avisFills = (await db.query(`SELECT s.*,
      substring(s.instruction->>'reference' from 3) AS robot_order_id FROM avis_core_v2.securities_orders s
      WHERE s.user_id=$1 AND s.security_id=$2 AND s.status='FILLED' AND s.journal_id=ANY($3::uuid[])
        AND s.instruction->>'reference'=ANY($4::text[]) ORDER BY s.executed_at,s.order_id`,
    [robot.user_id, robot.security_id, journalIds, rows.map(o => 'W-' + o.id)])).rows;
    const audit = auditTradingFills({robot, orders: rows, totalOrders: rows[0]?.total_orders || 0, avisFills, quote: market?.quote});
    return {schemaVersion: 1, observedAt, profiles, selectedRobotId: robot.robot_id, market, audit, liquidity};
  }

  avisMarket(robot, book, observedAt) {
    const bid = book?.bids[0], ask = book?.asks[0];
    return {provider: 'AVIS', symbolId: 'AVIS:' + robot.security_id, baseAsset: robot.base_asset, quoteAsset: robot.quote_asset,
      quote: bid && ask ? {bid: bid.price, ask: ask.price, bidSize: bid.quantity, askSize: ask.quantity,
        exchangeTime: null, providerTime: null, receivedAt: observedAt, ageMs: 0, ageBasis: 'RECEIVED', sourceDelayMs: null, stale: false} : null,
      trades: [], connection: {state: 'OPEN', lastMessageAt: observedAt, errorCode: null}, usedByStrategy: null};
  }

  async liveOrderBook(robot, observedAt, db = this.pool) {
    const rows = (await db.query(`WITH sell_reservations AS (
        SELECT user_id,sum(quantity) AS required_quantity FROM avis_core_v2.securities_orders
        WHERE security_id=$1 AND status='OPEN' AND side='SELL' GROUP BY user_id
      ),buy_reservations AS (
        SELECT cash_hold_id,sum(total) AS required_cash,count(*)::int AS hold_orders FROM avis_core_v2.securities_orders
        WHERE status='OPEN' AND side='BUY' AND cash_hold_id IS NOT NULL GROUP BY cash_hold_id
      ) SELECT o.order_id,o.side,o.quantity,o.price,o.total,o.submitted_at,
      count(*) OVER()::int AS total_orders,h.available_balance AS held_cash,h.locked_balance AS locked_cash,
      h.currency_code AS held_currency,p.reserved_quantity AS seller_reserved,
      sr.required_quantity,br.required_cash,br.hold_orders
      FROM avis_core_v2.securities_orders o
      LEFT JOIN avis_core_v2.ledger_accounts h ON h.account_id=o.cash_hold_id
      LEFT JOIN avis_core_v2.portfolio_positions p ON p.user_id=o.user_id AND p.security_id=o.security_id
      LEFT JOIN sell_reservations sr ON sr.user_id=o.user_id
      LEFT JOIN buy_reservations br ON br.cash_hold_id=o.cash_hold_id
      WHERE o.security_id=$1 AND o.user_id<>$2 AND o.status='OPEN'
      ORDER BY o.side,CASE WHEN o.side='BUY' THEN -o.price ELSE o.price END,o.submitted_at,o.order_id LIMIT 500`,
    [robot.security_id, robot.user_id])).rows;
    const groups = {BUY: new Map(), SELL: new Map()}, lots = [];
    for (const order of rows) {
      const price = auditDecimal(auditUnits(order.price)), quantity = auditUnits(order.quantity), value = auditUnits(order.total);
      const reservationCode = order.side === 'BUY' ? order.held_cash == null ? 'CASH_HOLD_MISSING' :
        order.hold_orders !== 1 ? 'CASH_HOLD_SHARED' : order.held_currency !== robot.quote_asset ? 'CASH_HOLD_CURRENCY' :
        auditUnits(order.held_cash) - auditUnits(order.locked_cash || '0') < auditUnits(order.required_cash) ? 'CASH_HOLD_SHORTFALL' : null :
        order.seller_reserved == null ? 'SECURITY_POSITION_MISSING' :
        auditUnits(order.seller_reserved) < auditUnits(order.required_quantity) ? 'SECURITY_RESERVE_SHORTFALL' : null;
      const reservationConsistent = reservationCode === null;
      if (reservationConsistent) {
        let level = groups[order.side].get(price);
        if (!level) { level = {price, quantity: 0n, quoteValue: 0n, orders: 0}; groups[order.side].set(price, level); }
        level.quantity += quantity; level.quoteValue += value; level.orders++;
      }
      lots.push({orderId: order.order_id, side: order.side, quantity: auditDecimal(quantity), price,
        quoteValue: auditDecimal(value), submittedAt: date(order.submitted_at), reservationConsistent, reservationCode});
    }
    const levels = side => [...groups[side].values()].map(level => ({...level, quantity: auditDecimal(level.quantity), quoteValue: auditDecimal(level.quoteValue)}));
    const cards = (await db.query(`SELECT card_id,name,symbol,network,contract_address,hub_address,
      token_quantity,source_quantity,state,updated_at FROM avis_core_v2.crypto_security_cards
      WHERE mode='REAL' AND security_id=$1 AND user_id=$2 ORDER BY sort_order`, [robot.security_id, robot.user_id])).rows;
    return {kind: 'AVIS_ORDER_BOOK', observedAt, securityId: robot.security_id, baseAsset: robot.base_asset,
      quoteAsset: robot.quote_asset, quoteBasis: robot.quote_basis, denomination: robot.denomination,
      complete: (rows[0]?.total_orders || 0) <= rows.length, totalOrders: rows[0]?.total_orders || 0,
      bids: levels('BUY'), asks: levels('SELL'), lots, wholeLotsOnly: true,
      reservationBasis: 'Levels include whole lots with a unique funded BUY hold or sufficient aggregate SELL reserves. Every open obligation is checked before the display cap; aggregate reserves are not a per-order escrow allocation.',
      securityTokens: cards.map(card => ({cardId: card.card_id, name: card.name, symbol: card.symbol, network: card.network,
        contractAddress: card.contract_address, hubAddress: card.hub_address, state: card.state,
        registeredTokenQuantity: card.token_quantity, reservedSourceQuantity: card.source_quantity,
        registeredAt: date(card.updated_at), liquidityType: 'SECURITY_REGISTER'}))};
  }

  /** Explicit read apart from the frequent market view. Per-card results are cached for one minute. */
  async tradingLiveLiquidity(actor, input = {}) {
    actualAdmin(actor); selectedInput(input);
    if (!input.robotId) fault('TRADING_LIVE_PROFILE', 'robotId');
    const robot = (await this.liveTradingProfiles()).find(r => r.robot_id === input.robotId);
    if (!robot || !robot.security_id) fault('TRADING_LIVE_PROFILE', 'robotId', 404);
    const cards = (await this.pool.query(`SELECT c.*,w.public_address FROM avis_core_v2.crypto_security_cards c
      JOIN avis_core_v2.user_deposit_addresses w ON w.address_id=c.wallet_address_id AND w.user_id=c.user_id AND w.network=c.network
      WHERE c.mode='REAL' AND c.security_id=$1 AND c.user_id=$2 AND c.contract_address IS NOT NULL AND c.hub_address IS NOT NULL
      ORDER BY c.sort_order LIMIT 3`, [robot.security_id, robot.user_id])).rows;
    const result = [];
    for (const card of cards) {
      const key = [card.card_id, card.version, card.network, card.contract_address, card.hub_address, card.public_address].join(':');
      let cached = this.securityLiquidityCache.get(key);
      if (!cached || this.liveNow() - cached.at > 60_000) {
        const at = this.liveNow();
        const promise = readSecurityLiquidity(this.chain, card, this.liveNow).then(chain => ({chain, errorCode: null})).catch(error =>
          ({chain: null, errorCode: /^TRADING_LIQUIDITY_(NETWORK|FINALITY|IDENTITY|ASSET)$/.test(error.message) ? error.message : 'TRADING_LIQUIDITY_READ'}));
        cached = {at, promise};
        this.securityLiquidityCache.set(key, cached);
        if (this.securityLiquidityCache.size > 30) this.securityLiquidityCache.delete(this.securityLiquidityCache.keys().next().value);
      }
      result.push({cardId: card.card_id, name: card.name, symbol: card.symbol, network: card.network,
        contractAddress: card.contract_address, ...(await cached.promise)});
    }
    return {schemaVersion: 1, robotId: robot.robot_id, observedAt: new Date(this.liveNow()).toISOString(), cards: result};
  }
}
