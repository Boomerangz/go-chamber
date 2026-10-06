-- archived_at is set while a session is put away from the list; '' means listed.
ALTER TABLE sessions ADD COLUMN archived_at TEXT NOT NULL DEFAULT '';
