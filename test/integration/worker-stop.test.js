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

function pidDir() {
  return path.join(cwd, '.queuectl', 'workers');
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

describe('worker stop (cross-process)', () => {
  it('stops a single worker started in another process', async () => {
    const worker = spawn('node', [CLI_PATH, 'worker', 'start'], { cwd });

    await waitFor(() => fs.existsSync(pidDir()) && fs.readdirSync(pidDir()).length === 1, 5000);

    // Run `worker stop` as its own separate process — matches the
    // interface contract requirement directly.
    const stopResult = runCliSync(['worker', 'stop']);
    expect(stopResult.status).toBe(0);

    const exitCode = await new Promise((resolve) => worker.on('exit', resolve));
    expect(exitCode).toBe(0);
    expect(fs.readdirSync(pidDir())).toHaveLength(0);
  }, 15000);

  it('stops all workers started via --count N', async () => {
    const parent = spawn('node', [CLI_PATH, 'worker', 'start', '--count', '3'], { cwd });

    await waitFor(() => fs.existsSync(pidDir()) && fs.readdirSync(pidDir()).length === 3, 10000);

    const stopResult = runCliSync(['worker', 'stop']);
    expect(stopResult.status).toBe(0);

    await new Promise((resolve) => parent.on('exit', resolve));
    expect(fs.readdirSync(pidDir())).toHaveLength(0);
  }, 20000);

  it('reports no running workers when none are active', () => {
    const result = runCliSync(['worker', 'stop']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/No running workers/);
  });

  it('finishes an in-flight job before exiting when stopped from another process', async () => {
    const slowCommand = `node -e "setTimeout(() => process.exit(0), 1500)"`;
    runCliSync(['enqueue', JSON.stringify({ id: 'slow1', command: slowCommand, max_retries: 3 })]);

    const worker = spawn('node', [CLI_PATH, 'worker', 'start'], { cwd });

    await waitFor(() => {
      const jobs = JSON.parse(runCliSync(['list', '--json']).stdout || '[]');
      return jobs.find((j) => j.id === 'slow1')?.state === 'processing';
    }, 5000);

    runCliSync(['worker', 'stop']);
    await new Promise((resolve) => worker.on('exit', resolve));

    const jobs = JSON.parse(runCliSync(['list', '--json']).stdout || '[]');
    expect(jobs.find((j) => j.id === 'slow1').state).toBe('completed');
  }, 15000);
});