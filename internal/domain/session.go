// Package domain holds the core model of go-chamber: sessions, turns, items,
// agent requests and quotas. It has no I/O and depends only on the stdlib.
package domain

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
)

var (
	ErrInvalidSession    = errors.New("invalid session")
	ErrInvalidTransition = errors.New("invalid session transition")
	ErrNeedsRuntime      = errors.New("session has no attached runtime")
	ErrNativeIDMismatch  = errors.New("runtime reported a different native session id")
	ErrInvalidReviewer   = errors.New("invalid approval reviewer")
	ErrInvalidModel      = errors.New("invalid model choice")
)

type SessionID string

// AgentKind names the CLI agent that backs a session.
type AgentKind string

const (
	AgentClaude AgentKind = "claude"
	AgentCodex  AgentKind = "codex"
)

func (k AgentKind) Valid() bool { return k == AgentClaude || k == AgentCodex }

type SessionStatus string

const (
	// StatusDetached: no agent process is attached; the session resumes lazily.
	StatusDetached SessionStatus = "detached"
	// StatusIdle: a process is attached and waits for input.
	StatusIdle SessionStatus = "idle"
	// StatusRunning: a turn is in progress.
	StatusRunning SessionStatus = "running"
	// StatusInterrupted: a turn ended abnormally; see Interruption.
	StatusInterrupted SessionStatus = "interrupted"
)

// ApprovalReviewer decides who reviews the agent's approval requests
// (sandbox escapes, network access, MCP prompts). Codex supports it; other
// agents ignore it.
type ApprovalReviewer string

const (
	// ReviewerDefault leaves the choice to the agent's own configuration.
	ReviewerDefault ApprovalReviewer = ""
	// ReviewerUser sends every approval request to the user.
	ReviewerUser ApprovalReviewer = "user"
	// ReviewerAuto lets the agent's reviewer subagent decide.
	ReviewerAuto ApprovalReviewer = "auto_review"
)

func (r ApprovalReviewer) Valid() bool {
	return r == ReviewerDefault || r == ReviewerUser || r == ReviewerAuto
}

// ExitReason explains why a runtime stopped or a turn was cut short.
type ExitReason string

const (
	ExitCrashed       ExitReason = "crashed"
	ExitIdleTimeout   ExitReason = "idle_timeout"
	ExitServerRestart ExitReason = "server_restart"
	ExitQuota         ExitReason = "quota"
)

// Interruption describes an abnormally ended turn. ResumeAfter is set for
// quota interruptions to the moment the rate-limit window resets.
type Interruption struct {
	Reason      ExitReason `json:"reason,omitempty"`
	ResumeAfter time.Time  `json:"resumeAfter,omitzero"`
}

// Session is the aggregate for a conversation with one agent. The agent
// process is disposable; the session survives it and can be resumed through
// its NativeID (Claude session_id or Codex threadId).
type Session struct {
	id           SessionID
	agent        AgentKind
	cwd          string
	title        string
	nativeID     string
	parentID     SessionID
	forkOf       SessionID
	status       SessionStatus
	attached     bool
	interruption Interruption
	autoContinue bool
	reviewer     ApprovalReviewer
	mode         string
	createdAt    time.Time
	activeAt     time.Time
	model        string
	effort       string
}

// SessionSnapshot is the persistable state of a Session.
type SessionSnapshot struct {
	ID       SessionID `json:"id"`
	Agent    AgentKind `json:"agent"`
	Cwd      string    `json:"cwd"`
	NativeID string    `json:"nativeId,omitempty"`
	ParentID SessionID `json:"parentId,omitempty"`
	// ForkOf is the session this one branched off from.
	ForkOf       SessionID     `json:"forkOf,omitempty"`
	Status       SessionStatus `json:"status"`
	Title        string        `json:"title,omitempty"`
	Interruption Interruption  `json:"interruption,omitzero"`
	// AutoContinue resumes a quota-interrupted turn once the limit resets.
	AutoContinue bool `json:"autoContinue,omitempty"`
	// ApprovalReviewer is empty when the agent's own configuration decides.
	ApprovalReviewer ApprovalReviewer `json:"approvalReviewer,omitempty"`
	// PermissionMode is empty when the agent's configuration decides.
	PermissionMode string    `json:"permissionMode,omitempty"`
	CreatedAt      time.Time `json:"createdAt,omitzero"`
	// ActiveAt is the last time the user started a turn (or the creation).
	ActiveAt time.Time `json:"activeAt,omitzero"`
	// Model and Effort are empty when the agent's configuration decides.
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
}

