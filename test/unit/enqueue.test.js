import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { parseJobInput, enqueueJob } from '../../src/jobs/enqueue.js';

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

describe('parseJobInput', () => {
  it('parses a valid job JSON string, leaving max_retries unset for enqueueJob to resolve', () => {
    expect(parseJobInput('{"id":"job1","command":"echo hi"}')).toEqual({
      id: 'job1',
      command: 'echo hi',
      maxRetries: undefined,
    });
  });

  it('respects a custom max_retries', () => {
    const job = parseJobInput('{"id":"job1","command":"echo hi","max_retries":5}');
    expect(job.maxRetries).toBe(5);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJobInput('not json')).toThrow();
  });

  it('throws when id is missing', () => {
    expect(() => parseJobInput('{"command":"echo hi"}')).toThrow(/id/);
  });

  it('throws when command is missing', () => {
    expect(() => parseJobInput('{"id":"job1"}')).toThrow(/command/);
  });

  it('throws when max_retries is not an integer', () => {
    expect(() =>
      parseJobInput('{"id":"job1","command":"echo hi","max_retries":"three"}')
    ).toThrow(/max_retries/);
  });
});

describe('enqueueJob', () => {
  it('inserts a job with pending state and zero attempts', async () => {
    const job = await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 3 });
    expect(job.state).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.max_retries).toBe(3);
  });

  it('sets created_at, updated_at, and next_attempt_at', async () => {
    const job = await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 3 });
    expect(job.created_at).toBeTruthy();
    expect(job.updated_at).toBe(job.created_at);
    expect(job.next_attempt_at).toBeTruthy();
  });

  it('rejects a duplicate id', async () => {
    await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 3 });
    await expect(
      enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: 3 })
    ).rejects.toThrow(/already exists/);
  });

  it('resolves max_retries from config when not given explicitly', async () => {
    const { setConfig } = await import('../../src/config/config.js');
    await setConfig(db, 'max-retries', 7);

    const job = await enqueueJob(db, { id: 'job1', command: 'echo hi', maxRetries: undefined });
    expect(job.max_retries).toBe(7);
  });
});