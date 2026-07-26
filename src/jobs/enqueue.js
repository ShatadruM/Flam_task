import { getConfig } from '../config/config.js';

export function parseJobInput(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new Error(`Invalid job JSON: ${jsonString}`);
  }

  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    throw new Error('Job must have a non-empty string "id"');
  }
  if (typeof parsed.command !== 'string' || parsed.command.length === 0) {
    throw new Error('Job must have a non-empty string "command"');
  }
  if (parsed.max_retries !== undefined && !Number.isInteger(parsed.max_retries)) {
    throw new Error('"max_retries" must be an integer');
  }

  return {
    id: parsed.id,
    command: parsed.command,
    maxRetries: parsed.max_retries, // may be undefined — resolved against config in enqueueJob
  };
}

export async function enqueueJob(db, { id, command, maxRetries }) {
  const existing = await db.get('SELECT id FROM jobs WHERE id = ?', id);
  if (existing) {
    throw new Error(`Job with id "${id}" already exists`);
  }

  // Explicit per-job max_retries wins; otherwise fall back to the current default.
  // This is why a config change never affects already-enqueued jobs — the value
  // is resolved and baked into the row at enqueue time, not looked up later.
  const resolvedMaxRetries = maxRetries ?? Number(await getConfig(db, 'max-retries', 3));

  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO jobs (id, command, state, attempts, max_retries, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)`,
    id, command, resolvedMaxRetries, now, now, now
  );

  return db.get('SELECT * FROM jobs WHERE id = ?', id);
}