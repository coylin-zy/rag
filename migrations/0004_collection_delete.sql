DROP TRIGGER prevent_last_collection_admin_delete;

CREATE TRIGGER prevent_last_collection_admin_delete
BEFORE DELETE ON memberships
WHEN OLD.role = 'admin'
  AND EXISTS (SELECT 1 FROM collections WHERE id = OLD.collection_id)
  AND (SELECT count(*) FROM memberships WHERE collection_id = OLD.collection_id AND role = 'admin') <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_admin');
END;
