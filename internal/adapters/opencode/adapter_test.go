package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

var fakeBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "fakeopencode")
	if err != nil {
		panic(err)
	}
	fakeBin = filepath.Join(dir, "opencode")
	if out, err := exec.Command("go", "build", "-o", fakeBin, "../../../testutil/fakeopencode").CombinedOutput(); err != nil {
		panic(string(out) + err.Error())
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func factory(t *testing.T, mode string) *Factory {
	t.Helper()
	f := &Factory{Binary: fakeBin, Env: []string{"FAKEOPENCODE_MODE=" + mode, "FAKEOPENCODE_DATA=" + t.TempDir()}, InitTimeout: 5 * time.Second}
	t.Cleanup(func() { _ = f.Close() })
	return f
}
func start(t *testing.T, f *Factory, id, cwd string) *Runtime {
	t.Helper()
	rt, err := f.Start(context.Background(), app.StartRequest{SessionID: domain.SessionID(id), Agent: domain.AgentOpenCode, Cwd: cwd})
	if err != nil {
		t.Fatal(err)
	}
	return rt.(*Runtime)
}
func collect(t *testing.T, rt app.AgentRuntime, typ domain.EventType) []domain.Event {
	t.Helper()
	var out []domain.Event
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case e, ok := <-rt.Events():
			if !ok {
				t.Fatal("runtime closed before ", typ)
			}
			if err := e.Valid(); err != nil {
				t.Fatal(err)
			}
			out = append(out, e)
			if e.Type == typ {
				return out
			}
		case <-timer.C:
			t.Fatalf("timeout waiting for %s: %+v", typ, out)
		}
	}
}
func send(t *testing.T, rt app.AgentRuntime, text string) {
	t.Helper()
	if err := rt.Send(context.Background(), "turn", text); err != nil {
		t.Fatal(err)
	}
}

