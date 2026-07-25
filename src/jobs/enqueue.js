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
    maxRetries: parsed.max_retries ?? 3,
  };
}

export async function enqueueJob(db, { id, command, maxRetries }) {
  const existing = await db.get('SELECT id FROM jobs WHERE id = ?', id);
  if (existing) {
    throw new Error(`Job with id "${id}" already exists`);
  }

  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO jobs (id, command, state, attempts, max_retries, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)`,
    id, command, maxRetries, now, now, now
  );

  return db.get('SELECT * FROM jobs WHERE id = ?', id);
}