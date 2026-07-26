import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '../../bin/queuectl.js');

let cwd;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'queuectl-cli-'));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function runCliSync(args) {
  return spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
}

function getJob(id) {
  const jobs = JSON.parse(runCliSync(['list', '--json']).stdout || '[]');
  return jobs.find((j) => j.id === id);
}

function waitFor(conditionFn, timeoutMs, intervalMs = 200) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const result = conditionFn();
      if (result) return resolve(result);
      if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for condition'));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe('SIGKILL crash recovery', () => {
  it('a job is never stuck in processing after its worker is SIGKILLed, and recovers within 60s', async () => {
    const slowCommand = `node -e "setTimeout(() => process.exit(0), 3000)"`;
    runCliSync(['enqueue', JSON.stringify({ id: 'job1', command: slowCommand, max_retries: 3 })]);

    const worker1 = spawn(
      'node',
      [CLI_PATH, 'worker', 'start', '--stale-timeout-ms', '2000'],
      { cwd }
    );

    await waitFor(() => getJob('job1')?.state === 'processing', 10000);

    worker1.kill('SIGKILL');

    const start = Date.now();

    const worker2 = spawn(
      'node',
      [CLI_PATH, 'worker', 'start', '--stale-timeout-ms', '2000'],
      { cwd }
    );

    await waitFor(() => {
      const job = getJob('job1');
      return job && job.state !== 'processing';
    }, 60000);

    const recoveredAt = Date.now();
    expect(recoveredAt - start).toBeLessThan(60000);

    await waitFor(() => getJob('job1')?.state === 'completed', 15000);

    worker2.kill('SIGTERM');
    await new Promise((resolve) => worker2.on('exit', resolve));
  }, 90000);

  it('recovers a crashed job so it eventually completes, and never leaves it stuck in processing', async () => {
    // Note: SIGKILL only kills the worker's own OS process, not any child
    // process it had already spawned via execSync for the in-flight job.
    // That means the job's underlying side effect could, in principle,
    // complete twice (once from the orphaned original child, once from the
    // recovery run) — this is a fundamental limit of crash recovery when the
    // executor can die at an arbitrary instant, not something this system
    // can fully close without the job command itself being idempotent. See
    // DECISIONS.md Q2. What we CAN and do guarantee: the job is never
    // permanently stuck in 'processing', and it does eventually complete.
    const resultsFile = path.join(cwd, 'results.txt');
    const helperScript = path.join(cwd, 'slow-append-helper.js');
    fs.writeFileSync(
      helperScript,
      `const fs = require('fs');\nconst [, , file] = process.argv;\nsetTimeout(() => fs.appendFileSync(file, 'ran\\n'), 3000);\n`
    );
    const slowAppendCommand = `node "${helperScript}" "${resultsFile}"`;

    runCliSync(['enqueue', JSON.stringify({ id: 'job1', command: slowAppendCommand, max_retries: 3 })]);

    const worker1 = spawn(
      'node',
      [CLI_PATH, 'worker', 'start', '--stale-timeout-ms', '2000'],
      { cwd }
    );

    await waitFor(() => getJob('job1')?.state === 'processing', 10000);
    worker1.kill('SIGKILL');

    const worker2 = spawn(
      'node',
      [CLI_PATH, 'worker', 'start', '--stale-timeout-ms', '2000'],
      { cwd }
    );

    await waitFor(() => getJob('job1')?.state === 'completed', 60000);
    worker2.kill('SIGTERM');
    await new Promise((resolve) => worker2.on('exit', resolve));

    // At least one execution definitely happened (the recovered run) —
    // that's the guarantee this system actually makes.
    const lines = fs.existsSync(resultsFile)
      ? fs.readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    expect(lines.length).toBeGreaterThanOrEqual(1);
  }, 90000);
});