package mcpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/igorzygin/go-chamber/internal/adapters/hub"
	mcpapi "github.com/igorzygin/go-chamber/internal/adapters/mcp"
	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// fakeSessions is a session manager whose agent is the test: it publishes
// what the manager would on the hub and records what MCP asked for.
type fakeSessions struct {
	mu       sync.Mutex
	hub      *hub.Hub
	sessions map[domain.SessionID]domain.SessionSnapshot
	pending  []domain.Request
	calls    []string
	answers  []app.RequestAnswer
	next     int
	// noise is how many events of another session Steer publishes before
	// the message, enough to overflow a subscriber that is not reading.
	noise int
	// reply ends the turn inside Steer with this answer when set.
	reply string
}

func newFakeSessions(h *hub.Hub) *fakeSessions {
	return &fakeSessions{hub: h, sessions: map[domain.SessionID]domain.SessionSnapshot{}}
}

func (f *fakeSessions) add(s domain.SessionSnapshot) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions[s.ID] = s
}

func (f *fakeSessions) setStatus(id domain.SessionID, st domain.SessionStatus) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.sessions[id]
	s.Status = st
	f.sessions[id] = s
}

func (f *fakeSessions) record(ctx context.Context, call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call+" origin="+string(app.OriginOf(ctx)))
}

func (f *fakeSessions) recorded() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *fakeSessions) CreateSession(ctx context.Context, agent domain.AgentKind, cwd string) (domain.SessionSnapshot, error) {
	f.record(ctx, "create "+string(agent)+" "+cwd)
	f.mu.Lock()
	f.next++
	s := domain.SessionSnapshot{ID: domain.SessionID("new" + string(rune('0'+f.next))), Agent: agent, Cwd: cwd, Status: domain.StatusDetached}
	f.sessions[s.ID] = s
	f.mu.Unlock()
	return s, nil
}

func (f *fakeSessions) ListSessions(context.Context) ([]domain.SessionSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []domain.SessionSnapshot
	for _, s := range f.sessions {
		out = append(out, s)
	}
	slices.SortFunc(out, func(a, b domain.SessionSnapshot) int { return strings.Compare(string(a.ID), string(b.ID)) })
	return out, nil
}

func (f *fakeSessions) GetSession(_ context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.sessions[id]
	if !ok {
		return s, app.ErrSessionNotFound
	}
	return s, nil
}

// Steer acts as the manager does: an idle session starts a turn.
func (f *fakeSessions) Steer(ctx context.Context, id domain.SessionID, text string) error {
	s, err := f.GetSession(ctx, id)
	if err != nil {
		return err
	}
	f.record(ctx, "steer "+string(id)+" "+text)
	for i := 0; i < f.noise; i++ {
		f.hub.Publish(domain.Event{SessionID: "noisy", Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "x", Text: "."}})
	}
	if s.Status != domain.StatusRunning {
		f.setStatus(id, domain.StatusRunning)
		f.hub.Publish(domain.Event{SessionID: id, Type: domain.EventTurnStarted})
	}
	item, _ := domain.NewItem(domain.ItemID("u-"+text), id, "t1", "", domain.ItemUserMessage)
	item.Text = text
	item.Status = domain.ItemCompleted
	f.hub.Publish(domain.Event{SessionID: id, Type: domain.EventItemUpdated, Item: item})
	if f.reply != "" {
		answer, _ := domain.NewItem("m-"+domain.ItemID(text), id, "t1", "", domain.ItemAssistantMessage)
		answer.Text = f.reply
		answer.Status = domain.ItemCompleted
		f.hub.Publish(domain.Event{SessionID: id, Type: domain.EventItemUpdated, Item: answer})
		f.setStatus(id, domain.StatusIdle)
		f.hub.Publish(domain.Event{SessionID: id, Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: f.reply}})
	}
	return nil
}

func (f *fakeSessions) Interrupt(ctx context.Context, id domain.SessionID) error {
	if _, err := f.GetSession(ctx, id); err != nil {
		return err
	}
	f.record(ctx, "interrupt "+string(id))
	return nil
}

func (f *fakeSessions) RespondRequest(ctx context.Context, id domain.SessionID, rid domain.RequestID, a app.RequestAnswer) error {
	f.record(ctx, "answer "+string(id)+" "+string(rid))
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers = append(f.answers, a)
	f.pending = slices.DeleteFunc(f.pending, func(r domain.Request) bool { return r.ID == rid })
	return nil
}

