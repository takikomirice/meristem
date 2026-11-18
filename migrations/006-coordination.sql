CREATE TABLE coordination_decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  payload TEXT NOT NULL,
  form_generation TEXT,
  answer TEXT,
  UNIQUE(run_id,id)
);
CREATE INDEX coordination_decisions_run ON coordination_decisions(run_id);
CREATE TABLE task_holds (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  released_execution_slot INTEGER NOT NULL CHECK(released_execution_slot IN (0,1)),
  PRIMARY KEY(run_id,task_id,decision_id),
  FOREIGN KEY(run_id,decision_id) REFERENCES coordination_decisions(run_id,id)
);
CREATE TABLE parallelism_approvals (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  decision_id TEXT NOT NULL,
  maximum INTEGER NOT NULL CHECK(maximum > 0),
  FOREIGN KEY(run_id,decision_id) REFERENCES coordination_decisions(run_id,id)
);
CREATE TABLE coordination_revisions (
  run_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  previous_plan_hash TEXT NOT NULL,
  proposed_plan_hash TEXT NOT NULL,
  PRIMARY KEY(run_id,decision_id),
  FOREIGN KEY(run_id,decision_id) REFERENCES coordination_decisions(run_id,id)
);
PRAGMA user_version = 6;
