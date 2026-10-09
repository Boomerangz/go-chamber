// Package mcpapi lets other agents drive go-chamber sessions over MCP:
// start them, send messages, wait for turns, answer requests and read what
// happened.
package mcpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/igorzygin/go-chamber/internal/adapters/hub"
	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// Sessions is the subset of the session manager MCP needs.
type Sessions interface {
	CreateSession(ctx context.Context, agent domain.AgentKind, cwd string) (domain.SessionSnapshot, error)
	ListSessions(ctx context.Context) ([]domain.SessionSnapshot, error)
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error)
	// Steer adds to the running turn or, when idle, starts one.
	Steer(ctx context.Context, id domain.SessionID, text string) error
	Interrupt(ctx context.Context, id domain.SessionID) error
	RespondRequest(ctx context.Context, id domain.SessionID, requestID domain.RequestID, answer app.RequestAnswer) error
	PendingRequests(ctx context.Context) []domain.Request
	SetModel(ctx context.Context, id domain.SessionID, model, effort string) (domain.SessionSnapshot, error)
	SetPermissionMode(ctx context.Context, id domain.SessionID, mode string) (domain.SessionSnapshot, error)
}

// Worktrees creates worktree sessions and reports a session folder's changes.
type Worktrees interface {
	Create(ctx context.Context, agent domain.AgentKind, dir, name string) (domain.SessionSnapshot, error)
	Changes(ctx context.Context, id domain.SessionID) (app.Changes, error)
	FileDiff(ctx context.Context, id domain.SessionID, path string) (string, error)
}

type Config struct {
	Sessions Sessions
	// Worktrees enables sessions in new worktrees and diffs when non-nil.
	Worktrees Worktrees
	Events    *hub.Hub
	// AllowApprovals lets clients grant permission requests. Off, they may
	// only deny them, so one agent cannot widen another's rights.
	AllowApprovals bool
	// MaxWait caps how long one wait call blocks; 30 minutes when zero.
	MaxWait time.Duration
	// Recheck is how often wait looks again in case the hub dropped the
	// event it waits for; 5 seconds when zero.
	Recheck time.Duration
}

// Server is the MCP endpoint. Run Watch for resource subscriptions.
type Server struct {
	cfg Config
	mcp *sdk.Server
	// done is closed by Close; blocked calls return on it.
	done      chan struct{}
	closeOnce sync.Once
}

const instructions = `Drive go-chamber agent sessions (Claude, Codex, OpenCode).
Loop: start_session or list_sessions -> send_message -> wait with the since_seq it returned.
While wait says "running", call wait again with the seq it returned.
On "needs_answer", call answer_request, then wait again.
read_session and get_diff show what the session did.`

func New(cfg Config) *Server {
	if cfg.MaxWait == 0 {
		cfg.MaxWait = 30 * time.Minute
	}
	if cfg.Recheck == 0 {
		cfg.Recheck = 5 * time.Second
	}
	s := &Server{cfg: cfg, done: make(chan struct{})}
	s.mcp = sdk.NewServer(&sdk.Implementation{Name: "go-chamber", Version: "1"}, &sdk.ServerOptions{
		Instructions:       instructions,
		Capabilities:       &sdk.ServerCapabilities{},
		SubscribeHandler:   s.subscribe,
		UnsubscribeHandler: func(context.Context, *sdk.UnsubscribeRequest) error { return nil },
	})
	s.tools()
	s.resources()
	return s
}

// Handler serves MCP over streamable HTTP; authentication is the caller's.
func (s *Server) Handler() http.Handler {
	return sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return s.mcp }, nil)
}

// mcpOrigin labels everything a client sends as not the owner's own.
func mcpOrigin(ctx context.Context) context.Context {
	return app.WithOrigin(ctx, domain.OriginMCP)
}

