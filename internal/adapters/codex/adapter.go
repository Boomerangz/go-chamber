package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// Factory launches and owns `codex app-server`. One app-server process serves
// every thread; Factory.Start attaches a per-thread Runtime facade.
type Factory struct {
	Binary      string
	Args        []string
	Env         []string
	Stderr      io.Writer
	InitTimeout time.Duration

	mu     sync.Mutex
	server *Server
}

func (f *Factory) binary() string {
	if f.Binary != "" {
		return f.Binary
	}
	return "codex"
}

func (f *Factory) stderr() io.Writer {
	if f.Stderr != nil {
		return f.Stderr
	}
	return os.Stderr
}

// Start implements app.RuntimeFactory.
func (f *Factory) Start(ctx context.Context, req app.StartRequest) (app.AgentRuntime, error) {
	srv, err := f.ensureServer(ctx)
	if err != nil {
		return nil, err
	}
	if req.Passive && req.NativeID != "" {
		return srv.attachThread(req.NativeID, req.SessionID)
	}
	return srv.startThread(ctx, req)
}

// ensureServer lazily starts the shared app-server, restarting it if it died.
func (f *Factory) ensureServer(ctx context.Context) (*Server, error) {
	f.mu.Lock()
	srv := f.server
	if srv != nil && !srv.alive() {
		f.server = nil
		srv = nil
	}
	f.mu.Unlock()
	if srv != nil {
		return srv, nil
	}
	started, err := f.startServer(ctx)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	if f.server != nil && f.server.alive() {
		existing := f.server
		f.mu.Unlock()
		_ = started.Close()
		return existing, nil
	}
	f.server = started
	f.mu.Unlock()
	return started, nil
}

// RateLimits implements app.QuotaProvider.
func (f *Factory) RateLimits(ctx context.Context, agent domain.AgentKind) (domain.QuotaSnapshot, error) {
	if agent != domain.AgentCodex {
		return domain.QuotaSnapshot{}, fmt.Errorf("codex: unsupported agent %q", agent)
	}
	srv, err := f.ensureServer(ctx)
	if err != nil {
		return domain.QuotaSnapshot{}, err
	}
	return srv.RateLimits(ctx)
}

// Account implements app.AccountManager.
func (f *Factory) Account(ctx context.Context, agent domain.AgentKind) (app.AccountInfo, error) {
	if agent != domain.AgentCodex {
		return app.AccountInfo{}, fmt.Errorf("codex: unsupported agent %q", agent)
	}
	srv, err := f.ensureServer(ctx)
	if err != nil {
		return app.AccountInfo{}, err
	}
	return srv.Account(ctx, agent)
}

// StartLogin implements app.AccountManager.
func (f *Factory) StartLogin(ctx context.Context, agent domain.AgentKind) (app.LoginChallenge, error) {
	if agent != domain.AgentCodex {
		return app.LoginChallenge{}, fmt.Errorf("codex: unsupported agent %q", agent)
	}
	srv, err := f.ensureServer(ctx)
	if err != nil {
		return app.LoginChallenge{}, err
	}
	return srv.StartLogin(ctx, agent)
}

// Close terminates the shared app-server.
func (f *Factory) Close() {
	f.mu.Lock()
	srv := f.server
	f.server = nil
	f.mu.Unlock()
	if srv != nil {
		_ = srv.Close()
	}
}

func (f *Factory) startServer(ctx context.Context) (*Server, error) {
	cmd := exec.Command(f.binary(), append([]string{"app-server"}, f.Args...)...)
	cmd.Env = append(os.Environ(), f.Env...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("codex: start %s app-server: %w", f.binary(), err)
	}

	s := &Server{
		cmd:     cmd,
		stdin:   stdin,
		threads: map[string]*Runtime{},
		pending: map[domain.RequestID]pendingServerRequest{},
		orphans: map[string][]orphan{},
	}
	s.client = NewClient(stdout, stdin, s.handleServerRequest, s.handleNotification)
	go s.drainStderr(stderr, f.stderr())
	go func() {
		_ = cmd.Wait()
		s.closeAll()
	}()

	timeout := f.InitTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	initCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if _, err := s.client.Call(initCtx, "initialize", map[string]any{
		"clientInfo":   map[string]string{"name": "go-chamber", "title": "go-chamber", "version": "0.1"},
		"capabilities": map[string]any{"experimentalApi": true},
	}); err != nil {
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("codex: initialize: %w", err)
	}
	if err := s.client.Notify("initialized", map[string]any{}); err != nil {
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("codex: initialized: %w", err)
	}
	return s, nil
}

