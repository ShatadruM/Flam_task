import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { enqueueJob } from '../../src/jobs/enqueue.js';
import { runWorkerLoop, executeCommand } from '../../src/worker/run.js';

let dbPath;
let db;
let successScript;
let failScript;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `queuectl-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  db = await openDatabase(dbPath);
  await migrate(db);

  // node -e scripts, run cross-platform (works the same on Windows and Unix,
  // unlike shell builtins like `exit 1` or `false`).
  successScript = path.join(os.tmpdir(), `queuectl-success-${Date.now()}.js`);
  fs.writeFileSync(successScript, 'process.exit(0);');

  failScript = path.join(os.tmpdir(), `queuectl-fail-${Date.now()}.js`);
  fs.writeFileSync(failScript, 'process.exit(1);');
});

afterEach(async () => {
  await db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  fs.rmSync(successScript, { force: true });
  fs.rmSync(failScript, { force: true });
});

describe('executeCommand', () => {
  it('returns true for a command that exits 0', () => {
    expect(executeCommand(`node "${successScript}"`)).toBe(true);
  });

  it('returns false for a command that exits non-zero', () => {
    expect(executeCommand(`node "${failScript}"`)).toBe(false);
  });

  it('returns false for a command that does not exist', () => {
    expect(executeCommand('this-command-does-not-exist-xyz')).toBe(false);
  });
});

describe('runWorkerLoop', () => {
  it('claims and completes a successful job', async () => {
    await enqueueJob(db, { id: 'job1', command: `node "${successScript}"`, maxRetries: 3 });

    let iterations = 0;
    await runWorkerLoop(db, {
      workerId: 'worker-1',
      pollIntervalMs: 10,
      shouldContinue: () => iterations++ < 1,
    });

    const row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');
    expect(row.state).toBe('completed');
  });

  it('claims and fails a failing job', async () => {
    await enqueueJob(db, { id: 'job1', command: `node "${failScript}"`, maxRetries: 3 });

    let iterations = 0;
    await runWorkerLoop(db, {
      workerId: 'worker-1',
      pollIntervalMs: 10,
      shouldContinue: () => iterations++ < 1,
    });

    const row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');
    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(1);
  });

  it('processes multiple jobs across several loop iterations', async () => {
    await enqueueJob(db, { id: 'job1', command: `node "${successScript}"`, maxRetries: 3 });
    await enqueueJob(db, { id: 'job2', command: `node "${successScript}"`, maxRetries: 3 });

    let iterations = 0;
    await runWorkerLoop(db, {
      workerId: 'worker-1',
      pollIntervalMs: 10,
      shouldContinue: () => iterations++ < 2,
    });

    const rows = await db.all('SELECT state FROM jobs');
    expect(rows.every((r) => r.state === 'completed')).toBe(true);
  });
});