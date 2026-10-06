package codex

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func feedCodex(t *testing.T, m *Mapper, method, params string) []domain.Event {
	t.Helper()
	evs := m.MapNotification(method, json.RawMessage(params))
	return evs
}

func lastItem(t *testing.T, events []domain.Event, kind domain.ItemKind) *domain.Item {
	t.Helper()
	var item *domain.Item
	for _, ev := range events {
		if ev.Item != nil && ev.Item.Kind == kind {
			item = ev.Item
		}
	}
	if item == nil {
		t.Fatalf("no %s item in %+v", kind, events)
	}
	return item
}

func TestMapAgentMessageLifecycle(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	started := feedCodex(t, m, "item/started", `{"threadId":"th","turnId":"t1","item":{"type":"agentMessage","id":"i1","text":""}}`)
	if len(started) != 1 || started[0].Item.Status != domain.ItemStreaming {
		t.Fatalf("started = %+v", started)
	}
	delta := feedCodex(t, m, "item/agentMessage/delta", `{"threadId":"th","turnId":"t1","itemId":"i1","delta":"Hel"}`)
	if len(delta) != 1 || delta[0].Type != domain.EventTextDelta || delta[0].Delta.Text != "Hel" {
		t.Fatalf("delta = %+v", delta)
	}
	completed := feedCodex(t, m, "item/completed", `{"threadId":"th","turnId":"t1","item":{"type":"agentMessage","id":"i1","text":"Hello"}}`)
	item := lastItem(t, completed, domain.ItemAssistantMessage)
	if item.Text != "Hello" || item.Status != domain.ItemCompleted {
		t.Fatalf("item = %+v", item)
	}
}

func TestMapCommandExecution(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	feedCodex(t, m, "item/started", `{"threadId":"th","turnId":"t1","item":{"type":"commandExecution","id":"c1","command":"ls","status":"inProgress"}}`)
	feedCodex(t, m, "item/commandExecution/outputDelta", `{"threadId":"th","turnId":"t1","itemId":"c1","delta":"a.txt\n"}`)
	events := feedCodex(t, m, "item/completed", `{"threadId":"th","turnId":"t1","item":{"type":"commandExecution","id":"c1","command":"ls","aggregatedOutput":"a.txt\n","exitCode":0,"status":"completed"}}`)
	item := lastItem(t, events, domain.ItemCommand)
	if item.Text != "a.txt\n" || item.ExitCode == nil || *item.ExitCode != 0 || item.Status != domain.ItemCompleted {
		t.Fatalf("item = %+v", item)
	}
	if string(item.Input) != `{"command":"ls"}` {
		t.Fatalf("input = %s", item.Input)
	}
}

func TestMapCommandOutputStopsStreamingAtTheCap(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	feedCodex(t, m, "item/started", `{"threadId":"th","turnId":"t1","item":{"type":"commandExecution","id":"c1","command":"yes","status":"inProgress"}}`)
	chunk := strings.Repeat("y\n", commandOutputCap/2)
	params := `{"threadId":"th","turnId":"t1","itemId":"c1","delta":"` + strings.ReplaceAll(chunk, "\n", `\n`) + `"}`
	if events := feedCodex(t, m, "item/commandExecution/outputDelta", params); len(events) != 1 {
		t.Fatalf("first chunk events = %d", len(events))
	}
	if events := feedCodex(t, m, "item/commandExecution/outputDelta", params); len(events) != 0 {
		t.Fatalf("output past the cap streamed: %d events", len(events))
	}
}

func TestMapFailedCommand(t *testing.T) {
	m := NewMapper("s1")
	events := feedCodex(t, m, "item/completed", `{"threadId":"th","turnId":"t1","item":{"type":"commandExecution","id":"c2","command":"false","status":"failed","exitCode":1}}`)
	if item := lastItem(t, events, domain.ItemCommand); item.Status != domain.ItemFailed {
		t.Fatalf("item = %+v", item)
	}
}

