ALTER TABLE requests ADD COLUMN worker TEXT;
ALTER TABLE requests ADD COLUMN turn_id TEXT;
ALTER TABLE requests ADD COLUMN payload_hash TEXT;
ALTER TABLE requests ADD COLUMN form_generation TEXT;
ALTER TABLE requests ADD COLUMN expires_at INTEGER;
ALTER TABLE attempts ADD COLUMN completed_turn_id TEXT;
PRAGMA user_version = 4;
