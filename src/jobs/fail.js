import { computeBackoffDelaySeconds } from '../lib/backoff.js';
import { getConfig } from '../config/config.js';

export async function failJob(db, jobId) {
  const job = await db.get('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) {
    throw new Error(`Job "${jobId}" not found`);
  }

  const newAttempts = job.attempts + 1;
  const now = new Date().toISOString();

  if (newAttempts >= job.max_retries) {
    await db.run(
      `UPDATE jobs
       SET state = 'dead', attempts = ?, worker_id = NULL, claimed_at = NULL, updated_at = ?
       WHERE id = ?`,
      newAttempts, now, jobId
    );
    return;
  }

  // backoff-base is read live at fail time, not baked in at enqueue time — a
  // config change DOES affect the delay used for a job's next retry, even for
  // jobs enqueued before the change. This is the opposite tradeoff from
  // max-retries above, and intentionally so: see DECISIONS.md.
  const base = Number(await getConfig(db, 'backoff-base', 2));
  const delaySeconds = computeBackoffDelaySeconds(base, newAttempts);
  const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

  await db.run(
    `UPDATE jobs
     SET state = 'failed', attempts = ?, worker_id = NULL, claimed_at = NULL,
         next_attempt_at = ?, updated_at = ?
     WHERE id = ?`,
    newAttempts, nextAttemptAt, now, jobId
  );
}