func TestEchoStreamingAndUsage(t *testing.T) {
	f := factory(t, "")
	rt := start(t, f, "s", t.TempDir())
	send(t, rt, "hello")
	events := collect(t, rt, domain.EventTurnEnded)
	var streamed string
	var users int
	var usage *domain.Usage
	for _, e := range events {
		if e.Delta != nil {
			streamed += e.Delta.Text
		}
		if e.Item != nil && e.Item.Kind == domain.ItemUserMessage {
			users++
		}
		if e.Usage != nil {
			usage = e.Usage
		}
	}
	if streamed != "echo: hello" || users != 0 || usage == nil || usage.CostUSD != 0.01 {
		t.Fatalf("text=%q users=%d usage=%+v", streamed, users, usage)
	}
	if events[len(events)-1].Result.Text != "echo: hello" {
		t.Fatal("missing turn result")
	}
}
func TestModelCatalogIsScopedAndSplitsOnlyFirstSlash(t *testing.T) {
	f := factory(t, "")
	models, err := f.ModelsInFolder(context.Background(), domain.AgentOpenCode, "/project/one")
	if err != nil || len(models) != 1 || models[0].ID != "openrouter/vendor/model" || models[0].Provider != "OpenRouter" || len(models[0].Efforts) != 2 || models[0].Images == nil || !*models[0].Images {
		t.Fatalf("models=%+v err=%v", models, err)
	}
	rt := start(t, f, "s", t.TempDir())
	if err := rt.SetModel(context.Background(), models[0].ID, "high"); err != nil {
		t.Fatal(err)
	}
	send(t, rt, "model")
	events := collect(t, rt, domain.EventTurnEnded)
	if !strings.Contains(events[len(events)-1].Result.Text, "openrouter/vendor/model high") {
		t.Fatal(events[len(events)-1].Result)
	}
	if err := rt.SetModel(context.Background(), "broken", ""); err == nil {
		t.Fatal("invalid qualified model accepted")
	}
	cmds, err := f.Commands(context.Background(), domain.AgentOpenCode, "/project/two")
	if err != nil || len(cmds) != 1 || cmds[0].Insert != "/echo" {
		t.Fatalf("commands=%+v %v", cmds, err)
	}
	info, err := f.Account(context.Background(), domain.AgentOpenCode)
	if err != nil || !info.LoggedIn || len(info.Providers) != 1 {
		t.Fatalf("account=%+v %v", info, err)
	}
}
func TestPermissionsAndQuestions(t *testing.T) {
	for _, mode := range []string{"permission", "question", "v2-permission", "v2-question"} {
		for _, allow := range []bool{false, true} {
			t.Run(mode+map[bool]string{false: "deny", true: "allow"}[allow], func(t *testing.T) {
				f := factory(t, mode)
				rt := start(t, f, "s", t.TempDir())
				send(t, rt, "hi")
				events := collect(t, rt, domain.EventRequestOpened)
				req := events[len(events)-1].Request
				answer := app.RequestAnswer{Allow: allow, AllowForSession: allow, Message: "no", Answers: map[string][]string{"Pick?": {"Alpha", "Beta"}}}
				if err := rt.Respond(context.Background(), req.ID, answer); err != nil {
					t.Fatal(err)
				}
				done := collect(t, rt, domain.EventTurnEnded)
				if !strings.Contains(done[len(done)-1].Result.Text, map[bool]string{true: "approved", false: "denied"}[allow]) {
					t.Fatal(done[len(done)-1].Result)
				}
				if err := rt.Respond(context.Background(), "missing", answer); err == nil {
					t.Fatal("unknown request accepted")
				}
			})
		}
	}
}
func TestResumeForkAndMultipleDirectories(t *testing.T) {
	f := factory(t, "")
	a := start(t, f, "a", t.TempDir())
	b := start(t, f, "b", t.TempDir())
	send(t, a, "one")
	send(t, b, "two")
	collect(t, a, domain.EventTurnEnded)
	collect(t, b, domain.EventTurnEnded)
	native, cwd := a.NativeID(), a.cwd
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	r, err := f.Start(context.Background(), app.StartRequest{SessionID: "a", Agent: domain.AgentOpenCode, Cwd: cwd, NativeID: native})
	if err != nil || r.NativeID() != native {
		t.Fatalf("resume=%v %v", r, err)
	}
	send(t, r, "again")
	collect(t, r, domain.EventTurnEnded)
	branch, err := f.Start(context.Background(), app.StartRequest{SessionID: "fork", Agent: domain.AgentOpenCode, Cwd: cwd, NativeID: native, Fork: true})
	if err != nil || branch.NativeID() == native {
		t.Fatalf("fork=%v %v", branch, err)
	}
	send(t, branch, "branched")
	collect(t, branch, domain.EventTurnEnded)
}
func TestSteerAbortToolsImagesAndChildren(t *testing.T) {
	f := factory(t, "slow")
	rt := start(t, f, "s", t.TempDir())
	send(t, rt, "wait")
	collect(t, rt, domain.EventTextDelta)
	if err := rt.Steer(context.Background(), "extra"); err != nil {
		t.Fatal(err)
	}
	done := collect(t, rt, domain.EventTurnEnded)
	if !strings.Contains(done[len(done)-1].Result.Text, "extra") {
		t.Fatal("steer not delivered")
	}
	send(t, rt, "wait")
	collect(t, rt, domain.EventTextDelta)
	if err := rt.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	collect(t, rt, domain.EventTurnEnded)
	tools := start(t, f, "tools", t.TempDir())
	send(t, tools, "tools")
	out := collect(t, tools, domain.EventTurnEnded)
	kinds := map[domain.ItemKind]bool{}
	for _, e := range out {
		if e.Item != nil {
			kinds[e.Item.Kind] = true
		}
	}
	if !kinds[domain.ItemCommand] || !kinds[domain.ItemFileChange] || !kinds[domain.ItemReasoning] {
		t.Fatal(kinds)
	}
	send(t, tools, "child")
	spawn := collect(t, tools, domain.EventSubagentSpawned)
	id := spawn[len(spawn)-1].Subagent.ThreadID
	child, err := f.Start(context.Background(), app.StartRequest{SessionID: "child", Cwd: tools.cwd, Agent: domain.AgentOpenCode, NativeID: id, Passive: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := tools.StopTask(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	collect(t, child, domain.EventTurnEnded)
	collect(t, tools, domain.EventTurnEnded)
	if err := tools.StopTask(context.Background(), rt.NativeID()); err == nil {
		t.Fatal("stopped unrelated session")
	}
	if err := tools.SendImages(context.Background(), "img", "image", []app.Image{{Path: "/tmp/test.png", MimeType: "image/png"}}); err != nil {
		t.Fatal(err)
	}
	collect(t, tools, domain.EventTurnEnded)
}
func TestReconnectAndProcessExit(t *testing.T) {
	f := factory(t, "disconnect")
	rt := start(t, f, "s", t.TempDir())
	send(t, rt, "hello")
	out := collect(t, rt, domain.EventTurnEnded)
	text := ""
	for _, e := range out {
		if e.Delta != nil {
			text += e.Delta.Text
		}
	}
	if text != "echo: hello" {
		t.Fatal(text)
	}
	crash := factory(t, "crash")
	c := start(t, crash, "crash", t.TempDir())
	send(t, c, "crash")
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case _, ok := <-c.Events():
			if !ok {
				return
			}
		case <-timer.C:
			t.Fatal("events not closed after process crash")
		}
	}
}
func TestStartupAndHTTPFailures(t *testing.T) {
	f := &Factory{Binary: "/not-installed"}
	if _, err := f.Start(context.Background(), app.StartRequest{Cwd: t.TempDir()}); err == nil {
		t.Fatal("missing binary accepted")
	}
	_ = f.Close()
	bad := factory(t, "http-error")
	if _, err := bad.Start(context.Background(), app.StartRequest{Cwd: t.TempDir()}); err == nil {
		t.Fatal("HTTP failure accepted")
	}
	closed := factory(t, "")
	_ = closed.Close()
	if _, err := closed.Models(context.Background(), domain.AgentOpenCode); err == nil {
		t.Fatal("closed factory started")
	}
}

func TestMapperRejectsMalformedAndDeduplicatesSnapshot(t *testing.T) {
	m := newMapper("s", false)
	m.turn = "t"
	if out := m.mapEvent(event{Type: "unknown", Properties: json.RawMessage(`{}`)}); len(out) != 0 {
		t.Fatal(out)
	}
	p := part{ID: "part", SessionID: "native", MessageID: "msg", Type: "text", Text: "abc"}
	m.messages["msg"] = "assistant"
	out := m.part(p)
	if len(out) == 0 {
		t.Fatal("no item")
	}
	if out := m.part(p); len(out) != 0 {
		t.Fatal("duplicate snapshot")
	}
}

func TestMapperOutOfOrderErrorsAndRequests(t *testing.T) {
	m := newMapper("s", false)
	m.begin("t")
	p := part{ID: "p", MessageID: "msg", Type: "text", Text: "answer"}
	if len(m.part(p)) != 0 {
		t.Fatal("guessed role")
	}
	if len(m.message(message{ID: "msg", Role: "assistant"})) == 0 {
		t.Fatal("lost buffered part")
	}
	out := m.mapEvent(event{Type: "session.error", Properties: json.RawMessage(`{"error":{"name":"APIError","data":{"message":"provider failed"}}}`)})
	if len(out) != 1 || out[0].Item.Text != "provider failed" {
		t.Fatal(out)
	}
	if len(m.fail("provider failed")) != 0 {
		t.Fatal("duplicate error")
	}
	out = m.status(status{Type: "idle"})
	if !out[len(out)-1].Result.IsError {
		t.Fatal("error not in result")
	}
	for _, raw := range []string{`invalid`, `{"message":"plain"}`, `{"name":"Error"}`} {
		if errorText(json.RawMessage(raw)) == "" {
			t.Fatal(raw)
		}
	}
	m.begin("t2")
	q := request{ID: "q", Questions: []question{{Question: "One?"}, {Question: "Two?", Multiple: true}}}
	if len(m.openRequest(q)) != 1 {
		t.Fatal("question")
	}
	if len(m.resolveRequest("q", domain.RequestStale)) != 1 {
		t.Fatal("stale")
	}
	if len(m.resolveRequest("q", domain.RequestStale)) != 0 {
		t.Fatal("duplicate resolve")
	}
	m.mapEvent(event{ID: "evt_same", Type: "unknown"})
	if len(m.mapEvent(event{ID: "evt_same", Type: "session.error", Properties: json.RawMessage(`{"error":{"message":"duplicate"}}`)})) != 0 {
		t.Fatal("duplicate event id")
	}
}
func TestCatalogDisconnectedAndImageUnsupported(t *testing.T) {
	f := factory(t, "no-provider")
	models, err := f.Models(context.Background(), domain.AgentOpenCode)
	if err != nil || len(models) != 0 {
		t.Fatal(models, err)
	}
	info, err := f.Account(context.Background(), domain.AgentOpenCode)
	if err != nil || info.LoggedIn {
		t.Fatal(info, err)
	}
	if _, err = f.StartLogin(context.Background(), domain.AgentOpenCode); !errors.Is(err, app.ErrAccountsUnsupported) {
		t.Fatal(err)
	}
	noImages := factory(t, "no-images")
	rt := start(t, noImages, "image", t.TempDir())
	if err := rt.SendImages(context.Background(), "t", "x", []app.Image{{Path: "/x.png"}}); !errors.Is(err, app.ErrImagesUnsupported) {
		t.Fatal(err)
	}
	_ = rt.SetModel(context.Background(), "openrouter/vendor/model", "high")
	send(t, rt, "/echo hello")
	out := collect(t, rt, domain.EventTurnEnded)
	if !strings.Contains(out[len(out)-1].Result.Text, "command: echo hello") {
		t.Fatal(out)
	}
	send(t, rt, "/unknown text")
	collect(t, rt, domain.EventTurnEnded)
	_ = rt.Close()
	if err := rt.Send(context.Background(), "t", "closed"); err == nil {
		t.Fatal("closed runtime accepted send")
	}
}

func TestV2RequestNormalization(t *testing.T) {
	m := newMapper("s", false)
	out := m.mapEvent(event{Type: "permission.v2.asked", Properties: json.RawMessage(`{"id":"per_1","sessionID":"ses_1","action":"bash","resources":["echo hi"],"save":["*"],"metadata":{"command":"echo hi"}}`)})
	if len(out) != 1 || out[0].Request.Title != "bash" || out[0].Request.Prompt != "echo hi" {
		t.Fatalf("v2: %+v", out)
	}
	if !m.requests["per_1"].V2 {
		t.Fatal("v2 reply route lost")
	}
}

func TestRealTranscriptGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/transcript-1.18.34.json")
	if err != nil {
		t.Fatal(err)
	}
	var msgs []transcript
	if err = json.Unmarshal(raw, &msgs); err != nil {
		t.Fatal(err)
	}
	m := newMapper("s", true)
	m.begin("replay")
	var out []domain.Event
	for _, msg := range msgs {
		out = append(out, m.message(msg.Info)...)
		for _, p := range msg.Parts {
			out = append(out, m.part(p)...)
		}
	}
	out = append(out, m.status(status{Type: "idle"})...)
	kinds := map[domain.ItemKind]int{}
	for _, ev := range domain.DetachItems(out) {
		if err := ev.Valid(); err != nil {
			t.Fatal(err)
		}
		if ev.Item != nil {
			kinds[ev.Item.Kind]++
		}
	}
	if kinds[domain.ItemUserMessage] == 0 || kinds[domain.ItemFileChange] == 0 || kinds[domain.ItemToolCall] == 0 {
		t.Fatal(kinds)
	}
	foundDiff := false
	for _, it := range m.items {
		if it.Kind == domain.ItemFileChange && strings.Contains(it.Diff, "+after-openrouter") {
			foundDiff = true
		}
	}
	if !foundDiff {
		t.Fatal("real edit diff lost")
	}
	if m.usage.CostUSD <= 0 || m.usage.TotalTokens <= 0 {
		t.Fatal(m.usage)
	}
}

