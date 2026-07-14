PRAGMA foreign_keys = ON;

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE memberships (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, user_email)
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'deleted')),
  version INTEGER NOT NULL,
  indexed_version INTEGER,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX idx_notes_collection_updated ON notes(collection_id, updated_at DESC);
CREATE INDEX idx_notes_status ON notes(status);

CREATE TABLE note_versions (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (note_id, version)
);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  heading_path_json TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (note_id, version, ordinal)
);

CREATE INDEX idx_chunks_note_version ON chunks(note_id, version);
CREATE INDEX idx_chunks_collection_version ON chunks(collection_id, version);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  chunk_id UNINDEXED,
  title,
  heading_path,
  content,
  tokenize='trigram'
);

CREATE TABLE index_jobs (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  version INTEGER,
  type TEXT NOT NULL CHECK (type IN ('index', 'delete')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_jobs_status_updated ON index_jobs(status, updated_at DESC);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  collection_ids_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE memory_proposals (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  source TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_by_token_id TEXT NOT NULL REFERENCES api_tokens(id),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_note TEXT,
  approved_note_id TEXT
);

CREATE INDEX idx_proposals_status_created ON memory_proposals(status, created_at DESC);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'token', 'system')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
