-- Replay skips text deltas a later item.updated replaces whole; item updates
-- carry item_id (with empty text, so message text rebuilt from deltas is
-- unchanged) and are indexed to find the last one per item.
UPDATE events SET item_id = json_extract(body, '$.item.id')
  WHERE type = 'item.updated' AND json_extract(body, '$.item.id') IS NOT NULL;

CREATE INDEX events_updates ON events (session_id, item_id, seq)
  WHERE type = 'item.updated';
