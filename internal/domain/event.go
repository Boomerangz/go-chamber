package domain

import "fmt"

// Seq is a monotonic per-session event sequence number used for replay.
type Seq int64

// EventType tags an entry of the normalized session event log.
type EventType string

const (
	EventSessionState    EventType = "session.state"
	EventTurnStarted     EventType = "turn.started"
	EventTurnEnded       EventType = "turn.ended"
	EventItemUpdated     EventType = "item.updated"
	EventTextDelta       EventType = "text.delta"
	EventRequestOpened   EventType = "request.opened"
	EventRequestResolved EventType = "request.resolved"
	EventSubagentSpawned EventType = "subagent.spawned"
	EventQuota           EventType = "quota"
	EventUsage           EventType = "usage"
)

// Event is one entry in a session's append-only event log. Seq is assigned
// by the session manager, not by agent adapters.
type Event struct {
	Seq       Seq              `json:"seq"`
	SessionID SessionID        `json:"sessionId"`
	Type      EventType        `json:"type"`
	Session   *SessionSnapshot `json:"session,omitempty"`
	Item      *Item            `json:"item,omitempty"`
	Delta     *Delta           `json:"delta,omitempty"`
	Request   *Request         `json:"request,omitempty"`
	Result    *TurnResult      `json:"result,omitempty"`
	Subagent  *SubagentSpawn   `json:"subagent,omitempty"`
	Quota     *QuotaSnapshot   `json:"quota,omitempty"`
	Usage     *Usage           `json:"usage,omitempty"`
}

// SubagentSpawn tells the manager to create a child session for a subagent
// thread the agent started on its own.
type SubagentSpawn struct {
	ThreadID string `json:"threadId"`
	Title    string `json:"title,omitempty"`
}

// TurnResult summarizes a finished turn.
type TurnResult struct {
	Text              string  `json:"text,omitempty"`
	IsError           bool    `json:"isError,omitempty"`
	Error             string  `json:"error,omitempty"`
	CostUSD           float64 `json:"costUsd,omitempty"`
	InputTokens       int64   `json:"inputTokens,omitempty"`
	OutputTokens      int64   `json:"outputTokens,omitempty"`
	PermissionDenials int     `json:"permissionDenials,omitempty"`
}

// Valid checks the event envelope and its payload.
func (e Event) Valid() error {
	if e.SessionID == "" {
		return fmt.Errorf("%w: empty session", ErrInvalidEvent)
	}
	switch e.Type {
	case EventSessionState:
		if e.Session == nil {
			return fmt.Errorf("%w: %s without snapshot", ErrInvalidEvent, e.Type)
		}
	case EventItemUpdated:
		if e.Item == nil {
			return fmt.Errorf("%w: %s without item", ErrInvalidEvent, e.Type)
		}
	case EventTextDelta:
		if e.Delta == nil {
			return fmt.Errorf("%w: %s without delta", ErrInvalidEvent, e.Type)
		}
		if err := e.Delta.Valid(); err != nil {
			return fmt.Errorf("%w: %w", ErrInvalidEvent, err)
		}
	case EventRequestOpened, EventRequestResolved:
		if e.Request == nil {
			return fmt.Errorf("%w: %s without request", ErrInvalidEvent, e.Type)
		}
		if err := e.Request.Validate(); err != nil {
			return fmt.Errorf("%w: %w", ErrInvalidEvent, err)
		}
	case EventQuota:
		if e.Quota == nil {
			return fmt.Errorf("%w: %s without snapshot", ErrInvalidEvent, e.Type)
		}
		return e.Quota.Validate()
	case EventUsage:
		if e.Usage == nil {
			return fmt.Errorf("%w: %s without usage", ErrInvalidEvent, e.Type)
		}
	case EventSubagentSpawned:
		if e.Subagent == nil || e.Subagent.ThreadID == "" {
			return fmt.Errorf("%w: %s without thread id", ErrInvalidEvent, e.Type)
		}
	case EventTurnStarted, EventTurnEnded:
	default:
		return fmt.Errorf("%w: unknown type %q", ErrInvalidEvent, e.Type)
	}
	return nil
}

// DetachItems replaces every event's Item with a copy. Mappers keep
// mutating their items after emitting them, while the events are stored
// and sent concurrently.
func DetachItems(events []Event) []Event {
	for i := range events {
		if it := events[i].Item; it != nil {
			c := *it
			c.Input = append([]byte(nil), it.Input...)
			c.Images = append([]string(nil), it.Images...)
			if it.ExitCode != nil {
				code := *it.ExitCode
				c.ExitCode = &code
			}
			events[i].Item = &c
		}
	}
	return events
}
