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
	// RestartBackoff is the first delay before restarting a crashed
	// app-server that still has threads; it doubles per attempt.
	RestartBackoff time.Duration
	// RestartAttempts bounds the restarts before the threads are closed.
	RestartAttempts int

	mu     sync.Mutex
	server *Server
	closed bool
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

// Models implements app.ModelCatalog.
func (f *Factory) Models(ctx context.Context, agent domain.AgentKind) ([]app.ModelInfo, error) {
	if agent != domain.AgentCodex {
		return nil, fmt.Errorf("codex: unsupported agent %q", agent)
	}
	srv, err := f.ensureServer(ctx)
	if err != nil {
		return nil, err
	}
	return srv.Models(ctx)
}

// Close terminates the shared app-server.
func (f *Factory) Close() {
	f.mu.Lock()
	srv := f.server
	f.server = nil
	f.closed = true
	f.mu.Unlock()
	if srv != nil {
		_ = srv.Close()
	}
}

// supervise runs when an app-server exits. Its threads keep their event
// streams: the server is restarted with backoff and every thread resumed on
// it. Turns and requests in flight are lost and reported as such. Threads
// are closed only if the server cannot be brought back.
func (f *Factory) supervise(dead *Server) {
	threads, stale := dead.takeAll()
	for _, rt := range threads {
		rt.interrupted(stale[rt.threadID])
	}
	if len(threads) == 0 {
		return
	}
	backoff, attempts := f.RestartBackoff, f.RestartAttempts
	if backoff <= 0 {
		backoff = time.Second
	}
	if attempts <= 0 {
		attempts = 5
	}
	for i := 0; i < attempts; i++ {
		time.Sleep(backoff << i)
		f.mu.Lock()
		closed := f.closed
		f.mu.Unlock()
		if closed {
			break
		}
		srv, err := f.ensureServer(context.Background())
		if err != nil {
			continue
		}
		for _, rt := range threads {
			if err := srv.resume(rt); err != nil {
				rt.closeEvents()
			}
		}
		return
	}
	for _, rt := range threads {
		rt.closeEvents()
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
		// Wait closes stdout, so it must not run before the reader is done.
		<-s.client.Done()
		_ = cmd.Wait()
		f.supervise(s)
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
	orphans map[string][]orphan

	pmu     sync.Mutex
	pending map[domain.RequestID]pendingServerRequest
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

// Models lists the visible models (model/list), following pagination.
func (s *Server) Models(ctx context.Context) ([]app.ModelInfo, error) {
	var out []app.ModelInfo
	var cursor *string
	for page := 0; page < 20; page++ {
		params := map[string]any{}
		if cursor != nil {
			params["cursor"] = *cursor
		}
		res, err := s.client.Call(ctx, "model/list", params)
		if err != nil {
			return nil, fmt.Errorf("codex: model/list: %w", err)
		}
		var list struct {
			Data []struct {
				Model                  string `json:"model"`
				DisplayName            string `json:"displayName"`
				Description            string `json:"description"`
				Hidden                 bool   `json:"hidden"`
				IsDefault              bool   `json:"isDefault"`
				DefaultReasoningEffort string `json:"defaultReasoningEffort"`
				SupportedEfforts       []struct {
					ReasoningEffort string `json:"reasoningEffort"`
				} `json:"supportedReasoningEfforts"`
			} `json:"data"`
			NextCursor *string `json:"nextCursor"`
		}
		if err := json.Unmarshal(res, &list); err != nil {
			return nil, fmt.Errorf("codex: model/list response: %w", err)
		}
		for _, m := range list.Data {
			if m.Hidden {
				continue
			}
			info := app.ModelInfo{
				ID: m.Model, Name: m.DisplayName, Description: m.Description,
				DefaultEffort: m.DefaultReasoningEffort, Default: m.IsDefault,
			}
			for _, e := range m.SupportedEfforts {
				info.Efforts = append(info.Efforts, e.ReasoningEffort)
			}
			out = append(out, info)
		}
		if list.NextCursor == nil || *list.NextCursor == "" {
			break
		}
		cursor = list.NextCursor
	}
	return out, nil
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
	threads, _ := s.takeAll()
	for _, rt := range threads {
		rt.closeEvents()
	}
}

// takeAll detaches every thread and forgets buffered and pending messages,
// returning the pending request ids per thread.
func (s *Server) takeAll() ([]*Runtime, map[string][]domain.RequestID) {
	s.mu.Lock()
	threads := make([]*Runtime, 0, len(s.threads))
	for _, rt := range s.threads {
		threads = append(threads, rt)
	}
	s.threads = map[string]*Runtime{}
	s.orphans = map[string][]orphan{}
	s.mu.Unlock()
	s.pmu.Lock()
	stale := map[string][]domain.RequestID{}
	for id, p := range s.pending {
		stale[p.threadID] = append(stale[p.threadID], id)
	}
	s.pending = map[domain.RequestID]pendingServerRequest{}
	s.pmu.Unlock()
	return threads, stale
}

// resume reattaches a thread of a crashed server to this one.
func (s *Server) resume(rt *Runtime) error {
	params := map[string]any{"threadId": rt.threadID}
	rt.mu.Lock()
	addReviewer(params, rt.reviewer)
	if rt.model != "" {
		params["model"] = rt.model
	}
	rt.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := s.client.Call(ctx, "thread/resume", params); err != nil {
		return fmt.Errorf("codex: thread/resume: %w", err)
	}
	rt.mu.Lock()
	rt.server = s
	rt.mu.Unlock()
	s.register(rt)
	return nil
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

const maxOrphansPerThread = 512

// route hands a message to its thread's runtime, or buffers it until the
// thread is attached. Holding s.mu keeps a thread's messages in order while
// register replays its buffer.
func (s *Server) route(threadID string, o orphan) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rt := s.threads[threadID]; rt != nil {
		s.deliver(rt, o)
		return
	}
	if s.orphans == nil {
		s.orphans = map[string][]orphan{}
	}
	queue := s.orphans[threadID]
	queue = append(queue, o)
	if drop := len(queue) - maxOrphansPerThread; drop > 0 {
		for _, old := range queue[:drop] {
			if old.isRequest {
				s.respondErrorAsync(old.id, "request dropped before its thread was attached")
			}
		}
		queue = queue[drop:]
	}
	s.orphans[threadID] = queue
}

// deliver maps a message for rt. Emitting never blocks, so it is safe to
// call on the read loop and under s.mu.
func (s *Server) deliver(rt *Runtime, o orphan) {
	if !o.isRequest {
		for _, ev := range rt.mapNotification(o.method, o.params) {
			rt.emit(ev)
		}
		return
	}
	ev, ok := rt.mapServerRequest(o.method, o.id, o.params)
	if !ok {
		s.respondErrorAsync(o.id, "unsupported request: "+o.method)
		return
	}
	s.pmu.Lock()
	s.pending[ev.Request.ID] = pendingServerRequest{id: o.id, threadID: rt.threadID, method: o.method, params: o.params}
	s.pmu.Unlock()
	rt.emit(ev)
}

// respondErrorAsync answers off the read loop: a write to app-server's
// stdin may block while it waits for us to read its stdout.
func (s *Server) respondErrorAsync(id json.RawMessage, message string) {
	go func() { _ = s.client.RespondError(id, -32601, message) }()
}

func (s *Server) newRuntime(threadID string, mapper *Mapper) *Runtime {
	rt := &Runtime{
		server: s, threadID: threadID, mapper: mapper,
		events: make(chan domain.Event), wake: make(chan struct{}, 1), stop: make(chan struct{}),
	}
	go rt.pump()
	return rt
}

// register attaches rt to its thread and replays what arrived before it.
func (s *Server) register(rt *Runtime) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.registerLocked(rt)
}

func (s *Server) registerLocked(rt *Runtime) {
	s.threads[rt.threadID] = rt
	orphans := s.orphans[rt.threadID]
	delete(s.orphans, rt.threadID)
	for _, o := range orphans {
		s.deliver(rt, o)
	}
}

// attachThread registers a passive runtime for a thread the agent created
// itself (a collab subagent) and replays messages buffered before it existed.
func (s *Server) attachThread(nativeID string, session domain.SessionID) (*Runtime, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rt := s.threads[nativeID]; rt != nil {
		return rt, nil
	}
	mapper := NewMapper(session)
	mapper.IncludeUserMessages = true
	rt := s.newRuntime(nativeID, mapper)
	s.registerLocked(rt)
	return rt, nil
}

func (s *Server) startThread(ctx context.Context, req app.StartRequest) (*Runtime, error) {
	var thread rpcThread
	if req.NativeID != "" {
		params := map[string]any{"threadId": req.NativeID}
		addReviewer(params, req.ApprovalReviewer)
		if req.Model != "" {
			params["model"] = req.Model
		}
		method := "thread/resume"
		if req.Fork {
			method = "thread/fork"
		}
		res, err := s.client.Call(ctx, method, params)
		if err != nil {
			return nil, fmt.Errorf("codex: %s: %w", method, err)
		}
		var out struct {
			Thread rpcThread `json:"thread"`
		}
		if err := json.Unmarshal(res, &out); err != nil {
			return nil, fmt.Errorf("codex: %s response: %w", method, err)
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

	rt := s.newRuntime(thread.ID, NewMapper(req.SessionID))
	rt.reviewer, rt.effort, rt.mode = req.ApprovalReviewer, req.Effort, req.PermissionMode
	rt.cwd = req.Cwd
	rt.mapper.IncludeUserMessages = req.Fork
	for _, ev := range rt.mapThread(thread) {
		rt.emit(ev)
	}
	rt.mapper.IncludeUserMessages = false
	s.register(rt)
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
		ThreadID  string          `json:"threadId"`
		RequestID json.RawMessage `json:"requestId"`
	}
	if err := json.Unmarshal(params, &meta); err != nil {
		return
	}
	if method == "serverRequest/resolved" {
		s.takePending(domain.RequestID(idKey(meta.RequestID)))
		if s.dropOrphanRequest(meta.ThreadID, idKey(meta.RequestID)) {
			return
		}
	}
	if meta.ThreadID == "" {
		return
	}
	s.route(meta.ThreadID, orphan{method: method, params: params})
}

func (s *Server) handleServerRequest(id json.RawMessage, method string, params json.RawMessage) {
	var meta struct {
		ThreadID string `json:"threadId"`
	}
	_ = json.Unmarshal(params, &meta)
	if meta.ThreadID == "" {
		// Token refresh, attestation and v1 approvals: nothing here can
		// answer them, and an unanswered request stalls app-server.
		s.respondErrorAsync(id, "unsupported request: "+method)
		return
	}
	s.route(meta.ThreadID, orphan{id: id, method: method, params: params, isRequest: true})
}

// dropOrphanRequest forgets a buffered request that app-server resolved
// before its thread was attached, so it is never replayed.
func (s *Server) dropOrphanRequest(threadID, requestID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.orphans[threadID]
	for i, o := range queue {
		if o.isRequest && idKey(o.id) == requestID {
			s.orphans[threadID] = append(queue[:i:i], queue[i+1:]...)
			return true
		}
	}
	return false
}

func (s *Server) takePending(id domain.RequestID) (pendingServerRequest, bool) {
	s.pmu.Lock()
	defer s.pmu.Unlock()
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

	// queue holds events until pump hands them to a consumer, so a slow
	// session never stalls the shared read loop.
	queue []domain.Event
	wake  chan struct{}
	stop  chan struct{}

	mu     sync.Mutex
	mapMu  sync.Mutex
	turnID string
	// doneTurn is the last completed turn; a late turn/start response must
	// not revive it.
	doneTurn string
	reviewer domain.ApprovalReviewer
	// model and effort override the thread's choice from the next turn on;
	// empty values keep what the thread already uses.
	model     string
	effort    string
	closed    bool
	closeOnce sync.Once

	// mode is the permission preset applied to each turn; empty restores config.
	cwd                string
	mode               string
	configuredApproval json.RawMessage
	configuredSandbox  json.RawMessage
}

func (r *Runtime) mapThread(thread rpcThread) []domain.Event {
	r.mapMu.Lock()
	defer r.mapMu.Unlock()
	return r.mapper.MapThread(thread)
}

func (r *Runtime) mapNotification(method string, params json.RawMessage) []domain.Event {
	r.mapMu.Lock()
	events := r.mapper.MapNotification(method, params)
	r.mapMu.Unlock()
	if method == "turn/started" || method == "turn/completed" {
		var n turnNotification
		if json.Unmarshal(params, &n) == nil && n.Turn.ID != "" {
			r.mu.Lock()
			if method == "turn/started" {
				r.turnID = n.Turn.ID
			} else {
				r.doneTurn = n.Turn.ID
				if r.turnID == n.Turn.ID {
					r.turnID = ""
				}
			}
			r.mu.Unlock()
		}
	}
	return events
}

func (r *Runtime) activeTurn() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.turnID
}

func (r *Runtime) mapServerRequest(method string, id, params json.RawMessage) (domain.Event, bool) {
	r.mapMu.Lock()
	defer r.mapMu.Unlock()
	return r.mapper.MapServerRequest(method, id, params)
}

// current is the server the thread lives on; a restart moves it.
func (r *Runtime) current() *Server {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.server
}

// interrupted reports the loss of the server under a turn: requests go
// stale, unfinished items fail and the running turn ends with an error.
func (r *Runtime) interrupted(stale []domain.RequestID) {
	r.mapMu.Lock()
	session := r.mapper.session
	events := r.mapper.FailUnfinished()
	r.mapMu.Unlock()
	for _, id := range stale {
		r.emit(domain.Event{SessionID: session, Type: domain.EventRequestResolved,
			Request: &domain.Request{ID: id, SessionID: session, Kind: domain.RequestPermission, State: domain.RequestStale}})
	}
	for _, ev := range events {
		r.emit(ev)
	}
	r.mu.Lock()
	turn := r.turnID
	r.turnID = ""
	r.mu.Unlock()
	if turn != "" {
		r.emit(domain.Event{SessionID: session, Type: domain.EventTurnEnded, Result: &domain.TurnResult{
			IsError: true, Error: "codex app-server restarted; the turn was interrupted",
			InterruptionReason: domain.ExitCrashed,
		}})
	}
}

func (r *Runtime) NativeID() string            { return r.threadID }
func (r *Runtime) Events() <-chan domain.Event { return r.events }

func (r *Runtime) emit(ev domain.Event) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.queue = append(r.queue, ev)
	r.mu.Unlock()
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// pump delivers queued events in order. After closeEvents it flushes the
// queue and closes events; Close stops it at once.
func (r *Runtime) pump() {
	defer close(r.events)
	for {
		r.mu.Lock()
		batch, closed := r.queue, r.closed
		r.queue = nil
		r.mu.Unlock()
		for _, ev := range batch {
			select {
			case r.events <- ev:
			case <-r.stop:
				return
			}
		}
		if len(batch) > 0 {
			continue
		}
		if closed {
			return
		}
		select {
		case <-r.wake:
		case <-r.stop:
			return
		}
	}
}

// Send starts a new turn on the thread.
func (r *Runtime) Send(ctx context.Context, _ domain.TurnID, text string) error {
	return r.startTurn(ctx, []map[string]any{{"type": "text", "text": text}})
}

func (r *Runtime) startTurn(ctx context.Context, input []map[string]any) error {
	params := map[string]any{
		"threadId": r.threadID,
		"input":    input,
	}
	r.mu.Lock()
	addReviewer(params, r.reviewer)
	if r.model != "" {
		params["model"] = r.model
	}
	if r.effort != "" {
		params["effort"] = r.effort
	}
	mode := r.mode
	addPermissionMode(params, mode)
	r.mu.Unlock()
	if mode == "" {
		approval, sandbox, err := r.configuredPermissions(ctx)
		if err != nil {
			return err
		}
		params["approvalPolicy"], params["sandboxPolicy"] = approval, sandbox
	}
	res, err := r.current().client.Call(ctx, "turn/start", params)
	if err != nil {
		return fmt.Errorf("codex: turn/start: %w", err)
	}
	var out struct {
		Turn rpcTurn `json:"turn"`
	}
	if err := json.Unmarshal(res, &out); err == nil && out.Turn.ID != "" {
		r.mu.Lock()
		if out.Turn.ID != r.doneTurn {
			r.turnID = out.Turn.ID
		}
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

// SetModel switches the model and reasoning effort from the next turn on;
// turn/start overrides stick to the thread. Empty values can't be sent, so
// the thread keeps its last explicit choice.
func (r *Runtime) SetModel(_ context.Context, model, effort string) error {
	r.mu.Lock()
	r.model, r.effort = model, effort
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
	turnID := r.activeTurn()
	if turnID == "" {
		return errors.New("codex: no active turn to steer")
	}
	_, err := r.current().client.Call(ctx, "turn/steer", map[string]any{
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
	turnID := r.activeTurn()
	if turnID == "" {
		return nil
	}
	_, err := r.current().client.Call(ctx, "turn/interrupt", map[string]any{
		"threadId": r.threadID, "turnId": turnID,
	})
	return err
}

// Respond answers a pending approval or question.
func (r *Runtime) Respond(_ context.Context, requestID domain.RequestID, answer app.RequestAnswer) error {
	srv := r.current()
	srv.pmu.Lock()
	p, ok := srv.pending[requestID]
	srv.pmu.Unlock()
	if !ok {
		return fmt.Errorf("codex: no pending request %s", requestID)
	}
	result, err := codexDecision(p, answer)
	if err != nil {
		return err
	}
	// Forget the request only once the answer is out, so a failed write
	// can be retried.
	if err := srv.client.Respond(p.id, result); err != nil {
		return err
	}
	srv.takePending(requestID)
	return nil
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
		if answer.AllowForSession {
			return map[string]any{"permissions": params.Permissions, "scope": "session"}, nil
		}
		return map[string]any{"permissions": params.Permissions}, nil
	case "item/tool/requestUserInput":
		var params userInputParams
		if err := json.Unmarshal(p.params, &params); err != nil {
			return nil, err
		}
		answers := map[string]any{}
		for _, q := range params.Questions {
			labels := []string{}
			if answer.Allow {
				labels = append(labels, answer.Answers[q.Question]...)
				if len(labels) == 0 {
					labels = append(labels, answer.Answers[q.ID]...)
				}
			}
			answers[q.ID] = map[string]any{"answers": labels}
		}
		return map[string]any{"answers": answers}, nil
	case "mcpServer/elicitation/request":
		if !answer.Allow {
			return map[string]any{"action": "decline"}, nil
		}
		content := answer.Content
		if len(content) == 0 {
			content = json.RawMessage(`{}`)
		}
		return map[string]any{"action": "accept", "content": content}, nil
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
		srv := r.current()
		srv.mu.Lock()
		if srv.threads[r.threadID] == r {
			delete(srv.threads, r.threadID)
		}
		srv.mu.Unlock()
		r.mu.Lock()
		r.closed = true
		r.mu.Unlock()
		close(r.stop)
	})
	return nil
}

// closeEvents ends the stream after the queued events are delivered.
func (r *Runtime) closeEvents() {
	r.mu.Lock()
	r.closed = true
	r.mu.Unlock()
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

var _ app.RuntimeFactory = (*Factory)(nil)
var _ app.AccountManager = (*Factory)(nil)
var _ app.QuotaProvider = (*Factory)(nil)
var _ app.ModelCatalog = (*Factory)(nil)
var _ app.ModelSetter = (*Runtime)(nil)
var _ app.AgentRuntime = (*Runtime)(nil)
