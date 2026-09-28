package codex

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// newPipeServer is a Server whose app-server side is a test peer.
func newPipeServer(t *testing.T) (*Server, *testPeer) {
	t.Helper()
	s := &Server{
		threads: map[string]*Runtime{},
		pending: map[domain.RequestID]pendingServerRequest{},
		orphans: map[string][]orphan{},
	}
	client, peer := newPair(t, s.handleServerRequest)
	client.nt = s.handleNotification
	s.client = client
	return s, peer
}

func within(t *testing.T, what string, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		fn()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("blocked: %s", what)
	}
}

func TestSlowRuntimeDoesNotBlockDispatch(t *testing.T) {
	s, _ := newPipeServer(t)
	slow := s.newRuntime("slow", NewMapper("a"))
	s.register(slow)
	within(t, "notifications to a runtime nobody reads", func() {
		for i := 0; i < 2000; i++ {
			s.handleNotification("item/agentMessage/delta", json.RawMessage(`{"threadId":"slow","itemId":"i1","delta":"x"}`))
		}
	})
}

func TestAttachReplaysManyOrphansWithoutConsumer(t *testing.T) {
	s, _ := newPipeServer(t)
	for i := 0; i < 400; i++ {
		s.handleNotification("item/agentMessage/delta", json.RawMessage(`{"threadId":"child","itemId":"i1","delta":"x"}`))
	}
	var child *Runtime
	within(t, "attach with more orphans than the channel holds", func() {
		child, _ = s.attachThread("child", "cs")
	})
	n := 0
	timeout := time.After(5 * time.Second)
	for n < 400 {
		select {
		case ev := <-child.Events():
			if ev.Type == domain.EventTextDelta {
				n++
			}
		case <-timeout:
			t.Fatalf("got %d deltas", n)
		}
	}
}

func TestRegisterDrainsOrphansOfTheThread(t *testing.T) {
	s, _ := newPipeServer(t)
	s.handleNotification("item/started", json.RawMessage(`{"threadId":"th","turnId":"t","item":{"type":"agentMessage","id":"i1","text":""}}`))
	rt := s.newRuntime("th", NewMapper("s"))
	s.register(rt)
	events := drainCodex(t, rt, func(ev domain.Event) bool { return ev.Item != nil })
	if events[len(events)-1].Item.ID != "i1" {
		t.Fatalf("events = %+v", events)
	}
	if len(s.orphans["th"]) != 0 {
		t.Fatal("orphans must be consumed")
	}
}

func TestRequestWithoutThreadIsAnswered(t *testing.T) {
	s, peer := newPipeServer(t)
	peer.send(map[string]any{"jsonrpc": "2.0", "id": 9, "method": "account/chatgptAuthTokens/refresh", "params": map[string]any{}})
	msg := peer.read()
	if string(msg.ID) != "9" || msg.Error == nil {
		t.Fatalf("response = %+v", msg)
	}
	_ = s
}

func TestDroppedOrphanRequestIsAnswered(t *testing.T) {
	s, peer := newPipeServer(t)
	s.handleServerRequest(json.RawMessage(`"old"`), "item/commandExecution/requestApproval", json.RawMessage(`{"threadId":"child","itemId":"c"}`))
	for i := 0; i < maxOrphansPerThread; i++ {
		s.handleNotification("item/agentMessage/delta", json.RawMessage(`{"threadId":"child","itemId":"i1","delta":"x"}`))
	}
	msg := peer.read()
	if idKey(msg.ID) != "old" || msg.Error == nil {
		t.Fatalf("response = %+v", msg)
	}
}

