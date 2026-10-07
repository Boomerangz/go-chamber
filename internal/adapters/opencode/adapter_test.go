package opencode

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

var turns int

func send(t *testing.T, rt app.AgentRuntime, text string) {
	t.Helper()
	turns++
	if err := rt.Send(context.Background(), domain.TurnID(fmt.Sprint("turn-", turns)), text); err != nil {
		t.Fatal(err)
	}
}
func result(t *testing.T, rt app.AgentRuntime) *domain.TurnResult {
	t.Helper()
	out := collect(t, rt, domain.EventTurnEnded)
	return out[len(out)-1].Result
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
	if r := events[len(events)-1].Result; r.Text != "echo: hello" || r.CostUSD != 0.01 {
		t.Fatalf("turn result %+v", r)
	}
}
func TestModelCatalogSelectionAndAccount(t *testing.T) {
	f := factory(t, "")
	models, err := f.ModelsInFolder(context.Background(), domain.AgentOpenCode, "/project/one")
	if err != nil || len(models) != 1 || models[0].ID != "openrouter/vendor/model" || models[0].Provider != "openrouter" || !models[0].Default || strings.Join(models[0].Efforts, ",") != "high,low" || models[0].Images == nil || !*models[0].Images {
		t.Fatalf("models=%+v err=%v", models, err)
	}
	rt := start(t, f, "s", t.TempDir())
	if err := rt.SetModel(context.Background(), models[0].ID, "high"); err != nil {
		t.Fatal(err)
	}
	send(t, rt, "model")
	if r := result(t, rt); !strings.Contains(r.Text, "openrouter/vendor/model high") {
		t.Fatal(r)
	}
	if err := rt.SetModel(context.Background(), "", ""); err != nil {
		t.Fatal(err)
	}
	send(t, rt, "model")
	if r := result(t, rt); strings.Contains(r.Text, "high") || !strings.Contains(r.Text, "openrouter/vendor/model") {
		t.Fatal("default model not selected again:", r)
	}
	if err := rt.SetModel(context.Background(), "broken", ""); err == nil {
		t.Fatal("invalid qualified model accepted")
	}
	cmds, err := f.Commands(context.Background(), domain.AgentOpenCode, "/project/two")
	if err != nil || len(cmds) != 1 || cmds[0].Insert != "/echo" {
		t.Fatalf("commands=%+v %v", cmds, err)
	}
	info, err := f.Account(context.Background(), domain.AgentOpenCode)
	if err != nil || !info.LoggedIn || strings.Join(info.Providers, ",") != "openrouter" {
		t.Fatalf("account=%+v %v", info, err)
	}
}
func TestPermissionsAndQuestions(t *testing.T) {
	for _, mode := range []string{"permission", "question"} {
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
				want := map[bool]string{true: "approved", false: "denied"}[allow]
				if mode == "question" && allow {
					want = `approved {"q0":["alpha","beta"]}`
				}
				if !strings.Contains(done[len(done)-1].Result.Text, want) {
					t.Fatal(done[len(done)-1].Result)
				}
				resolved := false
				for _, e := range done {
					resolved = resolved || e.Type == domain.EventRequestResolved
				}
				if !resolved {
					t.Fatal("request left open")
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
	if err != nil || r.NativeID() != native || r.(*Runtime).cwd != cwd {
		t.Fatalf("resume=%v %v", r, err)
	}
	send(t, r, "again")
	collect(t, r, domain.EventTurnEnded)
	branch, err := f.Start(context.Background(), app.StartRequest{SessionID: "fork", Agent: domain.AgentOpenCode, Cwd: cwd, NativeID: native, Fork: true})
	if err != nil || branch.NativeID() == native {
		t.Fatalf("fork=%v %v", branch, err)
	}
	replayed := collect(t, branch, domain.EventItemUpdated)
	if replayed[len(replayed)-1].Item.Kind != domain.ItemUserMessage {
		t.Fatal("fork does not replay the copied user message", replayed)
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
	if r := result(t, rt); !strings.Contains(r.Text, "extra") {
		t.Fatal("steer not delivered")
	}
	send(t, rt, "wait")
	collect(t, rt, domain.EventTextDelta)
	if err := rt.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r := result(t, rt); r.IsError {
		t.Fatal("interrupt reported as error", r)
	}
	tools := start(t, f, "tools", t.TempDir())
	send(t, tools, "tools")
	out := collect(t, tools, domain.EventTurnEnded)
	items := map[domain.ItemKind]*domain.Item{}
	for _, e := range out {
		if e.Item != nil {
			items[e.Item.Kind] = e.Item
		}
	}
	command, change := items[domain.ItemCommand], items[domain.ItemFileChange]
	if command == nil || command.ExitCode == nil || *command.ExitCode != 0 || command.Text != "done" || change == nil || change.Diff != "+hello" || change.Path != "test.txt" || items[domain.ItemReasoning] == nil {
		t.Fatal(items)
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
	_, err := bad.Start(context.Background(), app.StartRequest{Cwd: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "HTTP 500: fake failure") {
		t.Fatal("HTTP failure lost its reason:", err)
	}
	closed := factory(t, "")
	_ = closed.Close()
	if _, err := closed.Models(context.Background(), domain.AgentOpenCode); err == nil {
		t.Fatal("closed factory started")
	}
}

func raw(typ, data string) event { return event{Type: typ, Data: json.RawMessage(data)} }

func TestMapperIgnoresMalformedAndDuplicates(t *testing.T) {
	m := newMapper("s", false)
	m.begin("t")
	for _, e := range []event{raw("unknown", `{}`), raw("session.text.delta", `"not an object"`), raw("session.text.delta", `{"ordinal":0,"delta":"x"}`), raw("session.tool.called", `{"input":{}}`)} {
		if out := m.mapEvent(e); len(out) != 0 {
			t.Fatal(e.Type, out)
		}
	}
	ended := raw("session.text.ended", `{"assistantMessageID":"msg","ordinal":0,"text":"abc"}`)
	if len(m.mapEvent(ended)) == 0 {
		t.Fatal("no item")
	}
	if out := m.mapEvent(ended); len(out) != 0 {
		t.Fatal("duplicate snapshot", out)
	}
	m.mapEvent(event{ID: "evt_same", Type: "unknown"})
	if len(m.mapEvent(event{ID: "evt_same", Type: "session.execution.failed", Data: json.RawMessage(`{"error":{"message":"duplicate"}}`)})) != 0 {
		t.Fatal("duplicate event id")
	}
}
func TestMapperStreamsGapsAndFailures(t *testing.T) {
	m := newMapper("s", false)
	m.begin("t")
	// A delta can arrive before its start after a reconnect.
	m.mapEvent(raw("session.text.delta", `{"assistantMessageID":"msg","ordinal":0,"delta":"he"}`))
	m.mapEvent(raw("session.text.started", `{"assistantMessageID":"msg","ordinal":0}`))
	// The final text fills a gap the stream missed.
	m.mapEvent(raw("session.text.ended", `{"assistantMessageID":"msg","ordinal":0,"text":"hello world"}`))
	if out := m.mapEvent(raw("session.text.delta", `{"assistantMessageID":"msg","ordinal":0,"delta":"!"}`)); len(out) != 0 {
		t.Fatal("delta after the final text", out)
	}
	if it := m.items[blockKey("msg", "text", 0)]; it.Text != "hello world" || it.Status != domain.ItemCompleted {
		t.Fatal(it)
	}
	if out := m.mapEvent(raw("session.step.failed", `{"error":{"type":"aborted","message":"Step interrupted"}}`)); len(out) != 0 {
		t.Fatal("interrupt reported as failure", out)
	}
	out := m.mapEvent(raw("session.execution.failed", `{"error":{"type":"provider.no-route","message":"Model unavailable"}}`))
	if len(out) != 2 || out[0].Item.Text != "Model unavailable" || !out[1].Result.IsError || out[1].Result.Text != "hello world" {
		t.Fatal(out)
	}
	if len(m.fail("Model unavailable")) != 0 {
		t.Fatal("duplicate error")
	}
	if out := m.idle(); len(out) != 0 {
		t.Fatal("ended a turn twice", out)
	}
}
func TestMapperRequests(t *testing.T) {
	m := newMapper("s", false)
	m.begin("t")
	out := m.mapEvent(raw("permission.asked", `{"id":"per_1","sessionID":"ses_1","action":"shell","resources":["echo hi"],"save":["echo *"],"metadata":{"command":"echo hi"}}`))
	if len(out) != 1 || out[0].Request.Title != "shell" || out[0].Request.Prompt != "echo hi" || !strings.Contains(string(out[0].Request.Payload), `"ruleContent":"echo *"`) {
		t.Fatalf("%+v", out)
	}
	form := `{"form":{"id":"frm_1","sessionID":"ses_1","title":"Questions","fields":[{"key":"q0","title":"Color","description":"Which?","type":"string","options":[{"value":"red","label":"Red"}],"custom":true},{"key":"q1","type":"boolean","title":"Sure?"},{"key":"q2","type":"external","url":"https://x"},{"key":"q3","type":"integer","hidden":true}]}}`
	out = m.mapEvent(raw("form.created", form))
	var payload struct {
		Input struct {
			Questions []struct {
				Question string
				Options  []struct{ Label string }
				Custom   *bool
			}
		}
	}
	if len(out) != 1 || out[0].Request.Kind != domain.RequestQuestion || out[0].Request.Title != "Color" || json.Unmarshal(out[0].Request.Payload, &payload) != nil || len(payload.Input.Questions) != 2 || payload.Input.Questions[1].Options[0].Label != "Yes" {
		t.Fatalf("%+v %+v", out, payload)
	}
	if len(m.mapEvent(raw("form.created", form))) != 0 {
		t.Fatal("duplicate request")
	}
	if len(m.mapEvent(raw("form.replied", `{"id":"frm_1"}`))) != 1 || len(m.resolveRequest("frm_1", domain.RequestStale)) != 0 {
		t.Fatal("form not resolved once")
	}
	if len(m.mapEvent(raw("permission.replied", `{"requestID":"per_1"}`))) != 1 {
		t.Fatal("permission not resolved")
	}
}
func TestFormAnswerTypes(t *testing.T) {
	yes := true
	p := request{Form: true, Fields: []field{
		{Key: "s", Type: "string", Description: "Color?", Options: []option{{Value: "red", Label: "Red"}}, Custom: &yes},
		{Key: "m", Type: "multiselect", Title: "Tags", Options: []option{{Value: "a", Label: "A"}}},
		{Key: "b", Type: "boolean", Title: "Sure?"},
		{Key: "n", Type: "number", Title: "How many?"},
		{Key: "bad", Type: "integer", Title: "Count?"},
		{Key: "x", Type: "external", Title: "Open"},
		{Key: "h", Type: "string", Title: "Hidden", Hidden: true},
		{Key: "skip", Type: "string", Title: "Skipped"},
	}}
	got, _ := json.Marshal(formAnswer(p, map[string][]string{"Color?": {"Red"}, "Tags": {"A", "custom"}, "Sure?": {"No"}, "How many?": {"2.5"}, "Count?": {"many"}, "Open": {"x"}, "Hidden": {"x"}}))
	if string(got) != `{"b":false,"m":["a","custom"],"n":2.5,"s":"red"}` {
		t.Fatal(string(got))
	}
}

func readEvents(t *testing.T, name string) []event {
	t.Helper()
	f, err := os.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	var out []event
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 1<<20), 1<<20)
	for scanner.Scan() {
		var e event
		if err := json.Unmarshal(scanner.Bytes(), &e); err != nil {
			t.Fatal(err)
		}
		out = append(out, e)
	}
	return out
}
func readMessages(t *testing.T, name string) []message {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	var out []message
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
func items(t *testing.T, events []domain.Event) map[domain.ItemKind]int {
	t.Helper()
	kinds := map[domain.ItemKind]int{}
	for _, ev := range domain.DetachItems(events) {
		if err := ev.Valid(); err != nil {
			t.Fatal(err)
		}
		if ev.Item != nil {
			kinds[ev.Item.Kind]++
		}
	}
	return kinds
}

// The recorded 2.0.15 stream covers a rejected and an approved permission,
// a question form, a subagent, two interrupts and a provider failure.
func TestRecordedEventsGolden(t *testing.T) {
	const parent = "ses_ee9003cbaffeCJK63IOFz1GurE"
	m := newMapper("s", false)
	var out []domain.Event
	var results []*domain.TurnResult
	for i, e := range readEvents(t, "testdata/events-2.0.15.jsonl") {
		if !strings.Contains(string(e.Data), parent) {
			continue
		}
		if e.Type == "session.execution.started" {
			m.begin(domain.TurnID(e.ID))
		}
		for _, ev := range m.mapEvent(e) {
			out = append(out, ev)
			if ev.Result != nil {
				results = append(results, ev.Result)
			}
		}
		if i == 0 && len(out) != 0 {
			t.Fatal("session.created mapped", out)
		}
	}
	kinds := items(t, out)
	if kinds[domain.ItemCommand] == 0 || kinds[domain.ItemFileChange] == 0 || kinds[domain.ItemSubagent] == 0 || kinds[domain.ItemToolCall] == 0 || kinds[domain.ItemReasoning] == 0 || kinds[domain.ItemAssistantMessage] == 0 {
		t.Fatal(kinds)
	}
	opened, resolved := 0, 0
	for _, ev := range out {
		switch ev.Type {
		case domain.EventRequestOpened:
			opened++
		case domain.EventRequestResolved:
			resolved++
		}
	}
	// The third permission was still open when the review command was interrupted.
	if opened != 4 || resolved != 3 || len(m.requests) != 1 {
		t.Fatalf("opened=%d resolved=%d pending=%v", opened, resolved, m.requests)
	}
	var failed []string
	for _, r := range results {
		if r.IsError {
			failed = append(failed, r.Error)
		}
	}
	if len(results) != 6 || strings.Join(failed, ";") != "Model unavailable: openrouter/no-such-model" || results[1].Text != "Blue" {
		t.Fatalf("results=%d failed=%v", len(results), failed)
	}
	var subagent *domain.Item
	for _, it := range m.items {
		if it.Kind == domain.ItemSubagent {
			subagent = it
		}
	}
	if subagent.AgentID != "ses_ee8fdb3f0ffejAUcSD8lk6F45h" || subagent.Status != domain.ItemCompleted {
		t.Fatal(subagent)
	}
	if m.usage.TotalTokens == 0 {
		t.Fatal("usage lost")
	}
}
func TestRecordedHistoryGolden(t *testing.T) {
	m := newMapper("s", true)
	m.begin("replay")
	var out []domain.Event
	for _, name := range []string{"testdata/messages-edit-2.0.15.json", "testdata/messages-2.0.15.json"} {
		for _, msg := range readMessages(t, name) {
			out = append(out, m.message(msg)...)
		}
	}
	out = append(out, m.idle()...)
	kinds := items(t, out)
	if kinds[domain.ItemUserMessage] == 0 || kinds[domain.ItemFileChange] == 0 || kinds[domain.ItemToolCall] == 0 || kinds[domain.ItemCommand] == 0 || kinds[domain.ItemSubagent] == 0 {
		t.Fatal(kinds)
	}
	var diff, failedShell bool
	for _, it := range m.items {
		diff = diff || it.Kind == domain.ItemFileChange && strings.Contains(it.Diff, "+hello there") && it.Path == "hello.txt"
		failedShell = failedShell || it.Kind == domain.ItemCommand && it.Status == domain.ItemFailed && strings.HasPrefix(it.Text, "Unable to execute command")
		if !it.Status.Terminal() {
			t.Fatal("replayed item left streaming", it)
		}
	}
	if !diff || !failedShell {
		t.Fatalf("diff=%v failedShell=%v", diff, failedShell)
	}
	if m.turnError != "" {
		t.Fatal("interrupt replayed as error:", m.turnError)
	}
}

func TestLargeHistoryIsPagedWithoutBlockingAttach(t *testing.T) {
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
		msgs, err := rt.(*Runtime).server.history(context.Background(), rt.NativeID())
		if err != nil || len(msgs) != 1800 || msgs[1799].ID != "msg_history_1799" {
			t.Fatal(len(msgs), err)
		}
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
	s.remember("a", request{ID: "r", Action: "edit", Save: []string{"src/*.go"}})
	if !s.allowed("a", request{Action: "edit", Resources: []string{"src/deep/file.go"}}) {
		t.Fatal("native wildcard")
	}
	for _, p := range []request{{Action: "shell", Resources: []string{"src/a.go"}}, {Action: "edit", Resources: []string{"src/a.go", "secret.txt"}}, {Action: "edit"}, {Action: "edit", Form: true, Resources: []string{"src/a.go"}}} {
		if s.allowed("a", p) {
			t.Fatalf("overbroad grant %+v", p)
		}
	}
	if s.allowed("b", request{Action: "edit", Resources: []string{"src/a.go"}}) {
		t.Fatal("grant crossed native IDs")
	}
	s.forget("a", "r")
	if s.allowed("a", request{Action: "edit", Resources: []string{"src/a.go"}}) {
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

func TestCatalogDisconnectedImagesAndCommands(t *testing.T) {
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
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := rt.Send(ctx, "t", "/echo hello"); err != nil {
		t.Fatal(err)
	}
	if r := result(t, rt); !strings.Contains(r.Text, "command: echo hello") {
		t.Fatal(r)
	}
	send(t, rt, "/unknown text")
	if r := result(t, rt); r.Text != "echo: /unknown text" {
		t.Fatal(r)
	}
	_ = rt.Close()
	if err := rt.Send(context.Background(), "t", "closed"); err == nil {
		t.Fatal("closed runtime accepted send")
	}
}

func TestReconcileDropsATurnThatEndedWhileFetchingHistory(t *testing.T) {
	count := 0
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/session/active":
			count++
			if count == 1 {
				_, _ = w.Write([]byte(`{"data":{"n":{"type":"running"}}}`))
			} else {
				_, _ = w.Write([]byte(`{"data":{}}`))
			}
		case "/api/session/n":
			_, _ = w.Write([]byte(`{"data":{"id":"n"}}`))
		default:
			_, _ = w.Write([]byte(`{"data":[]}`))
		}
	}))
	defer httpServer.Close()
	s := &server{base: httpServer.URL, client: httpServer.Client()}
	rt := &Runtime{server: s, native: "n", mapper: newMapper("s", false), events: make(chan domain.Event, 10), done: make(chan struct{})}
	defer func() { _ = rt.Close() }()
	if err := rt.reconcile(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	collect(t, rt, domain.EventTurnStarted)
	collect(t, rt, domain.EventTurnEnded)
}
