import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '../../bin/queuectl.js');

// Spawns one real worker OS process — re-invokes this same CLI with
// --count 1 --internal-child, so the child runs a single worker loop and
// doesn't try to recursively spawn more workers itself.
export function spawnWorkerProcess() {
  return spawn('node', [CLI_PATH, 'worker', 'start', '--count', '1', '--internal-child'], {
    stdio: 'inherit',
  });
}

// `worker start --count N` spawns N real OS processes (not N in-process
// loops) — this is what satisfies "separate OS processes, not just threads"
// even within a single CLI invocation. Forwards SIGINT/SIGTERM from this
// parent to every child, and resolves once all children have exited.
export async function runMultipleWorkers(count) {
  const children = Array.from({ length: count }, () => spawnWorkerProcess());

  const forwardSignal = (signal) => {
    for (const child of children) {
      if (child.exitCode === null && !child.killed) {
        child.kill(signal);
      }
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  await Promise.all(
    children.map((child) => new Promise((resolve) => child.on('exit', resolve)))
  );
}