-- key is "access:" or "refresh:" and the token's SHA-256; the token itself
-- is never stored. expires is in Unix nanoseconds.
CREATE TABLE oauth_tokens (
  key      TEXT PRIMARY KEY,
  client   TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires  INTEGER NOT NULL
) WITHOUT ROWID;
