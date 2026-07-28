import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { enqueueJob } from '../../src/jobs/enqueue.js';
import { getStatusSummary } from '../../src/cli/status.js';
import { writePidFile, getWorkersDir } from '../../src/worker/pidfile.js';

let dbPath;
let db;
let workersDir;
let tmpBase;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `queuectl-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  db = await openDatabase(dbPath);
  await migrate(db);

  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'queuectl-status-'));
  workersDir = getWorkersDir(tmpBase);
});

afterEach(async () => {
  await db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('getStatusSummary', () => {
  it('returns zero counts and zero active workers when the system is empty', async () => {
    const summary = await getStatusSummary(db, { workersDir });
    expect(summary.counts).toEqual({
      pending: 0, processing: 0, completed: 0, failed: 0, dead: 0,
    });
    expect(summary.activeWorkers).toBe(0);
  });

  it('counts jobs correctly per state', async () => {
    await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 3 });
    await enqueueJob(db, { id: 'job2', command: 'echo hi', maxRetries: 3 });
    await db.run("UPDATE jobs SET state = 'completed' WHERE id = 'job2'");

    const summary = await getStatusSummary(db, { workersDir });
    expect(summary.counts.pending).toBe(1);
    expect(summary.counts.completed).toBe(1);
  });

  it('counts a live process as an active worker', async () => {
    const child = spawn('sleep', ['30']);
    writePidFile(child.pid, workersDir);

    const summary = await getStatusSummary(db, { workersDir });
    expect(summary.activeWorkers).toBe(1);

    child.kill('SIGKILL');
  });

  it('does not count a stale pid file whose process is dead', async () => {
    writePidFile(999999, workersDir); // not a real pid
    const summary = await getStatusSummary(db, { workersDir });
    expect(summary.activeWorkers).toBe(0);
  });
});