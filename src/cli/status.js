import { listJobs } from '../jobs/list.js';
import { listPidFiles, isProcessAlive, getWorkersDir } from '../worker/pidfile.js';

const JOB_STATES = ['pending', 'processing', 'completed', 'failed', 'dead'];

export async function getStatusSummary(db, { workersDir = getWorkersDir() } = {}) {
  const counts = {};
  for (const state of JOB_STATES) {
    const jobs = await listJobs(db, { state });
    counts[state] = jobs.length;
  }

  // Count only entries whose process is actually alive — a stale pid file
  // left behind by a SIGKILLed worker (before worker stop/next sweep cleans
  // it up) shouldn't be reported as an active worker.
  const activeWorkers = listPidFiles(workersDir).filter((entry) => isProcessAlive(entry.pid)).length;

  return { counts, activeWorkers };
}