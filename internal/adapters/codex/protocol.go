package codex

import "encoding/json"

// Hand-written subset of the generated app-server schema. Only fields the
// adapter maps are declared; unknown fields are ignored.

type rpcThread struct {
	ID    string    `json:"id"`
	Cwd   string    `json:"cwd"`
	Name  string    `json:"name"`
	Model string    `json:"model"`
	Turns []rpcTurn `json:"turns"`
}

type rpcTurn struct {
	ID         string        `json:"id"`
	Status     string        `json:"status"`
	Items      []rpcItem     `json:"items"`
	Error      *rpcTurnError `json:"error"`
	DurationMs *int          `json:"durationMs"`
}

type rpcTurnError struct {
	Message string `json:"message"`
}

type rpcItem struct {
	Type              string          `json:"type"`
	ID                string          `json:"id"`
	Text              string          `json:"text"`
	Command           string          `json:"command"`
	AggregatedOutput  *string         `json:"aggregatedOutput"`
	ExitCode          *int            `json:"exitCode"`
	Status            string          `json:"status"`
	Changes           []rpcFileChange `json:"changes"`
	Content           []rpcTextPart   `json:"content"`
	Summary           []rpcTextPart   `json:"summary"`
	Output            json.RawMessage `json:"output"`
	Name              string          `json:"name"`
	Query             string          `json:"query"`
	Server            string          `json:"server"`
	Tool              string          `json:"tool"`
	Arguments         json.RawMessage `json:"arguments"`
	Result            json.RawMessage `json:"result"`
	Prompt            *string         `json:"prompt"`
	ReceiverThreadIDs []string        `json:"receiverThreadIds"`
	AgentPath         string          `json:"agentPath"`
	AgentThreadID     string          `json:"agentThreadId"`
	Kind              string          `json:"kind"`
	// AgentsStates is a collab call's last known state of its child agents.
	AgentsStates map[string]rpcAgentState `json:"agentsStates"`
}

// rpcAgentState is CollabAgentState: a child agent's status and, once it
// returned, its message.
type rpcAgentState struct {
	Status  string  `json:"status"`
	Message *string `json:"message"`
}

type rpcFileChange struct {
	Path string `json:"path"`
	Diff string `json:"diff"`
	// Kind is PatchChangeKind, an object such as {"type":"update"}.
	Kind json.RawMessage `json:"kind"`
}

type rpcTextPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// UnmarshalJSON also takes a bare string: reasoning summary and content are
// arrays of strings, user message content an array of parts.
func (p *rpcTextPart) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		*p = rpcTextPart{Type: "text"}
		return json.Unmarshal(b, &p.Text)
	}
	type part rpcTextPart
	return json.Unmarshal(b, (*part)(p))
}

type rpcPlanStep struct {
	Step   string `json:"step"`
	Status string `json:"status"`
}

// Notification payloads.
type itemNotification struct {
	ThreadID string  `json:"threadId"`
	TurnID   string  `json:"turnId"`
	Item     rpcItem `json:"item"`
}

type deltaNotification struct {
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
	ItemID   string `json:"itemId"`
	Delta    string `json:"delta"`
}

type turnNotification struct {
	ThreadID string  `json:"threadId"`
	Turn     rpcTurn `json:"turn"`
}

type planUpdatedNotification struct {
	ThreadID    string        `json:"threadId"`
	TurnID      string        `json:"turnId"`
	Explanation *string       `json:"explanation"`
	Plan        []rpcPlanStep `json:"plan"`
}

type patchUpdatedNotification struct {
	ThreadID string          `json:"threadId"`
	TurnID   string          `json:"turnId"`
	ItemID   string          `json:"itemId"`
	Changes  []rpcFileChange `json:"changes"`
}

type resolvedNotification struct {
	ThreadID  string          `json:"threadId"`
	RequestID json.RawMessage `json:"requestId"`
}

// Server request payloads.
type commandApprovalParams struct {
	ThreadID    string `json:"threadId"`
	TurnID      string `json:"turnId"`
	ItemID      string `json:"itemId"`
	Command     string `json:"command"`
	Reason      string `json:"reason"`
	StartedAtMs int64  `json:"startedAtMs"`
}

type fileApprovalParams struct {
	ThreadID    string `json:"threadId"`
	TurnID      string `json:"turnId"`
	ItemID      string `json:"itemId"`
	Reason      string `json:"reason"`
	GrantRoot   string `json:"grantRoot"`
	StartedAtMs int64  `json:"startedAtMs"`
}

type userInputParams struct {
	ThreadID   string          `json:"threadId"`
	TurnID     string          `json:"turnId"`
	ItemID     string          `json:"itemId"`
	IsBlocking bool            `json:"isBlocking"`
	Questions  []inputQuestion `json:"questions"`
}

type inputQuestion struct {
	ID       string        `json:"id"`
	Header   string        `json:"header"`
	Question string        `json:"question"`
	IsOther  bool          `json:"isOther"`
	IsSecret bool          `json:"isSecret"`
	Options  []inputOption `json:"options"`
}

type inputOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

type rateLimitSnapshot struct {
	Primary              *rateLimitWindow `json:"primary"`
	Secondary            *rateLimitWindow `json:"secondary"`
	PlanType             string           `json:"planType"`
	RateLimitReachedType string           `json:"rateLimitReachedType"`
}

type rateLimitWindow struct {
	UsedPercent        int    `json:"usedPercent"`
	ResetsAt           *int64 `json:"resetsAt"`
	WindowDurationMins *int   `json:"windowDurationMins"`
}

type tokenUsageNotification struct {
	ThreadID   string `json:"threadId"`
	TurnID     string `json:"turnId"`
	TokenUsage struct {
		Total tokenBreakdown `json:"total"`
	} `json:"tokenUsage"`
}

type tokenBreakdown struct {
	InputTokens  int64 `json:"inputTokens"`
	OutputTokens int64 `json:"outputTokens"`
	TotalTokens  int64 `json:"totalTokens"`
}

type elicitationParams struct {
	ThreadID        string          `json:"threadId"`
	TurnID          string          `json:"turnId"`
	ServerName      string          `json:"serverName"`
	Message         string          `json:"message"`
	Mode            string          `json:"mode"`
	RequestedSchema json.RawMessage `json:"requestedSchema"`
}

type errorNotification struct {
	ThreadID  string       `json:"threadId"`
	TurnID    string       `json:"turnId"`
	WillRetry bool         `json:"willRetry"`
	Error     rpcTurnError `json:"error"`
}
