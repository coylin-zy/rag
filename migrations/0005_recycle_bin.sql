ALTER TABLE collections ADD COLUMN trashed_at TEXT;
ALTER TABLE collections ADD COLUMN trashed_by TEXT;
ALTER TABLE collections ADD COLUMN trash_reason TEXT;
ALTER TABLE collections ADD COLUMN purge_after TEXT;

ALTER TABLE notes ADD COLUMN deleted_from_status TEXT
  CHECK (deleted_from_status IS NULL OR deleted_from_status IN ('draft', 'published'));
ALTER TABLE notes ADD COLUMN deleted_by TEXT;
ALTER TABLE notes ADD COLUMN delete_reason TEXT;

CREATE INDEX idx_collections_trashed_updated
  ON collections(trashed_at, updated_at DESC);

CREATE INDEX idx_notes_collection_deleted
  ON notes(collection_id, deleted_at DESC);
