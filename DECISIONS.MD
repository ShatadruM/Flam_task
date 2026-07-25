# DECISIONS.md — QueueCTL

**Stack:** Node.js (JavaScript), `better-sqlite3` for persistence, native `child_process.exec` for job execution.

> Read this before the live review: every claim below points to a mechanism you must actually be able to point to in your own code. Don't paste this file — implement the thing it describes, then rewrite this in your own words once the code matches it.

---

## 0. Why SQLite (context for all five answers)

Persistence is SQLite (via `better-sqlite3`), in WAL mode, one file (`queue.db`) in the project root.

**Why:** SQLite gives you two things for free that a hand-rolled JSON-file store cannot: (1) atomic read-modify-write via a single `UPDATE` statement, and (2) cross-process locking enforced by the OS file lock underneath the SQLite file — not by anything in your Node process, so it works correctly even when workers are separate OS processes started from separate terminals.

**Rejected — flat JSON file with an in-process mutex:** an in-process lock (e.g. a JS `Mutex` or `async-lock`) only protects against races *within one process*. Two `worker start` processes each get their own Node event loop and their own copy of the lock — it does nothing across processes. You'd have to reinvent file locking (`flock`) yourself, which SQLite already does correctly.

**Rejected — one JSON file per job with `flock`:** works, but every operation (list, status, backoff scan) becomes a directory scan + N file opens, and you still have to hand-roll atomic claim semantics (rename-based locking, lockfiles) that SQLite gives you as a single statement. Not worth reinventing.

---

## 1. Which exact line(s) prevent two workers from claiming the same job, and why is that atomic across separate OS processes?

**The line — one statement, no gap between read and write:**

```sql
UPDATE jobs
SET state = 'processing',
    worker_id = @workerId,
    claimed_at = @now,
    updated_at = @now
WHERE id = (
  SELECT id FROM jobs
  WHERE state IN ('pending', 'failed')
    AND next_attempt_at <= @now
  ORDER BY created_at ASC
  LIMIT 1
)
RETURNING *;
```

This is one `db.prepare(...).get()` call in `claimNextJob()` — there is no separate `SELECT` followed by an `UPDATE` in application code. That's the entire point: if you did `SELECT` then `UPDATE` as two statements, two workers could both `SELECT` the same pending job before either `UPDATE`s it, and both would start executing it. By folding the selection into the `WHERE id = (subquery)` of a single `UPDATE`, there is no window in application code where two processes can both observe the job as claimable.

**Why it's atomic *across OS processes*, not just within one:** SQLite serializes all writers at the file level. In WAL mode, a writer takes an exclusive lock on the database file for the duration of a write transaction; this lock is implemented via `flock()`/OS file locking primitives, which are enforced by the kernel, not by anything running inside your Node process. So even though `worker start` in terminal A and `worker start` in terminal B are two completely independent OS processes with no shared memory, when both call `claimNextJob()` at the same instant, SQLite forces one `UPDATE` to fully commit before the other's `UPDATE` subquery even runs — the second worker's subquery no longer sees that job as `pending`/`failed`, because the first worker's row-level change is already visible. Set `busy_timeout` (e.g. `db.pragma('busy_timeout = 5000')`) so a worker that loses the race blocks briefly and retries instead of throwing `SQLITE_BUSY`.

**Rejected — optimistic locking with a version column, read-then-write in JS:** would require `SELECT` job, check `version`, `UPDATE ... WHERE id = ? AND version = ?`, and retry on 0-rows-affected. This *also* works correctly, but it's strictly more code for the same guarantee the subquery already gives for free — rejected for unnecessary complexity.

---

## 2. A worker is `SIGKILL`ed halfway through a job. Walk through, step by step, what state the job is in and how it eventually runs again. What is the worst-case delay before recovery?

**Step by step:**

