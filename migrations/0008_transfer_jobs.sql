ALTER TABLE notes ADD COLUMN external_path TEXT;
ALTER TABLE notes ADD COLUMN sync_base_hash TEXT;

CREATE INDEX idx_notes_external_path
  ON notes(collection_id, external_path);

CREATE UNIQUE INDEX idx_notes_collection_external_path_unique
  ON notes(collection_id, external_path)
  WHERE external_path IS NOT NULL;
