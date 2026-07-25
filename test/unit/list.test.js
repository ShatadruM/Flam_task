import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { enqueueJob } from '../../src/jobs/enqueue.js';
import { listJobs } from '../../src/jobs/list.js';

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

describe('listJobs', () => {
  it('returns all jobs when no state filter is given', async () => {
    await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 3 });
    await enqueueJob(db, { id: 'job2', command: 'echo bye', maxRetries: 3 });

    expect(await listJobs(db, {})).toHaveLength(2);
  });

  it('filters by state', async () => {
    await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 3 });

    expect(await listJobs(db, { state: 'pending' })).toHaveLength(1);
    expect(await listJobs(db, { state: 'dead' })).toHaveLength(0);
  });

  it('orders by created_at ascending', async () => {
    await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 3 });
    await enqueueJob(db, { id: 'job2', command: 'echo bye', maxRetries: 3 });

    const jobs = await listJobs(db, {});
    expect(jobs.map((j) => j.id)).toEqual(['job1', 'job2']);
  });

  it('rejects an invalid state filter', async () => {
    await expect(listJobs(db, { state: 'not-a-state' })).rejects.toThrow(/Invalid state/);
  });
});