func (f *fakeSessions) PendingRequests(context.Context) []domain.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]domain.Request(nil), f.pending...)
}

func (f *fakeSessions) SetModel(ctx context.Context, id domain.SessionID, model, effort string) (domain.SessionSnapshot, error) {
	f.record(ctx, "model "+string(id)+" "+model+" "+effort)
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.sessions[id]
	s.Model, s.Effort = model, effort
	f.sessions[id] = s
	return s, nil
}

func (f *fakeSessions) SetPermissionMode(ctx context.Context, id domain.SessionID, mode string) (domain.SessionSnapshot, error) {
	f.record(ctx, "mode "+string(id)+" "+mode)
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.sessions[id]
	s.PermissionMode = mode
	f.sessions[id] = s
	return s, nil
}

type fakeWorktrees struct {
	sessions *fakeSessions
	changes  app.Changes
	diffs    map[string]string
}

func (w *fakeWorktrees) Create(ctx context.Context, agent domain.AgentKind, dir, name string) (domain.SessionSnapshot, error) {
	s, _ := w.sessions.CreateSession(ctx, agent, dir+"/.wt/"+name)
	s.Worktree = &domain.Worktree{Repo: dir, Path: s.Cwd, Branch: name}
	w.sessions.add(s)
	return s, nil
}

func (w *fakeWorktrees) Changes(context.Context, domain.SessionID) (app.Changes, error) {
	return w.changes, nil
}

func (w *fakeWorktrees) FileDiff(_ context.Context, _ domain.SessionID, path string) (string, error) {
	d, ok := w.diffs[path]
	if !ok {
		return "", errors.New("no such file")
	}
	return d, nil
}

type fixture struct {
	hub      *hub.Hub
	sessions *fakeSessions
	wt       *fakeWorktrees
	client   *sdk.ClientSession
	server   *mcpapi.Server
	url      string
}

func newFixture(t *testing.T, cfg mcpapi.Config, opts *sdk.ClientOptions) *fixture {
	t.Helper()
	h := hub.New()
	f := &fixture{hub: h, sessions: newFakeSessions(h)}
	f.wt = &fakeWorktrees{sessions: f.sessions, diffs: map[string]string{}}
	cfg.Sessions, cfg.Worktrees, cfg.Events = f.sessions, f.wt, h
	if cfg.Recheck == 0 {
		cfg.Recheck = 20 * time.Millisecond
	}
	f.server = mcpapi.New(cfg)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	f.server.Watch(ctx)
	srv := httptest.NewServer(f.server.Handler())
	t.Cleanup(srv.Close)
	f.url = srv.URL
	client := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "1"}, opts)
	cs, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: srv.URL}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	f.client = cs
	return f
}

func (f *fixture) call(t *testing.T, name string, args any) (*sdk.CallToolResult, map[string]any) {
	t.Helper()
	res, err := f.client.CallTool(context.Background(), &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	var out map[string]any
	if res.StructuredContent != nil {
		raw, _ := json.Marshal(res.StructuredContent)
		_ = json.Unmarshal(raw, &out)
	}
	return res, out
}

func (f *fixture) mustCall(t *testing.T, name string, args any) map[string]any {
	t.Helper()
	res, out := f.call(t, name, args)
	if res.IsError {
		t.Fatalf("%s failed: %s", name, text(res))
	}
	return out
}

func text(res *sdk.CallToolResult) string {
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*sdk.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}

func (f *fixture) publishItem(id domain.SessionID, item domain.Item) domain.Event {
	item.SessionID = id
	return f.hub.Publish(domain.Event{SessionID: id, Type: domain.EventItemUpdated, Item: &item})
}

func (f *fixture) endTurn(id domain.SessionID, res domain.TurnResult) domain.Event {
	f.sessions.setStatus(id, domain.StatusIdle)
	return f.hub.Publish(domain.Event{SessionID: id, Type: domain.EventTurnEnded, Result: &res})
}

func idle(id domain.SessionID) domain.SessionSnapshot {
	return domain.SessionSnapshot{ID: id, Agent: domain.AgentClaude, Cwd: "/repo", Status: domain.StatusIdle, Title: "Fix it"}
}

func TestListsTheTools(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	res, err := f.client.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
	}
	slices.Sort(names)
	want := []string{"answer_request", "get_diff", "interrupt", "list_sessions", "read_session", "send_message", "start_session", "wait"}
	if !slices.Equal(names, want) {
		t.Fatalf("tools = %v", names)
	}
}

