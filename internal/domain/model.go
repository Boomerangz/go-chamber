package domain

import "encoding/json"

// ModelMessage is model context, distinct from the presentation-oriented Item.
type ModelMessage struct {
	Images    []ModelImage
	Role      string
	Text      string
	Reasoning string
	ToolCalls []ModelToolCall
	CallID    string
	Replay    ModelReplay
}

// ModelReplay is opaque provider-owned context. Only the producing adapter may
// interpret it. Source binds it to the endpoint, model and authenticated account.
type ModelReplay struct {
	Format string
	Source string
	Data   json.RawMessage `json:"Data,omitempty"`
}

type ModelToolCall struct {
	ID        string
	Name      string
	Arguments json.RawMessage
}

type ModelTool struct {
	Name        string
	Description string
	Parameters  json.RawMessage
}

type ModelRequest struct {
	Model        string
	SessionID    SessionID
	Instructions string
	Effort       string
	Messages     []ModelMessage
	Tools        []ModelTool
}

// ModelDelta is display-only. Tool execution must wait for a successful result.
type ModelDelta struct {
	Text      string
	Reasoning string
}

type ModelUsage struct {
	Input       int64
	Output      int64
	CachedInput int64
}

type ModelResult struct {
	Message ModelMessage
	Usage   ModelUsage
}

// Conversation stores model context independently of UI events. Every assistant
// tool call is paired with a result before execution can cause side effects.
type Conversation struct {
	ID             string
	Model          string
	Effort         string
	Messages       []ModelMessage
	Parent         string
	Busy           bool
	PendingPrompt  string
	PermissionMode string
	Depth          int
	LastError      string
	Goal           *Goal `json:"Goal,omitempty"`
	// Title and Background describe a child: a background child reports its
	// result to the parent, which is not waiting for it.
	Title      string `json:"Title,omitempty"`
	Background bool   `json:"Background,omitempty"`
}

// ModelImage is a validated inline image owned by the conversation.
type ModelImage struct{ URL string }