func TestRequestsAndNotificationsKeepOrder(t *testing.T) {
	var mu sync.Mutex
	var order []string
	client, peer := newPair(t, func(id json.RawMessage, method string, _ json.RawMessage) {
		time.Sleep(20 * time.Millisecond)
		mu.Lock()
		order = append(order, method)
		mu.Unlock()
	})
	client.nt = func(method string, _ json.RawMessage) {
		mu.Lock()
		order = append(order, method)
		mu.Unlock()
	}
	peer.send(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "req", "params": map[string]any{}})
	peer.send(map[string]any{"jsonrpc": "2.0", "method": "note", "params": map[string]any{}})
	waitFor(t, "both messages", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(order) == 2
	})
	if order[0] != "req" || order[1] != "note" {
		t.Fatalf("order = %v", order)
	}
}

func TestResolvedAndCrashForgetPending(t *testing.T) {
	s, _ := newPipeServer(t)
	rt := s.newRuntime("th", NewMapper("s"))
	s.register(rt)
	s.handleServerRequest(json.RawMessage(`"r1"`), "item/commandExecution/requestApproval", json.RawMessage(`{"threadId":"th","itemId":"c"}`))
	s.handleServerRequest(json.RawMessage(`"r2"`), "item/commandExecution/requestApproval", json.RawMessage(`{"threadId":"th","itemId":"c"}`))
	s.handleNotification("serverRequest/resolved", json.RawMessage(`{"threadId":"th","requestId":"r1"}`))
	if _, ok := s.pending["r1"]; ok {
		t.Fatal("resolved request must be forgotten")
	}
	s.closeAll()
	if len(s.pending) != 0 {
		t.Fatalf("pending after crash = %v", s.pending)
	}
}

func TestTurnIDFollowsNotifications(t *testing.T) {
	s, _ := newPipeServer(t)
	rt := s.newRuntime("th", NewMapper("s"))
	s.register(rt)
	s.handleNotification("turn/started", json.RawMessage(`{"threadId":"th","turn":{"id":"turn-1","status":"inProgress"}}`))
	if rt.activeTurn() != "turn-1" {
		t.Fatalf("turn = %q", rt.activeTurn())
	}
	s.handleNotification("turn/completed", json.RawMessage(`{"threadId":"th","turn":{"id":"turn-1","status":"completed"}}`))
	if rt.activeTurn() != "" {
		t.Fatalf("turn after completion = %q", rt.activeTurn())
	}
	if err := rt.Steer(context.Background(), "late"); err == nil {
		t.Fatal("steer after the turn ended must fail")
	}
}

