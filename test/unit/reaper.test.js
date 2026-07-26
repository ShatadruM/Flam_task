import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { sweepStaleJobs } from '../../src/jobs/reaper.js';

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

async function insertProcessingJob(id, { claimedAt, attempts = 0, maxRetries = 3 }) {
  await db.run(
    `INSERT INTO jobs (id, command, state, attempts, max_retries, worker_id, claimed_at, next_attempt_at, created_at, updated_at)
     VALUES (?, 'echo hi', 'processing', ?, ?, 'worker-1', ?, ?, ?, ?)`,
    id, attempts, maxRetries, claimedAt, claimedAt, claimedAt, claimedAt
  );
}

describe('sweepStaleJobs', () => {
  it('does nothing when there are no processing jobs', async () => {
    expect(await sweepStaleJobs(db, { staleTimeoutMs: 1000 })).toBe(0);
  });

  it('leaves a recently-claimed processing job alone', async () => {
    const now = new Date().toISOString();
    await insertProcessingJob('job1', { claimedAt: now });

    const swept = await sweepStaleJobs(db, { staleTimeoutMs: 5000 });

    expect(swept).toBe(0);
    const row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');
    expect(row.state).toBe('processing');
  });

  it('recovers a job whose claimed_at is older than the stale timeout', async () => {
    const staleClaimedAt = new Date(Date.now() - 10_000).toISOString();
    await insertProcessingJob('job1', { claimedAt: staleClaimedAt, attempts: 0, maxRetries: 3 });

    const swept = await sweepStaleJobs(db, { staleTimeoutMs: 1000 });

    expect(swept).toBe(1);
    const row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');
    expect(row.state).toBe('failed'); // retryable, not stuck in processing
    expect(row.attempts).toBe(1); // consumed a retry slot, same as a normal failure
    expect(row.worker_id).toBeNull();
    expect(row.claimed_at).toBeNull();
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('moves a stale job straight to the DLQ if it has exhausted its retries', async () => {
    const staleClaimedAt = new Date(Date.now() - 10_000).toISOString();
    await insertProcessingJob('job1', { claimedAt: staleClaimedAt, attempts: 2, maxRetries: 3 });

    await sweepStaleJobs(db, { staleTimeoutMs: 1000 });

    const row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');
    expect(row.state).toBe('dead');
    expect(row.attempts).toBe(3);
  });

  it('recovers multiple stale jobs in one sweep', async () => {
    const staleClaimedAt = new Date(Date.now() - 10_000).toISOString();
    await insertProcessingJob('job1', { claimedAt: staleClaimedAt });
    await insertProcessingJob('job2', { claimedAt: staleClaimedAt });

    const swept = await sweepStaleJobs(db, { staleTimeoutMs: 1000 });

    expect(swept).toBe(2);
    const rows = await db.all("SELECT state FROM jobs WHERE state != 'processing'");
    expect(rows).toHaveLength(2);
  });

  it('never leaves a swept job stuck in processing, regardless of DLQ outcome', async () => {
    const staleClaimedAt = new Date(Date.now() - 10_000).toISOString();
    await insertProcessingJob('job1', { claimedAt: staleClaimedAt, attempts: 0, maxRetries: 1 });

    await sweepStaleJobs(db, { staleTimeoutMs: 1000 });

    const row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');
    expect(row.state).not.toBe('processing');
  });
});