CREATE TABLE run_usage (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  policy TEXT NOT NULL,
  observation TEXT,
  waiting INTEGER NOT NULL DEFAULT 0
);
PRAGMA user_version = 7;
