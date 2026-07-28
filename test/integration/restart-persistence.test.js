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

function getJobs() {
  return JSON.parse(runCliSync(['list', '--json']).stdout || '[]');
}

describe('persistence across a full restart', () => {
  it('preserves pending, completed, and dead job states with no processes left running', async () => {
    runCliSync(['config', 'set', 'backoff-base', '1']);

    runCliSync(['enqueue', JSON.stringify({ id: 'done1', command: 'echo hi' })]);
    runCliSync(['enqueue', JSON.stringify({ id: 'dead1', command: 'node -e "process.exit(1)"', max_retries: 1 })]);

    const worker = spawn('node', [CLI_PATH, 'worker', 'start'], { cwd });

    await waitFor(() => {
      const jobs = getJobs();
      const done = jobs.find((j) => j.id === 'done1');
      const dead = jobs.find((j) => j.id === 'dead1');
      return done?.state === 'completed' && dead?.state === 'dead';
    }, 15000);

    worker.kill('SIGTERM');
    await new Promise((resolve) => worker.on('exit', resolve));

    // Worker is fully stopped — nothing can claim this job now. Enqueueing
    // it here, rather than earlier, is what actually guarantees it stays
    // pending, instead of hoping the worker doesn't get to it in time.
    runCliSync(['enqueue', JSON.stringify({ id: 'pending1', command: 'echo hi' })]);

    const jobsAfterRestart = getJobs();

    expect(jobsAfterRestart.find((j) => j.id === 'pending1').state).toBe('pending');
    expect(jobsAfterRestart.find((j) => j.id === 'done1').state).toBe('completed');
    expect(jobsAfterRestart.find((j) => j.id === 'dead1').state).toBe('dead');

    const dlqRetry = runCliSync(['dlq', 'retry', 'dead1']);
    expect(dlqRetry.status).toBe(0);
    expect(getJobs().find((j) => j.id === 'dead1').attempts).toBe(0);
  }, 20000);
});