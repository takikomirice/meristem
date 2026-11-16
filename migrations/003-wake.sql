ALTER TABLE wake_deliveries ADD COLUMN source_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wake_deliveries ADD COLUMN stop_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wake_deliveries ADD COLUMN parent TEXT;
ALTER TABLE wake_deliveries ADD COLUMN turn_id TEXT;
CREATE TABLE wake_cursors (run_id TEXT PRIMARY KEY REFERENCES runs(id), scanned_seq INTEGER NOT NULL DEFAULT 0, pending_seq INTEGER NOT NULL DEFAULT 0, delivered_seq INTEGER NOT NULL DEFAULT 0, read_seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE correction_counts (run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(run_id,task_id));
PRAGMA user_version = 3;
