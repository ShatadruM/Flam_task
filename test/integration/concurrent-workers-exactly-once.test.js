import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '../../bin/queuectl.js');

let cwd;
let resultsFile;
let helperScript;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'queuectl-cli-'));
  resultsFile = path.join(cwd, 'results.txt');

  helperScript = path.join(cwd, 'append-helper.js');
  fs.writeFileSync(
    helperScript,
    `const fs = require('fs');\nconst [, , file, id] = process.argv;\nfs.appendFileSync(file, id + '\\n');\n`
  );
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function runCliSync(args) {
  return spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
}

function enqueueAppendJob(id) {
  const command = `node "${helperScript}" "${resultsFile}" "${id}"`;
  runCliSync(['enqueue', JSON.stringify({ id, command, max_retries: 1 })]);
}

function waitUntil(conditionFn, timeoutMs = 15000, intervalMs = 150) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (conditionFn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for condition'));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe('worker start --count N — exactly-once execution', () => {
  it('every job runs exactly once across multiple concurrent worker processes', async () => {
    const jobIds = Array.from({ length: 20 }, (_, i) => `job${i}`);
    for (const id of jobIds) enqueueAppendJob(id);

    const parent = spawn('node', [CLI_PATH, 'worker', 'start', '--count', '4'], { cwd });

    await waitUntil(() => {
      const jobs = JSON.parse(runCliSync(['list', '--state', 'completed', '--json']).stdout || '[]');
      return jobs.length === jobIds.length;
    });

    parent.kill('SIGTERM');
    await new Promise((resolve) => parent.on('exit', resolve));

    const lines = fs.readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.sort()).toEqual([...jobIds].sort());
    expect(new Set(lines).size).toBe(jobIds.length);
  }, 30000);
});