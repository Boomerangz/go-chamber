CREATE TABLE quotas (
    agent      TEXT PRIMARY KEY,
    snapshot   TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
