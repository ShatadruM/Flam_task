import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writePidFile, listPidFiles, isProcessAlive, getWorkersDir } from '../../src/worker/pidfile.js';
import { stopAllWorkers } from '../../src/worker/stop.js';

let tmpBase;
let workersDir;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'queuectl-stop-'));
  workersDir = getWorkersDir(tmpBase);
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('stopAllWorkers', () => {
  it('returns a no-op result when there are no pid files', async () => {
    const result = await stopAllWorkers({ dir: workersDir });
    expect(result).toEqual({ stopped: [], timedOut: [] });
  });

  it('sends SIGTERM to a live process and waits for it to exit', async () => {
    const child = spawn('sleep', ['30']);
    writePidFile(child.pid, workersDir);

    const result = await stopAllWorkers({ dir: workersDir, timeoutMs: 5000, pollIntervalMs: 100 });

    expect(result.stopped).toEqual([child.pid]);
    expect(result.timedOut).toEqual([]);
    expect(isProcessAlive(child.pid)).toBe(false);
    expect(listPidFiles(workersDir)).toHaveLength(0);
  }, 10000);

  it('cleans up a stale pid file left by an already-dead process', async () => {
    writePidFile(999999, workersDir); // not a real running pid
    const result = await stopAllWorkers({ dir: workersDir });

    expect(result.stopped).toEqual([]);
    expect(result.timedOut).toEqual([]);
    expect(listPidFiles(workersDir)).toHaveLength(0);
  });

  it('stops multiple live workers in one call', async () => {
    const child1 = spawn('sleep', ['30']);
    const child2 = spawn('sleep', ['30']);
    writePidFile(child1.pid, workersDir);
    writePidFile(child2.pid, workersDir);

    const result = await stopAllWorkers({ dir: workersDir, timeoutMs: 5000, pollIntervalMs: 100 });

    expect(result.stopped.sort()).toEqual([child1.pid, child2.pid].sort());
    expect(listPidFiles(workersDir)).toHaveLength(0);
  }, 10000);
});