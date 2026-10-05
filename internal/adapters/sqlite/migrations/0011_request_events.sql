-- Restore closes requests left open by the previous run; reading them must
-- not scan every streamed fragment.
CREATE INDEX events_requests ON events (session_id, seq)
  WHERE type IN ('request.opened', 'request.resolved');
