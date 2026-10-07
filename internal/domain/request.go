package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"
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
	// OpenedAt is when go-chamber received the request: every device can
	// tell how long it has waited.
	OpenedAt time.Time `json:"openedAt,omitzero"`
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

// Gist says in one line what the request asks: the question, the command to
// run, the file to change; its generic title only when nothing more telling
// is known. The web's requestGist reads a live request the same way.
func (r *Request) Gist() string {
	var p struct {
		ToolName string `json:"toolName"`
		Input    struct {
			Questions []struct {
				Question string `json:"question"`
			} `json:"questions"`
			Command  string `json:"command"`
			FilePath string `json:"file_path"`
			Path     string `json:"path"`
		} `json:"input"`
	}
	_ = json.Unmarshal(r.Payload, &p)
	in := p.Input
	if len(in.Questions) > 0 {
		if first := flat(in.Questions[0].Question); first != "" {
			if more := len(in.Questions) - 1; more > 0 {
				return fmt.Sprintf("%s (+%d more)", first, more)
			}
			return first
		}
	}
	if c := flat(in.Command); c != "" {
		return c
	}
	file := in.FilePath
	if file == "" {
		file = in.Path
	}
	if strings.TrimSpace(file) != "" {
		name := path.Base(strings.TrimRight(file, "/"))
		if p.ToolName != "" {
			return p.ToolName + " " + name
		}
		return name
	}
	for _, text := range []string{r.Prompt, r.Title, p.ToolName} {
		if t := flat(text); t != "" {
			return t
		}
	}
	return "Request"
}

// flat folds runs of white space into single spaces.
func flat(s string) string { return strings.Join(strings.Fields(s), " ") }
