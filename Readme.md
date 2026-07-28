 # QueueCTL

A CLI-based background job queue system. `queuectl` manages background jobs across
worker processes, retries failures with exponential backoff, and maintains a Dead
Letter Queue (DLQ) for jobs that fail permanently. All job data is persisted to
SQLite, so it survives process restarts and worker crashes.

Built for the Backend Developer Internship assignment. See [`DECISIONS.md`](./DECISIONS.md)
for the design rationale behind the atomic job claiming, crash recovery, retry
semantics, and cross-process worker signaling.

## Demo

🎥 **[\[Demo video\]](https://drive.google.com/file/d/1MbzNPbVlAb2SS_4XwmLOs4WxiaDbpaPh/view?usp=sharing)**


---

## Tech Stack

- **Node.js** (ES modules)
- **SQLite** via the [`sqlite`](https://www.npmjs.com/package/sqlite) async wrapper
  around [`sqlite3`](https://www.npmjs.com/package/sqlite3), in WAL mode — gives
  atomic single-statement job claiming and OS-level file locking across separate
  worker processes
- **[`commander`](https://www.npmjs.com/package/commander)** for the CLI
- **[`vitest`](https://vitest.dev/)** for tests (unit + real-process integration tests)

No web framework, no ORM — this is a CLI backed by a single SQLite file, and an ORM
would obscure the exact `UPDATE` statement the atomic claim depends on (see
DECISIONS.md Q1).

---

## Setup

**Requirements:** Node.js ≥ 18, and a POSIX shell (Linux, macOS, or WSL on Windows —
see note below).

```bash
git clone https://github.com/ShatadruM/Flam_task.git
cd queuectl
npm install
chmod +x bin/queuectl.js
```

Optional, to run `queuectl` as a bare command instead of `node bin/queuectl.js`:
```bash
npm link
queuectl --help
```

### A note on Windows

`queuectl` depends on real POSIX signal semantics (`SIGTERM` vs `SIGKILL`) for
graceful shutdown and crash recovery. Node on native Windows does not deliver real
signals to child processes — `worker stop` and graceful shutdown will not behave
correctly under plain PowerShell/cmd. **Run this under WSL** (or Linux/macOS
directly) for correct behavior. If you installed dependencies on native Windows
first, reinstall from inside WSL so `sqlite3`'s native binary is built for Linux:
```bash
rm -rf node_modules package-lock.json
npm install
```

### Verify the install

```bash
npm test
```

All unit and integration tests should pass. Some integration tests spawn real
worker processes and wait on real timers (crash recovery, graceful shutdown), so the
full suite takes roughly a minute.

You can also run all five of the assignment's required scenarios directly against
the CLI:
```bash
./scripts/verify-scenarios.sh
```

---

## Quick Start

```bash
# Enqueue a job
node bin/queuectl.js enqueue '{"id":"job1","command":"echo hello"}'

# Start a worker (foreground — leave this running in its own terminal)
node bin/queuectl.js worker start

# From another terminal: check on it
node bin/queuectl.js list --json
node bin/queuectl.js status

# Stop all running workers, from any terminal
node bin/queuectl.js worker stop
```

---

## Command Reference

### `enqueue`
Add a new job to the queue.

```bash
queuectl enqueue '{"id":"job1","command":"sleep 2"}'
queuectl enqueue --file path/to/job.json
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | must be unique; enqueueing a duplicate id is rejected |
| `command` | yes | run via the shell; exit code 0 = success, anything else = failure |
| `max_retries` | no | defaults to the current `max-retries` config value at enqueue time |

Use `--file` instead of an inline argument on Windows/PowerShell, where shell
quoting for embedded JSON is unreliable.

### `worker start`
Run one or more workers in the foreground. Blocks until stopped.

```bash
queuectl worker start                  # one worker, this process
queuectl worker start --count 4        # 4 workers, as 4 separate OS processes
```

- `Ctrl+C` (`SIGINT`) or `worker stop` (`SIGTERM`) triggers a **graceful shutdown**:
  the worker finishes any in-flight job, then exits.
- `SIGKILL` (a hard crash) is survived: the job it was running is recovered by
  another worker's crash-recovery sweep within a few seconds, never left stuck.

### `worker stop`
Gracefully stop all running workers, from a different terminal/process than the one
running them.

```bash
queuectl worker stop
```

Reads the PID registry under `.queuectl/workers/`, sends `SIGTERM` to each live
worker, and waits for them to exit.

### `status`
Summary of job counts by state, and how many workers are currently active.

```bash
queuectl status
queuectl status --json
```

### `list`
List jobs, optionally filtered by state.

```bash
queuectl list
queuectl list --state pending
queuectl list --json                    # prints ONLY a JSON array to stdout
```

Valid states: `pending`, `processing`, `completed`, `failed`, `dead`.

### `dlq list` / `dlq retry`
View or recover jobs that exhausted their retries.

```bash
queuectl dlq list
queuectl dlq list --json
queuectl dlq retry job1                 # re-enqueues job1, resets its attempt count to 0
```

### `config set`
Configure retry behavior. Persisted across restarts.

```bash
queuectl config set max-retries 3
queuectl config set backoff-base 2      # delay = base ^ attempts, in seconds
```

`max-retries` only affects jobs enqueued *after* the change (the value is resolved
and stored on the job at enqueue time). `backoff-base` affects every future retry
delay calculation immediately, including for already-enqueued jobs. See
DECISIONS.md for the reasoning.

---

## Architecture Overview

```
queuectl (CLI) ──▶ queue.db (SQLite, WAL mode)
                     - jobs table
                     - config table

worker stop ──SIGTERM──▶ worker start (own OS process)
(reads PID files)          - claims jobs via one atomic UPDATE statement
                            - sweeps stale 'processing' jobs before every poll
                            - registers/deregisters a PID file on start/exit
```

- **Atomic claiming:** a single `UPDATE jobs SET state='processing' WHERE id =
  (SELECT ... LIMIT 1) RETURNING *` statement — no window where two workers can grab
  the same job, even across separate OS processes, because SQLite serializes writers
  at the file level.
- **Crash recovery:** every worker checks for stale `processing` jobs (claimed
  longer ago than a timeout) at the start of every poll — not a single dedicated
  reaper — so recovery only needs *any* worker to still be alive.
- **Retry/backoff:** `delay = base ^ attempts` seconds; a job moves to the DLQ once
  it hits `max_retries`.
- **Cross-process `worker stop`:** PID files under `.queuectl/workers/`, signaled
  with `SIGTERM`.

Full reasoning, trade-offs, and rejected alternatives for each of these are in
[`DECISIONS.md`](./DECISIONS.md).

---

## Project Structure

```
queuectl/
├── bin/queuectl.js          # CLI entrypoint
├── src/
│   ├── db/                  # connection, schema, migration
│   ├── jobs/                # enqueue, claim, complete, fail, reaper, list
│   ├── worker/               # run loop, pidfile registry, stop, spawn (--count N)
│   ├── dlq/                  # dlq list / retry
│   ├── config/                # config get/set
│   └── cli/                   # status
├── test/
│   ├── unit/                  # fast, no subprocesses
│   └── integration/           # real CLI processes, real signals, real timing
├── scripts/verify-scenarios.sh
├── DECISIONS.md
├── PROJECT_PLAN.md
└── README.md
```

---

## Testing

```bash
npm test                                    # full suite
npx vitest run test/unit                    # unit tests only, fast
npx vitest run test/integration             # real-process tests, slower
./scripts/verify-scenarios.sh               # the 5 assignment scenarios, end to end
```

Tests were written before their corresponding implementation for each phase of this
project.