export async function failJob(db, jobId) {
  const now = new Date().toISOString();
  await db.run(
    `UPDATE jobs
     SET state = 'failed', attempts = attempts + 1,
         worker_id = NULL, claimed_at = NULL,
         next_attempt_at = ?, updated_at = ?
     WHERE id = ?`,
    now, now, jobId
  );
}