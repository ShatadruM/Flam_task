import fs from 'fs';
import path from 'path';

export function getWorkersDir(baseDir = process.cwd()) {
  return path.join(baseDir, '.queuectl', 'workers');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function pidFilePath(dir, pid) {
  return path.join(dir, `${pid}.pid`);
}

export function writePidFile(pid = process.pid, dir = getWorkersDir()) {
  ensureDir(dir);
  fs.writeFileSync(
    pidFilePath(dir, pid),
    JSON.stringify({ pid, startedAt: new Date().toISOString() })
  );
}

export function removePidFile(pid = process.pid, dir = getWorkersDir()) {
  const p = pidFilePath(dir, pid);
  if (fs.existsSync(p)) fs.rmSync(p);
}

export function listPidFiles(dir = getWorkersDir()) {
  ensureDir(dir);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.pid'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return null; // corrupt/partial file — ignore rather than crash worker stop
      }
    })
    .filter(Boolean);
}

// process.kill(pid, 0) sends no actual signal — it's the standard liveness
// check: throws if the pid doesn't exist (or isn't ours to signal).
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}