func NewSession(id SessionID, agent AgentKind, cwd string) (*Session, error) {
	if err := validate(id, agent, cwd); err != nil {
		return nil, err
	}
	return &Session{id: id, agent: agent, cwd: cwd, status: StatusDetached}, nil
}

// NewChildSession creates a session spawned by another session (a subagent).
func NewChildSession(id SessionID, agent AgentKind, cwd string, parent SessionID) (*Session, error) {
	if parent == "" {
		return nil, fmt.Errorf("%w: empty parent", ErrInvalidSession)
	}
	s, err := NewSession(id, agent, cwd)
	if err != nil {
		return nil, err
	}
	s.parentID = parent
	return s, nil
}

// NewForkSession creates a session that continues the parent's
// conversation on a branch of its own; the agent assigns the native id.
func NewForkSession(id SessionID, parent *Session) (*Session, error) {
	if parent.nativeID == "" {
		return nil, fmt.Errorf("%w: fork before the first turn", ErrInvalidTransition)
	}
	s, err := NewSession(id, parent.agent, parent.cwd)
	if err != nil {
		return nil, err
	}
	s.forkOf = parent.id
	s.title = strings.TrimSpace(parent.title + " (fork)")
	s.model, s.effort, s.reviewer, s.mode = parent.model, parent.effort, parent.reviewer, parent.mode
	return s, nil
}

// RestoreSession rebuilds a session after a server restart. No process
// survives a restart, so a running turn becomes interrupted and an idle
// session becomes detached.
func RestoreSession(snap SessionSnapshot) (*Session, error) {
	if err := validate(snap.ID, snap.Agent, snap.Cwd); err != nil {
		return nil, err
	}
	s := &Session{
		id: snap.ID, agent: snap.Agent, cwd: snap.Cwd, title: snap.Title,
		nativeID: snap.NativeID, parentID: snap.ParentID, forkOf: snap.ForkOf, status: StatusDetached,
		reviewer: snap.ApprovalReviewer, mode: snap.PermissionMode, createdAt: snap.CreatedAt, activeAt: snap.ActiveAt,
		model: snap.Model, effort: snap.Effort,
	}
	switch snap.Status {
	case StatusRunning:
		s.status = StatusInterrupted
		s.interruption = Interruption{Reason: ExitServerRestart}
	case StatusInterrupted:
		s.status = StatusInterrupted
		s.interruption = snap.Interruption
		s.autoContinue = snap.AutoContinue
	}
	return s, nil
}

func validate(id SessionID, agent AgentKind, cwd string) error {
	switch {
	case id == "":
		return fmt.Errorf("%w: empty id", ErrInvalidSession)
	case !agent.Valid():
		return fmt.Errorf("%w: unknown agent %q", ErrInvalidSession, agent)
	case cwd == "":
		return fmt.Errorf("%w: empty cwd", ErrInvalidSession)
	}
	return nil
}

func (s *Session) ID() SessionID              { return s.id }
func (s *Session) Agent() AgentKind           { return s.agent }
func (s *Session) Cwd() string                { return s.cwd }
func (s *Session) Title() string              { return s.title }
func (s *Session) NativeID() string           { return s.nativeID }
func (s *Session) ParentID() SessionID        { return s.parentID }
func (s *Session) ForkOf() SessionID          { return s.forkOf }
func (s *Session) AutoContinue() bool         { return s.autoContinue }
func (s *Session) Status() SessionStatus      { return s.status }
func (s *Session) Interruption() Interruption { return s.interruption }

// NeedsRuntime reports whether an agent process must be (re)started before
// the session can accept input.
func (s *Session) NeedsRuntime() bool { return !s.attached }

func (s *Session) Rename(title string) { s.title = title }