func TestMapFileChange(t *testing.T) {
	m := NewMapper("s1")
	events := feedCodex(t, m, "item/completed", `{"threadId":"th","turnId":"t1","item":{"type":"fileChange","id":"f1","status":"completed","changes":[{"path":"/tmp/x.go","diff":"@@","kind":"update"}]}}`)
	item := lastItem(t, events, domain.ItemFileChange)
	if item.Path != "/tmp/x.go" || item.Diff != "@@" {
		t.Fatalf("item = %+v", item)
	}
}

func TestMapFileChangePatchUpdated(t *testing.T) {
	m := NewMapper("s1")
	events := feedCodex(t, m, "item/fileChange/patchUpdated", `{"threadId":"th","turnId":"t1","itemId":"f1","changes":[{"path":"/tmp/y.go","diff":"@@ y","kind":"update"}]}`)
	item := lastItem(t, events, domain.ItemFileChange)
	if item.ID != "f1" || item.Path != "/tmp/y.go" {
		t.Fatalf("item = %+v", item)
	}
}

func TestMapReasoning(t *testing.T) {
	m := NewMapper("s1")
	events := feedCodex(t, m, "item/reasoning/textDelta", `{"threadId":"th","turnId":"t1","itemId":"r1","delta":"hmm"}`)
	if events[0].Type != domain.EventItemUpdated {
		t.Fatalf("first event = %+v", events[0])
	}
	if events[1].Type != domain.EventTextDelta || events[1].Delta.ItemID != "r1" {
		t.Fatalf("second event = %+v", events[1])
	}
}

func TestMapSubagent(t *testing.T) {
	m := NewMapper("s1")
	events := feedCodex(t, m, "item/started", `{"threadId":"th","turnId":"t1","item":{"type":"collabAgentToolCall","id":"a1","prompt":"do it","receiverThreadIds":["thread-2"],"senderThreadId":"th"}}`)
	item := lastItem(t, events, domain.ItemSubagent)
	// The prompt says what the child does; it is not the child's output.
	if item.Text != "" || string(item.Input) != `{"prompt":"do it"}` || item.Name != "agent" {
		t.Fatalf("item = %+v input = %s", item, item.Input)
	}
	done := feedCodex(t, m, "item/completed", `{"threadId":"th","turnId":"t1","item":{"type":"collabAgentToolCall","id":"a1","tool":"wait","prompt":"do it","receiverThreadIds":["thread-2"],"senderThreadId":"th","status":"completed","agentsStates":{"thread-2":{"status":"completed","message":"all done"}}}}`)
	item = lastItem(t, done, domain.ItemSubagent)
	if item.Text != "all done" {
		t.Fatalf("returned item = %+v", item)
	}
	bare := feedCodex(t, m, "item/started", `{"threadId":"th","turnId":"t1","item":{"type":"subAgentActivity","id":"sa1","agentThreadId":"t2","kind":"started"}}`)
	if item := lastItem(t, bare, domain.ItemSubagent); item.Input != nil || item.Text != "" {
		t.Fatalf("activity = %+v", item)
	}
}

func TestMapTurnCompleted(t *testing.T) {
	m := NewMapper("s1")
	events := feedCodex(t, m, "turn/completed", `{"threadId":"th","turn":{"id":"t1","status":"failed","error":{"message":"boom"},"items":[{"type":"agentMessage","id":"i1","text":"partial"}]}}`)
	if len(events) != 2 || events[len(events)-1].Type != domain.EventTurnEnded {
		t.Fatalf("events = %+v", events)
	}
	if events[0].Item == nil || events[0].Item.Text != "partial" {
		t.Fatalf("item event = %+v", events[0])
	}
	res := events[len(events)-1].Result
	if !res.IsError || res.Error != "boom" || res.Text != "partial" {
		t.Fatalf("result = %+v", res)
	}
}

