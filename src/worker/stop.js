import { listPidFiles, removePidFile, isProcessAlive, getWorkersDir } from './pidfile.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reads every registered worker, signals the live ones with SIGTERM (which
// each worker's own handler turns into "finish current job, then exit" —
// see bin/queuectl.js), and waits for them to actually exit. Stale entries
// (pid file present but process already dead — e.g. a prior SIGKILL crash
// that never got to clean up its own file) are swept and removed here too,
// so worker stop is also the natural place stale registrations get cleaned.
export async function stopAllWorkers({ timeoutMs = 10000, pollIntervalMs = 200, dir = getWorkersDir() } = {}) {
  const entries = listPidFiles(dir);

  const liveEntries = [];
  for (const entry of entries) {
    if (isProcessAlive(entry.pid)) {
      liveEntries.push(entry);
    } else {
      removePidFile(entry.pid, dir);
    }
  }

  if (liveEntries.length === 0) {
    return { stopped: [], timedOut: [] };
  }

  for (const entry of liveEntries) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {
      // Died between our liveness check and now — fine, treated as stopped below.
    }
  }

  const start = Date.now();
  const remaining = new Set(liveEntries.map((e) => e.pid));

  while (remaining.size > 0 && Date.now() - start < timeoutMs) {
    for (const pid of [...remaining]) {
      if (!isProcessAlive(pid)) {
        remaining.delete(pid);
        removePidFile(pid, dir);
      }
    }
    if (remaining.size > 0) await sleep(pollIntervalMs);
  }

  return {
    stopped: liveEntries.filter((e) => !remaining.has(e.pid)).map((e) => e.pid),
    timedOut: [...remaining],
  };
}