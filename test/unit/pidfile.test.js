import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writePidFile, removePidFile, listPidFiles, isProcessAlive, getWorkersDir } from '../../src/worker/pidfile.js';

let tmpBase;
let workersDir;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'queuectl-pidfile-'));
  workersDir = getWorkersDir(tmpBase);
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('pidfile', () => {
  it('writes and lists a pid file', () => {
    writePidFile(1234, workersDir);
    const entries = listPidFiles(workersDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBe(1234);
    expect(entries[0].startedAt).toBeTruthy();
  });

  it('removes a pid file', () => {
    writePidFile(1234, workersDir);
    removePidFile(1234, workersDir);
    expect(listPidFiles(workersDir)).toHaveLength(0);
  });

  it('supports multiple pid files at once', () => {
    writePidFile(1111, workersDir);
    writePidFile(2222, workersDir);
    const pids = listPidFiles(workersDir).map((e) => e.pid).sort();
    expect(pids).toEqual([1111, 2222]);
  });

  it('ignores non-.pid files when listing', () => {
    fs.mkdirSync(workersDir, { recursive: true });
    fs.writeFileSync(path.join(workersDir, 'notes.txt'), 'hi');
    expect(listPidFiles(workersDir)).toHaveLength(0);
  });

  it('ignores a corrupt pid file rather than throwing', () => {
    fs.mkdirSync(workersDir, { recursive: true });
    fs.writeFileSync(path.join(workersDir, '999.pid'), 'not json');
    expect(() => listPidFiles(workersDir)).not.toThrow();
    expect(listPidFiles(workersDir)).toHaveLength(0);
  });

  it('isProcessAlive returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive returns false for a pid that does not exist', () => {
    expect(isProcessAlive(999999)).toBe(false);
  });
});