func TestListSessionsHidesArchivedAndFiltersByFolder(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	other := idle("b")
	other.Cwd = "/elsewhere"
	f.sessions.add(other)
	gone := idle("c")
	gone.ArchivedAt = time.Now()
	f.sessions.add(gone)
	f.sessions.pending = []domain.Request{{ID: "r1", SessionID: "a", Kind: domain.RequestQuestion}}

	out := f.mustCall(t, "list_sessions", map[string]any{"folder": "/repo"})
	list := out["sessions"].([]any)
	if len(list) != 1 {
		t.Fatalf("sessions = %v", list)
	}
	got := list[0].(map[string]any)
	if got["id"] != "a" || got["title"] != "Fix it" || got["pending_requests"] != float64(1) {
		t.Fatalf("session = %v", got)
	}
	out = f.mustCall(t, "list_sessions", map[string]any{"include_archived": true})
	if n := len(out["sessions"].([]any)); n != 3 {
		t.Fatalf("with archived = %d", n)
	}
}

func TestStartSessionConfiguresAndSendsTheFirstMessage(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	out := f.mustCall(t, "start_session", map[string]any{
		"agent": "claude", "cwd": "/repo", "model": "opus", "effort": "high",
		"permission_mode": "plan", "message": "go",
	})
	s := out["session"].(map[string]any)
	if s["id"] != "new1" || s["model"] != "opus" || s["permission_mode"] != "plan" {
		t.Fatalf("session = %v", s)
	}
	if out["since_seq"].(float64) < 1 {
		t.Fatalf("since_seq = %v", out["since_seq"])
	}
	want := []string{
		"create claude /repo origin=mcp",
		"model new1 opus high origin=mcp",
		"mode new1 plan origin=mcp",
		"steer new1 go origin=mcp",
	}
	if got := f.sessions.recorded(); !slices.Equal(got, want) {
		t.Fatalf("calls = %q", got)
	}
}

func TestStartSessionInAWorktree(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	out := f.mustCall(t, "start_session", map[string]any{"agent": "codex", "cwd": "/repo", "branch": "feat/x"})
	s := out["session"].(map[string]any)
	if s["branch"] != "feat/x" || s["cwd"] != "/repo/.wt/feat/x" {
		t.Fatalf("session = %v", s)
	}
	if _, sent := out["since_seq"]; sent {
		t.Fatal("no message, no since_seq")
	}
}

func TestSendMessageReturnsWhereToWaitFrom(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	f.hub.Publish(domain.Event{SessionID: "a", Type: domain.EventTurnEnded, Result: &domain.TurnResult{}})

	out := f.mustCall(t, "send_message", map[string]any{"session_id": "a", "text": "hello"})
	// Seq 1 is the old turn's end, 2 the new turn, 3 the message.
	if out["since_seq"] != float64(3) {
		t.Fatalf("out = %v", out)
	}
	if got := f.sessions.recorded(); !slices.Equal(got, []string{"steer a hello origin=mcp"}) {
		t.Fatalf("calls = %q", got)
	}
}

func TestSendMessageToUnknownSessionIsAToolError(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	res, _ := f.call(t, "send_message", map[string]any{"session_id": "nope", "text": "x"})
	if !res.IsError || !strings.Contains(text(res), "session not found") {
		t.Fatalf("res = %+v %s", res, text(res))
	}
}

func TestWaitReturnsTheFinishedTurn(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	since := f.mustCall(t, "send_message", map[string]any{"session_id": "a", "text": "hello"})["since_seq"]

	go func() {
		time.Sleep(30 * time.Millisecond)
		exit := 0
		f.publishItem("a", domain.Item{ID: "c1", Kind: domain.ItemCommand, Status: domain.ItemCompleted, Name: "Bash", Input: json.RawMessage(`{"command":"go test ./..."}`), ExitCode: &exit})
		f.publishItem("a", domain.Item{ID: "m1", Kind: domain.ItemAssistantMessage, Status: domain.ItemCompleted, Text: "All green."})
		f.endTurn("a", domain.TurnResult{Text: "All green."})
	}()
	out := f.mustCall(t, "wait", map[string]any{"session_id": "a", "since_seq": since, "timeout_seconds": 5})
	if out["status"] != "idle" || out["final"] != "All green." {
		t.Fatalf("out = %v", out)
	}
	if out["seq"].(float64) <= since.(float64) {
		t.Fatalf("seq did not move: %v", out["seq"])
	}
	activity := out["activity"].([]any)
	if len(activity) != 1 || !strings.Contains(activity[0].(string), "go test ./...") || !strings.Contains(activity[0].(string), "exit 0") {
		t.Fatalf("activity = %v", activity)
	}
}

