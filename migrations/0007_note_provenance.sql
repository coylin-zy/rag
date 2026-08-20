ALTER TABLE notes ADD COLUMN source_json TEXT;
ALTER TABLE notes ADD COLUMN observed_at TEXT;
ALTER TABLE notes ADD COLUMN reviewed_at TEXT;
ALTER TABLE notes ADD COLUMN review_after TEXT;
ALTER TABLE notes ADD COLUMN supersedes_json TEXT;
ALTER TABLE notes ADD COLUMN external_path TEXT;
ALTER TABLE notes ADD COLUMN sync_base_hash TEXT;

CREATE INDEX idx_notes_collection_review_after
  ON notes(collection_id, review_after);

CREATE INDEX idx_notes_external_path
  ON notes(collection_id, external_path);
