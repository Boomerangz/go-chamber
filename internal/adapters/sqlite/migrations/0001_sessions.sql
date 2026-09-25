CREATE TABLE sessions (
    id                  TEXT PRIMARY KEY,
    agent               TEXT NOT NULL,
    cwd                 TEXT NOT NULL,
    native_id           TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL,
    title               TEXT NOT NULL DEFAULT '',
    interruption_reason TEXT NOT NULL DEFAULT '',
    resume_after        TEXT NOT NULL DEFAULT ''
);