1. Worker A claims job `job1`: row becomes `state='processing'`, `claimed_at=<t0>`, `worker_id=<pidA>`.
2. Worker A is `SIGKILL`ed while `job1` is mid-execution. No signal handler runs (can't be caught), the child shell command may also die (or become orphaned, depending on OS process group handling — see note below). The database row is untouched: it is *permanently* left as `state='processing'` from SQLite's point of view, since nobody told it otherwise.
3. Every worker process, including Worker B (and A, if it's later restarted), runs a **reaper sweep** immediately before each poll for new work. The sweep is a single statement:

```sql
UPDATE jobs
SET state = 'failed',
    updated_at = @now,
    next_attempt_at = @now
WHERE state = 'processing'
  AND claimed_at <= @staleCutoff;   -- now - STALE_TIMEOUT_MS
```

4. Once `job1`'s `claimed_at` is older than `STALE_TIMEOUT_MS`, the next reaper sweep (run by *any* live worker, not just the one that died — this matters if Worker A never comes back) flips it back to `failed`, making it eligible for the normal retry/backoff path (`attempts` is **not** incremented by the reaper itself — see rationale below).
5. On the next poll cycle, `job1` is claimable again via the query in Q1 and gets picked up by whichever worker polls first.

**Worst-case delay math:** with `POLL_INTERVAL_MS = 2000` and `STALE_TIMEOUT_MS = 15000` (both defaults, configurable), the worst case is: job claimed at `t0`, worker dies at `t0+ε`. The reaper only catches it once `now - claimed_at > STALE_TIMEOUT_MS`, i.e. at `t0 + 15s`, and the sweep only runs when *some* worker polls, which happens at most `POLL_INTERVAL_MS` later. Worst case ≈ `15s + 2s = 17s`, safely under the 60s requirement, with margin for slow test-runner scheduling.

**Does the reaper reset `attempts`?** No — the reaper only changes `state`; it does not touch `attempts`. Incrementing `attempts` happens at the point a job is executed and *fails* (or is not confirmed complete) via the worker's own post-execution update. This means a crash-recovered job still consumes a retry slot the same way a normal failure would (it did fail to complete), keeping the `max_retries` accounting consistent — an infinite crash loop on a poisoned job still eventually reaches the DLQ instead of retrying forever.

**Rejected — a single dedicated "reaper" process:** simpler to reason about, but it's a single point of failure: if that one process is the one that gets `SIGKILL`ed (or never started), stuck jobs are never recovered. Making every worker sweep on its own poll loop means recovery only requires *any one* worker to be alive — matches the "must recover within 60s" requirement even in partial-crash scenarios.

**Rejected — OS process supervision (e.g. relying on the parent shell / `nohup` to detect child death and requeue):** `SIGKILL` cannot be intercepted or cleaned up after by the killed process itself, and relying on an external supervisor to also update the DB adds a second component with its own crash modes. The timestamp-based reaper only depends on the database, which is the one thing guaranteed to survive the crash.

---

## 3. Does `dlq retry <id>` reset `attempts`? Why is that the right call?

**Yes — `dlq retry` resets `attempts` to `0`** (and sets `state='pending'`, clears `worker_id`, sets `next_attempt_at=now`).

**Reasoning:** a job only reaches the DLQ after exhausting `max_retries` under the assumption that whatever was wrong when it failed is still wrong. A human (or an automated remediation) calling `dlq retry` is asserting "the underlying condition has changed" — a downstream service is back up, a bug was patched, a config value was fixed. If `attempts` were *not* reset, the job would already be at `attempts === max_retries`, so under the retry logic in `System Requirements §2` it would fail its very next attempt (if it fails once more) and go straight back to `dead` without ever getting the backoff delay a normal retry sequence gets — effectively giving the operator a single, immediate, high-stakes retry instead of the same graceful multi-attempt retry every other job gets. Resetting `attempts` treats a DLQ retry as "start this job's retry lifecycle over," which is the operator's actual intent.

**Rejected — keep `attempts` as-is:** technically preserves "true" historical attempt count, but produces a worse operational experience (one shot, then straight back to dead) and doesn't match what "retry" implies to whoever is running the command. Rejected in favor of a mechanism that behaves the way its name suggests.

---

## 4. What designs did you consider and reject for `worker stop` (cross-process signaling), and why?

**Chosen — PID file registry:** each `worker start` process, on boot, writes its own PID to `.queuectl/workers/<pid>.pid` (containing PID + start timestamp), and removes that file in its shutdown path (both the graceful-exit path and a `process.on('exit', ...)` best-effort cleanup). `worker stop`, running in a separate terminal, reads every file in `.queuectl/workers/`, sends `SIGTERM` to each PID (after verifying via `process.kill(pid, 0)` that it's still alive, to skip stale files from a previous crash), and polls briefly for the PID file to disappear (worker exited) before returning. This satisfies the interface contract directly: `SIGTERM` triggers the worker's own graceful-shutdown handler (finish in-flight job, then exit), and it works from a different terminal because PIDs and signals are OS-level, not tied to any shared parent process or terminal session.

**Rejected — Unix domain control socket:** `worker stop` connects to a socket each worker listens on and sends a `stop` message. This is strictly more moving parts (socket lifecycle, listen-address collisions if multiple workers share a path, cleanup-on-crash is *also* needed here since a dead worker leaves a stale socket file) for no capability `SIGTERM` doesn't already give — `SIGTERM` is precisely "please shut down gracefully," which is the OS-native version of the same message. Rejected as unnecessary indirection.

**Rejected — DB row heartbeat + "stop requested" flag:** register each worker as a row in a `workers` table with a periodic heartbeat timestamp; `worker stop` sets a `stop_requested=1` flag (globally or per-row) that each worker checks on its own poll loop before picking up the next job. Rejected because it makes shutdown *latency-bound by the poll interval* instead of instant — a worker mid-poll-sleep won't notice the flag until it wakes up, and if it's mid-execution of a long job it won't even check until that job finishes anyway (which is actually correct for the "finish current job" requirement, but the *stop signal itself* being polled rather than pushed adds needless delay for the common case of an idle worker). It also adds a periodic heartbeat write to the hot path for no benefit over an OS signal.

**Rejected — `pkill -f queuectl` / process-name matching:** fragile and unsafe: it can match unrelated processes with `queuectl` in their command line (e.g. a text editor with the source file open, a grep in the same shell history), doesn't distinguish this project's workers from another checkout of the same repo running on the same machine, and isn't scriptable across platforms consistently. Rejected on both correctness and safety grounds.

---

## 5. If priorities were added tomorrow (high-priority jobs jump the queue), which parts of your design survive unchanged and which break?

**Survives unchanged:**
- The SQLite persistence model and schema-as-source-of-truth approach.
- The atomic single-`UPDATE`-with-subquery claim pattern from Q1 — priority is just another column that changes the subquery's `ORDER BY`, not the atomicity mechanism itself.
- The reaper/crash-recovery mechanism from Q2 — stale `processing` jobs are recovered the same way regardless of priority.
- The DLQ and `dlq retry` semantics from Q3 — priority has no bearing on whether a job's retry budget is exhausted.
- The PID-file-based `worker stop` mechanism from Q4 — worker lifecycle management is orthogonal to job scheduling order.
- Config persistence (`config set`) mechanism — priority-related settings (if any, e.g. a default priority or aging rate) would use the same store.

**Breaks / needs changes:**
- **The claim query's `ORDER BY`:** currently `ORDER BY created_at ASC` (pure FIFO). Adding priority means `ORDER BY priority DESC, created_at ASC`, plus a `priority INTEGER NOT NULL DEFAULT 0` column and a supporting index on `(state, priority, created_at)` so the claim query stays a fast indexed lookup instead of a full scan as the table grows.
- **The job spec / `enqueue` command:** needs an optional `priority` field, with a documented default so existing enqueue calls (and the `Job Specification` schema from the assignment) keep working unmodified — backward compatible, not a breaking change to the CLI surface.
- **Starvation:** pure `priority DESC` ordering can starve low-priority jobs indefinitely if high-priority jobs keep arriving. Not handled in the current design at all — would need an aging factor (e.g. effective priority increases the longer a job waits) added to the `ORDER BY` expression. This is new logic, not a tweak to existing logic.
- **`status`/`list` output:** would need to surface `priority` as a field to remain useful for debugging queue behavior, and `list --state pending` output ordering would need to reflect the same priority order workers actually claim in, to avoid the CLI view being misleading.