func TestWaitIgnoresATurnThatEndedBeforeSince(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	running := idle("a")
	running.Status = domain.StatusRunning
	f.sessions.add(running)
	old := f.hub.Publish(domain.Event{SessionID: "a", Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: "old"}})

	out := f.mustCall(t, "wait", map[string]any{"session_id": "a", "since_seq": old.Seq, "timeout_seconds": 1})
	if out["status"] != "running" || out["final"] != nil {
		t.Fatalf("out = %v", out)
	}
}

func TestWaitStopsAtAQuestion(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	f.mustCall(t, "send_message", map[string]any{"session_id": "a", "text": "hello"})

	go func() {
		time.Sleep(30 * time.Millisecond)
		req := domain.Request{ID: "r1", SessionID: "a", Kind: domain.RequestQuestion, Title: "AskUserQuestion", State: domain.RequestPending,
			Payload: json.RawMessage(`{"input":{"questions":[{"question":"Which?","options":[{"label":"A"}]}]}}`)}
		f.sessions.mu.Lock()
		f.sessions.pending = append(f.sessions.pending, req)
		f.sessions.mu.Unlock()
		f.hub.Publish(domain.Event{SessionID: "a", Type: domain.EventRequestOpened, Request: &req})
	}()
	out := f.mustCall(t, "wait", map[string]any{"session_id": "a", "timeout_seconds": 5})
	if out["status"] != "needs_answer" {
		t.Fatalf("out = %v", out)
	}
	reqs := out["requests"].([]any)
	r := reqs[0].(map[string]any)
	if r["id"] != "r1" || r["kind"] != "question" || !strings.Contains(string(mustJSON(r["payload"])), "Which?") {
		t.Fatalf("request = %v", r)
	}
}

func TestWaitSeesAnEndItMissedThroughTheRecheck(t *testing.T) {
	f := newFixture(t, mcpapi.Config{Recheck: 10 * time.Millisecond}, nil)
	running := idle("a")
	running.Status = domain.StatusRunning
	f.sessions.add(running)
	go func() {
		time.Sleep(30 * time.Millisecond)
		// The state flips without an event, as when the hub dropped it.
		f.sessions.setStatus("a", domain.StatusInterrupted)
	}()
	out := f.mustCall(t, "wait", map[string]any{"session_id": "a", "timeout_seconds": 5})
	if out["status"] != "interrupted" {
		t.Fatalf("out = %v", out)
	}
}

func TestWaitIsCappedByMaxWait(t *testing.T) {
	f := newFixture(t, mcpapi.Config{MaxWait: 50 * time.Millisecond}, nil)
	running := idle("a")
	running.Status = domain.StatusRunning
	f.sessions.add(running)
	start := time.Now()
	out := f.mustCall(t, "wait", map[string]any{"session_id": "a", "timeout_seconds": 600})
	if out["status"] != "running" || time.Since(start) > 2*time.Second {
		t.Fatalf("out = %v after %v", out, time.Since(start))
	}
}

func TestWaitReportsProgress(t *testing.T) {
	var mu sync.Mutex
	var messages []string
	f := newFixture(t, mcpapi.Config{}, &sdk.ClientOptions{
		ProgressNotificationHandler: func(_ context.Context, req *sdk.ProgressNotificationClientRequest) {
			mu.Lock()
			messages = append(messages, req.Params.Message)
			mu.Unlock()
		},
	})
	f.sessions.add(idle("a"))
	f.mustCall(t, "send_message", map[string]any{"session_id": "a", "text": "hello"})
	go func() {
		time.Sleep(30 * time.Millisecond)
		f.publishItem("a", domain.Item{ID: "t1", Kind: domain.ItemToolCall, Status: domain.ItemCompleted, Name: "Read", Input: json.RawMessage(`{"file_path":"main.go"}`)})
		time.Sleep(20 * time.Millisecond)
		f.endTurn("a", domain.TurnResult{})
	}()
	params := &sdk.CallToolParams{Name: "wait", Arguments: map[string]any{"session_id": "a", "timeout_seconds": 5}}
	params.SetProgressToken("p1")
	res, err := f.client.CallTool(context.Background(), params)
	if err != nil || res.IsError {
		t.Fatalf("wait: %v %s", err, text(res))
	}
	mu.Lock()
	defer mu.Unlock()
	if len(messages) == 0 || !strings.Contains(messages[0], "Read") || !strings.Contains(messages[0], "main.go") {
		t.Fatalf("progress = %q", messages)
	}
}

