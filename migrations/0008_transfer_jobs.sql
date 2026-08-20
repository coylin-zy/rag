CREATE UNIQUE INDEX idx_notes_collection_external_path_unique
  ON notes(collection_id, external_path)
  WHERE external_path IS NOT NULL;

CREATE TABLE transfer_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('import', 'export_portable', 'export_backup')),
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'planning', 'planned', 'queued', 'processing', 'completed', 'failed', 'cancelled')),
  plan_version INTEGER NOT NULL DEFAULT 0,
  total_items INTEGER NOT NULL DEFAULT 0,
  completed_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  conflict_items INTEGER NOT NULL DEFAULT 0,
  invalid_items INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  manifest_hash TEXT,
  verified_at TEXT,
  verified_by TEXT,
  verification_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  last_error TEXT
);

CREATE INDEX idx_transfer_jobs_collection_updated
  ON transfer_jobs(collection_id, updated_at DESC);

CREATE INDEX idx_transfer_jobs_status_updated
  ON transfer_jobs(status, updated_at DESC);

CREATE TABLE transfer_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES transfer_jobs(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  staged_r2_key TEXT,
  source_sha256 TEXT,
  byte_size INTEGER NOT NULL DEFAULT 0,
  action TEXT CHECK (action IN ('create', 'update', 'unchanged', 'conflict', 'conflict_deleted', 'invalid')),
  decision TEXT CHECK (decision IN ('skip', 'overwrite', 'copy')),
  decision_path TEXT,
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'planned', 'queued', 'processing', 'completed', 'failed', 'cancelled')),
  target_note_id TEXT,
  expected_version INTEGER,
  result_note_id TEXT,
  result_version INTEGER,
  error_code TEXT,
  error_message TEXT,
  operation_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(job_id, relative_path),
  UNIQUE(job_id, operation_key)
);

CREATE INDEX idx_transfer_items_job_status
  ON transfer_items(job_id, status, id);

CREATE INDEX idx_transfer_items_job_action
  ON transfer_items(job_id, action, id);

CREATE TABLE transfer_export_objects (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES transfer_jobs(id) ON DELETE CASCADE,
  logical_path TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('current_markdown', 'history_markdown', 'collection_metadata', 'note_metadata', 'version_metadata')),
  note_id TEXT,
  note_version INTEGER,
  r2_key TEXT,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(job_id, logical_path)
);

CREATE INDEX idx_transfer_export_objects_job
  ON transfer_export_objects(job_id, id);
