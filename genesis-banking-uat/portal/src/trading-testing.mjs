import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {IndexEventAdviceCore, indexHash} from './index-event-advice.mjs';
import {fault} from './core.mjs';
import {runIsolatedTradingTest, TRADING_TEST_TIMEOUT_MS, TRADING_TEST_OUTPUT_BYTES} from './trading/test-runner.mjs';

export const TRADING_TEST_MESSAGES = {
  TRADING_TEST_INPUT: 'Check the test settings and replay data.',
  TRADING_TEST_PROFILE: 'Select an existing institution trading profile.',
  TRADING_TEST_QUEUE: 'The test queue is full. Wait for a current run to finish.',
  TRADING_TEST_NOT_FOUND: 'This trading test was not found.',
  TRADING_TEST_REVIEW_REQUIRED: 'Run and review a complete replay for this trading configuration before starting live entries.',
  TRADING_TEST_REVIEW: 'Review a passed profile replay with a completed entry and exit and no remaining virtual position.',
  TRADING_TEST_CHANGED: 'The trading configuration or implementation changed. Run a new replay.',
  TRADING_TEST_PROCESS: 'The isolated test process could not complete.',
  TRADING_TEST_TIMEOUT: 'The test exceeded its execution time limit.',
  TRADING_TEST_OUTPUT: 'The test process returned an incomplete or invalid report.',
  TRADING_TEST_INTERRUPTED: 'The test process stopped before completing its report.',
};
export const TRADING_TEST_LIMITS = Object.freeze({maxTicks: 10_000, maxIndices: 10_000,
  maxInputBytes: 2 * 1024 * 1024, maxReportBytes: TRADING_TEST_OUTPUT_BYTES, maxRecords: 1000,
  maxQueued: 20, timeoutMs: TRADING_TEST_TIMEOUT_MS, maxRevisionWaitMs: 30 * 60_000});
