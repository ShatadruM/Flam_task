import { execSync } from 'child_process';
import { claimNextJob } from '../jobs/claim.js';
import { completeJob } from '../jobs/complete.js';
import { failJob } from '../jobs/fail.js';

const DEFAULT_POLL_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exit code determines success/failure, per the assignment's job execution spec.
// stdio: 'ignore' for now — output capture is a bonus feature, not required.
export function executeCommand(command) {
  try {
    execSync(command, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// shouldContinue lets tests bound the loop to N iterations, and is also the hook
// Phase 5 will use for graceful shutdown on SIGTERM/SIGINT.
export async function runWorkerLoop(
  db,
  { workerId, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, shouldContinue = () => true } = {}
) {
  while (shouldContinue()) {
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