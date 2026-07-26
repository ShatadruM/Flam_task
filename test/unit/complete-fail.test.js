import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { enqueueJob } from '../../src/jobs/enqueue.js';
import { claimNextJob } from '../../src/jobs/claim.js';
import { completeJob } from '../../src/jobs/complete.js';
import { failJob } from '../../src/jobs/fail.js';

let dbPath;
let db;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `queuectl-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  db = await openDatabase(dbPath);
  await migrate(db);
  await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 3 });
  await claimNextJob(db, 'worker-1');
});

afterEach(async () => {
  await db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
});

describe('completeJob', () => {
  it('sets state to completed and clears worker fields', async () => {
    await completeJob(db, 'job1');
    const row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');

    expect(row.state).toBe('completed');
    expect(row.worker_id).toBeNull();
    expect(row.claimed_at).toBeNull();
  });
});

describe('failJob', () => {
  it('sets state to failed and increments attempts', async () => {
    await failJob(db, 'job1');
    const row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');

    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.worker_id).toBeNull();
    expect(row.claimed_at).toBeNull();
  });
});