-- interrupted_request is the gist of the request the interrupted turn was
-- waiting on when it was cut off ("" when none or not known).
ALTER TABLE sessions ADD COLUMN interrupted_request TEXT NOT NULL DEFAULT '';
