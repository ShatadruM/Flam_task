// Single statement, no gap between "check if claimable" and "mark claimed".
// This is what makes claiming atomic across separate OS processes: SQLite
// serializes writers at the file level (enforced by the OS, not by anything in
// this process), so two workers racing this same statement cannot both succeed
// against the same row.
export async function claimNextJob(db, workerId) {
  const now = new Date().toISOString();

  const job = await db.get(
    `UPDATE jobs
     SET state = 'processing', worker_id = ?, claimed_at = ?, updated_at = ?
     WHERE id = (
       SELECT id FROM jobs
       WHERE state IN ('pending', 'failed')
         AND next_attempt_at <= ?
       ORDER BY created_at ASC
       LIMIT 1
     )
     RETURNING *`,
    workerId, now, now, now
  );

  return job ?? null;
}