func TestLargeHistoryDoesNotBlockAttach(t *testing.T) {
	f := factory(t, "history")
	ready := make(chan app.AgentRuntime, 1)
	go func() {
		rt, err := f.Start(context.Background(), app.StartRequest{SessionID: "history", Cwd: t.TempDir()})
		if err == nil {
			ready <- rt
		}
	}()
	select {
	case rt := <-ready:
		defer func() { _ = rt.Close() }()
	case <-time.After(2 * time.Second):
		t.Fatal("attach blocked before a consumer can read history")
	}
}

func TestSessionPermissionGrantsDoNotReachSiblingSessions(t *testing.T) {
	f := factory(t, "permission")
	cwd := t.TempDir()
	a := start(t, f, "a", cwd)
	b := start(t, f, "b", cwd)
	send(t, a, "permission")
	opened := collect(t, a, domain.EventRequestOpened)
	id := opened[len(opened)-1].Request.ID
	if err := a.Respond(context.Background(), id, app.RequestAnswer{Allow: true, AllowForSession: true}); err != nil {
		t.Fatal(err)
	}
	collect(t, a, domain.EventTurnEnded)
	send(t, b, "permission")
	collect(t, b, domain.EventRequestOpened)
	send(t, a, "permission")
	events := collect(t, a, domain.EventTurnEnded)
	for _, ev := range events {
		if ev.Type == domain.EventRequestOpened {
			t.Fatal("session grant was not remembered")
		}
	}
}