const VERSION = '1.231.0';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const actualAdmin = actor => {
  if (!actor?.id || !actor.admin || actor.customerUserId || actor.indexService) fault('FORBIDDEN', null, 403);
};
const numberText = value => String(value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
// The runner keeps 64 significant Decimal digits; ratios may have leading
// fractional zeroes. Preserve those measured values without rounding to JS floats.
const decimal = value => typeof value === 'string' && /^-?\d{1,64}(\.\d{1,128})?$/.test(value) && Number.isFinite(Number(value));
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const timestamp = value => value == null ? null : new Date(value).toISOString();
const inputFault = field => fault('TRADING_TEST_INPUT', field);
const safeText = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

const implementationFiles = [
  './trading-instructions.mjs', './trading-live.mjs', './trading/live-market.mjs',
  './trading/live-liquidity.mjs', './trading/live-audit.mjs',
  '../trading/w_effect.py', '../trading/worker.py', '../trading/test_runner.py', '../trading/requirements.txt',
  './trading/test-runner.mjs', './trading-testing.mjs', './trading-robot.mjs',
  './trading/runtime.mjs', './trading/binance.mjs', './index-event-advice.mjs',
];
let fingerprintPromise;
export function tradingImplementationFingerprint() {
  fingerprintPromise ??= Promise.all(implementationFiles.map(async path => {
    const content = await readFile(new URL(path, import.meta.url));
    return [path, createHash('sha256').update(content).digest('hex')];
  })).then(files => indexHash({schemaVersion: 1, engine: 'NautilusTrader', version: VERSION, files}));
  return fingerprintPromise;
}

function validateDataset(dataset) {
  if (!object(dataset) || Object.keys(dataset).some(k => !['ticks', 'indices'].includes(k)) ||
      !Array.isArray(dataset.ticks) || !Array.isArray(dataset.indices) || !dataset.ticks.length ||
      dataset.ticks.length > TRADING_TEST_LIMITS.maxTicks || dataset.indices.length > TRADING_TEST_LIMITS.maxIndices) inputFault('dataset');
  let lastTime = 0, lastArrival = 0;
  for (const tick of dataset.ticks) {
    if (!object(tick) || Object.keys(tick).some(k => !['tsMicros', 'receivedAtMicros', 'bid', 'ask', 'bidSize', 'askSize', 'sellVolume'].includes(k)) ||
        !safeInteger(tick.tsMicros) || tick.tsMicros <= lastTime ||
        !['bid', 'ask', 'bidSize', 'askSize', 'sellVolume'].every(k => finite(tick[k])) ||
        Math.min(tick.bid, tick.ask, tick.bidSize, tick.askSize) <= 0 || tick.sellVolume < 0 || tick.bid > tick.ask) inputFault('dataset.ticks');
    const arrival = Object.hasOwn(tick, 'receivedAtMicros') ? tick.receivedAtMicros : tick.tsMicros;
    if (!safeInteger(arrival) || arrival < tick.tsMicros || arrival < lastArrival) inputFault('dataset.ticks');
    lastTime = tick.tsMicros;
    lastArrival = arrival;
  }
  let previous = 0;
  for (const observation of dataset.indices) {
    const index = observation?.index;
    if (!object(observation) || Object.keys(observation).some(k => !['atMicros', 'index'].includes(k)) ||
        !safeInteger(observation.atMicros) || observation.atMicros <= previous || !object(index) ||
        Object.keys(index).some(k => !['instrumentId', 'score', 'confidence', 'sourceCount', 'generatedAtMs', 'validUntilMs', 'sequence'].includes(k)) ||
        !safeText(index.instrumentId, 80) || !index.instrumentId.trim() || !safeText(index.sequence, 128) || !index.sequence.trim() ||
        !finite(index.score) || index.score < -100 || index.score > 100 ||
        !finite(index.confidence) || index.confidence < 0 || index.confidence > 1 ||
        !safeInteger(index.sourceCount) || index.sourceCount > 10_000 || !safeInteger(index.generatedAtMs) || !safeInteger(index.validUntilMs) ||
        index.generatedAtMs > observation.atMicros / 1000) inputFault('dataset.indices');
    previous = observation.atMicros;
  }
  return structuredClone(dataset);
}

function validateInput(input) {
  if (!object(input) || Object.keys(input).some(k => !['robotId', 'mode', 'dataset', 'initialCash', 'feeBps', 'slippageBps'].includes(k)) ||
      !['ACCEPTANCE', 'REPLAY'].includes(input.mode) ||
      input.robotId !== undefined && !uuid.test(input.robotId)) inputFault('mode');
  if (Buffer.byteLength(JSON.stringify(input)) > TRADING_TEST_LIMITS.maxInputBytes) inputFault('dataset');
  const initialCash = Object.hasOwn(input, 'initialCash') ? input.initialCash : '10000';
  const feeBps = Object.hasOwn(input, 'feeBps') ? input.feeBps : 10;
  const slippageBps = Object.hasOwn(input, 'slippageBps') ? input.slippageBps : 5;
  if (typeof initialCash !== 'string' || !/^\d{1,18}(\.\d{1,16})?$/.test(initialCash) || Number(initialCash) <= 0 || Number(initialCash) > 1e12) inputFault('initialCash');
  for (const [field, value] of Object.entries({feeBps, slippageBps})) {
    if (!finite(value) || value < 0 || value > 1000) inputFault(field);
  }
  if (input.mode === 'ACCEPTANCE' && input.dataset !== undefined) inputFault('dataset');
  const dataset = input.mode === 'REPLAY' ? validateDataset(input.dataset) : undefined;
  return {mode: input.mode, initialCash: numberText(initialCash), feeBps, slippageBps, ...(dataset ? {dataset} : {})};
}

const counters = ['ticksProcessed', 'indexObservationsUsed', 'ordersGenerated', 'filledOrders', 'rejectedOrders',
  'partialFills', 'duplicateSignalsIgnored', 'buyFills', 'sellFills', 'openOrders'];
const amounts = ['initialCash', 'finalCash', 'finalPosition', 'costBasis', 'realisedPnl', 'unrealisedPnl',
  'fees', 'finalEquity', 'drawdown', 'drawdownFraction'];

/** Validate the actual runner's bounded report before any result can be reviewed. */
export function validateTradingTestReport(report, input) {
  const invalid = () => fault('TRADING_TEST_OUTPUT');
  if (!object(report) || Buffer.byteLength(JSON.stringify(report)) > TRADING_TEST_LIMITS.maxReportBytes ||
      Object.keys(report).some(k => !['schemaVersion', 'engine', 'engineVersion', 'mode', 'status', 'complete', 'checks', 'metrics', 'orders', 'fills', 'assumptions'].includes(k)) ||
      report.schemaVersion !== 1 || report.engine !== 'NautilusTrader' || report.engineVersion !== VERSION ||
      report.mode !== input.mode || !['PASSED', 'FAILED'].includes(report.status) || typeof report.complete !== 'boolean' ||
      !Array.isArray(report.checks) || !report.checks.length || report.checks.length > 100 || !object(report.metrics) ||
      !Array.isArray(report.orders) || report.orders.length > TRADING_TEST_LIMITS.maxRecords ||
      !Array.isArray(report.fills) || report.fills.length > TRADING_TEST_LIMITS.maxRecords || !object(report.assumptions)) invalid();
  const checkIds = new Set();
  for (const check of report.checks) {
    if (!object(check) || Object.keys(check).some(k => !['id', 'label', 'passed', 'detail'].includes(k)) ||
        !safeText(check.id, 100) || !check.id || checkIds.has(check.id) || !safeText(check.label, 250) ||
        !safeText(check.detail, 2000) || typeof check.passed !== 'boolean') invalid();
    checkIds.add(check.id);
  }
  if (report.status === 'PASSED' && (!report.complete || report.checks.some(c => !c.passed))) invalid();
  if (report.complete) {
    if (counters.some(k => !safeInteger(report.metrics[k])) || amounts.some(k => !decimal(report.metrics[k])) ||
        ['ordersTruncated', 'fillsTruncated'].some(k => !safeInteger(report.metrics[k])) ||
        ['initialCash', 'finalCash', 'finalPosition', 'costBasis', 'fees', 'drawdown', 'drawdownFraction'].some(k => Number(report.metrics[k]) < 0) ||
        report.metrics.openOrders !== 0) invalid();
    // Acceptance discloses fixed reference settings; replay must use the supplied virtual capital.
    if (input.mode === 'REPLAY' && Number(report.metrics.initialCash) !== Number(input.initialCash)) invalid();
  }
  const orderIds = new Set();
  for (const order of report.orders) {
    if (!object(order) || !safeText(order.id, 128) || !order.id || orderIds.has(order.id) ||
        !safeText(order.signalId, 128) || !safeInteger(order.tsMicros) || !['BUY', 'SELL'].includes(order.side) ||
        !['requestedQuantity', 'limitPrice', 'filledQuantity'].every(k => decimal(order[k]) && Number(order[k]) >= 0) ||
        !safeText(order.status, 30) || !(order.reason === null || safeText(order.reason, 250)) ||
        order.type !== 'LIMIT' || order.timeInForce !== 'IOC') invalid();
    orderIds.add(order.id);
  }
  for (const fill of report.fills) {
    if (!object(fill) || !orderIds.has(fill.orderId) || !safeInteger(fill.tsMicros) || !['BUY', 'SELL'].includes(fill.side) ||
        !['quantity', 'price', 'notional', 'fee', 'cashAfter', 'positionAfter'].every(k => decimal(fill[k]) && Number(fill[k]) >= 0)) invalid();
  }
  return structuredClone(report);
}

function roundTripPassed(run) {
  const report = run.report;
  return run.status === 'PASSED' && run.mode === 'REPLAY' && !!run.robot_id && report?.complete === true &&
    report.status === 'PASSED' && report.checks?.length > 0 && report.checks.every(c => c.passed === true) &&
    report.metrics?.buyFills > 0 && report.metrics?.sellFills > 0 && Number(report.metrics?.finalPosition) === 0 &&
    report.metrics?.openOrders === 0 && report.metrics?.ordersTruncated === 0 && report.metrics?.fillsTruncated === 0 &&
    report.fills.some(f => f.side === 'BUY' && Number(f.quantity) > 0) &&
    report.fills.some(f => f.side === 'SELL' && Number(f.quantity) > 0);
}

const defaultRobot = {
  robot_id: null, name: 'Virtual W-effect profile', user_id: null, venue: 'AVIS', symbol: 'TEST', index_id: 'TEST',
  security_id: null, account_id: null, key_ref: null, max_notional: '1000', daily_notional: '10000', max_loss: '1000',
  minimum_index: 0, trailing_bps: 50, quantity_step: '0.001', price_tick: '0.01', base_asset: 'TEST', quote_asset: 'EUR',
};

export class TradingTestingCore extends IndexEventAdviceCore {
  constructor(pool, options = {}) {
    super(pool, options);
    this.tradingTestRunner = options.tradingTestRunner || (input => runIsolatedTradingTest(input, {
      python: this.secretEnv.AVIS_TRADING_TEST_PYTHON || 'python3',
    }));
    this.testingPump = null;
  }

  tradingTestingFingerprint() { return tradingImplementationFingerprint(); }

  async tradingTestConfiguration(db, robot) {
    let terms = null;
    if (robot.security_id) terms = (await db.query(
      'SELECT denomination,quote_basis,currency_code,quantity_decimals FROM avis_core_v2.portfolio_securities WHERE security_id=$1 FOR SHARE',
      [robot.security_id])).rows[0];
    if (robot.security_id && !terms) fault('TRADING_TEST_PROFILE', 'robotId');
    return {
      schemaVersion: 1, robotId: robot.robot_id, userId: robot.user_id === null ? null : String(robot.user_id),
      venue: robot.venue, symbol: robot.symbol, indexId: robot.index_id,
      securityId: robot.security_id || null, accountId: robot.account_id || null, keyRef: robot.key_ref || null,
      maxNotional: numberText(robot.max_notional), dailyNotional: numberText(robot.daily_notional), maxLoss: numberText(robot.max_loss),
      minimumIndex: Number(robot.minimum_index), trailingBps: Number(robot.trailing_bps),
      quantityStep: numberText(robot.quantity_step), priceTick: numberText(robot.price_tick),
      baseAsset: robot.base_asset || null, quoteAsset: robot.quote_asset || null,
      denomination: terms ? numberText(terms.denomination) : null, quoteBasis: terms?.quote_basis || null,
      securityCurrency: terms?.currency_code || null, securityQuantityDecimals: terms?.quantity_decimals ?? null,
      priceMultiplier: terms?.quote_basis === 'PERCENT' ? Number(terms.denomination) / 100 : 1,
    };
  }

  async tradingTestReview(db, robot, configurationHash, fingerprint) {
    const hash = configurationHash || indexHash(await this.tradingTestConfiguration(db, robot));
    const code = fingerprint || await this.tradingTestingFingerprint();
    return (await db.query(`SELECT v.run_id,v.reviewed_at FROM avis_core_v2.trading_test_reviews v
      JOIN avis_core_v2.trading_test_runs r USING(run_id)
      WHERE v.robot_id=$1 AND v.configuration_hash=$2 AND v.engine_fingerprint=$3
        AND r.status='PASSED' AND r.mode='REPLAY' ORDER BY v.reviewed_at DESC LIMIT 1`,
    [robot.robot_id, hash, code])).rows[0] || null;
  }

  async tradingTestReviewed(db, robot) { return !!(await this.tradingTestReview(db, robot)); }

  async assertTradingTestReviewed(db, robot) {
    if (!(await this.tradingTestReviewed(db, robot))) fault('TRADING_TEST_REVIEW_REQUIRED', 'robotId', 409);
  }

  async tradingTesting(actor) {
    actualAdmin(actor);
    const fingerprint = await this.tradingTestingFingerprint();
    const robots = (await this.pool.query(`SELECT r.* FROM avis_core_v2.trading_robots r
      JOIN avis_core_v2.sovereign_users u USING(user_id) WHERE u.account_role='INSTITUTION' ORDER BY r.created_at`)).rows;
    const profiles = [], currentHashes = new Map();
    for (const robot of robots) {
      const configurationHash = indexHash(await this.tradingTestConfiguration(this.pool, robot));
      currentHashes.set(robot.robot_id, configurationHash);
      const review = await this.tradingTestReview(this.pool, robot, configurationHash, fingerprint);
      profiles.push({robotId: robot.robot_id, name: robot.name, venue: robot.venue, symbol: robot.symbol,
        configurationHash, reviewedRunId: review?.run_id || null, testReviewed: !!review});
    }
    const rows = (await this.pool.query(`SELECT r.*,v.reviewed_at FROM avis_core_v2.trading_test_runs r
      LEFT JOIN avis_core_v2.trading_test_reviews v USING(run_id) ORDER BY r.created_at DESC,r.run_id DESC LIMIT 20`)).rows;
    const runs = rows.map(run => ({runId: run.run_id, robotId: run.robot_id, profileName: run.profile_name,
      mode: run.mode, status: run.status, configurationHash: run.configuration_hash, engineFingerprint: run.engine_fingerprint,
      datasetHash: run.dataset_hash, createdAt: timestamp(run.created_at), startedAt: timestamp(run.started_at), completedAt: timestamp(run.completed_at),
      errorCode: run.error_code, report: run.report, reviewedAt: timestamp(run.reviewed_at),
      reviewEligible: roundTripPassed(run) && run.engine_fingerprint === fingerprint &&
        currentHashes.get(run.robot_id) === run.configuration_hash}));
    return {engine: {name: 'NautilusTrader', version: VERSION, fingerprint}, profiles, runs, limits: TRADING_TEST_LIMITS,
      defaultProfile: {name: defaultRobot.name, symbol: defaultRobot.symbol, venue: defaultRobot.venue, indexId: defaultRobot.index_id}};
  }

  async runTradingTest(actor, input, key) {
    actualAdmin(actor);
    const validated = validateInput(input), fingerprint = await this.tradingTestingFingerprint();
    const result = await this.operation(actor, 'RUN_TRADING_TEST', input, key, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('trading-test-queue',0))");
      const pending = (await db.query("SELECT count(*)::int AS n FROM avis_core_v2.trading_test_runs WHERE status IN ('QUEUED','RUNNING')")).rows[0].n;
      if (pending >= TRADING_TEST_LIMITS.maxQueued) fault('TRADING_TEST_QUEUE', null, 409);
      let robot = defaultRobot;
      if (input.robotId) {
        robot = (await db.query(`SELECT r.* FROM avis_core_v2.trading_robots r JOIN avis_core_v2.sovereign_users u USING(user_id)
          WHERE r.robot_id=$1 AND u.account_role='INSTITUTION' FOR SHARE OF r,u`, [input.robotId])).rows[0];
        if (!robot) fault('TRADING_TEST_PROFILE', 'robotId');
      }
      const configuration = await this.tradingTestConfiguration(db, robot);
      const settings = Object.fromEntries(['symbol', 'venue', 'indexId', 'maxNotional', 'dailyNotional', 'maxLoss',
        'minimumIndex', 'trailingBps', 'quantityStep', 'priceTick', 'priceMultiplier'].map(k => [k, configuration[k]]));
      const payload = {schemaVersion: 1, ...validated, settings: {...settings, id: robot.robot_id || 'virtual-test',
        enabled: true, positionQuantity: '0', stopPrice: '0', peakPrice: '0'}};
      if (Buffer.byteLength(JSON.stringify(payload)) > TRADING_TEST_LIMITS.maxInputBytes) inputFault('dataset');
      const runId = randomUUID(), configurationHash = indexHash(configuration);
      await db.query(`INSERT INTO avis_core_v2.trading_test_runs
        (run_id,robot_id,profile_name,mode,configuration,configuration_hash,engine_fingerprint,dataset_hash,input,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [runId, robot.robot_id, robot.name, input.mode,
        JSON.stringify(configuration), configurationHash, fingerprint,
        indexHash(validated.dataset || {reference: 'W_EFFECT_ACCEPTANCE_V1'}), JSON.stringify(payload), actor.id]);
      return {id: runId, runId, status: 'QUEUED'};
    });
    void this.processTradingTests().catch(() => console.error(JSON.stringify({operation: 'TRADING_TEST', code: 'TRADING_TEST_PROCESS'})));
    return result;
  }

  processTradingTests() {
    if (!this.testingPump) this.testingPump = this.drainTradingTests().finally(() => { this.testingPump = null; });
    return this.testingPump;
  }

  async claimTradingTest() {
    const fingerprint = await this.tradingTestingFingerprint();
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('trading-test-queue',0))");
      await db.query(`UPDATE avis_core_v2.trading_test_runs SET status='FAILED',error_code='TRADING_TEST_INTERRUPTED',completed_at=now()
        WHERE status='RUNNING' AND lease_expires_at<=now()`);
      // A rolling deployment may have workers from two revisions. Leave a fresh
      // request for its matching worker; retire orphaned revisions after a bounded
      // wait longer than the full 20-job queue at its 75-second lease limit.
      await db.query(`UPDATE avis_core_v2.trading_test_runs SET status='FAILED',error_code='TRADING_TEST_CHANGED',completed_at=now()
        WHERE status='QUEUED' AND engine_fingerprint<>$1
          AND created_at<=now()-($2::double precision*interval '1 millisecond')`,
      [fingerprint, TRADING_TEST_LIMITS.maxRevisionWaitMs]);
      if ((await db.query("SELECT 1 FROM avis_core_v2.trading_test_runs WHERE status='RUNNING'")).rows.length) {
        await db.query('COMMIT');
        return null;
      }
      const run = (await db.query(`SELECT * FROM avis_core_v2.trading_test_runs
        WHERE status='QUEUED' AND engine_fingerprint=$1 ORDER BY created_at,run_id LIMIT 1 FOR UPDATE`, [fingerprint])).rows[0];
      if (run) {
        run.runner_token = randomUUID();
        await db.query(`UPDATE avis_core_v2.trading_test_runs SET status='RUNNING',started_at=now(),runner_token=$2,
          lease_expires_at=now()+interval '75 seconds' WHERE run_id=$1`, [run.run_id, run.runner_token]);
      }
      await db.query('COMMIT');
      return run || null;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  async drainTradingTests() {
    for (let i = 0; i < TRADING_TEST_LIMITS.maxQueued; i++) {
      const run = await this.claimTradingTest();
      if (!run) return;
      let report = null, errorCode = null;
      try {
        if (run.engine_fingerprint !== await this.tradingTestingFingerprint()) fault('TRADING_TEST_CHANGED');
        report = validateTradingTestReport(await this.tradingTestRunner(structuredClone(run.input)), run.input);
      } catch (error) {
        errorCode = Object.hasOwn(TRADING_TEST_MESSAGES, error.code) ? error.code : 'TRADING_TEST_PROCESS';
      }
      await this.pool.query(`UPDATE avis_core_v2.trading_test_runs SET status=$3,report=$4,error_code=$5,completed_at=now()
        WHERE run_id=$1 AND runner_token=$2 AND status='RUNNING'`, [run.run_id, run.runner_token,
        report?.status === 'PASSED' ? 'PASSED' : 'FAILED', report ? JSON.stringify(report) : null, errorCode]);
    }
  }

  async reviewTradingTest(actor, input, key) {
    actualAdmin(actor);
    if (!object(input) || Object.keys(input).some(k => k !== 'runId') || !uuid.test(input.runId)) inputFault('runId');
    return this.operation(actor, 'REVIEW_TRADING_TEST', input, key, async db => {
      const hint = (await db.query('SELECT robot_id FROM avis_core_v2.trading_test_runs WHERE run_id=$1', [input.runId])).rows[0];
      if (!hint) fault('TRADING_TEST_NOT_FOUND', 'runId', 404);
      if (!hint.robot_id) fault('TRADING_TEST_REVIEW', 'runId', 409);
      const robot = (await db.query(`SELECT r.* FROM avis_core_v2.trading_robots r JOIN avis_core_v2.sovereign_users u USING(user_id)
        WHERE robot_id=$1 AND u.account_role='INSTITUTION' FOR UPDATE OF r`, [hint.robot_id])).rows[0];
      const run = (await db.query('SELECT * FROM avis_core_v2.trading_test_runs WHERE run_id=$1 FOR UPDATE', [input.runId])).rows[0];
      if (!robot || !roundTripPassed(run)) fault('TRADING_TEST_REVIEW', 'runId', 409);
      const configurationHash = indexHash(await this.tradingTestConfiguration(db, robot));
      if (configurationHash !== run.configuration_hash || await this.tradingTestingFingerprint() !== run.engine_fingerprint) fault('TRADING_TEST_CHANGED', 'runId', 409);
      const existing = (await db.query('SELECT reviewed_at FROM avis_core_v2.trading_test_reviews WHERE run_id=$1', [run.run_id])).rows[0];
      let reviewedAt = existing?.reviewed_at;
      if (!existing) {
        reviewedAt = (await db.query(`INSERT INTO avis_core_v2.trading_test_reviews
          (run_id,robot_id,configuration_hash,engine_fingerprint,report_hash,reviewed_by)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING reviewed_at`, [run.run_id, robot.robot_id,
          configurationHash, run.engine_fingerprint, indexHash(run.report), actor.id])).rows[0].reviewed_at;
        // Review grants eligibility only. A separate explicit start is always required.
        await db.query('UPDATE avis_core_v2.trading_robots SET enabled=false,version=version+1 WHERE robot_id=$1 AND enabled', [robot.robot_id]);
      }
      return {id: run.run_id, runId: run.run_id, robotId: robot.robot_id, testReviewed: true, reviewedAt: timestamp(reviewedAt)};
    });
  }
}
