CREATE TABLE events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  -- item_id and text are set for text deltas so a message streamed without
  -- a final full text can be rebuilt for the search index.
  item_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE INDEX events_deltas ON events (session_id, item_id) WHERE item_id != '';

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  session_id UNINDEXED,
  item_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
