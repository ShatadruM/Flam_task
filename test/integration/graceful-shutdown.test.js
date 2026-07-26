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

function waitForJobState(id, expectedStates, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const jobs = JSON.parse(runCliSync(['list', '--json']).stdout || '[]');
      const job = jobs.find((j) => j.id === id);
      if (job && expectedStates.includes(job.state)) return resolve(job);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out waiting for "${id}" to reach [${expectedStates}], last seen: ${job?.state}`));
      }
      setTimeout(poll, 150);
    };
    poll();
  });
}

describe('worker start — graceful shutdown', () => {
  it('finishes the in-flight job before exiting on SIGTERM', async () => {
    const jobCommand = `node -e "setTimeout(() => process.exit(0), 1500)"`;
    runCliSync(['enqueue', JSON.stringify({ id: 'slow1', command: jobCommand, max_retries: 3 })]);

    const workerProc = spawn('node', [CLI_PATH, 'worker', 'start'], { cwd });

    await waitForJobState('slow1', ['processing']);
    workerProc.kill('SIGTERM');

    const exitCode = await new Promise((resolve) => workerProc.on('exit', resolve));
    expect(exitCode).toBe(0);

    const jobs = JSON.parse(runCliSync(['list', '--json']).stdout);
    expect(jobs.find((j) => j.id === 'slow1').state).toBe('completed');
  }, 15000);
}); 