// An interrupted turn was stopped, not failed.
func TestMapTurnInterruptedIsStopped(t *testing.T) {
	m := NewMapper("s1")
	events := feedCodex(t, m, "turn/completed", `{"threadId":"th","turn":{"id":"t1","status":"interrupted","items":[]}}`)
	res := events[len(events)-1].Result
	if !res.Stopped || res.IsError {
		t.Fatalf("result = %+v", res)
	}
	events = feedCodex(t, m, "turn/completed", `{"threadId":"th","turn":{"id":"t2","status":"completed","items":[]}}`)
	if res := events[len(events)-1].Result; res.Stopped {
		t.Fatalf("result = %+v", res)
	}
}

func TestMapTurnStartedSetsTurn(t *testing.T) {
	m := NewMapper("s1")
	feedCodex(t, m, "turn/started", `{"threadId":"th","turn":{"id":"turn-9","status":"inProgress"}}`)
	events := feedCodex(t, m, "item/started", `{"threadId":"th","turnId":"turn-9","item":{"type":"agentMessage","id":"i1","text":"x"}}`)
	if events[0].Item.TurnID != "turn-9" {
		t.Fatalf("turn = %q", events[0].Item.TurnID)
	}
}

func TestMapPlanUpdated(t *testing.T) {
	m := NewMapper("s1")
	events := feedCodex(t, m, "turn/plan/updated", `{"threadId":"th","turnId":"t1","explanation":"why","plan":[{"step":"one","status":"completed"},{"step":"two","status":"inProgress"}]}`)
	item := lastItem(t, events, domain.ItemPlan)
	if item.Text == "" || item.TurnID != "" {
		t.Fatalf("item = %+v", item)
	}
}

func TestMapCommandApprovalRequest(t *testing.T) {
	m := NewMapper("s1")
	ev, ok := m.MapServerRequest("item/commandExecution/requestApproval", json.RawMessage(`"srv-1"`), json.RawMessage(`{"threadId":"th","turnId":"t1","itemId":"c1","command":"rm -rf x","reason":"destructive"}`))
	if !ok || ev.Type != domain.EventRequestOpened {
		t.Fatalf("event = %+v ok=%v", ev, ok)
	}
	if ev.Request.ID != "srv-1" || ev.Request.Kind != domain.RequestPermission {
		t.Fatalf("request = %+v", ev.Request)
	}
}

func TestMapUserInputRequest(t *testing.T) {
	m := NewMapper("s1")
	ev, ok := m.MapServerRequest("item/tool/requestUserInput", json.RawMessage(`7`), json.RawMessage(`{"threadId":"th","turnId":"t1","itemId":"i1","isBlocking":true,"questions":[{"id":"q1","header":"H","question":"Pick?","options":[{"label":"A","description":"a"}]}]}`))
	if !ok || ev.Request.Kind != domain.RequestQuestion || ev.Request.ID != "7" {
		t.Fatalf("event = %+v ok=%v", ev, ok)
	}
}

func TestMapUnknownServerRequest(t *testing.T) {
	m := NewMapper("s1")
	if _, ok := m.MapServerRequest("something/else", json.RawMessage(`1`), json.RawMessage(`{}`)); ok {
		t.Fatal("unknown request must not map")
	}
	if _, ok := m.MapServerRequest("item/commandExecution/requestApproval", nil, json.RawMessage(`{}`)); ok {
		t.Fatal("request without id must not map")
	}
}

func TestMapServerRequestResolved(t *testing.T) {
	m := NewMapper("s1")
	events := feedCodex(t, m, "serverRequest/resolved", `{"threadId":"th","requestId":"srv-1"}`)
	if len(events) != 1 || events[0].Type != domain.EventRequestResolved || events[0].Request.ID != "srv-1" {
		t.Fatalf("events = %+v", events)
	}
}

