package claude

import (
	"encoding/json"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// feed maps every line and returns the collected events; it fails the test on
// a mapping error.
func feed(t *testing.T, m *Mapper, lines ...string) []domain.Event {
	t.Helper()
	var out []domain.Event
	for _, l := range lines {
		evs, err := m.Map([]byte(l))
		if err != nil {
			t.Fatalf("Map(%s): %v", l, err)
		}
		out = append(out, evs...)
	}
	return out
}

func TestMapStreamedText(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	evs := feed(t, m,
		`{"type":"stream_event","session_id":"s1","uuid":"u1","event":{"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"u2","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"u3","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"u4","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"u5","event":{"type":"content_block_stop","index":0}}`,
		`{"type":"assistant","session_id":"s1","uuid":"u6","parent_tool_use_id":null,"message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"Hello"}]}}`,
	)

	if len(evs) != 5 {
		t.Fatalf("got %d events: %+v", len(evs), evs)
	}
	var text string
	for _, ev := range evs {
		if ev.Type == domain.EventTextDelta {
			text += ev.Delta.Text
		}
	}
	if text != "Hello" {
		t.Fatalf("streamed text = %q", text)
	}
	var final *domain.Item
	for _, ev := range evs {
		if ev.Type == domain.EventItemUpdated {
			final = ev.Item
		}
	}
	if final == nil || final.Kind != domain.ItemAssistantMessage || final.Status != domain.ItemCompleted || final.Text != "Hello" {
		t.Fatalf("final item = %+v", final)
	}
	if final.TurnID != "t1" {
		t.Fatalf("turn = %q", final.TurnID)
	}
}

func TestMapToolUseAndResult(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	evs := feed(t, m,
		`{"type":"stream_event","session_id":"s1","uuid":"a1","event":{"type":"message_start","message":{"id":"msg_2","role":"assistant","content":[]}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"a2","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}}`,
		`{"type":"assistant","session_id":"s1","uuid":"a3","parent_tool_use_id":null,"message":{"id":"msg_2","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"echo hi"}}]}}`,
		`{"type":"user","session_id":"s1","uuid":"a4","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"hi","is_error":false}]}}`,
	)

	var tool *domain.Item
	for _, ev := range evs {
		if ev.Item != nil && ev.Item.Kind == domain.ItemCommand {
			tool = ev.Item
		}
	}
	if tool == nil {
		t.Fatalf("no command item in %+v", evs)
	}
	if tool.Name != "Bash" || tool.Status != domain.ItemCompleted || tool.Text != "hi" {
		t.Fatalf("tool item = %+v", tool)
	}
	if string(tool.Input) != `{"command":"echo hi"}` {
		t.Fatalf("tool input = %s", tool.Input)
	}
}

func TestMapFileChangeKindAndPath(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	evs := feed(t, m,
		`{"type":"stream_event","session_id":"s1","uuid":"b1","event":{"type":"message_start","message":{"id":"msg_3","role":"assistant","content":[]}}}`,
		`{"type":"assistant","session_id":"s1","uuid":"b2","parent_tool_use_id":null,"message":{"id":"msg_3","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Edit","input":{"file_path":"/tmp/x.go","old_string":"a","new_string":"b"}}]}}`,
	)
	var item *domain.Item
	for _, ev := range evs {
		if ev.Item != nil {
			item = ev.Item
		}
	}
	if item == nil || item.Kind != domain.ItemFileChange || item.Path != "/tmp/x.go" {
		t.Fatalf("item = %+v", item)
	}
}

func TestMapSubagentKind(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	evs := feed(t, m,
		`{"type":"stream_event","session_id":"s1","uuid":"c1","event":{"type":"message_start","message":{"id":"msg_4","role":"assistant","content":[]}}}`,
		`{"type":"assistant","session_id":"s1","uuid":"c2","parent_tool_use_id":null,"message":{"id":"msg_4","role":"assistant","content":[{"type":"tool_use","id":"toolu_3","name":"Task","input":{"description":"do stuff"}}]}}`,
	)
	var item *domain.Item
	for _, ev := range evs {
		if ev.Item != nil {
			item = ev.Item
		}
	}
	if item == nil || item.Kind != domain.ItemSubagent {
		t.Fatalf("item = %+v", item)
	}
}

func TestMapResultEndsTurn(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	evs := feed(t, m,
		`{"type":"result","subtype":"success","is_error":false,"session_id":"s1","result":"done","total_cost_usd":0.12,"usage":{"input_tokens":10,"output_tokens":20}}`,
	)
	if len(evs) != 1 || evs[0].Type != domain.EventTurnEnded {
		t.Fatalf("events = %+v", evs)
	}
	r := evs[0].Result
	if r == nil || r.Text != "done" || r.CostUSD != 0.12 || r.InputTokens != 10 || r.OutputTokens != 20 || r.IsError {
		t.Fatalf("result = %+v", r)
	}
}

func TestMapErrorResult(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	evs := feed(t, m,
		`{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"s1","errors":["kaboom"],"usage":{"input_tokens":1,"output_tokens":0}}`,
	)
	if len(evs) != 1 || !evs[0].Result.IsError || evs[0].Result.Error != "kaboom" {
		t.Fatalf("events = %+v", evs)
	}
}

func TestMapThinkingAndUnknownMessages(t *testing.T) {
	m := NewMapper("s1")
	evs := feed(t, m,
		`{"type":"stream_event","session_id":"s1","uuid":"d1","event":{"type":"message_start","message":{"id":"msg_5","role":"assistant","content":[]}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"d2","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"d3","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}}`,
		`{"type":"system","subtype":"init","session_id":"s1"}`,
		`{"type":"unknown_future_type","session_id":"s1"}`,
	)
	var reasoning *domain.Item
	text := ""
	for _, ev := range evs {
		if ev.Item != nil && ev.Item.Kind == domain.ItemReasoning {
			reasoning = ev.Item
		}
		if ev.Type == domain.EventTextDelta && reasoning != nil && ev.Delta.ItemID == reasoning.ID {
			text += ev.Delta.Text
		}
	}
	if reasoning == nil || text != "hmm" {
		t.Fatalf("reasoning = %+v, text %q (events %+v)", reasoning, text, evs)
	}
}

func TestMapRejectsBadJSON(t *testing.T) {
	m := NewMapper("s1")
	if _, err := m.Map([]byte("not json")); err == nil {
		t.Fatal("want error")
	}
}

func TestMapAssistantTextWithoutStream(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	evs := feed(t, m,
		`{"type":"assistant","session_id":"s1","uuid":"x1","parent_tool_use_id":null,"message":{"id":"msg_a","role":"assistant","content":[{"type":"text","text":"full"}]}}`,
	)
	var item *domain.Item
	for _, ev := range evs {
		if ev.Item != nil {
			item = ev.Item
		}
	}
	if item == nil || item.Text != "full" || item.Status != domain.ItemCompleted {
		t.Fatalf("item = %+v", item)
	}
}

func TestMapInputStreamedToolInput(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	evs := feed(t, m,
		`{"type":"stream_event","session_id":"s1","uuid":"y1","event":{"type":"message_start","message":{"id":"msg_b","role":"assistant","content":[]}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"y2","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"Bash","input":{}}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"y3","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"y4","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"ls\"}"}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"y5","event":{"type":"content_block_stop","index":0}}`,
	)
	var item *domain.Item
	for _, ev := range evs {
		if ev.Item != nil && ev.Item.Kind == domain.ItemCommand {
			item = ev.Item
		}
	}
	if item == nil || string(item.Input) != `{"command":"ls"}` {
		t.Fatalf("item = %+v", item)
	}
}

func TestMapToolResultVariants(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	evs := feed(t, m,
		`{"type":"assistant","session_id":"s1","uuid":"z1","parent_tool_use_id":null,"message":{"id":"msg_c","role":"assistant","content":[{"type":"tool_use","id":"toolu_e","name":"Bash","input":{"command":"x"}}]}}`,
		`{"type":"user","session_id":"s1","uuid":"z2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_e","is_error":true,"content":[{"type":"text","text":"boom"}]}]}}`,
		`{"type":"user","session_id":"s1","uuid":"z3","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"unknown","content":"ignored"}]}}`,
	)
	var item *domain.Item
	for _, ev := range evs {
		if ev.Item != nil && ev.Item.Kind == domain.ItemCommand {
			item = ev.Item
		}
	}
	if item == nil || item.Text != "boom" || item.Status != domain.ItemFailed {
		t.Fatalf("item = %+v", item)
	}
	if item.ExitCode == nil || *item.ExitCode != 1 {
		t.Fatalf("exit code = %v", item.ExitCode)
	}
}

func TestMapDeltaForUnknownItemIgnored(t *testing.T) {
	m := NewMapper("s1")
	evs := feed(t, m,
		`{"type":"stream_event","session_id":"s1","uuid":"w1","event":{"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"x"}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"w2","event":{"type":"content_block_stop","index":3}}`,
	)
	if len(evs) != 0 {
		t.Fatalf("events = %+v", evs)
	}
}

func TestMapBadStreamPayloadsIgnored(t *testing.T) {
	m := NewMapper("s1")
	evs := feed(t, m,
		`{"type":"stream_event","session_id":"s1","event":"not-an-object"}`,
		`{"type":"stream_event","session_id":"s1","event":{"type":"message_start","message":"bad"}}`,
		`{"type":"stream_event","session_id":"s1","event":{"type":"content_block_start","index":0,"content_block":"bad"}}`,
		`{"type":"stream_event","session_id":"s1","event":{"type":"content_block_delta","index":0,"delta":"bad"}}`,
		`{"type":"assistant","session_id":"s1","message":"bad"}`,
		`{"type":"user","session_id":"s1","message":"bad"}`,
	)
	if len(evs) != 0 {
		t.Fatalf("events = %+v", evs)
	}
}

func TestToolKindMapping(t *testing.T) {
	cases := map[string]domain.ItemKind{
		"Bash": domain.ItemCommand, "BashOutput": domain.ItemCommand, "KillShell": domain.ItemCommand,
		"Edit": domain.ItemFileChange, "Write": domain.ItemFileChange, "MultiEdit": domain.ItemFileChange, "NotebookEdit": domain.ItemFileChange,
		"Task": domain.ItemSubagent, "Agent": domain.ItemSubagent,
		"Read": domain.ItemToolCall, "WebFetch": domain.ItemToolCall,
	}
	for name, want := range cases {
		if got := toolKind(name); got != want {
			t.Errorf("toolKind(%s) = %s, want %s", name, got, want)
		}
	}
}

func TestInputString(t *testing.T) {
	if got := inputString(json.RawMessage(`{"file_path":"/a"}`), "file_path"); got != "/a" {
		t.Fatalf("got %q", got)
	}
	if got := inputString(json.RawMessage(`{"path":"/b"}`), "file_path", "path"); got != "/b" {
		t.Fatalf("got %q", got)
	}
	if got := inputString(json.RawMessage(`not-json`), "path"); got != "" {
		t.Fatalf("got %q", got)
	}
	if got := inputString(nil, "path"); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestTextFromToolResult(t *testing.T) {
	if got := textFromToolResult(json.RawMessage(`"plain"`)); got != "plain" {
		t.Fatalf("string = %q", got)
	}
	if got := textFromToolResult(json.RawMessage(`[{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"b"}]`)); got != "ab" {
		t.Fatalf("array = %q", got)
	}
	if got := textFromToolResult(json.RawMessage(`42`)); got != "42" {
		t.Fatalf("fallback = %q", got)
	}
	if got := textFromToolResult(nil); got != "" {
		t.Fatalf("empty = %q", got)
	}
}

func TestMapPermissionRequest(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	evs := feed(t, m, `{"type":"control_request","request_id":"perm-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm x"},"permission_suggestions":[{"type":"addRules","behavior":"allow","destination":"session","rules":[{"toolName":"Bash"}]}],"tool_use_id":"toolu_1","description":"Claude wants to run","title":"Run command"}}`)
	if len(evs) != 1 || evs[0].Type != domain.EventRequestOpened {
		t.Fatalf("events = %+v", evs)
	}
	r := evs[0].Request
	if r.Kind != domain.RequestPermission || r.Title != "Run command" || r.State != domain.RequestPending {
		t.Fatalf("request = %+v", r)
	}
	if r.TurnID != "t1" || string(r.Payload) == "" {
		t.Fatalf("request payload/turn = %+v", r)
	}
	p, ok := m.TakePending("perm-1")
	if !ok || p.toolName != "Bash" || p.toolUseID != "toolu_1" || len(p.suggestions) == 0 {
		t.Fatalf("pending = %+v, %v", p, ok)
	}
	if _, ok := m.TakePending("perm-1"); ok {
		t.Fatal("pending must be consumed once")
	}
}

func TestMapQuestionRequest(t *testing.T) {
	m := NewMapper("s1")
	evs := feed(t, m, `{"type":"control_request","request_id":"q-1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Pick?","header":"H","options":[{"label":"A"},{"label":"B"}]}]},"tool_use_id":"toolu_q","description":"a question"}}`)
	if len(evs) != 1 || evs[0].Request.Kind != domain.RequestQuestion {
		t.Fatalf("events = %+v", evs)
	}
	if evs[0].Request.Title != "AskUserQuestion" {
		t.Fatalf("title = %q", evs[0].Request.Title)
	}
}

func TestMapControlRequestIgnoresOtherSubtypes(t *testing.T) {
	m := NewMapper("s1")
	evs := feed(t, m, `{"type":"control_request","request_id":"i-1","request":{"subtype":"set_model","model":"x"}}`)
	if len(evs) != 0 {
		t.Fatalf("events = %+v", evs)
	}
	evs = feed(t, m, `{"type":"control_request","request":{}}`)
	if len(evs) != 0 {
		t.Fatalf("events without id = %+v", evs)
	}
}

func TestMapControlCancelRequest(t *testing.T) {
	m := NewMapper("s1")
	evs := feed(t, m, `{"type":"control_cancel_request","request_id":"perm-9"}`)
	if len(evs) != 1 || evs[0].Type != domain.EventRequestResolved || evs[0].Request.State != domain.RequestStale {
		t.Fatalf("events = %+v", evs)
	}
	if evs = feed(t, m, `{"type":"control_cancel_request"}`); len(evs) != 0 {
		t.Fatalf("cancel without id = %+v", evs)
	}
}

func TestMapSubagentNesting(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	evs := feed(t, m,
		`{"type":"stream_event","session_id":"s1","uuid":"p1","event":{"type":"message_start","message":{"id":"msg_p","role":"assistant","content":[]}}}`,
		`{"type":"assistant","session_id":"s1","uuid":"p2","parent_tool_use_id":null,"message":{"id":"msg_p","role":"assistant","content":[{"type":"tool_use","id":"toolu_task","name":"Task","input":{"description":"do stuff"}}]}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"p3","parent_tool_use_id":"toolu_task","event":{"type":"message_start","message":{"id":"msg_c","role":"assistant","content":[]}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"p4","parent_tool_use_id":"toolu_task","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"p5","parent_tool_use_id":"toolu_task","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"working"}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"p6","parent_tool_use_id":"toolu_task","event":{"type":"content_block_stop","index":0}}`,
		`{"type":"assistant","session_id":"s1","uuid":"p7","parent_tool_use_id":"toolu_task","message":{"id":"msg_c","role":"assistant","content":[{"type":"text","text":"working"}]}}`,
	)
	var subagent, child *domain.Item
	for _, ev := range evs {
		if ev.Item == nil {
			continue
		}
		switch ev.Item.Kind {
		case domain.ItemSubagent:
			subagent = ev.Item
		case domain.ItemAssistantMessage:
			if ev.Item.Text == "working" {
				child = ev.Item
			}
		}
	}
	if subagent == nil || child == nil {
		t.Fatalf("subagent=%+v child=%+v", subagent, child)
	}
	if child.ParentItemID != subagent.ID {
		t.Fatalf("child parent = %q, want %q", child.ParentItemID, subagent.ID)
	}
}

func TestMapBackgroundTaskLifecycle(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	evs := feed(t, m,
		`{"type":"assistant","session_id":"s1","uuid":"k1","parent_tool_use_id":null,"message":{"id":"msg_t","role":"assistant","content":[{"type":"tool_use","id":"toolu_t","name":"Task","input":{"description":"bg"}}]}}`,
		`{"type":"system","subtype":"task_started","session_id":"s1","task_id":"task-1","tool_use_id":"toolu_t","description":"bg work","subagent_type":"general-purpose","is_backgrounded":true}`,
		`{"type":"system","subtype":"task_notification","session_id":"s1","task_id":"task-1","status":"stopped","summary":"stopped by user"}`,
	)
	var sub *domain.Item
	for _, ev := range evs {
		if ev.Item != nil && ev.Item.Kind == domain.ItemSubagent {
			sub = ev.Item
		}
	}
	if sub == nil {
		t.Fatalf("no subagent in %+v", evs)
	}
	if sub.AgentID != "task-1" || sub.Text != "stopped by user" || sub.Status != domain.ItemFailed {
		t.Fatalf("subagent = %+v", sub)
	}
}

func TestMapTaskStartedWithoutToolUse(t *testing.T) {
	m := NewMapper("s1")
	evs := feed(t, m,
		`{"type":"system","subtype":"task_started","session_id":"s1","task_id":"task-9","description":"work","task_type":"local_agent","prompt":"do it"}`,
	)
	sub := lastItemKind(t, evs, domain.ItemSubagent)
	if sub.AgentID != "task-9" || sub.Text != "work" || sub.Status != domain.ItemStreaming {
		t.Fatalf("subagent = %+v", sub)
	}
	done := feed(t, m, `{"type":"system","subtype":"task_notification","session_id":"s1","task_id":"task-9","status":"completed","summary":"done"}`)
	sub = lastItemKind(t, done, domain.ItemSubagent)
	if sub.Status != domain.ItemCompleted || sub.Text != "done" {
		t.Fatalf("subagent = %+v", sub)
	}
	if evs := feed(t, m, `{"type":"system","subtype":"task_notification","session_id":"s1","task_id":"unknown","status":"completed"}`); len(evs) != 0 {
		t.Fatalf("unknown task = %+v", evs)
	}
	if evs := feed(t, m, `{"type":"system","subtype":"task_started","session_id":"s1"}`); len(evs) != 0 {
		t.Fatalf("no task id = %+v", evs)
	}
	if evs := feed(t, m, `{"type":"system","subtype":"background_tasks_changed","session_id":"s1"}`); len(evs) != 0 {
		t.Fatalf("other system = %+v", evs)
	}
}

func lastItemKind(t *testing.T, events []domain.Event, kind domain.ItemKind) *domain.Item {
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

func TestMapRateLimit(t *testing.T) {
	m := NewMapper("s1")
	evs := feed(t, m, `{"type":"rate_limit_event","session_id":"s1","rate_limit_info":{"status":"allowed_warning","resetsAt":1790000000,"rateLimitType":"five_hour","utilization":0.42}}`)
	if len(evs) != 1 || evs[0].Type != domain.EventQuota {
		t.Fatalf("events = %+v", evs)
	}
	q := evs[0].Quota
	if q.Agent != domain.AgentClaude || len(q.Windows) != 1 {
		t.Fatalf("quota = %+v", q)
	}
	w := q.Windows[0]
	if w.Name != "five_hour" || w.UsedPct != 42 || w.ResetsAt.Unix() != 1790000000 || w.Status != "allowed_warning" {
		t.Fatalf("window = %+v", w)
	}

	rejected := feed(t, m, `{"type":"rate_limit_event","session_id":"s1","rate_limit_info":{"status":"rejected","rateLimitType":"seven_day","utilization":88}}`)
	if !rejected[0].Quota.Reached || rejected[0].Quota.Windows[0].UsedPct != 88 {
		t.Fatalf("rejected = %+v", rejected[0].Quota)
	}
	if evs := feed(t, m, `{"type":"rate_limit_event","session_id":"s1","rate_limit_info":{"status":"allowed"}}`); len(evs) != 0 {
		t.Fatalf("no type = %+v", evs)
	}
	if evs := feed(t, m, `{"type":"rate_limit_event","session_id":"s1"}`); len(evs) != 0 {
		t.Fatalf("no info = %+v", evs)
	}
}

// Emitted items are snapshots: the mapper keeps mutating its own item while
// the event is being stored and sent concurrently.
func TestEmittedItemsAreSnapshots(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	started := feed(t, m,
		`{"type":"stream_event","session_id":"s1","uuid":"u1","event":{"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"u2","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}`,
	)
	feed(t, m,
		`{"type":"stream_event","session_id":"s1","uuid":"u3","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}`,
		`{"type":"stream_event","session_id":"s1","uuid":"u5","event":{"type":"content_block_stop","index":0}}`,
	)
	for _, ev := range started {
		if ev.Item != nil && (ev.Item.Text != "" || ev.Item.Status == domain.ItemCompleted) {
			t.Fatalf("emitted item changed afterwards: %+v", ev.Item)
		}
	}
}