func mustJSON(v any) []byte {
	raw, _ := json.Marshal(v)
	return raw
}

func TestReadSessionFoldsTheTranscript(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	f.publishItem("a", domain.Item{ID: "u1", Kind: domain.ItemUserMessage, Status: domain.ItemCompleted, Text: "fix the bug", Origin: domain.OriginMCP})
	f.publishItem("a", domain.Item{ID: "m1", Kind: domain.ItemAssistantMessage, Status: domain.ItemStreaming})
	f.hub.Publish(domain.Event{SessionID: "a", Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "m1", Text: "Look"}})
	f.hub.Publish(domain.Event{SessionID: "a", Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "m1", Text: "ing."}})
	f.publishItem("a", domain.Item{ID: "r1", Kind: domain.ItemReasoning, Status: domain.ItemCompleted, Text: "secret thoughts"})
	f.publishItem("a", domain.Item{ID: "e1", Kind: domain.ItemFileChange, Status: domain.ItemCompleted, Path: "main.go"})
	f.publishItem("a", domain.Item{ID: "d1", Kind: domain.ItemDecision, Status: domain.ItemCompleted, Decision: domain.DecisionDenied, Name: "Bash", Text: "no"})

	res, out := f.call(t, "read_session", map[string]any{"session_id": "a"})
	got := text(res)
	for _, want := range []string{"user (mcp): fix the bug", "assistant: Looking.", "edit main.go", "denied Bash: no"} {
		if !strings.Contains(got, want) {
			t.Fatalf("transcript lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "secret thoughts") {
		t.Fatalf("reasoning leaked:\n%s", got)
	}
	if out["seq"] != float64(7) || out["status"] != "idle" {
		t.Fatalf("out = %v", out)
	}
}

func TestReadSessionKeepsTheTail(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	f.publishItem("a", domain.Item{ID: "u1", Kind: domain.ItemUserMessage, Status: domain.ItemCompleted, Text: strings.Repeat("old ", 500)})
	f.publishItem("a", domain.Item{ID: "m1", Kind: domain.ItemAssistantMessage, Status: domain.ItemCompleted, Text: "the end"})

	res, _ := f.call(t, "read_session", map[string]any{"session_id": "a", "max_chars": 200})
	got := text(res)
	if !strings.HasSuffix(strings.TrimSpace(got), "the end") || !strings.Contains(got, "cut") || len(got) > 400 {
		t.Fatalf("transcript:\n%s", got)
	}
}

func TestAnswerRequest(t *testing.T) {
	permission := domain.Request{ID: "p1", SessionID: "a", Kind: domain.RequestPermission, State: domain.RequestPending}
	question := domain.Request{ID: "q1", SessionID: "a", Kind: domain.RequestQuestion, State: domain.RequestPending}
	elicitation := domain.Request{ID: "e1", SessionID: "a", Kind: domain.RequestElicitation, State: domain.RequestPending}
	cases := []struct {
		name    string
		allowed bool
		args    map[string]any
		err     string
		answer  app.RequestAnswer
	}{
		{"permission grant is refused by default", false, map[string]any{"request_id": "p1", "allow": true}, "mcp-allow-approvals", app.RequestAnswer{}},
		{"permission denial is fine", false, map[string]any{"request_id": "p1", "allow": false, "message": "no"}, "", app.RequestAnswer{Message: "no"}},
		{"permission grant when allowed", true, map[string]any{"request_id": "p1", "allow": true, "allow_for_session": true}, "", app.RequestAnswer{Allow: true, AllowForSession: true}},
		{"question answers", false, map[string]any{"request_id": "q1", "allow": true, "answers": map[string]any{"Which?": []string{"A"}}}, "", app.RequestAnswer{Allow: true, Answers: map[string][]string{"Which?": {"A"}}}},
		{"unknown request", false, map[string]any{"request_id": "zz", "allow": false}, "request not found", app.RequestAnswer{}},
		// Codex asks to approve an MCP tool call as an elicitation.
		{"elicitation accept is refused by default", false, map[string]any{"request_id": "e1", "allow": true}, "mcp-allow-approvals", app.RequestAnswer{}},
		{"elicitation decline is fine", false, map[string]any{"request_id": "e1", "allow": false}, "", app.RequestAnswer{}},
		{"elicitation accept when allowed", true, map[string]any{"request_id": "e1", "allow": true}, "", app.RequestAnswer{Allow: true}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t, mcpapi.Config{AllowApprovals: c.allowed}, nil)
			f.sessions.add(idle("a"))
			f.sessions.pending = []domain.Request{permission, question, elicitation}
			c.args["session_id"] = "a"
			res, _ := f.call(t, "answer_request", c.args)
			if c.err != "" {
				if !res.IsError || !strings.Contains(text(res), c.err) {
					t.Fatalf("res = %s", text(res))
				}
				if len(f.sessions.answers) != 0 {
					t.Fatal("answered anyway")
				}
				return
			}
			if res.IsError {
				t.Fatal(text(res))
			}
			calls := f.sessions.recorded()
			if len(f.sessions.answers) != 1 || !strings.HasSuffix(calls[len(calls)-1], "origin=mcp") {
				t.Fatalf("answers %+v calls %q", f.sessions.answers, calls)
			}
			got, _ := json.Marshal(f.sessions.answers[0])
			want, _ := json.Marshal(c.answer)
			if string(got) != string(want) {
				t.Fatalf("answer = %s, want %s", got, want)
			}
		})
	}
}