func TestMapThreadHistory(t *testing.T) {
	m := NewMapper("s1")
	m.IncludeUserMessages = true
	events := m.MapThread(rpcThread{Turns: []rpcTurn{
		{ID: "t1", Status: "completed", Items: []rpcItem{
			{Type: "userMessage", ID: "u1", Content: []rpcTextPart{{Type: "text", Text: "hi"}}},
			{Type: "agentMessage", ID: "a1", Text: "hello"},
		}},
	}})
	if len(events) != 2 {
		t.Fatalf("events = %+v", events)
	}
	if events[0].Item.Kind != domain.ItemUserMessage || events[0].Item.Text != "hi" {
		t.Fatalf("user = %+v", events[0].Item)
	}
}

func TestMapUnknownNotificationIgnored(t *testing.T) {
	m := NewMapper("s1")
	if evs := feedCodex(t, m, "thread/settings/updated", `{}`); len(evs) != 0 {
		t.Fatalf("events = %+v", evs)
	}
	if evs := feedCodex(t, m, "item/started", `not json`); len(evs) != 0 {
		t.Fatalf("events = %+v", evs)
	}
}

func TestMapOtherItemKinds(t *testing.T) {
	cases := []struct {
		it   string
		kind domain.ItemKind
	}{
		{`{"type":"mcpToolCall","id":"m1","server":"srv","tool":"do","status":"completed"}`, domain.ItemToolCall},
		{`{"type":"dynamicToolCall","id":"d1","tool":"dyn","status":"completed"}`, domain.ItemToolCall},
		{`{"type":"webSearch","id":"w1","query":"golang"}`, domain.ItemToolCall},
		{`{"type":"functionCallOutput","id":"o1","name":"Read","output":"body"}`, domain.ItemToolCall},
		{`{"type":"subAgentActivity","id":"sa1","agentThreadId":"t2","kind":"thinking"}`, domain.ItemSubagent},
		{`{"type":"imageView","id":"iv1","path":"/img.png"}`, domain.ItemToolCall},
	}
	for _, tc := range cases {
		m := NewMapper("s1")
		events := feedCodex(t, m, "item/completed", `{"threadId":"th","turnId":"t1","item":`+tc.it+`}`)
		if item := lastItem(t, events, tc.kind); item == nil {
			t.Fatalf("%s: no item", tc.it)
		}
	}
}

func TestMapReasoningTextAggregates(t *testing.T) {
	m := NewMapper("s1")
	events := feedCodex(t, m, "item/completed", `{"threadId":"th","turnId":"t1","item":{"type":"reasoning","id":"r1","summary":[{"type":"summary_text","text":"sum"}],"content":[{"type":"reasoning_text","text":"body"}]}}`)
	item := lastItem(t, events, domain.ItemReasoning)
	if item.Text != "sumbody" {
		t.Fatalf("text = %q", item.Text)
	}
}

func TestOutputTextVariants(t *testing.T) {
	if got := outputText(json.RawMessage(`"plain"`)); got != "plain" {
		t.Fatalf("string = %q", got)
	}
	if got := outputText(json.RawMessage(`[{"type":"text","text":"a"},{"type":"text","text":"b"}]`)); got != "ab" {
		t.Fatalf("array = %q", got)
	}
	if got := outputText(json.RawMessage(`42`)); got != "42" {
		t.Fatalf("fallback = %q", got)
	}
	if got := outputText(nil); got != "" {
		t.Fatalf("empty = %q", got)
	}
}

func TestMapPlanWithExplanation(t *testing.T) {
	m := NewMapper("s1")
	events := feedCodex(t, m, "turn/plan/updated", `{"threadId":"th","turnId":"t1","explanation":"because","plan":[{"step":"one","status":"completed"}]}`)
	item := lastItem(t, events, domain.ItemPlan)
	if item.Text == "" || !contains(item.Text, "because") || !contains(item.Text, "one") {
		t.Fatalf("text = %q", item.Text)
	}
	if evs := feedCodex(t, m, "turn/plan/updated", `{"threadId":"th","turnId":"t1","plan":[]}`); len(evs) != 0 {
		t.Fatalf("empty plan = %+v", evs)
	}
}

