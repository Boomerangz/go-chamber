// Package opencode implements the agent ports over OpenCode HTTP and SSE.
package opencode

import "encoding/json"

const ProtocolVersion = "2.0.15"

// These types are the consumed subset of the installed server's /openapi.json.
// Events are not described there; their shape comes from recorded traffic.
type event struct {
	ID   string          `json:"id"`
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}
type tokens struct {
	Input     int64 `json:"input"`
	Output    int64 `json:"output"`
	Reasoning int64 `json:"reasoning"`
	Cache     struct {
		Read  int64 `json:"read"`
		Write int64 `json:"write"`
	} `json:"cache"`
}
type failure struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}
type modelRef struct {
	ID         string `json:"id"`
	ProviderID string `json:"providerID"`
	Variant    string `json:"variant,omitempty"`
}
type sessionInfo struct {
	ID       string  `json:"id"`
	ParentID string  `json:"parentID"`
	Title    string  `json:"title"`
	Cost     float64 `json:"cost"`
	Tokens   tokens  `json:"tokens"`
	Location struct {
		Directory string `json:"directory"`
	} `json:"location"`
}

// content is one entry of an assistant message: text, reasoning or a tool call.
type content struct {
	Type  string `json:"type"`
	Text  string `json:"text"`
	ID    string `json:"id"`
	Name  string `json:"name"`
	State struct {
		Status   string          `json:"status"`
		Input    json.RawMessage `json:"input"`
		Content  []toolOutput    `json:"content"`
		Error    *failure        `json:"error"`
		Metadata json.RawMessage `json:"metadata"`
	} `json:"state"`
}
type toolOutput struct {
	Type string `json:"type"`
	Text string `json:"text"`
}
type message struct {
	ID      string    `json:"id"`
	Type    string    `json:"type"`
	Text    string    `json:"text"`
	Content []content `json:"content"`
	Error   *failure  `json:"error"`
}
type option struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}
type field struct {
	Key         string   `json:"key"`
	Type        string   `json:"type"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Hidden      bool     `json:"hidden"`
	Custom      *bool    `json:"custom"`
	Options     []option `json:"options"`
}

// request is a pending permission or, when Form is set, a form whose fields
// are questions.
type request struct {
	Form      bool            `json:"-"`
	ID        string          `json:"id"`
	SessionID string          `json:"sessionID"`
	Action    string          `json:"action"`
	Resources []string        `json:"resources"`
	Save      []string        `json:"save"`
	Metadata  json.RawMessage `json:"metadata"`
	Title     string          `json:"title"`
	Fields    []field         `json:"fields"`
}
type modelInfo struct {
	ID           string `json:"id"`
	ProviderID   string `json:"providerID"`
	Name         string `json:"name"`
	Enabled      bool   `json:"enabled"`
	Capabilities struct {
		Input []string `json:"input"`
	} `json:"capabilities"`
	Variants []struct {
		ID string `json:"id"`
	} `json:"variants"`
}
