import { JOB_STATES } from './states.js';

export async function listJobs(db, { state } = {}) {
  if (state && !JOB_STATES.includes(state)) {
    throw new Error(`Invalid state "${state}". Must be one of: ${JOB_STATES.join(', ')}`);
  }

  if (state) {
    return db.all('SELECT * FROM jobs WHERE state = ? ORDER BY created_at ASC', state);
  }
  return db.all('SELECT * FROM jobs ORDER BY created_at ASC');
}