import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';

// Opens a fresh connection, migrates, runs fn, always closes — one call per
// CLI invocation. Keeps db lifecycle out of every individual command handler.
export async function withDatabase(fn) {
  const db = await openDatabase();
  try {
    await migrate(db);
    return await fn(db);
  } finally {
    await db.close();
  }
}