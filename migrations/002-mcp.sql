CREATE TABLE run_bindings (id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), operation_id TEXT NOT NULL, parent TEXT NOT NULL, scope_hash TEXT NOT NULL, scope TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','confirmed','consumed')), confirmed_at TEXT);
CREATE TABLE reports (operation_id TEXT PRIMARY KEY REFERENCES operations(id), run_id TEXT NOT NULL REFERENCES runs(id), attempt_id TEXT NOT NULL REFERENCES attempts(id), turn_id TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE task_decisions (run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT NOT NULL, decision TEXT NOT NULL, PRIMARY KEY(run_id,task_id));
CREATE TABLE binding_history (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE instruction_reservations (operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id));
PRAGMA user_version = 2;
