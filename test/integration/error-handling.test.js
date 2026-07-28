import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

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

describe('error handling — enqueue', () => {
  it('rejects malformed JSON with a non-zero exit and a clear stderr message', () => {
    const result = runCli(['enqueue', 'not json at all']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Invalid job JSON/);
  });

  it('rejects a job missing "id"', () => {
    const result = runCli(['enqueue', JSON.stringify({ command: 'echo hi' })]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/id/);
  });

  it('rejects a job missing "command"', () => {
    const result = runCli(['enqueue', JSON.stringify({ id: 'job1' })]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/command/);
  });

  it('rejects a duplicate id with a clear message, not a raw SQLite error', () => {
    runCli(['enqueue', JSON.stringify({ id: 'job1', command: 'echo hi' })]);
    const result = runCli(['enqueue', JSON.stringify({ id: 'job1', command: 'echo hi' })]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/already exists/);
    expect(result.stderr).not.toMatch(/SQLITE/i); // internals shouldn't leak to the user
  });

  it('gives a clear error for a --file path that does not exist', () => {
    const result = runCli(['enqueue', '--file', path.join(cwd, 'nope.json')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe('error handling — list', () => {
  it('rejects an invalid --state value', () => {
    const result = runCli(['list', '--state', 'not-a-real-state']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Invalid state/);
  });
});

describe('error handling — dlq', () => {
  it('rejects dlq retry for a job id that does not exist', () => {
    const result = runCli(['dlq', 'retry', 'nonexistent']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not found/);
  });

  it('rejects dlq retry for a job that exists but is not dead', () => {
    runCli(['enqueue', JSON.stringify({ id: 'job1', command: 'echo hi' })]);
    const result = runCli(['dlq', 'retry', 'job1']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not in the DLQ/);
  });
});

describe('error handling — config', () => {
  it('rejects an unknown config key', () => {
    const result = runCli(['config', 'set', 'not-a-real-key', '5']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Unknown config key/);
  });

  it('rejects a non-integer value for backoff-base', () => {
    const result = runCli(['config', 'set', 'backoff-base', 'abc']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Invalid value/);
  });

  it('rejects a negative value for max-retries', () => {
    const result = runCli(['config', 'set', 'max-retries', '-1']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Invalid value/);
  });
});

describe('error handling — worker start', () => {
  it('rejects --count 0', () => {
    const result = runCli(['worker', 'start', '--count', '0']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/positive integer/);
  });

  it('rejects a non-numeric --count', () => {
    const result = runCli(['worker', 'start', '--count', 'abc']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/positive integer/);
  });
});