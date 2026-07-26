import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '../../bin/queuectl.js');

let cwd;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'queuectl-cli-'));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function runCli(args) {
  return spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
}

describe('retry -> DLQ -> dlq retry (CLI, real process)', () => {
  it('a job that always fails ends up in the DLQ, then dlq retry brings it back', async () => {
    expect(runCli(['config', 'set', 'backoff-base', '1']).status).toBe(0); // 1s delay every time, keeps the test fast
    expect(
      runCli(['enqueue', JSON.stringify({
        id: 'job1', command: 'node -e "process.exit(1)"', max_retries: 2,
      })]).status
    ).toBe(0);

    const db = await openDatabase(path.join(cwd, '.queuectl', 'queue.db'));
    try {
      // Two manual claim+fail cycles, same as a worker would do, without needing
      // to actually run `worker start` in the background for this test.
      const { claimNextJob } = await import('../../src/jobs/claim.js');
      const { failJob } = await import('../../src/jobs/fail.js');

      await claimNextJob(db, 'worker-1');
      await failJob(db, 'job1');
      await db.run("UPDATE jobs SET next_attempt_at = ? WHERE id = ?", new Date(0).toISOString(), 'job1');

      await claimNextJob(db, 'worker-1');
      await failJob(db, 'job1');

      const row = await db.get('SELECT * FROM jobs WHERE id = ?', 'job1');
      expect(row.state).toBe('dead');
    } finally {
      await db.close();
    }

    const dlqResult = runCli(['dlq', 'list', '--json']);
    const dlqJobs = JSON.parse(dlqResult.stdout);
    expect(dlqJobs).toHaveLength(1);
    expect(dlqJobs[0].id).toBe('job1');

    expect(runCli(['dlq', 'retry', 'job1']).status).toBe(0);

    const afterRetry = JSON.parse(runCli(['list', '--state', 'pending', '--json']).stdout);
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry[0].attempts).toBe(0);
  });
});