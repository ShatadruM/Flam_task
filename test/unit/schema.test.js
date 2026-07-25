import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';

let dbPath;
let db;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `queuectl-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
});

afterEach(async () => {
  if (db) {
    await db.close();
    db = null;
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
});

describe('openDatabase', () => {
  it('creates the containing directory if it does not exist', async () => {
    const nestedPath = path.join(os.tmpdir(), `queuectl-nested-${Date.now()}`, 'queue.db');
    db = await openDatabase(nestedPath);
    expect(fs.existsSync(path.dirname(nestedPath))).toBe(true);
    await db.close();
    db = null;
    fs.rmSync(path.dirname(nestedPath), { recursive: true, force: true });
  });

  it('sets WAL journal mode', async () => {
    db = await openDatabase(dbPath);
    const row = await db.get('PRAGMA journal_mode');
    expect(row.journal_mode).toBe('wal');
  });

  it('sets a non-zero busy_timeout', async () => {
    db = await openDatabase(dbPath);
    const row = await db.get('PRAGMA busy_timeout');
    expect(row.timeout).toBeGreaterThan(0);
  });
});

describe('migrate', () => {
  beforeEach(async () => {
    db = await openDatabase(dbPath);
  });

  it('creates the jobs table with the required columns', async () => {
    await migrate(db);
    const columns = (await db.all('PRAGMA table_info(jobs)')).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'command', 'state', 'attempts', 'max_retries',
      'worker_id', 'claimed_at', 'next_attempt_at', 'created_at', 'updated_at',
    ]));
  });

  it('creates the config table with key/value columns', async () => {
    await migrate(db);
    const columns = (await db.all('PRAGMA table_info(config)')).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['key', 'value']));
  });

  it('creates the indexes the claim query and reaper depend on', async () => {
    await migrate(db);
    const indexNames = (
      await db.all("SELECT name FROM sqlite_master WHERE type = 'index'")
    ).map((row) => row.name);
    expect(indexNames).toEqual(expect.arrayContaining([
      'idx_jobs_claimable', 'idx_jobs_processing_claimed_at',
    ]));
  });

  it('rejects a job state outside the allowed enum', async () => {
    await migrate(db);
    await expect(
      db.run(
        `INSERT INTO jobs (id, command, state, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        'job1', 'echo hi', 'not-a-real-state', 'now', 'now', 'now'
      )
    ).rejects.toThrow();
  });

  it('accepts a valid job row with defaults applied', async () => {
    await migrate(db);
    await db.run(
      `INSERT INTO jobs (id, command, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      'job1', "echo 'Hello World'", 'now', 'now', 'now'
    );

    const row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.max_retries).toBe(3);
  });

  it('is idempotent when run twice', async () => {
    await migrate(db);
    await expect(migrate(db)).resolves.not.toThrow();
    const { n } = await db.get(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'jobs'"
    );
    expect(n).toBe(1);
  });

  it('survives being reopened against the same file', async () => {
    await migrate(db);
    await db.run(
      `INSERT INTO jobs (id, command, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      'job1', 'echo hi', 'now', 'now', 'now'
    );
    await db.close();

    db = await openDatabase(dbPath);
    const row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');
    expect(row).toBeDefined();
    expect(row.command).toBe('echo hi');
  });
});