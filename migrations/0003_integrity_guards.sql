ALTER TABLE memory_proposals ADD COLUMN review_lock TEXT;
ALTER TABLE memory_proposals ADD COLUMN review_locked_at TEXT;

CREATE TRIGGER prevent_last_collection_admin_delete
BEFORE DELETE ON memberships
WHEN OLD.role = 'admin'
  AND (SELECT count(*) FROM memberships WHERE collection_id = OLD.collection_id AND role = 'admin') <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_admin');
END;

CREATE TRIGGER prevent_last_collection_admin_demotion
BEFORE UPDATE OF role ON memberships
WHEN OLD.role = 'admin'
  AND NEW.role != 'admin'
  AND (SELECT count(*) FROM memberships WHERE collection_id = OLD.collection_id AND role = 'admin') <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_admin');
END;
