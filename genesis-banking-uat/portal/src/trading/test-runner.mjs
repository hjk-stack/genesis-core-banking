import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const TRADING_TEST_TIMEOUT_MS = 60_000;
export const TRADING_TEST_OUTPUT_BYTES = 2 * 1024 * 1024;
const runnerPath = fileURLToPath(new URL('../../trading/test_runner.py', import.meta.url));
const runnerDirectory = fileURLToPath(new URL('../../trading/', import.meta.url));

/** The fixed runner receives data only. No application credentials or connectors enter its process. */
export function runIsolatedTradingTest(input, {python = process.env.AVIS_TRADING_TEST_PYTHON || 'python3',
  timeoutMs = TRADING_TEST_TIMEOUT_MS, maxOutputBytes = TRADING_TEST_OUTPUT_BYTES,
  spawnProcess = spawn} = {}) {
  const bytes = Buffer.from(JSON.stringify(input));
  if (bytes.length > 2 * 1024 * 1024) return Promise.reject(Object.assign(new Error('TRADING_TEST_INPUT'), {code: 'TRADING_TEST_INPUT'}));
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, size = 0;
    const chunks = [];
    const fail = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.kill('SIGKILL');
      reject(Object.assign(new Error(code), {code}));
    };
    try {
      child = spawnProcess(python, ['-I', runnerPath], {
        cwd: runnerDirectory, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC',
          PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
          OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1',
        },
      });
    } catch {
      fail('TRADING_TEST_PROCESS');
      return;
    }
    timer = setTimeout(() => fail('TRADING_TEST_TIMEOUT'), timeoutMs);
    timer.unref?.();
    child.on('error', () => fail('TRADING_TEST_PROCESS'));
    child.stdin.on('error', () => fail('TRADING_TEST_PROCESS'));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxOutputBytes) return fail('TRADING_TEST_OUTPUT');
      chunks.push(chunk);
    });
    // Never echo subprocess diagnostics: persisted errors are fixed application codes.
    child.stderr.on('data', chunk => {
      size += chunk.length;
      if (size > maxOutputBytes) fail('TRADING_TEST_OUTPUT');
    });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return fail('TRADING_TEST_PROCESS');
      let report;
      try { report = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return fail('TRADING_TEST_OUTPUT'); }
      settled = true;
      clearTimeout(timer);
      resolve(report);
    });
    child.stdin.end(bytes);
  });
}
