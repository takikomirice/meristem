CREATE TABLE plans (run_id TEXT PRIMARY KEY REFERENCES runs(id), snapshot TEXT NOT NULL, pin TEXT NOT NULL, binding_hash TEXT NOT NULL, frozen INTEGER NOT NULL DEFAULT 0, initialized INTEGER NOT NULL DEFAULT 0);
CREATE TABLE plan_revisions (run_id TEXT NOT NULL REFERENCES runs(id), plan_hash TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(run_id,plan_hash));
CREATE TABLE git_assignments (attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), payload TEXT NOT NULL);
CREATE TABLE plan_task_state (run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id,task_id));
CREATE TABLE decisions (operation_id TEXT PRIMARY KEY REFERENCES operations(id), run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT NOT NULL, parent_turn_id TEXT NOT NULL, payload TEXT NOT NULL);
PRAGMA user_version = 5;