type sessionView struct {
	ID              string `json:"id"`
	Agent           string `json:"agent"`
	Cwd             string `json:"cwd"`
	Status          string `json:"status"`
	Title           string `json:"title,omitempty"`
	Model           string `json:"model,omitempty"`
	Effort          string `json:"effort,omitempty"`
	PermissionMode  string `json:"permission_mode,omitempty"`
	ParentID        string `json:"parent_id,omitempty"`
	Branch          string `json:"branch,omitempty"`
	Archived        bool   `json:"archived,omitempty"`
	PendingRequests int    `json:"pending_requests,omitempty"`
}

func view(s domain.SessionSnapshot, pending []domain.Request) sessionView {
	v := sessionView{
		ID: string(s.ID), Agent: string(s.Agent), Cwd: s.Cwd, Status: string(s.Status), Title: s.Title,
		Model: s.Model, Effort: s.Effort, PermissionMode: s.PermissionMode, ParentID: string(s.ParentID),
		Archived: !s.ArchivedAt.IsZero(),
	}
	if s.Worktree != nil {
		v.Branch = s.Worktree.Branch
	}
	for _, r := range pending {
		if r.SessionID == s.ID {
			v.PendingRequests++
		}
	}
	return v
}

func (s *Server) pending(ctx context.Context, id domain.SessionID) []domain.Request {
	var out []domain.Request
	for _, r := range s.cfg.Sessions.PendingRequests(ctx) {
		if r.SessionID == id {
			out = append(out, r)
		}
	}
	return out
}

func (s *Server) tools() {
	readOnly := &sdk.ToolAnnotations{ReadOnlyHint: true}
	sdk.AddTool(s.mcp, &sdk.Tool{Name: "list_sessions", Description: "List go-chamber sessions with their status and open requests.", Annotations: readOnly}, s.listSessions)
	sdk.AddTool(s.mcp, &sdk.Tool{Name: "start_session", Description: "Start an agent session in a folder, optionally in a new git worktree branch, and optionally send it a first message."}, s.startSession)
	sdk.AddTool(s.mcp, &sdk.Tool{Name: "send_message", Description: "Send a message to a session: starts a turn, or adds to the running one. Returns since_seq for wait."}, s.sendMessage)
	sdk.AddTool(s.mcp, &sdk.Tool{Name: "wait", Description: "Block until the session's turn ends or it asks something, or until timeout_seconds pass (status running: call again with the returned seq). Keep timeout_seconds under your client's tool timeout.", Annotations: readOnly}, s.wait)
	sdk.AddTool(s.mcp, &sdk.Tool{Name: "read_session", Description: "Read a session's transcript since since_seq, compacted: messages in full, tools one line each.", Annotations: readOnly}, s.readSession)
	sdk.AddTool(s.mcp, &sdk.Tool{Name: "answer_request", Description: "Answer a session's open request: a question (answers maps question text to chosen labels) or a permission (allow; granting may be disabled)."}, s.answerRequest)
	sdk.AddTool(s.mcp, &sdk.Tool{Name: "interrupt", Description: "Stop the session's running turn."}, s.interrupt)
	sdk.AddTool(s.mcp, &sdk.Tool{Name: "get_diff", Description: "Show what the session's folder changed against its base: the file list and the diff, of one path or all.", Annotations: readOnly}, s.getDiff)
}

type listIn struct {
	IncludeArchived bool   `json:"include_archived,omitempty"`
	Folder          string `json:"folder,omitempty" jsonschema:"only sessions in this folder or below"`
}

type listOut struct {
	Sessions []sessionView `json:"sessions"`
}

func (s *Server) listSessions(ctx context.Context, _ *sdk.CallToolRequest, in listIn) (*sdk.CallToolResult, listOut, error) {
	all, err := s.cfg.Sessions.ListSessions(ctx)
	if err != nil {
		return nil, listOut{}, err
	}
	pending := s.cfg.Sessions.PendingRequests(ctx)
	out := listOut{Sessions: []sessionView{}}
	for _, snap := range all {
		if !snap.ArchivedAt.IsZero() && !in.IncludeArchived {
			continue
		}
		if in.Folder != "" && !within(snap.Cwd, in.Folder) {
			continue
		}
		out.Sessions = append(out.Sessions, view(snap, pending))
	}
	return nil, out, nil
}