func TestInterrupt(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	f.mustCall(t, "interrupt", map[string]any{"session_id": "a"})
	if got := f.sessions.recorded(); !slices.Equal(got, []string{"interrupt a origin=mcp"}) {
		t.Fatalf("calls = %q", got)
	}
}

func TestGetDiff(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	f.wt.changes = app.Changes{Repository: true, Base: "main", Files: []app.FileChange{{Path: "a.go", Status: "M", Added: 1}, {Path: "b.go", Status: "A", Added: 2}}}
	f.wt.diffs["a.go"] = "--- a/a.go\n+++ b/a.go\n+x\n"
	f.wt.diffs["b.go"] = "+++ b/b.go\n+y\n+z\n"

	res, out := f.call(t, "get_diff", map[string]any{"session_id": "a"})
	if res.IsError || len(out["files"].([]any)) != 2 || !strings.Contains(text(res), "+x") || !strings.Contains(text(res), "+z") {
		t.Fatalf("diff = %v\n%s", out, text(res))
	}
	res, _ = f.call(t, "get_diff", map[string]any{"session_id": "a", "path": "b.go"})
	if got := text(res); strings.Contains(got, "+x") || !strings.Contains(got, "+z") {
		t.Fatalf("one file:\n%s", got)
	}
}

func readResource(t *testing.T, f *fixture, uri string) string {
	t.Helper()
	res, err := f.client.ReadResource(context.Background(), &sdk.ReadResourceParams{URI: uri})
	if err != nil {
		t.Fatalf("read %s: %v", uri, err)
	}
	return res.Contents[0].Text
}

func TestResources(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	f.publishItem("a", domain.Item{ID: "m1", Kind: domain.ItemAssistantMessage, Status: domain.ItemCompleted, Text: "Done here."})
	f.wt.changes = app.Changes{Repository: true, Files: []app.FileChange{{Path: "a.go"}}}
	f.wt.diffs["a.go"] = "+x\n"

	if got := readResource(t, f, "chamber://sessions"); !strings.Contains(got, `"id":"a"`) {
		t.Fatalf("list = %s", got)
	}
	if got := readResource(t, f, "chamber://sessions/a"); !strings.Contains(got, "assistant: Done here.") {
		t.Fatalf("transcript = %s", got)
	}
	if got := readResource(t, f, "chamber://sessions/a/diff"); !strings.Contains(got, "+x") {
		t.Fatalf("diff = %s", got)
	}
	if _, err := f.client.ReadResource(context.Background(), &sdk.ReadResourceParams{URI: "chamber://sessions/nope"}); err == nil {
		t.Fatal("unknown session read")
	}
}

func TestSubscribedResourceIsToldOfChanges(t *testing.T) {
	updated := make(chan string, 16)
	f := newFixture(t, mcpapi.Config{}, &sdk.ClientOptions{
		ResourceUpdatedHandler: func(_ context.Context, req *sdk.ResourceUpdatedNotificationRequest) {
			updated <- req.Params.URI
		},
	})
	f.sessions.add(idle("a"))
	if err := f.client.Subscribe(context.Background(), &sdk.SubscribeParams{URI: "chamber://sessions/a"}); err != nil {
		t.Fatal(err)
	}
	// A streaming fragment is not news; a finished item is.
	f.hub.Publish(domain.Event{SessionID: "a", Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "m1", Text: "x"}})
	f.publishItem("a", domain.Item{ID: "m1", Kind: domain.ItemAssistantMessage, Status: domain.ItemCompleted, Text: "x"})
	select {
	case uri := <-updated:
		if uri != "chamber://sessions/a" {
			t.Fatalf("uri = %s", uri)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no update")
	}
}

