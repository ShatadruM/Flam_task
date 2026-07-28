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

describe('status (CLI, real process)', () => {
  it('reports job counts and zero active workers when nothing is running', () => {
    runCliSync(['enqueue', JSON.stringify({ id: 'job1', command: 'echo hi' })]);

    const result = runCliSync(['status', '--json']);
    expect(result.status).toBe(0);

    const summary = JSON.parse(result.stdout);
    expect(summary.counts.pending).toBe(1);
    expect(summary.activeWorkers).toBe(0);
  });

  it('reports an active worker while one is running', async () => {
    const worker = spawn('node', [CLI_PATH, 'worker', 'start'], { cwd });

    await waitFor(() => {
      const summary = JSON.parse(runCliSync(['status', '--json']).stdout);
      return summary.activeWorkers === 1;
    }, 5000);

    worker.kill('SIGTERM');
    await new Promise((resolve) => worker.on('exit', resolve));
  }, 10000);
});