# QueueCTL — Project Plan

A CLI-based background job queue with worker processes, retry/backoff, a Dead Letter
Queue, and crash-safe persistence — built in **Node.js / JavaScript**.

This document is the build plan. `DECISIONS.md` is the *why*; this is the *in what
order, and how it's laid out*. Treat this as a checklist, not a spec to build all at
once — each phase should end with a working, tested slice of the system, committed to
git before you move on (the assignment explicitly reads incremental git history).

---

## 1. Tech Stack

| Concern | Choice | Why (short — full reasoning in DECISIONS.md) |
|---|---|---|
| Language / runtime | Node.js (JavaScript, CommonJS) | required by assignment choice |
| CLI framework | [`commander`](https://www.npmjs.com/package/commander) | mature, minimal, good subcommand support (`enqueue`, `worker start`, `dlq retry`, etc.) |
| Persistence | SQLite via [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3) | synchronous API (no accidental interleaving from async callbacks), atomic single-statement claim, OS-level cross-process file locking |
| Job execution | `child_process.execSync` or `exec` (shell) | assignment requires shell execution of `command`, exit code determines success/failure |
| Process identification | raw `process.pid`, PID files on disk | needed for `worker stop` cross-process signaling (see DECISIONS.md Q4) |
| Testing | [`vitest`](https://www.npmjs.com/package/vitest) | fast, works well with sync SQLite, supports child-process spawning for integration tests |
| Process spawning in tests | `child_process.spawn` | integration tests need to start real `worker start` as a real OS process, then send it real signals — this is the whole point of the assignment |
| Linting/formatting | ESLint + Prettier (optional but keeps code review clean) | code quality is graded |

**No web framework, no ORM.** Both are unjustified complexity for a CLI + single SQLite
file — an ORM in particular would obscure the exact `UPDATE` statement that Q1 in
DECISIONS.md requires you to point to.

---

## 2. Architecture Recap (from DECISIONS.md)

```
┌─────────────────┐        ┌──────────────────┐
│  queuectl (CLI)  │──────▶ │   queue.db         │  (SQLite, WAL mode)
│  enqueue/list/    │       │   - jobs table      │
│  status/dlq/config │      │   - config table    │
└─────────────────┘        └──────────────────┘
        ▲                              ▲
        │                              │ atomic claim (single UPDATE)
        │                              │
┌───────┴────────┐           ┌─────────┴────────┐
│ worker stop      │──SIGTERM─▶│  worker start #1  │──▶ reaper sweep + poll loop
│ (reads PID files) │          │  (own OS process)  │
└──────────────────┘          └────────────────────┘
                                          │
                               ┌──────────┴──────────┐
                               │  worker start #2      │  (separate terminal,
                               │  (own OS process)      │   separate PID file)
                               └────────────────────────┘
```

Core mechanisms (each has a dedicated Q&A in DECISIONS.md):
1. **Atomic claim** — `UPDATE jobs SET state='processing' WHERE id = (SELECT ... LIMIT 1) RETURNING *` — one statement, no race window.
2. **Crash recovery** — every worker sweeps for stale `processing` rows (`claimed_at` older than `STALE_TIMEOUT_MS`) before each poll.
3. **Retry/backoff** — `delay = base ^ attempts` seconds, computed from `next_attempt_at`, checked in the same claim query.
4. **DLQ** — jobs move to `dead` after `max_retries`; `dlq retry` resets `attempts`.
5. **Cross-process `worker stop`** — PID files in `.queuectl/workers/`, signaled with `SIGTERM`.

---

## 3. File Structure

```
queuectl/
├── bin/
│   └── queuectl.js              # CLI entrypoint (shebang, commander setup, dispatch)
├── src/
│   ├── db/
│   │   ├── connection.js        # opens/creates queue.db, sets PRAGMAs (WAL, busy_timeout)
│   │   ├── schema.sql           # CREATE TABLE statements (jobs, config)
│   │   └── migrate.js           # applies schema.sql if not already applied
│   ├── jobs/
│   │   ├── enqueue.js           # validates + inserts a new job row
│   │   ├── claim.js             # THE atomic claim query (Q1 of DECISIONS.md lives here)
│   │   ├── complete.js          # marks a job completed
│   │   ├── fail.js              # marks a job failed, computes next_attempt_at via backoff, or moves to dead
│   │   └── reaper.js            # stale 'processing' -> 'failed' sweep (Q2)
│   ├── worker/
│   │   ├── run.js               # worker start: poll loop, reaper call, job execution, signal handlers
│   │   ├── pidfile.js           # write/remove/list PID files under .queuectl/workers/
│   │   └── stop.js              # worker stop: reads PID files, sends SIGTERM, waits for exit
│   ├── dlq/
│   │   └── dlq.js               # dlq list / dlq retry (resets attempts — Q3)
│   ├── config/
│   │   └── config.js            # config get/set, persisted in the config table
│   ├── cli/
│   │   ├── status.js            # queuectl status
│   │   └── list.js              # queuectl list --state <state> [--json]
│   └── lib/
│       ├── backoff.js           # delay = base ^ attempts, pure function, easy to unit test
│       └── logger.js            # small structured logger (stdout for --json must stay clean!)
├── test/
│   ├── unit/
│   │   ├── backoff.test.js
│   │   ├── claim.test.js
│   │   ├── fail-and-dlq.test.js
│   │   └── reaper.test.js
│   └── integration/
│       ├── basic-job-completes.test.js
│       ├── retry-backoff-to-dlq.test.js
│       ├── concurrent-workers-exactly-once.test.js
│       ├── sigkill-recovery.test.js
│       └── restart-persistence.test.js
├── .queuectl/                   # gitignored — runtime state (queue.db, PID files)
│   └── workers/
├── package.json
├── README.md
├── DECISIONS.md
├── PROJECT_PLAN.md              # this file
└── .gitignore                   # .queuectl/, node_modules/
```

**Why this shape:** `src/jobs/*` contains the state machine and is where nearly all
correctness lives (this is what the automated test scenarios exercise) — kept
separate from `src/cli/*` and `bin/queuectl.js`, which are just thin argument-parsing
and formatting layers. This separation is also what makes the "live change" portion of
the review tractable: a new command or behavior tweak should mean touching one or two
small files, not hunting through a monolith.

---

## 4. Testing Philosophy — Write Tests First

**Tests for each phase are written before the implementation that satisfies them.**
This isn't a formality — it directly de-risks the two hardest, least-forgiving parts
of this assignment:

- **Concurrency correctness** (Q1: exactly-once claiming) and **crash recovery**
  (Q2: worst-case 60s) are exactly the kind of bugs that *look* fine in casual manual
  testing and only show up under real concurrent load or a real `SIGKILL`. Writing the
  integration test first (spawn N real worker processes, `SIGKILL` one mid-job, assert
  on the DB state after) forces you to define "correct" precisely before you write code
  that might convince you it's correct when it isn't.
- The assignment's own automated test suite mirrors this exactly — scenarios 1-5 are
  process-level, black-box tests against your real CLI. If you've already written and
  passed the same category of test yourself, there should be no surprises in the live
  review.

**Practical rule for every phase below:** write the failing test(s) for that phase
first, watch them fail for the right reason, then implement until they pass, then
commit both together (or the test first, implementation second, as separate commits —
either is fine, just don't implement first and backfill tests after).

---

## 5. Phase-Wise Plan

### Phase 0 — Project Scaffolding
- `npm init`, install `commander`, `better-sqlite3`, `vitest`.
- `bin/queuectl.js` with commander wired up, all subcommands registered as stubs
  (`enqueue`, `worker start`, `worker stop`, `status`, `list`, `dlq list`, `dlq retry`,
  `config set`) that just print "not implemented" — so the CLI surface exists end to end
  from commit one.
- `.gitignore`, empty `README.md`, `DECISIONS.md` already written.
- **Commit.**

### Phase 1 — Persistence Layer + Schema
- Write `test/unit/schema.test.js` first: open a fresh DB, assert the `jobs` table and
  `config` table exist with the right columns/types after migration.
- `src/db/schema.sql`: `jobs` table (`id TEXT PRIMARY KEY, command TEXT, state TEXT,
  attempts INTEGER, max_retries INTEGER, worker_id TEXT, claimed_at TEXT,
  next_attempt_at TEXT, created_at TEXT, updated_at TEXT`) + `config` table
  (`key TEXT PRIMARY KEY, value TEXT`).
- `src/db/connection.js`: open `.queuectl/queue.db`, set `PRAGMA journal_mode = WAL`,
  `PRAGMA busy_timeout = 5000`.
- `src/db/migrate.js`: idempotent — safe to call on every CLI invocation.
- **Commit.**

### Phase 2 — Enqueue + List (no workers yet)
- Tests first: enqueue a job, assert it's readable via `list --state pending --json`
  as a valid JSON array; assert `list` prints *only* JSON to stdout when `--json` is
  passed (this is an explicit interface-contract requirement).
- Implement `src/jobs/enqueue.js` (validates required fields from the Job
  Specification, defaults `state: 'pending'`, `attempts: 0`, timestamps).
- Implement `src/cli/list.js`.
- **Commit.**

### Phase 3 — Atomic Claim (Q1) + Single-Process Worker Loop
- Tests first (`test/unit/claim.test.js`): insert 2 pending jobs, call `claim()` twice
  from the *same* process, assert two different jobs come back and both are now
  `processing`. Then: insert 1 job, call `claim()` from two separate `better-sqlite3`
  connections opened against the same file, assert only one succeeds — this is the
  first real test of the atomicity claim in DECISIONS.md.
- Implement `src/jobs/claim.js` — the single `UPDATE ... WHERE id = (subquery) ...
  RETURNING *` statement.
- Implement `src/worker/run.js` as a single-process poll loop: claim → execute via
  `child_process.exec` → mark complete/failed based on exit code. No signal handling,
  no multi-process concerns yet — just correctness of one worker doing one job at a
  time.
- **Commit.**

### Phase 4 — Retry, Backoff, DLQ (Q3)
- Tests first: a job that always fails should retry with `delay = base^attempts`
  (assert `next_attempt_at` is set correctly), and after `max_retries` failed attempts
  should end up `state='dead'`.
- Implement `src/lib/backoff.js` (pure function, trivially unit-testable) and
  `src/jobs/fail.js` (increments `attempts`, computes `next_attempt_at`, or transitions
  to `dead` if `attempts >= max_retries`).
- Update `claim.js`'s `WHERE` clause to also respect `next_attempt_at <= now`.
- Implement `src/dlq/dlq.js`: `dlq list`, `dlq retry <id>` (resets `attempts` to 0 —
  Q3).
- Integration test: full run of "job fails repeatedly → lands in DLQ → `dlq retry` →
  runs again and can now succeed."
- **Commit.**

### Phase 5 — Multi-Process Workers + Graceful Shutdown
- Tests first (`test/integration/concurrent-workers-exactly-once.test.js`): enqueue N
  jobs (each just appends its own ID to a shared file, e.g. via the job command doing
  `echo <id> >> results.txt`), spawn multiple real `worker start` **processes** via
  `child_process.spawn`, wait for completion, assert every job appears in the results
  file **exactly once**.
- Add `SIGTERM`/`SIGINT` handling to `src/worker/run.js`: on signal, stop polling for
  *new* work, finish the current in-flight job, then exit(0).
- **Commit.**

### Phase 6 — Crash Recovery / Reaper (Q2)
- Tests first (`test/integration/sigkill-recovery.test.js`): spawn a worker as a real
  process, enqueue a slow job (e.g. `sleep 5`), wait until it's claimed
  (`state='processing'`), `SIGKILL` the worker process, then poll the DB in a loop and
  assert the job returns to a retryable/completed state within 60 seconds, and is never
  duplicated.
- Implement `src/jobs/reaper.js` and call it from the top of every poll iteration in
  `src/worker/run.js`.
- **Commit.**

### Phase 7 — `worker stop` (Q4) + PID Files
- Tests first: spawn 2 worker processes, run `worker stop` (as its own process, or by
  calling the module directly from the test), assert both worker processes have
  exited and their PID files are removed.
- Implement `src/worker/pidfile.js` (write on start, remove on exit — both the
  graceful path and an `process.on('exit')` best-effort cleanup) and
  `src/worker/stop.js` (read all files in `.queuectl/workers/`, `process.kill(pid,
  0)` to check liveness, send `SIGTERM`, poll for PID file removal, report
  timeouts).
- **Commit.**

### Phase 8 — `status`, `config`, Persistence-Across-Restart
- Tests first: `restart-persistence.test.js` — enqueue jobs, run some to completion,
  kill everything (no processes left running), reopen the DB fresh (simulating a
  process restart), assert all job states are exactly as they were left.
- Implement `src/cli/status.js` (counts per state + count of live workers, derived
  from PID files).
- Implement `src/config/config.js` (`config set max-retries 3`, `config set
  backoff-base 2`, persisted in the `config` table; document in DECISIONS.md /
  README whether it affects already-enqueued jobs — decide and note the answer).
- **Commit.**

### Phase 9 — Full Scenario Pass + Polish
- Run all 5 scenarios from the assignment end-to-end, manually, exactly as described
  (basic completion, retry-to-DLQ, multi-worker exactly-once, `SIGKILL` recovery,
  full restart) — not just your own unit/integration tests, the literal scenario
  descriptions.
- Fix any gaps between "my tests pass" and "the scenario as described passes."
- Clean up error handling: malformed `enqueue` JSON, duplicate job IDs, invalid
  `--state` values, missing job IDs for `dlq retry`.
- **Commit.**

### Phase 10 — README, Demo Recording
- `README.md`: setup steps, install instructions, usage examples for every CLI
  command, architecture overview (can summarize DECISIONS.md), how to run the test
  suite.
- Record a short CLI demo (enqueue a few jobs, start workers in one terminal, `worker
  stop` from another, show a job in the DLQ, `dlq retry` it). Link it in the README.
- **Commit.**
- (Bonus, only if time remains: job timeouts, priority queues, `run_at` scheduled
  jobs, output logging, metrics, minimal web dashboard — in that order of effort vs.
  payoff, and only after everything above is solid.)

---

## 6. Definition of Done (per phase)

Before moving to the next phase, each phase should satisfy all of:
- [ ] Tests for this phase were written before the corresponding implementation.
- [ ] `npm test` passes, including everything from prior phases (no regressions).
- [ ] The CLI surface for this phase works when run manually, not just under the
      test runner.
- [ ] Changes are committed with a message describing *what phase / capability* this
      commit adds — this is what an incremental, explainable git history looks like.