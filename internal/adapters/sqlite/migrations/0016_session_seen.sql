-- seen_item/seen_at are where the owner last looked at the session, on any
-- device; ended_at is when a turn last ended. '' means never.
ALTER TABLE sessions ADD COLUMN seen_item TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN seen_at TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN ended_at TEXT NOT NULL DEFAULT '';
