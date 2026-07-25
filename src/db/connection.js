import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

export const DEFAULT_DB_PATH = path.join(process.cwd(), '.queuectl', 'queue.db');

// One call per CLI invocation / worker process — not a singleton. Tests need
// independent connections against different (or the same) db file to simulate
// multiple worker processes.
export async function openDatabase(dbPath = DEFAULT_DB_PATH) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  await db.run('PRAGMA journal_mode = WAL');   // required for correct cross-process locking
  await db.run('PRAGMA busy_timeout = 5000');  // block-and-retry instead of SQLITE_BUSY on write races

  return db;
}