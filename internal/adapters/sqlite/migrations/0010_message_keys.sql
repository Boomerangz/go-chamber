-- FTS metadata columns are UNINDEXED. Keep a normal indexed key -> rowid
-- mapping so replacing a message does not scan the entire search archive.
CREATE TABLE message_keys (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  UNIQUE (session_id, item_id)
);

INSERT INTO message_keys (id, session_id, item_id)
SELECT rowid, session_id, item_id FROM messages_fts;