func TestMapServerRequestVariants(t *testing.T) {
	cases := []struct {
		method string
		params string
		kind   domain.RequestKind
	}{
		{"item/fileChange/requestApproval", `{"threadId":"th","turnId":"t1","itemId":"f1","reason":"apply","grantRoot":"/tmp"}`, domain.RequestPermission},
		{"item/permissions/requestApproval", `{"threadId":"th","turnId":"t1","itemId":"p1","permissions":{"network":true}}`, domain.RequestPermission},
		{"mcpServer/elicitation/request", `{"threadId":"th","turnId":"t1","turnId":"t1","serverName":"mcp","message":"need input"}`, domain.RequestElicitation},
	}
	for _, tc := range cases {
		m := NewMapper("s1")
		ev, ok := m.MapServerRequest(tc.method, json.RawMessage(`"req-1"`), json.RawMessage(tc.params))
		if !ok || ev.Request.Kind != tc.kind {
			t.Fatalf("%s: event = %+v ok=%v", tc.method, ev, ok)
		}
	}
}

func TestMapServerRequestBadParams(t *testing.T) {
	m := NewMapper("s1")
	if _, ok := m.MapServerRequest("item/commandExecution/requestApproval", json.RawMessage(`1`), json.RawMessage(`not json`)); ok {
		t.Fatal("bad params must not map")
	}
}

func TestItemKindUnknown(t *testing.T) {
	if _, ok := itemKind("sleep"); ok {
		t.Fatal("sleep should have no item kind")
	}
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }

func TestMapCollabAgentSpawn(t *testing.T) {
	m := NewMapper("s1")
	events := feedCodex(t, m, "item/started", `{"threadId":"th","turnId":"t1","item":{"type":"collabAgentToolCall","id":"a1","prompt":"triage","receiverThreadIds":["child-1","child-2"],"senderThreadId":"th"}}`)
	var spawns []domain.SubagentSpawn
	for _, ev := range events {
		if ev.Type == domain.EventSubagentSpawned {
			spawns = append(spawns, *ev.Subagent)
		}
	}
	if len(spawns) != 2 || spawns[0].ThreadID != "child-1" || spawns[0].Title != "triage" {
		t.Fatalf("spawns = %+v", spawns)
	}
	again := feedCodex(t, m, "item/completed", `{"threadId":"th","turnId":"t1","item":{"type":"collabAgentToolCall","id":"a1","prompt":"triage","receiverThreadIds":["child-1"],"senderThreadId":"th"}}`)
	for _, ev := range again {
		if ev.Type == domain.EventSubagentSpawned {
			t.Fatal("spawn must not repeat")
		}
	}
}

func TestMapRateLimitsGlobal(t *testing.T) {
	m := NewMapper("s1")
	events := m.MapGlobalNotification("account/rateLimits/updated", json.RawMessage(`{"rateLimits":{"primary":{"usedPercent":40,"resetsAt":1790000000,"windowDurationMins":300},"secondary":{"usedPercent":10},"planType":"plus","rateLimitReachedType":"primary"}}`))
	if len(events) != 1 || events[0].Type != domain.EventQuota {
		t.Fatalf("events = %+v", events)
	}
	q := events[0].Quota
	if q.Agent != domain.AgentCodex || q.Plan != "plus" || !q.Reached || len(q.Windows) != 2 {
		t.Fatalf("quota = %+v", q)
	}
	if q.Windows[0].UsedPct != 40 || q.Windows[0].ResetsAt.Unix() != 1790000000 || q.Windows[0].Status != "300m" {
		t.Fatalf("primary = %+v", q.Windows[0])
	}
	if q.Windows[1].Name != "secondary" || q.Windows[1].UsedPct != 10 {
		t.Fatalf("secondary = %+v", q.Windows[1])
	}
	if evs := m.MapGlobalNotification("other/thing", json.RawMessage(`{}`)); len(evs) != 0 {
		t.Fatalf("unknown method = %+v", evs)
	}
	if evs := m.MapGlobalNotification("account/rateLimits/updated", json.RawMessage(`bad`)); len(evs) != 0 {
		t.Fatalf("bad json = %+v", evs)
	}
}

