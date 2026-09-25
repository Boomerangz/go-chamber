package domain

import (
	"encoding/json"
	"errors"
	"fmt"
)

var (
	ErrInvalidRequest = errors.New("invalid request")
)

type RequestID string
type RequestKind string
type RequestState string

const (
	RequestPermission  RequestKind = "permission"
	RequestQuestion    RequestKind = "question"
	RequestElicitation RequestKind = "elicitation"
)

const (
	RequestPending  RequestState = "pending"
	RequestResolved RequestState = "resolved"
	RequestStale    RequestState = "stale"
)

// Valid reports whether k is a request kind the model understands.
func (k RequestKind) Valid() bool {
	switch k {
	case RequestPermission, RequestQuestion, RequestElicitation:
		return true
	}
	return false
}

// Request is a blocking question the agent asks the user: a permission
// prompt, an AskUserQuestion dialog or an MCP elicitation. The agent turn is
// paused until it is resolved.
type Request struct {
	ID        RequestID       `json:"id"`
	SessionID SessionID       `json:"sessionId"`
	TurnID    TurnID          `json:"turnId,omitempty"`
	ItemID    ItemID          `json:"itemId,omitempty"`
	Kind      RequestKind     `json:"kind"`
	Title     string          `json:"title,omitempty"`
	Prompt    string          `json:"prompt,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	State     RequestState    `json:"state"`
	Answer    json.RawMessage `json:"answer,omitempty"`
}

func (r *Request) Validate() error {
	switch {
	case r.ID == "":
		return fmt.Errorf("%w: empty id", ErrInvalidRequest)
	case r.SessionID == "":
		return fmt.Errorf("%w: empty session", ErrInvalidRequest)
	case !r.Kind.Valid():
		return fmt.Errorf("%w: unknown kind %q", ErrInvalidRequest, r.Kind)
	}
	return nil
}

// Resolve records the user's answer and closes the request.
func (r *Request) Resolve(answer json.RawMessage) error {
	if r.State != RequestPending {
		return fmt.Errorf("%w: resolve in %s", ErrInvalidRequest, r.State)
	}
	r.State = RequestResolved
	r.Answer = answer
	return nil
}

// MarkStale closes a request whose agent process vanished before answering.
func (r *Request) MarkStale() {
	if r.State == RequestPending {
		r.State = RequestStale
	}
}
