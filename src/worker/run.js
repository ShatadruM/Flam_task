import { execSync } from 'child_process';
import { claimNextJob } from '../jobs/claim.js';
import { completeJob } from '../jobs/complete.js';
import { failJob } from '../jobs/fail.js';
import { sweepStaleJobs, DEFAULT_STALE_TIMEOUT_MS } from '../jobs/reaper.js';

const DEFAULT_POLL_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function executeCommand(command) {
  try {
    execSync(command, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function runWorkerLoop(
  db,
  {
    workerId,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS,
    shouldContinue = () => true,
  } = {}
) {
  while (shouldContinue()) {
    // Every worker sweeps on every iteration — recovery only needs ANY
    // worker to be alive, not a single dedicated reaper process.
    await sweepStaleJobs(db, { staleTimeoutMs });

    const job = await claimNextJob(db, workerId);

    if (!job) {
      await sleep(pollIntervalMs);
      continue;
    }

    const succeeded = executeCommand(job.command);

    if (succeeded) {
      await completeJob(db, job.id);
    } else {
      await failJob(db, job.id);
    }
  }
}