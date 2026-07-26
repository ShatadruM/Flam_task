import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { enqueueJob } from '../../src/jobs/enqueue.js';
import { claimNextJob } from '../../src/jobs/claim.js';
import { failJob } from '../../src/jobs/fail.js';
import { setConfig } from '../../src/config/config.js';
import { listDlqJobs, retryDlqJob } from '../../src/dlq/dlq.js';

let dbPath;
let db;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `queuectl-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  db = await openDatabase(dbPath);
  await migrate(db);
});

afterEach(async () => {
  await db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
});

describe('failJob — retry with backoff', () => {
  it('sets next_attempt_at using base^attempts seconds from now', async () => {
    await setConfig(db, 'backoff-base', 2);
    await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 5 });
    await claimNextJob(db, 'worker-1');

    const before = Date.now();
    await failJob(db, 'job1');

    const row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');
    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(1);

    const delayMs = new Date(row.next_attempt_at).getTime() - before;
    expect(delayMs).toBeGreaterThanOrEqual(1900); // ~2s, with slack for test timing
    expect(delayMs).toBeLessThan(3000);
  });

  it('increases delay on successive failures (2s, 4s)', async () => {
    await setConfig(db, 'backoff-base', 2);
    await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 5 });

    await claimNextJob(db, 'worker-1');
    await failJob(db, 'job1'); // attempts=1, ~2s
    const firstDelay = (await db.get('SELECT next_attempt_at FROM jobs WHERE id = ?', 'job1')).next_attempt_at;

    // Force it claimable again for the second failure.
    await db.run("UPDATE jobs SET next_attempt_at = ? WHERE id = ?", new Date(0).toISOString(), 'job1');
    await claimNextJob(db, 'worker-1');
    await failJob(db, 'job1'); // attempts=2, ~4s
    const secondDelay = (await db.get('SELECT next_attempt_at FROM jobs WHERE id = ?', 'job1')).next_attempt_at;

    expect(new Date(secondDelay).getTime()).toBeGreaterThan(new Date(firstDelay).getTime());
  });
});

describe('failJob — DLQ transition', () => {
  it('moves to dead once attempts reaches max_retries', async () => {
    await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 2 });

    await claimNextJob(db, 'worker-1');
    await failJob(db, 'job1'); // attempts=1, still failed

    let row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');
    expect(row.state).toBe('failed');

    await db.run("UPDATE jobs SET next_attempt_at = ? WHERE id = ?", new Date(0).toISOString(), 'job1');
    await claimNextJob(db, 'worker-1');
    await failJob(db, 'job1'); // attempts=2 === max_retries -> dead

    row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');
    expect(row.state).toBe('dead');
  });
});

describe('DLQ operations', () => {
  async function forceJobToDlq(db, id) {
    await enqueueJob(db, { id, command: 'echo hi', maxRetries: 1 });
    await claimNextJob(db, 'worker-1');
    await failJob(db, id); // maxRetries=1, one failure is enough to go dead
  }

  it('listDlqJobs returns only dead jobs', async () => {
    await forceJobToDlq(db, 'job1');
    await enqueueJob(db, { id: 'job2', command: 'echo hi', maxRetries: 3 });

    const dead = await listDlqJobs(db);
    expect(dead).toHaveLength(1);
    expect(dead[0].id).toBe('job1');
  });

  it('retryDlqJob resets attempts and returns the job to pending', async () => {
    await forceJobToDlq(db, 'job1');

    const retried = await retryDlqJob(db, 'job1');
    expect(retried.state).toBe('pending');
    expect(retried.attempts).toBe(0);
  });

  it('rejects retrying a job that is not in the DLQ', async () => {
    await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 3 });
    await expect(retryDlqJob(db, 'job1')).rejects.toThrow(/not in the DLQ/);
  });

  it('rejects retrying a job that does not exist', async () => {
    await expect(retryDlqJob(db, 'nope')).rejects.toThrow(/not found/);
  });
});