type pendingServerRequest struct {
	id       json.RawMessage
	threadID string
	method   string
	params   json.RawMessage
}

// Server owns one app-server process and dispatches per-thread messages.
type Server struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	client *Client

	mu      sync.Mutex
	threads map[string]*Runtime
	pending map[domain.RequestID]pendingServerRequest
	orphans map[string][]orphan
}

// orphan is a message that arrived before its thread was attached.
type orphan struct {
	id        json.RawMessage
	method    string
	params    json.RawMessage
	isRequest bool
}

func (s *Server) alive() bool {
	select {
	case <-s.client.Done():
		return false
	default:
		return true
	}
}

// Account reports the logged-in account from account/read.
func (s *Server) Account(ctx context.Context, agent domain.AgentKind) (app.AccountInfo, error) {
	res, err := s.client.Call(ctx, "account/read", map[string]any{})
	if err != nil {
		return app.AccountInfo{}, fmt.Errorf("codex: account/read: %w", err)
	}
	var out struct {
		Account *struct {
			Type     string `json:"type"`
			Email    string `json:"email"`
			PlanType string `json:"planType"`
		} `json:"account"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return app.AccountInfo{}, fmt.Errorf("codex: account/read response: %w", err)
	}
	info := app.AccountInfo{Agent: agent}
	if out.Account != nil {
		info.LoggedIn = true
		info.AuthMode = out.Account.Type
		info.Email = out.Account.Email
		info.Plan = out.Account.PlanType
	}
	return info, nil
}

// StartLogin begins a ChatGPT device-code login.
func (s *Server) StartLogin(ctx context.Context, _ domain.AgentKind) (app.LoginChallenge, error) {
	res, err := s.client.Call(ctx, "account/login/start", map[string]any{"type": "chatgptDeviceCode"})
	if err != nil {
		return app.LoginChallenge{}, fmt.Errorf("codex: account/login/start: %w", err)
	}
	var out struct {
		LoginID         string `json:"loginId"`
		UserCode        string `json:"userCode"`
		VerificationURL string `json:"verificationUrl"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return app.LoginChallenge{}, fmt.Errorf("codex: login response: %w", err)
	}
	return app.LoginChallenge{LoginID: out.LoginID, UserCode: out.UserCode, URL: out.VerificationURL}, nil
}

func (s *Server) drainStderr(r io.Reader, dst io.Writer) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			_, _ = fmt.Fprint(dst, "codex: ", string(buf[:n]))
		}
		if err != nil {
			return
		}
	}
}

func (s *Server) closeAll() {
	s.mu.Lock()
	threads := s.threads
	s.threads = map[string]*Runtime{}
	s.mu.Unlock()
	for _, rt := range threads {
		rt.closeEvents()
	}
}

// Close terminates the process.
func (s *Server) Close() error {
	_ = s.stdin.Close()
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	return nil
}