func TestCloseEndsABlockedWait(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	running := idle("a")
	running.Status = domain.StatusRunning
	f.sessions.add(running)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = f.client.CallTool(context.Background(), &sdk.CallToolParams{Name: "wait", Arguments: map[string]any{"session_id": "a", "timeout_seconds": 600}})
	}()
	time.Sleep(50 * time.Millisecond)
	f.server.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("wait outlived Close")
	}
}

func TestStartSessionRefusesUnboundedModesByDefault(t *testing.T) {
	for _, c := range []struct{ agent, mode string }{{"claude", "bypassPermissions"}, {"codex", "full-access"}} {
		t.Run(c.mode, func(t *testing.T) {
			f := newFixture(t, mcpapi.Config{}, nil)
			res, _ := f.call(t, "start_session", map[string]any{"agent": c.agent, "cwd": "/repo", "permission_mode": c.mode})
			if !res.IsError || !strings.Contains(text(res), "mcp-allow-approvals") {
				t.Fatalf("res = %s", text(res))
			}
			if got := f.sessions.recorded(); len(got) != 0 {
				t.Fatalf("acted anyway: %q", got)
			}
		})
	}
	for _, c := range []struct{ agent, mode string }{{"claude", "acceptEdits"}, {"claude", "plan"}, {"codex", "auto"}, {"codex", "read-only"}} {
		f := newFixture(t, mcpapi.Config{}, nil)
		f.mustCall(t, "start_session", map[string]any{"agent": c.agent, "cwd": "/repo", "permission_mode": c.mode})
	}
	f := newFixture(t, mcpapi.Config{AllowApprovals: true}, nil)
	f.mustCall(t, "start_session", map[string]any{"agent": "claude", "cwd": "/repo", "permission_mode": "bypassPermissions"})
}

func TestStartSessionRefusesAModeTheAgentLacksBeforeCreating(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	res, _ := f.call(t, "start_session", map[string]any{"agent": "opencode", "cwd": "/repo", "permission_mode": "plan", "branch": "x"})
	if !res.IsError || len(f.sessions.recorded()) != 0 {
		t.Fatalf("res = %s, calls %q", text(res), f.sessions.recorded())
	}
}

func TestSendMessageRefusesAnUnboundedSessionByDefault(t *testing.T) {
	open := idle("a")
	open.PermissionMode = "bypassPermissions"
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(open)
	res, _ := f.call(t, "send_message", map[string]any{"session_id": "a", "text": "rm -rf"})
	if !res.IsError || !strings.Contains(text(res), "mcp-allow-approvals") || len(f.sessions.recorded()) != 0 {
		t.Fatalf("res = %s, calls %q", text(res), f.sessions.recorded())
	}
	f = newFixture(t, mcpapi.Config{AllowApprovals: true}, nil)
	f.sessions.add(open)
	f.mustCall(t, "send_message", map[string]any{"session_id": "a", "text": "go"})
}

func TestWaitBlocksOnARequestItAlreadyReported(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	running := idle("a")
	running.Status = domain.StatusRunning
	f.sessions.add(running)
	req := domain.Request{ID: "p1", SessionID: "a", Kind: domain.RequestPermission, State: domain.RequestPending}
	f.sessions.pending = []domain.Request{req}
	f.hub.Publish(domain.Event{SessionID: "a", Type: domain.EventRequestOpened, Request: &req})

	first := f.mustCall(t, "wait", map[string]any{"session_id": "a", "timeout_seconds": 5})
	if first["status"] != "needs_answer" {
		t.Fatalf("first = %v", first)
	}
	// The owner answers a while later; the client waits for that, not spins.
	go func() {
		time.Sleep(150 * time.Millisecond)
		f.sessions.mu.Lock()
		f.sessions.pending = nil
		f.sessions.mu.Unlock()
		f.hub.Publish(domain.Event{SessionID: "a", Type: domain.EventRequestResolved, Request: &req})
		f.endTurn("a", domain.TurnResult{Text: "done"})
	}()
	start := time.Now()
	out := f.mustCall(t, "wait", map[string]any{"session_id": "a", "since_seq": first["seq"], "timeout_seconds": 5})
	if out["status"] != "idle" || time.Since(start) < 100*time.Millisecond {
		t.Fatalf("out = %v after %v", out, time.Since(start))
	}
}

