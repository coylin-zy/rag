ALTER TABLE notes ADD COLUMN source_json TEXT;
ALTER TABLE notes ADD COLUMN observed_at TEXT;
ALTER TABLE notes ADD COLUMN reviewed_at TEXT;
ALTER TABLE notes ADD COLUMN review_after TEXT;
ALTER TABLE notes ADD COLUMN supersedes_json TEXT;

CREATE INDEX idx_notes_collection_review_after
  ON notes(collection_id, review_after);

CREATE INDEX idx_notes_supersedes
  ON notes(supersedes_json)
  WHERE supersedes_json IS NOT NULL;
