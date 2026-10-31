-- Seed the state of a paginated transcript without scanning item payloads.
CREATE INDEX events_state ON events (session_id, type, seq)
  WHERE type IN ('session.state', 'turn.started', 'turn.ended', 'usage');
