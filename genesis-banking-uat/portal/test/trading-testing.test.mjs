import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {TradingTestingCore, validateTradingTestReport} from '../src/trading-testing.mjs';
import {runIsolatedTradingTest} from '../src/trading/test-runner.mjs';
import {migrate} from '../src/migrate.mjs';

const admin = {id: 'trading-test-admin', admin: true};
const customer = {id: 'trading-test-customer', admin: false, customerUserId: '2'};
const key = () => randomUUID();
let pool, database, core, robotId, legacyRobotId, calls = 0, captured;
const dataset = () => ({ticks: [{tsMicros: 1_000_000, bid: 100, ask: 100.01, bidSize: 2, askSize: 1, sellVolume: 0}],
  indices: [{atMicros: 900_000, index: {instrumentId: 'BTC', score: 30, confidence: 0.8, sourceCount: 3,
    generatedAtMs: 800, validUntilMs: 180000, sequence: 'test-observation'}}]});

// Only dependency-injected unit tests use this report. Production always launches the actual pinned Python engine.
function fixtureReport(input, patch = {}) {
  const cash = input.initialCash || '10000';
  const orders = ['BUY', 'SELL'].map((side, i) => ({id: 'order-' + i, signalId: String(i).repeat(64),
    tsMicros: 1_000_000 + i, side, requestedQuantity: '1', limitPrice: '100', filledQuantity: '1',
    status: 'FILLED', reason: null, type: 'LIMIT', timeInForce: 'IOC'}));
  return {schemaVersion: 1, engine: 'NautilusTrader', engineVersion: '1.231.0', mode: input.mode,
    status: 'PASSED', complete: true, checks: [{id: 'ISOLATED_ACCOUNTING', label: 'Isolated accounting', passed: true, detail: 'Injected deterministic regression report.'}],
    metrics: {ticksProcessed: 250, indexObservationsUsed: 1, ordersGenerated: 2, filledOrders: 2,
      rejectedOrders: 0, partialFills: 0, duplicateSignalsIgnored: 0, buyFills: 1, sellFills: 1, openOrders: 0,
      initialCash: cash, finalCash: cash, finalPosition: '0', costBasis: '0', realisedPnl: '0', unrealisedPnl: '0',
      fees: '0', finalEquity: cash, drawdown: '0', drawdownFraction: '0', ordersTruncated: 0, fillsTruncated: 0},
    orders, fills: orders.map((o, i) => ({orderId: o.id, tsMicros: o.tsMicros, side: o.side,
      quantity: '1', price: '100', notional: '100', fee: '0', cashAfter: String(Number(cash) - (i ? 0 : 100)), positionAfter: i ? '0' : '1'})),
    assumptions: {virtualCash: true}, ...patch};
}