// RuntimeAttached records that an agent process is up for this session. The
// native id is fixed on first attach; a resumed process must report the same.
func (s *Session) RuntimeAttached(nativeID string) error {
	if s.attached || nativeID == "" {
		return fmt.Errorf("%w: attach (attached=%v, native=%q)", ErrInvalidTransition, s.attached, nativeID)
	}
	if s.nativeID != "" && s.nativeID != nativeID {
		return fmt.Errorf("%w: have %q, got %q", ErrNativeIDMismatch, s.nativeID, nativeID)
	}
	s.nativeID = nativeID
	s.attached = true
	s.status = StatusIdle
	s.interruption = Interruption{}
	s.autoContinue = false
	return nil
}

// RuntimeExited records that the agent process is gone.
func (s *Session) RuntimeExited(reason ExitReason) {
	if !s.attached {
		return
	}
	s.attached = false
	switch s.status {
	case StatusRunning:
		s.status = StatusInterrupted
		s.interruption = Interruption{Reason: reason}
	case StatusIdle:
		s.status = StatusDetached
	}
}

func (s *Session) TurnStarted() error {
	if !s.attached {
		return ErrNeedsRuntime
	}
	if s.status == StatusRunning {
		return fmt.Errorf("%w: turn already running", ErrInvalidTransition)
	}
	s.status = StatusRunning
	s.interruption = Interruption{}
	s.autoContinue = false
	return nil
}

func (s *Session) TurnCompleted() error {
	if s.status != StatusRunning {
		return fmt.Errorf("%w: complete turn in %s", ErrInvalidTransition, s.status)
	}
	s.status = StatusIdle
	return nil
}

// QuotaExhausted marks the running turn as stopped by a subscription limit.
func (s *Session) QuotaExhausted(resetsAt time.Time) error {
	if s.status != StatusRunning {
		return fmt.Errorf("%w: quota in %s", ErrInvalidTransition, s.status)
	}
	s.status = StatusInterrupted
	s.interruption = Interruption{Reason: ExitQuota, ResumeAfter: resetsAt}
	return nil
}

// Continuable reports whether the conversation was cut off or put aside
// and can be picked up where it stopped.
func (s *Session) Continuable() bool {
	return s.nativeID != "" && (s.status == StatusInterrupted || s.status == StatusDetached)
}

// SetAutoContinue asks to resume a quota-interrupted turn once the limit
// resets. Turning it off is always allowed.
func (s *Session) SetAutoContinue(on bool) error {
	if on && (s.status != StatusInterrupted || s.interruption.Reason != ExitQuota || s.interruption.ResumeAfter.IsZero()) {
		return fmt.Errorf("%w: auto-continue in %s (%s)", ErrInvalidTransition, s.status, s.interruption.Reason)
	}
	s.autoContinue = on
	return nil
}

func (s *Session) Snapshot() SessionSnapshot {
	return SessionSnapshot{
		ID: s.id, Agent: s.agent, Cwd: s.cwd, NativeID: s.nativeID, ParentID: s.parentID, ForkOf: s.forkOf,
		Status: s.status, Title: s.title, Interruption: s.interruption, AutoContinue: s.autoContinue,
		ApprovalReviewer: s.reviewer, PermissionMode: s.mode, CreatedAt: s.createdAt, ActiveAt: s.activeAt,
		Model: s.model, Effort: s.effort,
	}
}

// Model returns the chosen model and reasoning effort.
func (s *Session) Model() (model, effort string) { return s.model, s.effort }

// SetModel chooses the model and reasoning effort; empty values defer to
// the agent's configuration. Values are agent-specific names, so only
// their shape is checked.
func (s *Session) SetModel(model, effort string) error {
	for _, v := range []string{model, effort} {
		if len(v) > 100 || strings.ContainsFunc(v, unicode.IsSpace) {
			return fmt.Errorf("%w: %q", ErrInvalidModel, v)
		}
	}
	s.model, s.effort = model, effort
	return nil
}

// Touch records activity at now; the first touch is the creation time.
func (s *Session) Touch(now time.Time) {
	if s.createdAt.IsZero() {
		s.createdAt = now
	}
	s.activeAt = now
}

func (s *Session) ApprovalReviewer() ApprovalReviewer { return s.reviewer }

// SetApprovalReviewer changes who reviews approval requests from now on.
func (s *Session) SetApprovalReviewer(r ApprovalReviewer) error {
	if !r.Valid() {
		return fmt.Errorf("%w: %q", ErrInvalidReviewer, r)
	}
	s.reviewer = r
	return nil
}
