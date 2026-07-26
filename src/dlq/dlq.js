export async function listDlqJobs(db) {
  return db.all("SELECT * FROM jobs WHERE state = 'dead' ORDER BY created_at ASC");
}

// Resets attempts to 0 — see DECISIONS.md Q3 for why this is the right call.
export async function retryDlqJob(db, jobId) {
  const job = await db.get('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) {
    throw new Error(`Job "${jobId}" not found`);
  }
  if (job.state !== 'dead') {
    throw new Error(`Job "${jobId}" is not in the DLQ (state: ${job.state})`);
  }

  const now = new Date().toISOString();
  await db.run(
    `UPDATE jobs
     SET state = 'pending', attempts = 0, worker_id = NULL, claimed_at = NULL,
         next_attempt_at = ?, updated_at = ?
     WHERE id = ?`,
    now, now, jobId
  );

  return db.get('SELECT * FROM jobs WHERE id = ?', jobId);
}