func TestSessionGrantPatternsAndReattach(t *testing.T) {
	s := &server{}
	s.remember("a", request{ID: "r", Permission: "edit", Always: []string{"src/*.go"}})
	if !s.allowed("a", request{Permission: "edit", Patterns: []string{"src/deep/file.go"}}) {
		t.Fatal("native wildcard")
	}
	for _, p := range []request{{Permission: "bash", Patterns: []string{"src/a.go"}}, {Permission: "edit", Patterns: []string{"src/a.go", "secret.txt"}}, {Permission: "edit"}, {Permission: "edit", Questions: []question{{Question: "Q?"}}, Patterns: []string{"src/a.go"}}} {
		if s.allowed("a", p) {
			t.Fatalf("overbroad grant %+v", p)
		}
	}
	if s.allowed("b", request{Permission: "edit", Patterns: []string{"src/a.go"}}) {
		t.Fatal("grant crossed native IDs")
	}
	s.forget("a", "r")
	if s.allowed("a", request{Permission: "edit", Patterns: []string{"src/a.go"}}) {
		t.Fatal("rollback")
	}
	f := factory(t, "permission")
	cwd := t.TempDir()
	a := start(t, f, "a", cwd)
	send(t, a, "permission")
	ev := collect(t, a, domain.EventRequestOpened)
	if err := a.Respond(context.Background(), ev[len(ev)-1].Request.ID, app.RequestAnswer{Allow: true, AllowForSession: true}); err != nil {
		t.Fatal(err)
	}
	collect(t, a, domain.EventTurnEnded)
	native := a.NativeID()
	_ = a.Close()
	rt, err := f.Start(context.Background(), app.StartRequest{SessionID: "a", Cwd: cwd, NativeID: native})
	if err != nil {
		t.Fatal(err)
	}
	send(t, rt, "permission")
	out := collect(t, rt, domain.EventTurnEnded)
	for _, ev := range out {
		if ev.Type == domain.EventRequestOpened {
			t.Fatal("grant lost on detach")
		}
	}
}