func TestMapRateLimitsSkipsRepeatedSnapshots(t *testing.T) {
	m := NewMapper("s1")
	a := json.RawMessage(`{"rateLimits":{"primary":{"usedPercent":40}}}`)
	b := json.RawMessage(`{"rateLimits":{"primary":{"usedPercent":41}}}`)
	for i, step := range []struct {
		params json.RawMessage
		want   int
	}{{a, 1}, {a, 0}, {b, 1}, {a, 1}} {
		if got := len(m.MapGlobalNotification("account/rateLimits/updated", step.params)); got != step.want {
			t.Fatalf("step %d: events = %d, want %d", i, got, step.want)
		}
	}
}

// A reached limit must keep arriving: only a running session can stop on it,
// and an idle one may have seen the same snapshot first.
func TestMapRateLimitsRepeatsReachedSnapshots(t *testing.T) {
	m := NewMapper("s1")
	reached := json.RawMessage(`{"rateLimits":{"primary":{"usedPercent":100},"rateLimitReachedType":"primary"}}`)
	for i := range 2 {
		if got := len(m.MapGlobalNotification("account/rateLimits/updated", reached)); got != 1 {
			t.Fatalf("reached snapshot %d: events = %d", i, got)
		}
	}
}

func TestMapTokenUsage(t *testing.T) {
	m := NewMapper("s1")
	events := feedCodex(t, m, "thread/tokenUsage/updated", `{"threadId":"th","turnId":"t1","tokenUsage":{"total":{"inputTokens":10,"outputTokens":5,"totalTokens":15}}}`)
	if len(events) != 1 || events[0].Type != domain.EventUsage || events[0].Usage.TotalTokens != 15 {
		t.Fatalf("events = %+v", events)
	}
}

// Emitted items are snapshots: later notifications must not change them.
func TestEmittedItemsAreSnapshots(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	started := feedCodex(t, m, "item/started", `{"threadId":"th","turnId":"t1","item":{"type":"agentMessage","id":"i1","text":""}}`)
	feedCodex(t, m, "item/agentMessage/delta", `{"threadId":"th","turnId":"t1","itemId":"i1","delta":"Hel"}`)
	feedCodex(t, m, "item/completed", `{"threadId":"th","turnId":"t1","item":{"type":"agentMessage","id":"i1","text":"Hello"}}`)
	for _, ev := range started {
		if ev.Item != nil && (ev.Item.Text != "" || ev.Item.Status == domain.ItemCompleted) {
			t.Fatalf("emitted item changed afterwards: %+v", ev.Item)
		}
	}
}

func hookRun(id, event, status, statusMessage string, entries ...[2]string) string {
	es := []map[string]string{}
	for _, e := range entries {
		es = append(es, map[string]string{"kind": e[0], "text": e[1]})
	}
	raw, _ := json.Marshal(map[string]any{"threadId": "th", "turnId": "t1", "run": map[string]any{
		"id": id, "eventName": event, "handlerType": "command", "executionMode": "sync", "scope": "turn",
		"sourcePath": "/h/.codex/hooks.json", "source": "user", "displayOrder": 1, "status": status,
		"statusMessage": statusMessage, "startedAt": 1, "entries": es,
	}})
	return string(raw)
}

