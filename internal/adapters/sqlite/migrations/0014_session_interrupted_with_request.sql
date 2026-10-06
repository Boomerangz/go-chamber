-- interrupted_with_request is set when the interrupted turn was waiting for
-- the owner (a question or a permission was open) when it was cut off.
ALTER TABLE sessions ADD COLUMN interrupted_with_request INTEGER NOT NULL DEFAULT 0;
