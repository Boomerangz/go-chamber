package claude

import "encoding/json"

// The following structs are a hand-written subset of the CLI's stream-json
// protocol. The source of truth is the @anthropic-ai/claude-agent-sdk type
// definitions; unknown fields are ignored so minor protocol additions do not
// break the adapter.

type rawMessage struct {
	Type            string          `json:"type"`
	Subtype         string          `json:"subtype"`
	SessionID       string          `json:"session_id"`
	UUID            string          `json:"uuid"`
	ParentToolUseID *string         `json:"parent_tool_use_id"`
	Message         json.RawMessage `json:"message"`
	Event           json.RawMessage `json:"event"`
	Result          string          `json:"result"`
	IsError         bool            `json:"is_error"`
	Errors          []string        `json:"errors"`
	TotalCostUSD    float64         `json:"total_cost_usd"`
	Usage           *rawUsage       `json:"usage"`
	RequestID       string          `json:"request_id"`
	Request         json.RawMessage `json:"request"`

	// system/task_started and system/task_notification fields.
	TaskID         string `json:"task_id"`
	ToolUseID      string `json:"tool_use_id"`
	Status         string `json:"status"`
	Summary        string `json:"summary"`
	Description    string `json:"description"`
	SubagentType   string `json:"subagent_type"`
	TaskType       string `json:"task_type"`
	Prompt         string `json:"prompt"`
	IsBackgrounded *bool  `json:"is_backgrounded"`

	RateLimitInfo *rawRateLimitInfo `json:"rate_limit_info"`
}

// rawRateLimitInfo is the payload of a rate_limit_event.
type rawRateLimitInfo struct {
	Status        string   `json:"status"`
	ResetsAt      *int64   `json:"resetsAt"`
	RateLimitType string   `json:"rateLimitType"`
	Utilization   *float64 `json:"utilization"`
}

type rawUsage struct {
	InputTokens  int64 `json:"input_tokens"`
	OutputTokens int64 `json:"output_tokens"`
}

type rawContentMessage struct {
	ID      string     `json:"id"`
	Content []rawBlock `json:"content"`
}

type rawBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

type rawStreamEnvelope struct {
	Type         string          `json:"type"`
	Index        int             `json:"index"`
	Message      json.RawMessage `json:"message"`
	ContentBlock json.RawMessage `json:"content_block"`
	Delta        json.RawMessage `json:"delta"`
}

type rawStreamMessage struct {
	ID string `json:"id"`
}

type rawStreamDelta struct {
	Type        string `json:"type"`
	Text        string `json:"text"`
	Thinking    string `json:"thinking"`
	PartialJSON string `json:"partial_json"`
}

// rawPermissionRequest is the body of a can_use_tool control_request.
type rawPermissionRequest struct {
	Subtype               string          `json:"subtype"`
	ToolName              string          `json:"tool_name"`
	Input                 json.RawMessage `json:"input"`
	PermissionSuggestions json.RawMessage `json:"permission_suggestions"`
	ToolUseID             string          `json:"tool_use_id"`
	AgentID               string          `json:"agent_id"`
	Description           string          `json:"description"`
	Title                 string          `json:"title"`
	DisplayName           string          `json:"display_name"`
}

// textFromToolResult extracts plain text from a tool_result content field,
// which may be a string or an array of content blocks.
func textFromToolResult(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []rawBlock
	if err := json.Unmarshal(raw, &blocks); err == nil {
		out := ""
		for _, b := range blocks {
			if b.Type == "text" {
				out += b.Text
			}
		}
		return out
	}
	return string(raw)
}