func within(path, folder string) bool {
	folder = strings.TrimSuffix(folder, "/")
	return path == folder || strings.HasPrefix(path, folder+"/")
}

type startIn struct {
	Agent          string `json:"agent" jsonschema:"claude, codex or opencode"`
	Cwd            string `json:"cwd" jsonschema:"absolute folder the agent works in"`
	Branch         string `json:"branch,omitempty" jsonschema:"create a git worktree on this new branch and work there"`
	Model          string `json:"model,omitempty"`
	Effort         string `json:"effort,omitempty"`
	PermissionMode string `json:"permission_mode,omitempty"`
	Message        string `json:"message,omitempty" jsonschema:"first message to send"`
}

type startOut struct {
	Session  sessionView `json:"session"`
	SinceSeq *domain.Seq `json:"since_seq,omitempty"`
}

func (s *Server) startSession(ctx context.Context, _ *sdk.CallToolRequest, in startIn) (*sdk.CallToolResult, startOut, error) {
	ctx = mcpOrigin(ctx)
	agent := domain.AgentKind(in.Agent)
	var snap domain.SessionSnapshot
	var err error
	switch {
	case in.Branch == "":
		snap, err = s.cfg.Sessions.CreateSession(ctx, agent, in.Cwd)
	case s.cfg.Worktrees == nil:
		err = errors.New("worktrees are not available")
	default:
		snap, err = s.cfg.Worktrees.Create(ctx, agent, in.Cwd, in.Branch)
	}
	if err != nil {
		return nil, startOut{}, err
	}
	if in.Model != "" || in.Effort != "" {
		if snap, err = s.cfg.Sessions.SetModel(ctx, snap.ID, in.Model, in.Effort); err != nil {
			return nil, startOut{}, err
		}
	}
	if in.PermissionMode != "" {
		if snap, err = s.cfg.Sessions.SetPermissionMode(ctx, snap.ID, in.PermissionMode); err != nil {
			return nil, startOut{}, err
		}
	}
	out := startOut{Session: view(snap, nil)}
	if in.Message != "" {
		since, err := s.send(ctx, snap.ID, in.Message)
		if err != nil {
			return nil, out, err
		}
		out.SinceSeq = &since
		if snap, err = s.cfg.Sessions.GetSession(ctx, snap.ID); err == nil {
			out.Session = view(snap, nil)
		}
	}
	return nil, out, nil
}

type sendIn struct {
	SessionID string `json:"session_id"`
	Text      string `json:"text"`
}

type sendOut struct {
	SinceSeq domain.Seq `json:"since_seq"`
}

func (s *Server) sendMessage(ctx context.Context, _ *sdk.CallToolRequest, in sendIn) (*sdk.CallToolResult, sendOut, error) {
	since, err := s.send(mcpOrigin(ctx), domain.SessionID(in.SessionID), in.Text)
	return nil, sendOut{SinceSeq: since}, err
}

// send delivers text and returns the seq of the message it left in the
// transcript: what the turn does after it comes later.
func (s *Server) send(ctx context.Context, id domain.SessionID, text string) (domain.Seq, error) {
	sub := s.cfg.Events.Subscribe()
	defer sub.Close()
	if err := s.cfg.Sessions.Steer(ctx, id, text); err != nil {
		return 0, err
	}
	timeout := time.After(time.Second)
	for {
		select {
		case ev := <-sub.Events():
			if ev.SessionID == id && ev.Type == domain.EventItemUpdated && ev.Item != nil && ev.Item.Kind == domain.ItemUserMessage {
				return ev.Seq, nil
			}
		case <-timeout:
			// The message event was dropped: everything so far is before it.
			return lastSeq(s.cfg.Events.History(id, 0), 0), nil
		}
	}
}

func lastSeq(events []domain.Event, since domain.Seq) domain.Seq {
	if n := len(events); n > 0 {
		return events[n-1].Seq
	}
	return since
}

