// Package app holds use cases and the ports they depend on.
package app

import (
	"context"
	"errors"

	"github.com/igorzygin/go-chamber/internal/domain"
)

var ErrSessionNotFound = errors.New("session not found")
var ErrRequestNotFound = errors.New("request not found")
var ErrAccountsUnsupported = errors.New("agent account management is not supported")
var ErrQuotasUnsupported = errors.New("agent quota lookup is not supported")

// ErrModelsUnsupported is returned when no model catalog is configured.
var ErrModelsUnsupported = errors.New("agent model listing is not supported")

// AccountInfo describes the agent's login state.
type AccountInfo struct {
	Agent    domain.AgentKind `json:"agent"`
	LoggedIn bool             `json:"loggedIn"`
	AuthMode string           `json:"authMode,omitempty"`
	Email    string           `json:"email,omitempty"`
	Plan     string           `json:"plan,omitempty"`
}

// LoginChallenge is a device-code login prompt shown to the user.
type LoginChallenge struct {
	LoginID  string `json:"loginId"`
	UserCode string `json:"userCode"`
	URL      string `json:"url"`
}

// QuotaRepo caches the latest quota snapshot per agent.
type QuotaRepo interface {
	SaveQuota(ctx context.Context, q domain.QuotaSnapshot) error
	GetQuota(ctx context.Context, agent domain.AgentKind) (domain.QuotaSnapshot, bool, error)
	ListQuotas(ctx context.Context) ([]domain.QuotaSnapshot, error)
}

// QuotaProvider fetches live rate limits for an agent on demand.
type QuotaProvider interface {
	RateLimits(ctx context.Context, agent domain.AgentKind) (domain.QuotaSnapshot, error)
}

// AccountManager reports and starts agent logins.
type AccountManager interface {
	Account(ctx context.Context, agent domain.AgentKind) (AccountInfo, error)
	StartLogin(ctx context.Context, agent domain.AgentKind) (LoginChallenge, error)
}

// SessionRepo persists session snapshots.
type SessionRepo interface {
	Save(ctx context.Context, s domain.SessionSnapshot) error
	Get(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error)
	List(ctx context.Context) ([]domain.SessionSnapshot, error)
}

// StartRequest describes the agent process to launch for a session.
type StartRequest struct {
	SessionID domain.SessionID
	Agent     domain.AgentKind
	// Cwd is the working directory the agent runs in.
	Cwd string
	// NativeID resumes an existing agent conversation when non-empty.
	NativeID string
	// Fork branches off a resumed conversation into a new one.
	Fork bool
	// Model overrides the agent's default model when non-empty.
	Model string
	// Effort overrides the agent's reasoning effort when non-empty.
	Effort string
	// PermissionMode selects the agent's approval behaviour when non-empty.
	PermissionMode string
	// Passive attaches to an already-running agent thread (a subagent spawned
	// by the agent itself) without starting or resuming it.
	Passive bool
	// ApprovalReviewer chooses who reviews approval requests; empty keeps
	// the agent's own configuration. Agents without the notion ignore it.
	ApprovalReviewer domain.ApprovalReviewer
}

// ApprovalReviewerSetter is implemented by runtimes that can change the
// approval reviewer while running; others pick it up on their next start.
type ApprovalReviewerSetter interface {
	SetApprovalReviewer(ctx context.Context, r domain.ApprovalReviewer) error
}

// AgentRuntime is one running agent conversation. Events are normalized
// domain events; the channel is closed when the process exits.
type AgentRuntime interface {
	// NativeID is the agent's own session/thread id.
	NativeID() string
	// Events streams normalized events until the process exits.
	Events() <-chan domain.Event
	// Send delivers a user message to the agent as the given turn.
	Send(ctx context.Context, turn domain.TurnID, text string) error
	// Steer appends input to the active turn without starting a new one.
	Steer(ctx context.Context, text string) error
	// Interrupt stops the current turn without killing the process.
	Interrupt(ctx context.Context) error
	// StopTask stops a background subagent task by its native id.
	StopTask(ctx context.Context, taskID string) error
	// Respond answers a pending blocking request (permission or question).
	Respond(ctx context.Context, requestID domain.RequestID, answer RequestAnswer) error
	// Close terminates the process and closes Events.
	Close() error
}

// RequestAnswer is the user's decision on a pending request.
type RequestAnswer struct {
	// Allow grants the request; false denies it.
	Allow bool
	// Message is the denial reason.
	Message string
	// AllowForSession applies the agent's suggested permission rules so the
	// same tool is not asked again.
	AllowForSession bool
	// Answers maps a question's text to the selected option label(s).
	Answers map[string][]string
}

// RuntimeFactory starts agent processes.
type RuntimeFactory interface {
	Start(ctx context.Context, req StartRequest) (AgentRuntime, error)
}

// EventBus assigns sequence numbers, buffers and fans out normalized events.
type EventBus interface {
	// Publish buffers the event for replay and delivers it to subscribers,
	// returning the event with its per-session Seq assigned.
	Publish(ev domain.Event) domain.Event
}

// EventLog persists the per-session event stream so history survives
// restarts and can be searched.
type EventLog interface {
	Append(ctx context.Context, ev domain.Event) error
	// History returns events with Seq > since, in order.
	History(ctx context.Context, session domain.SessionID, since domain.Seq) ([]domain.Event, error)
	// LastSeq is the highest stored Seq for a session, 0 when none.
	LastSeq(ctx context.Context, session domain.SessionID) (domain.Seq, error)
}

// SearchHit is one session whose messages match a search.
type SearchHit struct {
	SessionID domain.SessionID `json:"sessionId"`
	ItemID    domain.ItemID    `json:"itemId"`
	// Snippet is the matching text with matches wrapped in [[ and ]].
	Snippet string `json:"snippet"`
	Matches int    `json:"matches"`
}

// MessageSearch finds sessions by the text of their messages.
type MessageSearch interface {
	Search(ctx context.Context, query string, limit int) ([]SearchHit, error)
}

// ErrRestartRequired is returned by a ModelSetter that can only apply the
// choice to a new agent process.
var ErrRestartRequired = errors.New("model change needs an agent restart")

// ModelSetter is implemented by runtimes that can switch the model (and
// reasoning effort) of a live conversation.
type ModelSetter interface {
	SetModel(ctx context.Context, model, effort string) error
}

// ModelInfo describes one model an agent offers.
type ModelInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// Efforts are the reasoning efforts the model accepts, if any.
	Efforts       []string `json:"efforts,omitempty"`
	DefaultEffort string   `json:"defaultEffort,omitempty"`
	// Default marks the model the agent uses when none is chosen.
	Default bool `json:"default,omitempty"`
}

// ModelCatalog lists the models an agent offers.
type ModelCatalog interface {
	Models(ctx context.Context, agent domain.AgentKind) ([]ModelInfo, error)
}
