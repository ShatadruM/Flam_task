import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Every statement in schema.sql is IF NOT EXISTS, so this is safe to call on
// every startup — no migration framework needed for a single, static schema.
export async function migrate(db) {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  await db.exec(schemaSql);
}   