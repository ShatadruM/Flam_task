import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { enqueueJob } from '../../src/jobs/enqueue.js';
import { claimNextJob } from '../../src/jobs/claim.js';

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

describe('claimNextJob', () => {
  it('returns null when there are no claimable jobs', async () => {
    expect(await claimNextJob(db, 'worker-1')).toBeNull();
  });

  it('claims a pending job and marks it processing', async () => {
    await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 3 });

    const job = await claimNextJob(db, 'worker-1');

    expect(job.id).toBe('job1');
    expect(job.state).toBe('processing');
    expect(job.worker_id).toBe('worker-1');
    expect(job.claimed_at).toBeTruthy();
  });

  it('does not reclaim a job that is already processing', async () => {
    await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 3 });
    await claimNextJob(db, 'worker-1');

    expect(await claimNextJob(db, 'worker-2')).toBeNull();
  });

  it('claims jobs in created_at order', async () => {
    await enqueueJob(db, { id: 'job1', command: 'echo 1', maxRetries: 3 });
    await enqueueJob(db, { id: 'job2', command: 'echo 2', maxRetries: 3 });

    const first = await claimNextJob(db, 'worker-1');
    expect(first.id).toBe('job1');

    const second = await claimNextJob(db, 'worker-1');
    expect(second.id).toBe('job2');
  });

  it('does not claim a job whose next_attempt_at is in the future', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    await db.run(
      `INSERT INTO jobs (id, command, state, attempts, max_retries, next_attempt_at, created_at, updated_at)
       VALUES ('job1', 'echo hi', 'failed', 1, 3, ?, ?, ?)`,
      future, future, future
    );

    expect(await claimNextJob(db, 'worker-1')).toBeNull();
  });

  it('claims a failed job once its next_attempt_at has passed', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await db.run(
      `INSERT INTO jobs (id, command, state, attempts, max_retries, next_attempt_at, created_at, updated_at)
       VALUES ('job1', 'echo hi', 'failed', 1, 3, ?, ?, ?)`,
      past, past, past
    );

    const job = await claimNextJob(db, 'worker-1');
    expect(job.id).toBe('job1');
    expect(job.state).toBe('processing');
  });

  it('only lets one of two concurrent claimers win when there is one job', async () => {
    await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 3 });

    // Two independent connections against the SAME file, simulating two worker
    // processes racing to claim the same job — this is the actual scenario Q1
    // in DECISIONS.md is defending.
    const dbA = await openDatabase(dbPath);
    const dbB = await openDatabase(dbPath);

    try {
      const [resultA, resultB] = await Promise.all([
        claimNextJob(dbA, 'worker-A'),
        claimNextJob(dbB, 'worker-B'),
      ]);

      const winners = [resultA, resultB].filter(Boolean);
      expect(winners).toHaveLength(1);
    } finally {
      await dbA.close();
      await dbB.close();
    }
  });
});