const SCALE = 10n ** 18n;
const date = value => value == null || !Number.isFinite(new Date(value).getTime()) ? null : new Date(value).toISOString();
const venueDate = value => Number.isSafeInteger(value) && value > 0 ? date(value) : null;
export function auditUnits(value) {
  const text = String(value);
  if (!/^-?\d{1,30}(?:\.\d{1,18})?$/.test(text)) throw Error('TRADING_AUDIT_AMOUNT');
  const negative = text.startsWith('-'), [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
  return negative ? -result : result;
}
export function auditDecimal(value) {
  const negative = value < 0n, digits = (negative ? -value : value).toString().padStart(19, '0');
  return (negative ? '-' : '') + (digits.slice(0, -18) + '.' + digits.slice(-18)).replace(/0+$/, '').replace(/\.$/, '');
}
const nonnegative = value => { const units = auditUnits(value); if (units < 0n) throw Error('TRADING_AUDIT_AMOUNT'); return units; };
const sumFee = (map, asset, amount) => map.set(asset, (map.get(asset) || 0n) + amount);

/** Reconstruct only persisted terminal execution evidence; no connector call or financial write occurs here. */
export function auditTradingFills({robot, orders, totalOrders = orders.length, avisFills = [], quote = null}) {
  const coverageComplete = totalOrders <= orders.length;
  const allFees = new Map(), unknownFeeAssets = new Set(), issues = [], fills = [], visibleOrders = [];
  let position = 0n, basis = 0n, netPnl = 0n, feeBasis = 0n, grossPnl = 0n;
  let buyQuantity = 0n, sellQuantity = 0n, buyValue = 0n, sellValue = 0n, buyExecutions = 0, sellExecutions = 0;
  let accountingComplete = coverageComplete, commissionComplete = true, feePricesComplete = true;
  const issue = (code, id) => { if (issues.length < 100) issues.push({code, orderId: id}); };
  for (const order of orders) {
    const response = order.response || {}, recordedAt = date(order.updated_at), createdAt = date(order.created_at);
    const item = {id: order.id, side: order.side, status: order.status, requestedQuantity: String(order.quantity),
      executedQuantity: null, quoteValue: null, averagePrice: null, createdAt, recordedAt, executedAt: null};
    visibleOrders.push(item);
    if (order.status !== 'SETTLED') continue;
    let quantity, value, baseFee = 0n, quoteFee = 0n, feeValue = 0n;
    const orderFills = [], orderFees = new Map();
    try {
      quantity = nonnegative(response.executedQty);
      value = nonnegative(response.cummulativeQuoteQty);
      if (!['BUY', 'SELL'].includes(order.side) || quantity > nonnegative(order.quantity) || quantity > 0n && value <= 0n) throw Error('TRADING_AUDIT_AMOUNT');
      if (robot.venue === 'BINANCE' && (response.symbol !== robot.symbol || response.side !== order.side || response.clientOrderId !== order.client_order_id)) throw Error('TRADING_AUDIT_IDENTITY');
      item.executedQuantity = auditDecimal(quantity);
      item.quoteValue = auditDecimal(value);
      item.averagePrice = quantity ? auditDecimal(value * SCALE / quantity) : null;
      item.executedAt = venueDate(response.transactTime) || venueDate(response.updateTime);
      if (!quantity) continue;
      if (robot.venue === 'AVIS') {
        const journals = new Set((response.executions || []).map(e => e.journalId));
        const matches = avisFills.filter(f => f.robot_order_id === order.id && journals.has(f.journal_id));
        let totalQuantity = 0n, totalValue = 0n;
        for (const fill of matches) {
          const qty = nonnegative(fill.quantity), total = nonnegative(fill.total), price = nonnegative(fill.price);
          if (fill.side !== order.side || String(fill.user_id) !== String(robot.user_id) || fill.security_id !== robot.security_id || qty <= 0n || price <= 0n) throw Error('TRADING_AUDIT_IDENTITY');
          totalQuantity += qty; totalValue += total;
          orderFills.push({id: order.id + ':' + fill.order_id, orderId: order.id, side: order.side,
            quantity: auditDecimal(qty), price: auditDecimal(price), quoteValue: auditDecimal(total), fees: [],
            executedAt: date(fill.executed_at), recordedAt, evidence: 'AVIS_LEDGER', journalId: fill.journal_id});
        }
        if (totalQuantity !== quantity || totalValue !== value) {
          accountingComplete = false; issue('TRADING_AUDIT_LEDGER_EVIDENCE', order.id);
        }
        item.executedAt = orderFills.at(-1)?.executedAt || null;
      } else {
        const rawFills = Array.isArray(response.fills) ? response.fills : [];
        if (rawFills.length > 1000) throw Error('TRADING_AUDIT_FILL_LIMIT');
        if (!rawFills.length) { commissionComplete = false; issue('TRADING_AUDIT_FEES_MISSING', order.id); }
        const seen = new Set();
        let totalQuantity = 0n, totalValue = 0n, pricedQuantity = 0n;
        for (let index = 0; index < rawFills.length; index++) {
          const fill = rawFills[index], identity = String(fill.tradeId ?? fill.id ?? 'record-' + index);
          if (identity.length > 100 || seen.has(identity)) throw Error('TRADING_AUDIT_DUPLICATE_FILL');
          seen.add(identity);
          const asset = fill.commissionAsset;
          if (typeof asset !== 'string' || !/^[A-Z0-9]{1,25}$/.test(asset) || fill.commission === undefined) {
            commissionComplete = false; issue('TRADING_AUDIT_FEES_MISSING', order.id); continue;
          }
          const fee = nonnegative(fill.commission);
          sumFee(orderFees, asset, fee);
          if (asset === robot.base_asset) baseFee += fee;
          else if (asset === robot.quote_asset) { quoteFee += fee; feeValue += fee; }
          else if (fee) unknownFeeAssets.add(asset);
          let qty = null, price = null, total = null;
          if (fill.qty !== undefined && fill.price !== undefined) {
            qty = nonnegative(fill.qty); price = nonnegative(fill.price);
            if (qty <= 0n || price <= 0n) throw Error('TRADING_AUDIT_AMOUNT');
            total = fill.quoteQty !== undefined ? nonnegative(fill.quoteQty) : qty * price / SCALE;
            totalQuantity += qty; totalValue += total; pricedQuantity += qty;
          } else { commissionComplete = false; issue('TRADING_AUDIT_FILL_DETAIL', order.id); }
          if (asset === robot.base_asset && fee) {
            if (price === null) feePricesComplete = false;
            else feeValue += fee * price / SCALE;
          }
          // A commission record alone is not invented into a per-fill execution.
          if (qty !== null) orderFills.push({id: order.id + ':' + identity, orderId: order.id, side: order.side,
            quantity: auditDecimal(qty), price: auditDecimal(price), quoteValue: auditDecimal(total),
            fees: [{asset, amount: auditDecimal(fee)}], executedAt: venueDate(fill.time) || item.executedAt,
            recordedAt, evidence: 'VENUE_FILL', venueTradeId: fill.tradeId ?? fill.id ?? null});
        }
        if (pricedQuantity && (totalQuantity !== quantity || totalValue !== value)) {
          accountingComplete = false; issue('TRADING_AUDIT_FILL_TOTAL', order.id);
        }
      }
      if (order.side === 'BUY') {
        if (baseFee > quantity) throw Error('TRADING_AUDIT_POSITION');
        position += quantity - baseFee;
        basis += value + quoteFee;
        feeBasis += feeValue;
        buyQuantity += quantity; buyValue += value; buyExecutions++;
      } else {
        const removed = quantity + baseFee;
        if (!position || removed > position) {
          accountingComplete = false; issue('TRADING_AUDIT_POSITION_HISTORY', order.id);
        } else {
          const used = basis * removed / position, allocatedFees = feeBasis * removed / position;
          const realised = value - quoteFee - used;
          netPnl += realised;
          grossPnl += realised + allocatedFees + feeValue;
          basis -= used; feeBasis -= allocatedFees; position -= removed;
        }
        sellQuantity += quantity; sellValue += value; sellExecutions++;
      }
      for (const [asset, amount] of orderFees) sumFee(allFees, asset, amount);
      fills.push(...orderFills);
    } catch (error) {
      accountingComplete = false;
      commissionComplete = false;
      issue(/^TRADING_AUDIT_/.test(error.message) ? error.message : 'TRADING_AUDIT_EVIDENCE', order.id);
    }
  }
  let storedPosition, storedBasis, recordedPnl;
  try { storedPosition = nonnegative(robot.position_quantity); storedBasis = nonnegative(robot.cost_basis); recordedPnl = auditUnits(robot.realized_pnl); }
  catch { storedPosition = storedBasis = recordedPnl = null; accountingComplete = false; }
  const reconciliation = {positionMatches: coverageComplete && storedPosition !== null ? position === storedPosition : null,
    costBasisMatches: coverageComplete && storedBasis !== null ? basis === storedBasis : null,
    realisedPnlMatches: coverageComplete && recordedPnl !== null ? netPnl === recordedPnl : null};
  const reconciles = Object.values(reconciliation).every(value => value === true);
  const netComplete = accountingComplete && commissionComplete && !unknownFeeAssets.size && reconciles;
  let unrealised = null;
  if (quote && !quote.stale && storedPosition !== null && storedBasis !== null) {
    try {
      let marked = storedPosition * nonnegative(quote.bid) / SCALE;
      if (robot.quote_basis === 'PERCENT') marked = marked * nonnegative(robot.denomination) / (100n * SCALE);
      unrealised = auditDecimal(marked - storedBasis);
    } catch { /* A missing mark stays unknown. */ }
  }
  return {
    coverage: {scope: coverageComplete ? 'ALL_RECORDED_ORDERS' : 'RECENT_RECORDED_ORDERS', complete: coverageComplete,
      totalOrders, ordersIncluded: orders.length, from: date(orders[0]?.created_at), to: date(orders.at(-1)?.updated_at)},
    orders: visibleOrders.slice(-100).reverse(), fills: fills.slice(-200).reverse(),
    totals: {baseVolume: auditDecimal(buyQuantity + sellQuantity), quoteVolume: auditDecimal(buyValue + sellValue),
      buyQuantity: auditDecimal(buyQuantity), sellQuantity: auditDecimal(sellQuantity), buyQuoteValue: auditDecimal(buyValue),
      sellQuoteValue: auditDecimal(sellValue), executedOrders: buyExecutions + sellExecutions, buyExecutions, sellExecutions,
      fees: [...allFees].sort(([a], [b]) => a.localeCompare(b)).map(([asset, amount]) => ({asset, amount: auditDecimal(amount)})),
      recordedRealisedPnl: recordedPnl === null ? null : auditDecimal(recordedPnl),
      knownFeeAdjustedPnl: accountingComplete && commissionComplete && reconciles ? auditDecimal(netPnl) : null,
      grossRealisedPnl: accountingComplete && commissionComplete && feePricesComplete && reconciles ? auditDecimal(grossPnl) : null,
      netRealisedPnl: netComplete ? auditDecimal(netPnl) : null, netPnlComplete: netComplete,
      unpricedFeeAssets: [...unknownFeeAssets].sort(), positionQuantity: storedPosition === null ? null : auditDecimal(storedPosition),
      costBasis: storedBasis === null ? null : auditDecimal(storedBasis), unrealisedPnl: unrealised},
    reconciliation, issues,
    accounting: {method: 'MOVING_AVERAGE', realizedBasis: 'Persisted settled executions; base and quote fees allocated to actual acquired inventory',
      grossBasis: 'Known fee-adjusted realised P&L plus allocated acquisition fees and disposal fees valued only at their recorded fill price',
      volumeBasis: 'Sum of executed base quantities and quote consideration; fees are separate and currencies are never added together'},
  };
}
