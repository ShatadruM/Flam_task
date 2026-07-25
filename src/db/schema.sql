CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  command         TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'processing', 'completed', 'failed', 'dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_retries     INTEGER NOT NULL DEFAULT 3,
  worker_id       TEXT,
  claimed_at      TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_claimable
  ON jobs (state, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_jobs_processing_claimed_at
  ON jobs (state, claimed_at);

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);