// RateLimits reads the account's current rate limits.
func (s *Server) RateLimits(ctx context.Context) (domain.QuotaSnapshot, error) {
	res, err := s.client.Call(ctx, "account/rateLimits/read", map[string]any{})
	if err != nil {
		return domain.QuotaSnapshot{}, fmt.Errorf("codex: account/rateLimits/read: %w", err)
	}
	var out struct {
		RateLimits rateLimitSnapshot `json:"rateLimits"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return domain.QuotaSnapshot{}, fmt.Errorf("codex: rate limits response: %w", err)
	}
	return quotaFromSnapshot(out.RateLimits), nil
}

func (s *Server) allRuntimes() []*Runtime {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Runtime, 0, len(s.threads))
	for _, rt := range s.threads {
		out = append(out, rt)
	}
	return out
}

func (s *Server) runtimeFor(threadID string) *Runtime {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.threads[threadID]
}

const maxOrphansPerThread = 512

func (s *Server) bufferOrphan(threadID string, o orphan) {
	if threadID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.orphans == nil {
		s.orphans = map[string][]orphan{}
	}
	queue := s.orphans[threadID]
	queue = append(queue, o)
	if len(queue) > maxOrphansPerThread {
		queue = queue[len(queue)-maxOrphansPerThread:]
	}
	s.orphans[threadID] = queue
}

// attachThread registers a passive runtime for a thread the agent created
// itself (a collab subagent) and replays messages buffered before it existed.
func (s *Server) attachThread(nativeID string, session domain.SessionID) (*Runtime, error) {
	s.mu.Lock()
	if rt := s.threads[nativeID]; rt != nil {
		s.mu.Unlock()
		return rt, nil
	}
	rt := &Runtime{server: s, threadID: nativeID, mapper: NewMapper(session), events: make(chan domain.Event, 256)}
	s.threads[nativeID] = rt
	orphans := s.orphans[nativeID]
	delete(s.orphans, nativeID)
	s.mu.Unlock()

	for _, o := range orphans {
		if o.isRequest {
			s.handleServerRequest(o.id, o.method, o.params)
		} else {
			s.handleNotification(o.method, o.params)
		}
	}
	return rt, nil
}

func (s *Server) startThread(ctx context.Context, req app.StartRequest) (*Runtime, error) {
	var thread rpcThread
	if req.NativeID != "" {
		params := map[string]any{"threadId": req.NativeID}
		addReviewer(params, req.ApprovalReviewer)
		res, err := s.client.Call(ctx, "thread/resume", params)
		if err != nil {
			return nil, fmt.Errorf("codex: thread/resume: %w", err)
		}
		var out struct {
			Thread rpcThread `json:"thread"`
		}
		if err := json.Unmarshal(res, &out); err != nil {
			return nil, fmt.Errorf("codex: thread/resume response: %w", err)
		}
		thread = out.Thread
	} else {
		params := map[string]any{"cwd": req.Cwd}
		if req.Model != "" {
			params["model"] = req.Model
		}
		addReviewer(params, req.ApprovalReviewer)
		res, err := s.client.Call(ctx, "thread/start", params)
		if err != nil {
			return nil, fmt.Errorf("codex: thread/start: %w", err)
		}
		var out struct {
			Thread rpcThread `json:"thread"`
		}
		if err := json.Unmarshal(res, &out); err != nil {
			return nil, fmt.Errorf("codex: thread/start response: %w", err)
		}
		thread = out.Thread
	}
	if thread.ID == "" {
		return nil, errors.New("codex: server returned an empty thread id")
	}

	rt := &Runtime{
		server:   s,
		threadID: thread.ID,
		mapper:   NewMapper(req.SessionID),
		events:   make(chan domain.Event, 256),
		reviewer: req.ApprovalReviewer,
	}
	s.mu.Lock()
	s.threads[thread.ID] = rt
	s.mu.Unlock()

	for _, ev := range rt.mapThread(thread) {
		rt.emit(ev)
	}
	if q, err := s.RateLimits(ctx); err == nil {
		rt.emit(domain.Event{SessionID: req.SessionID, Type: domain.EventQuota, Quota: &q})
	}
	return rt, nil
}

func (s *Server) handleNotification(method string, params json.RawMessage) {
	if strings.HasPrefix(method, "account/") {
		for _, rt := range s.allRuntimes() {
			for _, ev := range rt.mapper.MapGlobalNotification(method, params) {
				rt.emit(ev)
			}
		}
		return
	}
	var meta struct {
		ThreadID string `json:"threadId"`
	}
	if err := json.Unmarshal(params, &meta); err != nil {
		return
	}
	rt := s.runtimeFor(meta.ThreadID)
	if rt == nil {
		s.bufferOrphan(meta.ThreadID, orphan{method: method, params: params})
		return
	}
	for _, ev := range rt.mapNotification(method, params) {
		rt.emit(ev)
	}
}

func (s *Server) handleServerRequest(id json.RawMessage, method string, params json.RawMessage) {
	var meta struct {
		ThreadID string `json:"threadId"`
	}
	_ = json.Unmarshal(params, &meta)
	rt := s.runtimeFor(meta.ThreadID)
	if rt == nil {
		s.bufferOrphan(meta.ThreadID, orphan{id: id, method: method, params: params, isRequest: true})
		return
	}
	ev, ok := rt.mapServerRequest(method, id, params)
	if !ok {
		_ = s.client.RespondError(id, -32601, "unsupported request: "+method)
		return
	}
	s.mu.Lock()
	s.pending[ev.Request.ID] = pendingServerRequest{id: id, threadID: meta.ThreadID, method: method, params: params}
	s.mu.Unlock()
	rt.emit(ev)
}

func (s *Server) takePending(id domain.RequestID) (pendingServerRequest, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.pending[id]
	delete(s.pending, id)
	return p, ok
}

// Runtime is one thread's view of the shared app-server.
type Runtime struct {
	server   *Server
	threadID string
	mapper   *Mapper
	events   chan domain.Event

	mu        sync.Mutex
	mapMu     sync.Mutex
	turnID    string
	reviewer  domain.ApprovalReviewer
	closed    bool
	closeOnce sync.Once
}

func (r *Runtime) mapThread(thread rpcThread) []domain.Event {
	r.mapMu.Lock()
	defer r.mapMu.Unlock()
	return r.mapper.MapThread(thread)
}

func (r *Runtime) mapNotification(method string, params json.RawMessage) []domain.Event {
	r.mapMu.Lock()
	defer r.mapMu.Unlock()
	return r.mapper.MapNotification(method, params)
}

func (r *Runtime) mapServerRequest(method string, id, params json.RawMessage) (domain.Event, bool) {
	r.mapMu.Lock()
	defer r.mapMu.Unlock()
	return r.mapper.MapServerRequest(method, id, params)
}

func (r *Runtime) NativeID() string            { return r.threadID }
func (r *Runtime) Events() <-chan domain.Event { return r.events }

func (r *Runtime) emit(ev domain.Event) {
	r.mu.Lock()
	closed := r.closed
	r.mu.Unlock()
	if closed {
		return
	}
	defer func() { _ = recover() }() // channel may close concurrently
	r.events <- ev
}

// Send starts a new turn on the thread.
func (r *Runtime) Send(ctx context.Context, _ domain.TurnID, text string) error {
	params := map[string]any{
		"threadId": r.threadID,
		"input":    []map[string]any{{"type": "text", "text": text}},
	}
	r.mu.Lock()
	addReviewer(params, r.reviewer)
	r.mu.Unlock()
	res, err := r.server.client.Call(ctx, "turn/start", params)
	if err != nil {
		return fmt.Errorf("codex: turn/start: %w", err)
	}
	var out struct {
		Turn rpcTurn `json:"turn"`
	}
	if err := json.Unmarshal(res, &out); err == nil && out.Turn.ID != "" {
		r.mu.Lock()
		r.turnID = out.Turn.ID
		r.mu.Unlock()
		r.mapMu.Lock()
		r.mapper.SetTurn(domain.TurnID(out.Turn.ID))
		r.mapMu.Unlock()
	}
	return nil
}

// SetApprovalReviewer changes who reviews approval requests from the next
// turn on; Codex keeps the value for the thread. The empty (agent default)
// value cannot be sent, so the thread keeps the last explicit choice.
func (r *Runtime) SetApprovalReviewer(_ context.Context, rev domain.ApprovalReviewer) error {
	r.mu.Lock()
	r.reviewer = rev
	r.mu.Unlock()
	return nil
}

// addReviewer sets approvalsReviewer unless the agent's own config decides.
func addReviewer(params map[string]any, rev domain.ApprovalReviewer) {
	if rev != domain.ReviewerDefault {
		params["approvalsReviewer"] = string(rev)
	}
}

// StopTask interrupts the active turn for a Codex collab agent.
func (r *Runtime) StopTask(ctx context.Context, _ string) error {
	return r.Interrupt(ctx)
}

// Steer appends input to the active turn.
func (r *Runtime) Steer(ctx context.Context, text string) error {
	r.mu.Lock()
	turnID := r.turnID
	r.mu.Unlock()
	if turnID == "" {
		return errors.New("codex: no active turn to steer")
	}
	_, err := r.server.client.Call(ctx, "turn/steer", map[string]any{
		"threadId": r.threadID, "expectedTurnId": turnID,
		"input": []map[string]any{{"type": "text", "text": text}},
	})
	if err != nil {
		return fmt.Errorf("codex: turn/steer: %w", err)
	}
	return nil
}

// Interrupt stops the active turn.
func (r *Runtime) Interrupt(ctx context.Context) error {
	r.mu.Lock()
	turnID := r.turnID
	r.mu.Unlock()
	if turnID == "" {
		return nil
	}
	_, err := r.server.client.Call(ctx, "turn/interrupt", map[string]any{
		"threadId": r.threadID, "turnId": turnID,
	})
	return err
}

// Respond answers a pending approval or question.
func (r *Runtime) Respond(_ context.Context, requestID domain.RequestID, answer app.RequestAnswer) error {
	p, ok := r.server.takePending(requestID)
	if !ok {
		return fmt.Errorf("codex: no pending request %s", requestID)
	}
	result, err := codexDecision(p, answer)
	if err != nil {
		return err
	}
	return r.server.client.Respond(p.id, result)
}

func codexDecision(p pendingServerRequest, answer app.RequestAnswer) (any, error) {
	switch p.method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		return map[string]any{"decision": approvalDecision(answer)}, nil
	case "item/permissions/requestApproval":
		var params struct {
			Permissions json.RawMessage `json:"permissions"`
		}
		_ = json.Unmarshal(p.params, &params)
		if !answer.Allow {
			return map[string]any{"permissions": json.RawMessage(`{}`)}, nil
		}
		return map[string]any{"permissions": params.Permissions}, nil
	case "item/tool/requestUserInput":
		var params userInputParams
		if err := json.Unmarshal(p.params, &params); err != nil {
			return nil, err
		}
		answers := map[string]any{}
		for _, q := range params.Questions {
			labels := answer.Answers[q.Question]
			if len(labels) == 0 {
				labels = answer.Answers[q.ID]
			}
			answers[q.ID] = map[string]any{"answers": labels}
		}
		return map[string]any{"answers": answers}, nil
	case "mcpServer/elicitation/request":
		action := "decline"
		if answer.Allow {
			action = "accept"
		}
		return map[string]any{"action": action}, nil
	}
	return nil, errors.New("codex: unsupported request " + p.method)
}

func approvalDecision(answer app.RequestAnswer) string {
	if !answer.Allow {
		if answer.Message == "cancel" {
			return "cancel"
		}
		return "decline"
	}
	if answer.AllowForSession {
		return "acceptForSession"
	}
	return "accept"
}

// Close closes the runtime's event stream; the shared server stays up.
func (r *Runtime) Close() error {
	r.closeOnce.Do(func() {
		r.server.mu.Lock()
		delete(r.server.threads, r.threadID)
		r.server.mu.Unlock()
		r.closeEvents()
	})
	return nil
}

func (r *Runtime) closeEvents() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	r.mu.Unlock()
	close(r.events)
}

var _ app.RuntimeFactory = (*Factory)(nil)
var _ app.AccountManager = (*Factory)(nil)
var _ app.QuotaProvider = (*Factory)(nil)
var _ app.AgentRuntime = (*Runtime)(nil)
