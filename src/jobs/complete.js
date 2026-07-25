export async function completeJob(db, jobId) {
  const now = new Date().toISOString();
  await db.run(
    `UPDATE jobs
     SET state = 'completed', worker_id = NULL, claimed_at = NULL, updated_at = ?
     WHERE id = ?`,
    now, jobId
  );
}