// Shapes as codex 0.157.0 sends them with a user Stop hook.
func TestMapHookRuns(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	started := feedCodex(t, m, "hook/started", hookRun("stop:1:/h", "stop", "running", "Agent Reflection"))
	if len(started) != 1 || started[0].Item.Kind != domain.ItemHook || started[0].Item.Name != "Stop" ||
		started[0].Item.Status != domain.ItemStreaming {
		t.Fatalf("started = %+v", started)
	}
	done := feedCodex(t, m, "hook/completed", hookRun("stop:1:/h", "stop", "blocked", "Agent Reflection",
		[2]string{"feedback", "Check your work."}, [2]string{"warning", "slow hook"}))
	hook := done[0].Item
	if hook.ID != started[0].Item.ID || hook.Outcome != domain.HookBlocked || hook.Status != domain.ItemCompleted ||
		hook.Text != "Check your work.\nslow hook" {
		t.Fatalf("completed = %+v", hook)
	}

	// The same run id comes again for the next Stop: a new item.
	again := feedCodex(t, m, "hook/started", hookRun("stop:1:/h", "stop", "running", "Agent Reflection"))
	if again[0].Item.ID == hook.ID {
		t.Fatal("second run reused the first item")
	}
	ok := feedCodex(t, m, "hook/completed", hookRun("stop:1:/h", "stop", "completed", "Agent Reflection"))
	if it := ok[0].Item; it.Outcome != domain.HookSuccess || it.Text != "Agent Reflection" {
		t.Fatalf("plain completion = %+v", it)
	}

	feedCodex(t, m, "hook/started", hookRun("p:0", "preToolUse", "running", ""))
	failed := feedCodex(t, m, "hook/completed", hookRun("p:0", "preToolUse", "failed", "", [2]string{"error", "exit 1"}))
	if it := failed[0].Item; it.Name != "PreToolUse" || it.Outcome != domain.HookError || it.Status != domain.ItemFailed {
		t.Fatalf("failed = %+v", it)
	}
	feedCodex(t, m, "hook/started", hookRun("s:0", "sessionStart", "running", ""))
	stopped := feedCodex(t, m, "hook/completed", hookRun("s:0", "sessionStart", "stopped", "", [2]string{"stop", "halt"}))
	if it := stopped[0].Item; it.Outcome != domain.HookBlocked {
		t.Fatalf("stopped = %+v", it)
	}

	// A completion without a start still shows up; garbage is ignored.
	orphan := feedCodex(t, m, "hook/completed", hookRun("x:0", "stop", "completed", "late"))
	if len(orphan) != 1 || orphan[0].Item.Outcome != domain.HookSuccess {
		t.Fatalf("orphan = %+v", orphan)
	}
	if evs := m.MapNotification("hook/started", json.RawMessage(`{"run":{}}`)); len(evs) != 0 {
		t.Fatalf("empty run = %+v", evs)
	}
	if evs := m.MapNotification("hook/completed", json.RawMessage(`nope`)); len(evs) != 0 {
		t.Fatalf("bad json = %+v", evs)
	}
}

// go-chamber records the user's own messages itself; Codex echoing them as
// userMessage items would show every message twice.
func TestUserMessagesAreSkippedUnlessIncluded(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	if evs := feedCodex(t, m, "item/completed", `{"threadId":"th","turnId":"t1","item":{"type":"userMessage","id":"u1","content":[{"type":"text","text":"hi"}]}}`); len(evs) != 0 {
		t.Fatalf("echoed user message = %+v", evs)
	}
	history := m.MapThread(rpcThread{Turns: []rpcTurn{{ID: "t1", Status: "completed", Items: []rpcItem{
		{Type: "userMessage", ID: "u2", Content: []rpcTextPart{{Type: "text", Text: "hi"}}},
		{Type: "agentMessage", ID: "a1", Text: "hello"},
	}}}})
	for _, ev := range history {
		if ev.Item != nil && ev.Item.Kind == domain.ItemUserMessage {
			t.Fatalf("history user message = %+v", ev.Item)
		}
	}
}
