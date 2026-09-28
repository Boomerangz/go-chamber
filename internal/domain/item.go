package domain

import (
	"encoding/json"
	"errors"
	"fmt"
)

var (
	ErrInvalidItem           = errors.New("invalid item")
	ErrInvalidItemTransition = errors.New("invalid item transition")
	ErrInvalidEvent          = errors.New("invalid event")
)

type ItemID string
type TurnID string

// ItemKind classifies one normalized piece of a conversation. The UI knows
// only these kinds; agent protocols never leak through.
type ItemKind string

const (
	ItemUserMessage      ItemKind = "user_message"
	ItemAssistantMessage ItemKind = "assistant_message"
	ItemReasoning        ItemKind = "reasoning"
	ItemToolCall         ItemKind = "tool_call"
	ItemCommand          ItemKind = "command"
	ItemFileChange       ItemKind = "file_change"
	ItemSubagent         ItemKind = "subagent"
	ItemPlan             ItemKind = "plan"
	ItemError            ItemKind = "error"
	// ItemHook is a user-configured hook the agent ran (Stop,
	// UserPromptSubmit…); Name is the hook event.
	ItemHook ItemKind = "hook"
	// ItemDecision records how the user resolved an agent request; Name is
	// the request title and Text the deny reason or the chosen answers.
	ItemDecision ItemKind = "decision"
)

// Decision is how the user resolved an agent request.
type Decision string

const (
	DecisionApproved Decision = "approved"
	DecisionDenied   Decision = "denied"
	DecisionAnswered Decision = "answered"
)

func (d Decision) Valid() bool {
	return d == DecisionApproved || d == DecisionDenied || d == DecisionAnswered
}

// DecisionFor names the outcome of answering a request of the given kind:
// a granted permission is approved, a granted question is answered.
func DecisionFor(kind RequestKind, allow bool) Decision {
	switch {
	case !allow:
		return DecisionDenied
	case kind == RequestPermission:
		return DecisionApproved
	}
	return DecisionAnswered
}

// HookOutcome is how a hook run ended.
type HookOutcome string

const (
	HookSuccess HookOutcome = "success"
	// HookBlocked: the hook stopped the agent and fed its reason back.
	HookBlocked HookOutcome = "blocked"
	HookError   HookOutcome = "error"
)

func (o HookOutcome) Valid() bool { return o == HookSuccess || o == HookBlocked || o == HookError }

// Valid reports whether k is a kind the normalized model understands.
func (k ItemKind) Valid() bool {
	switch k {
	case ItemUserMessage, ItemAssistantMessage, ItemReasoning, ItemToolCall,
		ItemCommand, ItemFileChange, ItemSubagent, ItemPlan, ItemError, ItemHook, ItemDecision:
		return true
	}
	return false
}

type ItemStatus string

const (
	ItemPending   ItemStatus = "pending"
	ItemStreaming ItemStatus = "streaming"
	ItemCompleted ItemStatus = "completed"
	ItemFailed    ItemStatus = "failed"
)

// Terminal reports whether no further status change is expected.
func (s ItemStatus) Terminal() bool { return s == ItemCompleted || s == ItemFailed }

// Item is a normalized unit of conversation content: a user or assistant
// message, a reasoning block, a tool call, a file change and so on. The
// optional fields carry the kind-specific payload.
type Item struct {
	ID           ItemID     `json:"id"`
	SessionID    SessionID  `json:"sessionId"`
	TurnID       TurnID     `json:"turnId,omitempty"`
	ParentItemID ItemID     `json:"parentItemId,omitempty"`
	Kind         ItemKind   `json:"kind"`
	Status       ItemStatus `json:"status"`

	// Text holds assistant/reasoning text or command output.
	Text string `json:"text,omitempty"`
	// Name is the tool name for tool calls.
	Name string `json:"name,omitempty"`
	// Input is the raw tool input.
	Input json.RawMessage `json:"input,omitempty"`
	// Path and Diff describe file changes.
	Path string `json:"path,omitempty"`
	Diff string `json:"diff,omitempty"`
	// ExitCode is set for finished commands.
	ExitCode *int `json:"exitCode,omitempty"`
	// AgentID links a subagent item to its child session.
	AgentID string `json:"agentId,omitempty"`
	// Outcome is set for finished hooks.
	Outcome HookOutcome `json:"outcome,omitempty"`
	// Decision is set for decision items.
	Decision Decision `json:"decision,omitempty"`
	// Images are the ids of pictures attached to a user message.
	Images []string `json:"images,omitempty"`
}

func NewItem(id ItemID, session SessionID, turn TurnID, parent ItemID, kind ItemKind) (*Item, error) {
	switch {
	case id == "":
		return nil, fmt.Errorf("%w: empty id", ErrInvalidItem)
	case session == "":
		return nil, fmt.Errorf("%w: empty session", ErrInvalidItem)
	case !kind.Valid():
		return nil, fmt.Errorf("%w: unknown kind %q", ErrInvalidItem, kind)
	}
	return &Item{
		ID: id, SessionID: session, TurnID: turn, ParentItemID: parent,
		Kind: kind, Status: ItemPending,
	}, nil
}

// AppendText appends streamed text to the item.
func (i *Item) AppendText(s string) { i.Text += s }

// SetStatus moves the item through its lifecycle. Terminal states are final.
func (i *Item) SetStatus(next ItemStatus) error {
	if i.Status.Terminal() {
		return fmt.Errorf("%w: %s from terminal %s", ErrInvalidItemTransition, next, i.Status)
	}
	switch next {
	case ItemStreaming, ItemCompleted, ItemFailed:
		i.Status = next
		return nil
	}
	return fmt.Errorf("%w: unknown status %q", ErrInvalidItemTransition, next)
}

// Delta is a streamed text chunk belonging to an item.
type Delta struct {
	ItemID ItemID `json:"itemId"`
	Text   string `json:"text"`
}

func (d Delta) Valid() error {
	if d.ItemID == "" {
		return fmt.Errorf("%w: delta without item id", ErrInvalidItem)
	}
	return nil
}