func TestWaitStillNamesAnOpenRequestAtTheTimeout(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	running := idle("a")
	running.Status = domain.StatusRunning
	f.sessions.add(running)
	req := domain.Request{ID: "p1", SessionID: "a", Kind: domain.RequestPermission, State: domain.RequestPending}
	f.sessions.pending = []domain.Request{req}
	opened := f.hub.Publish(domain.Event{SessionID: "a", Type: domain.EventRequestOpened, Request: &req})

	start := time.Now()
	out := f.mustCall(t, "wait", map[string]any{"session_id": "a", "since_seq": opened.Seq, "timeout_seconds": 1})
	if out["status"] != "needs_answer" || time.Since(start) < 900*time.Millisecond {
		t.Fatalf("out = %v after %v", out, time.Since(start))
	}
}

func TestDiffIsCapped(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	f.wt.changes = app.Changes{Repository: true, Files: []app.FileChange{{Path: "lock.json"}}}
	f.wt.diffs["lock.json"] = strings.Repeat("+line\n", 50_000)
	res, _ := f.call(t, "get_diff", map[string]any{"session_id": "a"})
	if got := text(res); len(got) > 110_000 || !strings.Contains(got, "cut") {
		t.Fatalf("diff of %d bytes", len(got))
	}
	if got := readResource(t, f, "chamber://sessions/a/diff"); len(got) > 110_000 {
		t.Fatalf("resource of %d bytes", len(got))
	}
}

func TestSubscribeOnlyToResourcesThatGetUpdates(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	for _, uri := range []string{"chamber://sessions", "chamber://sessions/a", "chamber://sessions/a/diff"} {
		if err := f.client.Subscribe(context.Background(), &sdk.SubscribeParams{URI: uri}); err != nil {
			t.Errorf("%s: %v", uri, err)
		}
	}
	// The SDK client drops a refused subscriptions/listen, so the session
	// protocol shows the refusals.
	legacy, err := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "1"}, nil).
		Connect(context.Background(), &sdk.StreamableClientTransport{Endpoint: f.url}, &sdk.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = legacy.Close() })
	for _, uri := range []string{"chamber://sessions/", "chamber://sessions/nope", "chamber://sessions/a/x", "chamber://other"} {
		if err := legacy.Subscribe(context.Background(), &sdk.SubscribeParams{URI: uri}); err == nil {
			t.Errorf("%s: subscribed", uri)
		}
	}
}

func TestReadSessionTakesANonPositiveLimitAsTheDefault(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	f.publishItem("a", domain.Item{ID: "m1", Kind: domain.ItemAssistantMessage, Status: domain.ItemCompleted, Text: "hello there"})
	res, _ := f.call(t, "read_session", map[string]any{"session_id": "a", "max_chars": -5})
	if res.IsError || !strings.Contains(text(res), "hello there") {
		t.Fatalf("res = %s", text(res))
	}
}

func TestSendMessageSurvivesADroppedMessageEvent(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	f.sessions.noise, f.sessions.reply = 400, "quick answer"

	since := f.mustCall(t, "send_message", map[string]any{"session_id": "a", "text": "hi"})["since_seq"]
	out := f.mustCall(t, "wait", map[string]any{"session_id": "a", "since_seq": since, "timeout_seconds": 2})
	if out["status"] != "idle" || out["final"] != "quick answer" {
		t.Fatalf("since %v, out = %v", since, out)
	}
}

func TestReadSessionSkipsFragmentsOfItemsItHasNotSeen(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	f.sessions.add(idle("a"))
	start := f.publishItem("a", domain.Item{ID: "c1", Kind: domain.ItemCommand, Status: domain.ItemStreaming, Name: "Bash"})
	f.hub.Publish(domain.Event{SessionID: "a", Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "c1", Text: "build output"}})

	res, _ := f.call(t, "read_session", map[string]any{"session_id": "a", "since_seq": start.Seq})
	if strings.Contains(text(res), "assistant") {
		t.Fatalf("command output read as the assistant:\n%s", text(res))
	}
}

func TestMCPWorksBehindALocalReverseProxy(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	srv := httptest.NewServer(f.server.Handler())
	t.Cleanup(srv.Close)
	body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`
	req, _ := http.NewRequest("POST", srv.URL, strings.NewReader(body))
	req.Host = "box.tailnet.ts.net"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("code = %d", resp.StatusCode)
	}
}
