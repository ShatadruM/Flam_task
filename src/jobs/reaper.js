import { failJob } from './fail.js';

const DEFAULT_STALE_TIMEOUT_MS = 5000;

// Finds jobs stuck in 'processing' whose claimed_at is older than
// staleTimeoutMs (meaning the worker that claimed them almost certainly
// crashed before finishing) and routes each through the normal failJob path
// — same backoff/DLQ accounting as an ordinary failure, no separate logic to
// duplicate or drift out of sync.
export async function sweepStaleJobs(db, { staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS } = {}) {
  const cutoff = new Date(Date.now() - staleTimeoutMs).toISOString();

  const staleJobs = await db.all(
    `SELECT id FROM jobs WHERE state = 'processing' AND claimed_at <= ?`,
    cutoff
  );

  for (const { id } of staleJobs) {
    await failJob(db, id);
  }

  return staleJobs.length;
}

export { DEFAULT_STALE_TIMEOUT_MS };