func TestNativeCommandReturnsWhileItsTurnIsRunning(t *testing.T) {
	f := factory(t, "blocked-command")
	rt := start(t, f, "cmd", t.TempDir())
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := rt.Send(ctx, "command", "/echo hello"); err != nil {
		t.Fatal("command submission waited for execution", err)
	}
	out := collect(t, rt, domain.EventTurnEnded)
	if out[len(out)-1].Result.IsError {
		t.Fatal(out[len(out)-1].Result)
	}
}

func TestHistoryRecoveryDoesNotReplayBufferedTextDeltas(t *testing.T) {
	m := newMapper("s", false)
	m.begin("t")
	m.message(message{ID: "msg", Role: "assistant"})
	m.part(part{ID: "p", MessageID: "msg", Type: "text", Text: "a"})
	m.replayPart(part{ID: "p", MessageID: "msg", Type: "text", Text: "abc"})
	if out := m.mapEvent(event{Type: "message.part.delta", Properties: json.RawMessage(`{"partID":"p","messageID":"msg","field":"text","delta":"bc"}`)}); len(out) != 0 {
		t.Fatal("replayed delta already included in history")
	}
	m.mapEvent(event{Type: "message.part.updated", Properties: json.RawMessage(`{"part":{"id":"p","messageID":"msg","type":"text","text":"abcde","time":{"end":2}}}`)})
	if m.items["p"].Text != "abcde" {
		t.Fatal(m.items["p"].Text)
	}
	if out := m.mapEvent(event{Type: "message.part.delta", Properties: json.RawMessage(`{"partID":"p","messageID":"msg","field":"text","delta":"de"}`)}); len(out) != 0 {
		t.Fatal("delta after complete snapshot")
	}
}

func TestReconcileDropsAStatusRemovedWhileFetchingHistory(t *testing.T) {
	count := 0
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/session/status":
			count++
			if count == 1 {
				_, _ = w.Write([]byte(`{"n":{"type":"busy"}}`))
			} else {
				_, _ = w.Write([]byte(`{}`))
			}
		case "/api/permission/request", "/api/question/request":
			_, _ = w.Write([]byte(`{"data":[]}`))
		default:
			_, _ = w.Write([]byte(`[]`))
		}
	}))
	defer httpServer.Close()
	s := &server{base: httpServer.URL, client: httpServer.Client()}
	rt := &Runtime{server: s, native: "n", mapper: newMapper("s", false), events: make(chan domain.Event, 10), done: make(chan struct{})}
	rt.mapper.begin("t")
	defer func() { _ = rt.Close() }()
	if err := rt.reconcile(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	collect(t, rt, domain.EventTurnEnded)
}
