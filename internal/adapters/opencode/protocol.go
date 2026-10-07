// Package opencode implements the agent ports over OpenCode HTTP and SSE.
package opencode

import "encoding/json"

const ProtocolVersion = "1.18.34"

// These types are the consumed subset of the installed server's /doc schema.
type event struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	Properties json.RawMessage `json:"properties"`
}
type envelope struct {
	Directory string `json:"directory"`
	Payload   event  `json:"payload"`
}
type timing struct {
	Start     int64 `json:"start"`
	End       int64 `json:"end"`
	Created   int64 `json:"created"`
	Completed int64 `json:"completed"`
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
type message struct {
	ID        string          `json:"id"`
	SessionID string          `json:"sessionID"`
	Role      string          `json:"role"`
	Time      timing          `json:"time"`
	Cost      float64         `json:"cost"`
	Tokens    tokens          `json:"tokens"`
	Error     json.RawMessage `json:"error"`
}
type part struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
	MessageID string `json:"messageID"`
	Type      string `json:"type"`
	Text      string `json:"text"`
	Tool      string `json:"tool"`
	CallID    string `json:"callID"`
	Time      timing `json:"time"`
	State     struct {
		Status   string          `json:"status"`
		Input    json.RawMessage `json:"input"`
		Output   string          `json:"output"`
		Error    string          `json:"error"`
		Metadata json.RawMessage `json:"metadata"`
	} `json:"state"`
}
type transcript struct {
	Info  message `json:"info"`
	Parts []part  `json:"parts"`
}
type sessionInfo struct {
	ID        string `json:"id"`
	Directory string `json:"directory"`
	ParentID  string `json:"parentID"`
	Title     string `json:"title"`
}
type status struct {
	Type string `json:"type"`
}
type question struct {
	Question string `json:"question"`
	Header   string `json:"header"`
	Multiple bool   `json:"multiple"`
	Custom   *bool  `json:"custom"`
	Options  []struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	} `json:"options"`
}
type request struct {
	V2         bool            `json:"-"`
	Action     string          `json:"action"`
	Resources  []string        `json:"resources"`
	Save       []string        `json:"save"`
	ID         string          `json:"id"`
	SessionID  string          `json:"sessionID"`
	Permission string          `json:"permission"`
	Patterns   []string        `json:"patterns"`
	Always     []string        `json:"always"`
	Metadata   json.RawMessage `json:"metadata"`
	Questions  []question      `json:"questions"`
}
type providerModel struct {
	ID           string                     `json:"id"`
	Name         string                     `json:"name"`
	Variants     map[string]json.RawMessage `json:"variants"`
	Capabilities struct {
		Input struct {
			Image bool `json:"image"`
		} `json:"input"`
	} `json:"capabilities"`
}
type providers struct {
	All []struct {
		ID     string                   `json:"id"`
		Name   string                   `json:"name"`
		Models map[string]providerModel `json:"models"`
	} `json:"all"`
	Connected []string          `json:"connected"`
	Default   map[string]string `json:"default"`
}
