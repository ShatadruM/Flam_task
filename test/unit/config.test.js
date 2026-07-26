import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { getConfig, setConfig } from '../../src/config/config.js';

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

describe('getConfig / setConfig', () => {
  it('returns the default when a key is unset', async () => {
    expect(await getConfig(db, 'backoff-base', 2)).toBe(2);
  });

  it('persists a value across reads', async () => {
    await setConfig(db, 'backoff-base', 3);
    expect(await getConfig(db, 'backoff-base', 2)).toBe('3');
  });

  it('overwrites an existing value', async () => {
    await setConfig(db, 'max-retries', 3);
    await setConfig(db, 'max-retries', 5);
    expect(await getConfig(db, 'max-retries', 3)).toBe('5');
  });

  it('rejects an unknown key', async () => {
    await expect(setConfig(db, 'not-a-real-key', 1)).rejects.toThrow(/Unknown config key/);
  });

  it('rejects a non-positive-integer value', async () => {
    await expect(setConfig(db, 'backoff-base', 'abc')).rejects.toThrow(/Invalid value/);
    await expect(setConfig(db, 'backoff-base', -1)).rejects.toThrow(/Invalid value/);
    await expect(setConfig(db, 'backoff-base', 0)).rejects.toThrow(/Invalid value/);
  });
});