before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname, '/avispay_ci');
    pool = new pg.Pool({connectionString: process.env.TEST_DATABASE_URL});
    await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');
  } else {
    database = new PGlite();
    pool = {query: (...args) => database.query(...args), connect: async () => ({query: (...args) => database.query(...args), exec: sql => database.exec(sql), release() {}})};
  }
  const client = await pool.connect();
  legacyRobotId = randomUUID();
  const insertLegacyProfile = async sql => {
    if (!sql.startsWith('CREATE TABLE avis_core_v2.trading_test_runs')) return;
    await client.query(`INSERT INTO avis_core_v2.trading_robots
      (robot_id,name,user_id,venue,symbol,index_id,enabled,max_notional,daily_notional,max_loss,trailing_bps,quantity_step,price_tick,position_quantity,stop_price,peak_price)
      VALUES($1,'Existing entry flag',1,'AVIS','LEGACY','LEGACY',true,1000,10000,1000,50,1,0.01,3,90,105)`, [legacyRobotId]);
  };
  const migrationClient = {
    query: async (sql, ...args) => { await insertLegacyProfile(sql); return client.query(sql, ...args); },
    ...(client.exec ? {exec: async sql => { await insertLegacyProfile(sql); return client.exec(sql); }} : {}),
  };
  try { await migrate(migrationClient); } finally { client.release(); }
  core = new TradingTestingCore(pool, {secretEnv: {TRADING_PRIVATE_KEY: 'not-for-runner'}, tradingTestRunner: async input => {
    calls++;
    captured = input;
    return fixtureReport(input);
  }});
  robotId = randomUUID();
  await pool.query(`INSERT INTO avis_core_v2.trading_robots
    (robot_id,name,user_id,venue,symbol,index_id,key_ref,max_notional,daily_notional,max_loss,minimum_index,trailing_bps,quantity_step,price_tick,base_asset,quote_asset,position_quantity,cost_basis)
    VALUES($1,'Isolated test profile',1,'BINANCE','BTCUSDT','BTC','TRADING_PRIVATE','1000','10000','1000',0,50,'0.001','0.01','BTC','USDT','7','700')`, [robotId]);
});
after(async () => {
  await core?.processTradingTests();
  if (database) await database.close(); else await pool.end();
});
const robot = async () => (await pool.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=$1', [robotId])).rows[0];
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
async function completed(input, selected = core, idempotencyKey = key()) {
  const result = await selected.runTradingTest(admin, input, idempotencyKey);
  await selected.processTradingTests();
  const run = (await selected.tradingTesting(admin)).runs.find(r => r.runId === result.runId);
  return {result, run};
}
async function financialSnapshot() {
  return {
    accounts: (await pool.query('SELECT account_id,available_balance,locked_balance FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows,
    journals: (await pool.query('SELECT journal_id FROM avis_core_v2.ledger_journals ORDER BY journal_id')).rows,
    orders: (await pool.query('SELECT id FROM avis_core_v2.trading_robot_orders ORDER BY id')).rows,
    robot: await robot(),
  };
}

test('testing metadata and actions require an actual administrator, including service and customer-workspace denial', async () => {
  for (const actor of [customer, {...admin, customerUserId: '2'}, {...admin, indexService: true}, null]) {
    await rejected(core.tradingTesting(actor), 'FORBIDDEN');
    await rejected(core.runTradingTest(actor, {mode: 'ACCEPTANCE'}, key()), 'FORBIDDEN');
    await rejected(core.reviewTradingTest(actor, {runId: randomUUID()}, key()), 'FORBIDDEN');
  }
});

test('the migration pauses existing entry flags while retaining position and trailing-stop state', async () => {
  const legacy = (await pool.query('SELECT * FROM avis_core_v2.trading_robots WHERE robot_id=$1', [legacyRobotId])).rows[0];
  assert.equal(legacy.enabled, false);
  assert.equal(legacy.version, 2);
  assert.equal(Number(legacy.position_quantity), 3);
  assert.equal(Number(legacy.stop_price), 90);
  assert.equal(Number(legacy.peak_price), 105);
});

test('unbound acceptance works without venue credentials and cannot approve a robot', async () => {
  const before = await financialSnapshot();
  const {run} = await completed({mode: 'ACCEPTANCE'});
  assert.equal(run.status, 'PASSED');
  assert.equal(run.robotId, null);
  assert.equal(run.reviewEligible, false);
  await rejected(core.reviewTradingTest(admin, {runId: run.runId}, key()), 'TRADING_TEST_REVIEW');
  assert.deepEqual(await financialSnapshot(), before);
  assert.equal(await core.tradingTestReviewed(pool, await robot()), false);
});

test('profile replay copies only strategy settings, resets virtual positions and never changes accounts or entry flags', async () => {
  const before = await financialSnapshot();
  const {run} = await completed({robotId, mode: 'REPLAY', dataset: dataset(), initialCash: '5000', feeBps: 8, slippageBps: 3});
  assert.equal(run.status, 'PASSED');
  assert.equal(run.reviewEligible, true);
  assert.equal(captured.settings.positionQuantity, '0');
  assert.equal(captured.settings.stopPrice, '0');
  assert.equal(captured.initialCash, '5000');
  assert.equal(captured.settings.maxNotional, '1000');
  assert.equal(captured.settings.symbol, 'BTCUSDT');
  for (const field of ['keyRef', 'accountId', 'userId', 'key_ref', 'secretEnv']) assert.equal(Object.hasOwn(captured.settings, field), false);
  assert.equal(JSON.stringify(captured).includes('not-for-runner'), false);
  assert.deepEqual(await financialSnapshot(), before);
  await rejected(core.assertTradingTestReviewed(pool, await robot()), 'TRADING_TEST_REVIEW_REQUIRED');
});

test('idempotent requests execute once and reject a changed payload under the same key', async () => {
  const before = calls, input = {robotId, mode: 'REPLAY', dataset: dataset()}, token = key();
  const first = await completed(input, core, token);
  const second = await completed(input, core, token);
  assert.deepEqual(second.result, first.result);
  assert.equal(calls, before + 1);
  await rejected(core.runTradingTest(admin, {...input, initialCash: '2500'}, token), 'IDEMPOTENCY_CONFLICT');
});

test('a distinct explicit review binds the current configuration and does not start or alter holdings', async () => {
  const {run} = await completed({robotId, mode: 'REPLAY', dataset: dataset()});
  const before = await financialSnapshot(), token = key();
  const review = await core.reviewTradingTest(admin, {runId: run.runId}, token);
  assert.equal(review.testReviewed, true);
  assert.deepEqual(await core.reviewTradingTest(admin, {runId: run.runId}, token), review);
  assert.equal(await core.tradingTestReviewed(pool, await robot()), true);
  assert.deepEqual(await financialSnapshot(), before);
  const profile = (await core.tradingTesting(admin)).profiles.find(p => p.robotId === robotId);
  assert.equal(profile.reviewedRunId, run.runId);
  assert.equal(profile.testReviewed, true);
});

test('config or implementation changes invalidate review while toggle/version/position changes do not change the configuration fingerprint', async () => {
  const {run} = await completed({robotId, mode: 'REPLAY', dataset: dataset()});
  await core.reviewTradingTest(admin, {runId: run.runId}, key());
  await pool.query('UPDATE avis_core_v2.trading_robots SET version=version+1,position_quantity=8,cost_basis=800 WHERE robot_id=$1', [robotId]);
  assert.equal(await core.tradingTestReviewed(pool, await robot()), true);
  await pool.query('UPDATE avis_core_v2.trading_robots SET max_notional=999 WHERE robot_id=$1', [robotId]);
  await rejected(core.assertTradingTestReviewed(pool, await robot()), 'TRADING_TEST_REVIEW_REQUIRED');
  await rejected(core.reviewTradingTest(admin, {runId: run.runId}, key()), 'TRADING_TEST_CHANGED');
  await pool.query('UPDATE avis_core_v2.trading_robots SET max_notional=1000 WHERE robot_id=$1', [robotId]);
  const changedCode = new TradingTestingCore(pool, {tradingTestRunner: async input => fixtureReport(input)});
  changedCode.tradingTestingFingerprint = async () => 'f'.repeat(64);
  assert.equal(await changedCode.tradingTestReviewed(pool, await robot()), false);
  await rejected(changedCode.reviewTradingTest(admin, {runId: run.runId}, key()), 'TRADING_TEST_CHANGED');
});

test('reviewing a newly completed run pauses a retained entry flag and preserves all position and stop state', async () => {
  const {run} = await completed({robotId, mode: 'REPLAY', dataset: dataset()});
  await pool.query('UPDATE avis_core_v2.trading_robots SET enabled=true,stop_price=90,peak_price=110 WHERE robot_id=$1', [robotId]);
  const before = await robot();
  await core.reviewTradingTest(admin, {runId: run.runId}, key());
  const after = await robot();
  assert.equal(after.enabled, false);
  assert.equal(after.version, before.version + 1);
  for (const field of ['position_quantity', 'cost_basis', 'stop_price', 'peak_price']) assert.equal(after[field], before[field]);
});

test('bound acceptance, no-entry replays, open positions and incomplete reports cannot grant a review', async () => {
  const acceptance = await completed({robotId, mode: 'ACCEPTANCE'});
  assert.equal(acceptance.run.reviewEligible, false);
  await rejected(core.reviewTradingTest(admin, {runId: acceptance.run.runId}, key()), 'TRADING_TEST_REVIEW');
  for (const patch of [{buyFills: 0}, {finalPosition: '1'}, {fillsTruncated: 1}]) {
    const selected = new TradingTestingCore(pool, {tradingTestRunner: async input => {
      const report = fixtureReport(input); Object.assign(report.metrics, patch); return report;
    }});
    const {run} = await completed({robotId, mode: 'REPLAY', dataset: dataset()}, selected);
    assert.equal(run.reviewEligible, false);
    await rejected(selected.reviewTradingTest(admin, {runId: run.runId}, key()), 'TRADING_TEST_REVIEW');
  }
  const selected = new TradingTestingCore(pool, {tradingTestRunner: async input => fixtureReport(input, {complete: false})});
  const {run} = await completed({robotId, mode: 'REPLAY', dataset: dataset()}, selected);
  assert.equal(run.status, 'FAILED');
  assert.equal(run.errorCode, 'TRADING_TEST_OUTPUT');
});

test('invalid replay data, nonfinite economics and caller-supplied connector settings fail before enqueue', async () => {
  const before = calls;
  for (const input of [
    {mode: 'OTHER'}, {mode: 'REPLAY'}, {mode: 'ACCEPTANCE', dataset: dataset()},
    {mode: 'REPLAY', dataset: {...dataset(), ticks: []}},
    {mode: 'REPLAY', dataset: {...dataset(), ticks: Array(10001).fill(dataset().ticks[0])}},
    {mode: 'REPLAY', dataset: {...dataset(), ticks: [{...dataset().ticks[0], bid: Infinity}]}},
    {mode: 'REPLAY', dataset: {...dataset(), ticks: [{...dataset().ticks[0], receivedAtMicros: 1}]}},
    {mode: 'REPLAY', dataset: {...dataset(), ticks: [{...dataset().ticks[0], receivedAtMicros: null}]}},
    {mode: 'REPLAY', dataset: {...dataset(), indices: [{...dataset().indices[0], index: {...dataset().indices[0].index, generatedAtMs: 999999}}]}},
    {mode: 'REPLAY', dataset: {...dataset(), indices: [{...dataset().indices[0], index: {...dataset().indices[0].index, sourceCount: 10001}}]}},
    {mode: 'ACCEPTANCE', feeBps: -1}, {mode: 'ACCEPTANCE', slippageBps: NaN},
    {mode: 'ACCEPTANCE', initialCash: '0'}, {mode: 'ACCEPTANCE', initialCash: null},
    {mode: 'ACCEPTANCE', feeBps: null}, {mode: 'ACCEPTANCE', keyRef: 'TRADING_PRIVATE'},
  ]) await rejected(core.runTradingTest(admin, input, key()), 'TRADING_TEST_INPUT');
  await rejected(core.runTradingTest(admin, {robotId: randomUUID(), mode: 'ACCEPTANCE'}, key()), 'TRADING_TEST_PROFILE');
  assert.equal(calls, before);
});

test('replay intake preserves multiple ticks sharing the same recorded arrival', async () => {
  const replay = dataset();
  replay.ticks = [1_000_000, 1_000_001].map(tsMicros => ({...replay.ticks[0], tsMicros, receivedAtMicros: 1_000_002}));
  const {run} = await completed({mode: 'REPLAY', dataset: replay});
  assert.equal(run.status, 'PASSED');
  assert.deepEqual(captured.dataset.ticks.map(t => t.receivedAtMicros), [1_000_002, 1_000_002]);
});

test('the actual pinned Python engine completes a bound replay, and explicit review alone grants eligibility', async () => {
  const selected = new TradingTestingCore(pool);
  await pool.query('UPDATE avis_core_v2.trading_robots SET max_notional=900 WHERE robot_id=$1', [robotId]);
  await rejected(selected.assertTradingTestReviewed(pool, await robot()), 'TRADING_TEST_REVIEW_REQUIRED');
  const start = 1_800_000_000_000_000;
  const ticks = Array.from({length: 250}, (_, i) => {
    let mid = 101 + Math.sin(i) * 0.05;
    if (i >= 80 && i < 160) mid = 101.5 + Math.sin(i) * 0.05;
    if (i >= 160 && i < 240) mid = 100.5 + Math.sin(i) * 0.05;
    if (i === 60) mid = 99;
    if (i === 120) mid = 102;
    if (i === 200) mid = 99.1;
    if (i >= 240) mid = 101.7 + (i - 240) * 0.045;
    return {tsMicros: start + i * 1000, bid: Number((mid - 0.01).toFixed(5)), ask: Number((mid + 0.01).toFixed(5)),
      bidSize: 2, askSize: 1, sellVolume: i >= 56 && i <= 64 ? 10 : i >= 196 && i <= 204 ? 0.5 : 1};
  });
  ticks.push({...ticks.at(-1), tsMicros: ticks.at(-1).tsMicros + 6_000_000, bid: 98, ask: 98.01});
  const indices = [{atMicros: start, index: {instrumentId: 'BTC', score: 30, confidence: 0.8, sourceCount: 3,
    generatedAtMs: start / 1000, validUntilMs: start / 1000 + 180000, sequence: 'recorded-replay-index'}}];
  const before = await financialSnapshot();
  try {
    const {run} = await completed({robotId, mode: 'REPLAY', initialCash: '10000', feeBps: 0, slippageBps: 0,
      dataset: {ticks, indices}}, selected);
    assert.equal(run.status, 'PASSED', JSON.stringify({error: run.errorCode, checks: run.report?.checks}));
    assert.equal(run.report.engineVersion, '1.231.0');
    assert.ok(run.report.metrics.buyFills > 0);
    assert.ok(run.report.metrics.sellFills > 0);
    assert.equal(run.report.metrics.finalPosition, '0');
    assert.equal(run.reviewEligible, true);
    await rejected(selected.assertTradingTestReviewed(pool, await robot()), 'TRADING_TEST_REVIEW_REQUIRED');
    await selected.reviewTradingTest(admin, {runId: run.runId}, key());
    await selected.assertTradingTestReviewed(pool, await robot());
    assert.deepEqual(await financialSnapshot(), before);
  } finally {
    await pool.query('UPDATE avis_core_v2.trading_robots SET max_notional=1000 WHERE robot_id=$1', [robotId]);
  }
});

test('runner failure is persisted with a bounded fixed diagnostic and cannot be reviewed', async () => {
  const selected = new TradingTestingCore(pool, {tradingTestRunner: async () => { throw Error('private credential should never be recorded'); }});
  const {run} = await completed({robotId, mode: 'REPLAY', dataset: dataset()}, selected);
  assert.equal(run.status, 'FAILED');
  assert.equal(run.errorCode, 'TRADING_TEST_PROCESS');
  assert.equal(run.report, null);
  assert.equal(JSON.stringify(run).includes('private credential'), false);
  await rejected(selected.reviewTradingTest(admin, {runId: run.runId}, key()), 'TRADING_TEST_REVIEW');
});

test('terminal reports, original inputs and reviews are immutable', async () => {
  const {run} = await completed({robotId, mode: 'REPLAY', dataset: dataset()});
  await core.reviewTradingTest(admin, {runId: run.runId}, key());
  await assert.rejects(pool.query("UPDATE avis_core_v2.trading_test_runs SET report='{}' WHERE run_id=$1", [run.runId]), /TRADING_TEST_HISTORY_IMMUTABLE/);
  await assert.rejects(pool.query("UPDATE avis_core_v2.trading_test_runs SET configuration_hash=$2 WHERE run_id=$1", [run.runId, '0'.repeat(64)]), /TRADING_TEST_HISTORY_IMMUTABLE/);
  await assert.rejects(pool.query('DELETE FROM avis_core_v2.trading_test_reviews WHERE run_id=$1', [run.runId]));
});

test('an interrupted running lease becomes a terminal failure and is never executed twice', async () => {
  const source = (await pool.query('SELECT * FROM avis_core_v2.trading_test_runs ORDER BY created_at LIMIT 1')).rows[0];
  const runId = randomUUID(), before = calls;
  await pool.query(`INSERT INTO avis_core_v2.trading_test_runs
    (run_id,robot_id,profile_name,mode,configuration,configuration_hash,engine_fingerprint,dataset_hash,input,created_by,status,runner_token,started_at,lease_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'interrupted-regression','RUNNING',$10,now()-interval '2 minutes',now()-interval '1 second')`,
  [runId, source.robot_id, source.profile_name, source.mode, JSON.stringify(source.configuration), source.configuration_hash,
    source.engine_fingerprint, source.dataset_hash, JSON.stringify(source.input), randomUUID()]);
  await core.processTradingTests();
  const run = (await core.tradingTesting(admin)).runs.find(r => r.runId === runId);
  assert.equal(run.status, 'FAILED');
  assert.equal(run.errorCode, 'TRADING_TEST_INTERRUPTED');
  assert.equal(run.reviewEligible, false);
  assert.ok(run.completedAt);
  assert.equal(calls, before);
});

test('the pending queue is bounded and draining processes each immutable request once', async () => {
  const queued = new TradingTestingCore(pool, {tradingTestRunner: async input => fixtureReport(input)});
  queued.processTradingTests = async () => {};
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push((await queued.runTradingTest(admin, {mode: 'ACCEPTANCE'}, key())).runId);
  await rejected(queued.runTradingTest(admin, {mode: 'ACCEPTANCE'}, key()), 'TRADING_TEST_QUEUE');
  const before = calls;
  await core.processTradingTests();
  assert.equal(calls, before + 20);
  const runs = (await pool.query('SELECT status FROM avis_core_v2.trading_test_runs WHERE run_id=ANY($1::uuid[])', [ids])).rows;
  assert.equal(runs.length, 20);
  assert.ok(runs.every(r => r.status === 'PASSED'));
});

test('rolling-deployment workers claim only their implementation fingerprint, even with the same engine version', async () => {
  let oldExecutions = 0, newExecutions = 0;
  const oldWorker = new TradingTestingCore(pool, {tradingTestRunner: async input => { oldExecutions++; return fixtureReport(input); }});
  const newWorker = new TradingTestingCore(pool, {tradingTestRunner: async input => { newExecutions++; return fixtureReport(input); }});
  oldWorker.tradingTestingFingerprint = async () => 'a'.repeat(64);
  newWorker.tradingTestingFingerprint = async () => 'b'.repeat(64);
  oldWorker.processTradingTests = newWorker.processTradingTests = async () => {};
  const input = {robotId, mode: 'REPLAY', dataset: dataset()}, requestKey = key();
  const newer = await newWorker.runTradingTest(admin, input, requestKey);
  const older = await oldWorker.runTradingTest(admin, input, key());
  const before = await financialSnapshot();
  await oldWorker.drainTradingTests();
  const untouched = (await pool.query('SELECT * FROM avis_core_v2.trading_test_runs WHERE run_id=$1', [newer.runId])).rows[0];
  assert.equal(untouched.status, 'QUEUED'); assert.equal(untouched.started_at, null); assert.equal(untouched.runner_token, null);
  assert.equal(oldExecutions, 1); assert.equal(newExecutions, 0);
  await newWorker.drainTradingTests();
  const rows = (await pool.query('SELECT * FROM avis_core_v2.trading_test_runs WHERE run_id=ANY($1::uuid[])', [[older.runId, newer.runId]])).rows;
  assert.ok(rows.every(run => run.status === 'PASSED' && run.report.engineVersion === '1.231.0'));
  assert.equal(rows.find(run => run.run_id === older.runId).engine_fingerprint, 'a'.repeat(64));
  assert.equal(rows.find(run => run.run_id === newer.runId).engine_fingerprint, 'b'.repeat(64));
  assert.deepEqual(await newWorker.runTradingTest(admin, input, requestKey), newer);
  await newWorker.drainTradingTests();
  assert.equal(oldExecutions, 1); assert.equal(newExecutions, 1);
  await rejected(oldWorker.reviewTradingTest(admin, {runId: newer.runId}, key()), 'TRADING_TEST_CHANGED');
  assert.deepEqual(await financialSnapshot(), before);
});

test('an incompatible queued revision expires without a runner claim or execution after its bounded wait', async () => {
  const source = (await pool.query('SELECT * FROM avis_core_v2.trading_test_runs ORDER BY created_at LIMIT 1')).rows[0];
  const runId = randomUUID(), before = calls;
  await pool.query(`INSERT INTO avis_core_v2.trading_test_runs
    (run_id,robot_id,profile_name,mode,configuration,configuration_hash,engine_fingerprint,dataset_hash,input,created_by,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'orphaned-revision-regression',now()-interval '31 minutes')`,
  [runId, source.robot_id, source.profile_name, source.mode, JSON.stringify(source.configuration), source.configuration_hash,
    'e'.repeat(64), source.dataset_hash, JSON.stringify(source.input)]);
  await core.processTradingTests();
  const run = (await pool.query('SELECT * FROM avis_core_v2.trading_test_runs WHERE run_id=$1', [runId])).rows[0];
  assert.equal(run.status, 'FAILED'); assert.equal(run.error_code, 'TRADING_TEST_CHANGED');
  assert.equal(run.started_at, null); assert.equal(run.runner_token, null); assert.equal(run.report, null);
  assert.ok(run.completed_at); assert.equal(calls, before);
});

test('report validation rejects fake engines, failed checks labelled passed and unbounded output', () => {
  const input = {mode: 'REPLAY', initialCash: '10000'}, report = fixtureReport(input);
  for (const patch of [{engine: 'fake'}, {engineVersion: '0'}, {mode: 'ACCEPTANCE'}, {complete: false},
    {checks: [{id: 'BAD', label: 'Bad', passed: false, detail: 'Failed'}]},
    {orders: Array(1001).fill(report.orders[0])}, {assumptions: {oversized: 'x'.repeat(2 * 1024 * 1024)}}]) {
    assert.throws(() => validateTradingTestReport({...report, ...patch}, input), error => error.code === 'TRADING_TEST_OUTPUT');
  }
});

function childFixture(onEnd) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.stdin = new Writable({write(chunk, encoding, callback) { callback(); }, final(callback) { callback(); queueMicrotask(() => onEnd?.(child)); }});
  return child;
}

test('the production spawn contract has a fixed path, no shell and no inherited application credentials', async () => {
  let observed;
  const report = fixtureReport({mode: 'ACCEPTANCE'});
  const result = await runIsolatedTradingTest({mode: 'ACCEPTANCE'}, {python: '/fixed/python', spawnProcess: (python, args, options) => {
    observed = {python, args, options};
    return childFixture(child => { child.stdout.write(JSON.stringify(report)); child.emit('close', 0); });
  }});
  assert.deepEqual(result, report);
  assert.equal(observed.python, '/fixed/python');
  assert.equal(observed.args[0], '-I');
  assert.ok(observed.args[1].endsWith('/trading/test_runner.py'));
  assert.equal(observed.options.shell, false);
  assert.deepEqual(Object.keys(observed.options.env).sort(), ['LANG', 'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED', 'TZ'].sort());
});

test('spawn deadlines and output caps terminate only the isolated child and emit fixed error codes', async () => {
  let large, stalled;
  await rejected(runIsolatedTradingTest({}, {maxOutputBytes: 20, spawnProcess: () => (large = childFixture(child => child.stdout.write('x'.repeat(21))))}), 'TRADING_TEST_OUTPUT');
  assert.equal(large.killed, true);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await rejected(runIsolatedTradingTest({}, {timeoutMs: 10, spawnProcess: () => (stalled = childFixture())}), 'TRADING_TEST_TIMEOUT');
    assert.equal(stalled.killed, true);
  } finally { clearTimeout(keepAlive); }
});

test('PostgreSQL concurrent pumps claim a queued run once', {skip: !process.env.TEST_DATABASE_URL}, async () => {
  let executions = 0;
  const input = {mode: 'ACCEPTANCE'};
  const selected = new TradingTestingCore(pool, {tradingTestRunner: async value => { executions++; return fixtureReport(value); }});
  const other = new TradingTestingCore(pool, {tradingTestRunner: async value => { executions++; return fixtureReport(value); }});
  const run = await selected.runTradingTest(admin, input, key());
  await Promise.all([selected.processTradingTests(), other.processTradingTests()]);
  assert.equal(executions, 1);
  assert.equal((await selected.tradingTesting(admin)).runs.find(r => r.runId === run.runId).status, 'PASSED');
});