type answerIn struct {
	SessionID       string              `json:"session_id"`
	RequestID       string              `json:"request_id"`
	Allow           bool                `json:"allow" jsonschema:"true grants the permission or submits the answers; false denies or skips"`
	Message         string              `json:"message,omitempty" jsonschema:"reason given with a denial"`
	AllowForSession bool                `json:"allow_for_session,omitempty" jsonschema:"do not ask again for this tool in this session"`
	Answers         map[string][]string `json:"answers,omitempty" jsonschema:"question text to the chosen option labels"`
}

type okOut struct {
	OK bool `json:"ok"`
}

func (s *Server) answerRequest(ctx context.Context, _ *sdk.CallToolRequest, in answerIn) (*sdk.CallToolResult, okOut, error) {
	id, rid := domain.SessionID(in.SessionID), domain.RequestID(in.RequestID)
	var req *domain.Request
	for _, r := range s.pending(ctx, id) {
		if r.ID == rid {
			req = &r
			break
		}
	}
	if req == nil {
		return nil, okOut{}, fmt.Errorf("%w: %s", app.ErrRequestNotFound, rid)
	}
	if req.Kind == domain.RequestPermission && in.Allow && !s.cfg.AllowApprovals {
		return nil, okOut{}, errors.New("granting permissions over MCP is off (start go-chamber with -mcp-allow-approvals); deny it, or leave it to the owner")
	}
	answer := app.RequestAnswer{Allow: in.Allow, Message: in.Message, AllowForSession: in.AllowForSession, Answers: in.Answers}
	if err := s.cfg.Sessions.RespondRequest(mcpOrigin(ctx), id, rid, answer); err != nil {
		return nil, okOut{}, err
	}
	return nil, okOut{OK: true}, nil
}

type sessionIn struct {
	SessionID string `json:"session_id"`
}

func (s *Server) interrupt(ctx context.Context, _ *sdk.CallToolRequest, in sessionIn) (*sdk.CallToolResult, okOut, error) {
	if err := s.cfg.Sessions.Interrupt(mcpOrigin(ctx), domain.SessionID(in.SessionID)); err != nil {
		return nil, okOut{}, err
	}
	return nil, okOut{OK: true}, nil
}

type diffIn struct {
	SessionID string `json:"session_id"`
	Path      string `json:"path,omitempty" jsonschema:"one file, relative to the repository root"`
}

type diffOut struct {
	Base  string           `json:"base,omitempty"`
	Files []app.FileChange `json:"files"`
}

func (s *Server) getDiff(ctx context.Context, _ *sdk.CallToolRequest, in diffIn) (*sdk.CallToolResult, diffOut, error) {
	changes, diff, err := s.diff(ctx, domain.SessionID(in.SessionID), in.Path)
	if err != nil {
		return nil, diffOut{}, err
	}
	out := diffOut{Base: changes.Base, Files: changes.Files}
	if out.Files == nil {
		out.Files = []app.FileChange{}
	}
	if diff == "" {
		diff = "no changes"
	}
	return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: diff}}}, out, nil
}

// diff is the session's changes and the diff of path, or of every file.
func (s *Server) diff(ctx context.Context, id domain.SessionID, path string) (app.Changes, string, error) {
	if s.cfg.Worktrees == nil {
		return app.Changes{}, "", errors.New("diffs are not available")
	}
	changes, err := s.cfg.Worktrees.Changes(ctx, id)
	if err != nil {
		return changes, "", err
	}
	if !changes.Repository {
		return changes, "", errors.New("the session folder is not in a git repository")
	}
	if path != "" {
		d, err := s.cfg.Worktrees.FileDiff(ctx, id, path)
		return changes, d, err
	}
	var b strings.Builder
	for _, f := range changes.Files {
		d, err := s.cfg.Worktrees.FileDiff(ctx, id, f.Path)
		if err != nil {
			return changes, "", err
		}
		b.WriteString(d)
		if !strings.HasSuffix(d, "\n") {
			b.WriteByte('\n')
		}
	}
	return changes, b.String(), nil
}

// Close ends every client session and the calls they have in flight, so
// that a server shutdown does not wait for them.
func (s *Server) Close() {
	s.closeOnce.Do(func() { close(s.done) })
	for ss := range s.mcp.Sessions() {
		_ = ss.Close()
	}
}