func TestExitDeliversTrailingEvents(t *testing.T) {
	rt := startCodex(t, app.StartRequest{}, "FAKECODEX_MODE=exit-after-turn")
	if err := rt.Send(context.Background(), "t1", "hi"); err != nil {
		t.Fatal(err)
	}
	// The thread outlives the server (it is resumed on a new one), so wait
	// for the turn's end rather than for the stream to close.
	events := drainCodex(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	if end := events[len(events)-1].Result; end == nil || end.IsError {
		t.Fatalf("turn/completed written right before exit was lost: %+v", end)
	}
}

func TestCodexDecisionShapes(t *testing.T) {
	input := pendingServerRequest{method: "item/tool/requestUserInput", params: json.RawMessage(`{"questions":[{"id":"q1","question":"Pick?"}]}`)}
	for name, answer := range map[string]app.RequestAnswer{
		"unanswered": {Allow: true},
		"denied":     {Allow: false, Answers: map[string][]string{"Pick?": {"A"}}},
	} {
		res, err := codexDecision(input, answer)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(res)
		if string(b) != `{"answers":{"q1":{"answers":[]}}}` {
			t.Fatalf("%s: %s", name, b)
		}
	}

	elicit := pendingServerRequest{method: "mcpServer/elicitation/request"}
	res, _ := codexDecision(elicit, app.RequestAnswer{Allow: true, Content: json.RawMessage(`{"name":"x"}`)})
	if b, _ := json.Marshal(res); string(b) != `{"action":"accept","content":{"name":"x"}}` {
		t.Fatalf("elicit = %s", b)
	}
	res, _ = codexDecision(elicit, app.RequestAnswer{Allow: true})
	if b, _ := json.Marshal(res); string(b) != `{"action":"accept","content":{}}` {
		t.Fatalf("elicit without content = %s", b)
	}

	perms := pendingServerRequest{method: "item/permissions/requestApproval", params: json.RawMessage(`{"permissions":{"network":true}}`)}
	res, _ = codexDecision(perms, app.RequestAnswer{Allow: true, AllowForSession: true})
	if b, _ := json.Marshal(res); string(b) != `{"permissions":{"network":true},"scope":"session"}` {
		t.Fatalf("permissions for session = %s", b)
	}
}

func TestMapFileApprovalShowsThePath(t *testing.T) {
	m := NewMapper("s1")
	feedCodex(t, m, "item/started", `{"threadId":"th","turnId":"t1","item":{"type":"fileChange","id":"f1","status":"inProgress","changes":[{"path":"/p/a.go","diff":"@@ -1 +1 @@","kind":"update"}]}}`)
	ev, ok := m.MapServerRequest("item/fileChange/requestApproval", json.RawMessage(`3`), json.RawMessage(`{"threadId":"th","turnId":"t1","itemId":"f1","startedAtMs":1}`))
	if !ok {
		t.Fatal("not mapped")
	}
	var payload struct {
		Input struct{ Path, Diff string } `json:"input"`
	}
	_ = json.Unmarshal(ev.Request.Payload, &payload)
	if payload.Input.Path != "/p/a.go" || payload.Input.Diff == "" {
		t.Fatalf("payload = %s", ev.Request.Payload)
	}
}

func TestMapElicitationPayloadKeepsSchema(t *testing.T) {
	m := NewMapper("s1")
	ev, ok := m.MapServerRequest("mcpServer/elicitation/request", json.RawMessage(`4`), json.RawMessage(`{"threadId":"th","serverName":"srv","mode":"form","message":"Your name?","requestedSchema":{"type":"object","properties":{"name":{"type":"string"}}}}`))
	if !ok {
		t.Fatal("not mapped")
	}
	var payload struct {
		Message         string          `json:"message"`
		RequestedSchema json.RawMessage `json:"requestedSchema"`
	}
	_ = json.Unmarshal(ev.Request.Payload, &payload)
	if payload.Message != "Your name?" || !strings.Contains(string(payload.RequestedSchema), `"name"`) {
		t.Fatalf("payload = %s", ev.Request.Payload)
	}
}

func TestMapSpawnOnCompletion(t *testing.T) {
	m := NewMapper("s1")
	feedCodex(t, m, "item/started", `{"threadId":"th","turnId":"t1","item":{"type":"collabAgentToolCall","id":"a1","prompt":"go","receiverThreadIds":[]}}`)
	events := feedCodex(t, m, "item/completed", `{"threadId":"th","turnId":"t1","item":{"type":"collabAgentToolCall","id":"a1","prompt":"go","receiverThreadIds":["child-9"]}}`)
	for _, ev := range events {
		if ev.Type == domain.EventSubagentSpawned && ev.Subagent.ThreadID == "child-9" {
			return
		}
	}
	t.Fatalf("no spawn in %+v", events)
}

func TestMapErrorNotification(t *testing.T) {
	m := NewMapper("s1")
	if events := feedCodex(t, m, "error", `{"threadId":"th","turnId":"t1","willRetry":true,"error":{"message":"retrying"}}`); len(events) != 0 {
		t.Fatalf("retried error must stay quiet: %+v", events)
	}
	events := feedCodex(t, m, "error", `{"threadId":"th","turnId":"t1","willRetry":false,"error":{"message":"stream disconnected"}}`)
	item := lastItem(t, events, domain.ItemError)
	if item.Text != "stream disconnected" || item.Status != domain.ItemFailed {
		t.Fatalf("item = %+v", item)
	}
}
