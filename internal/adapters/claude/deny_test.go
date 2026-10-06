package claude

import (
	"context"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// A tool the owner denied never ran: it has no exit code and is not a
// failure of its own; the decision record says what happened.
func TestMapDeniedToolNeverRan(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	feed(t, m,
		`{"type":"assistant","session_id":"s1","uuid":"d1","parent_tool_use_id":null,"message":{"id":"msg_d","role":"assistant","content":[{"type":"tool_use","id":"toolu_d","name":"Bash","input":{"command":"rm x"}},{"type":"tool_use","id":"toolu_f","name":"Bash","input":{"command":"false"}}]}}`,
		`{"type":"control_request","request_id":"perm-d","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm x"},"tool_use_id":"toolu_d"}}`,
	)
	m.Deny("perm-d")
	if _, ok := m.Pending("perm-d"); ok {
		t.Fatal("a denied request must be forgotten")
	}
	evs := feed(t, m,
		`{"type":"user","session_id":"s1","uuid":"d2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_d","is_error":true,"content":"nope"},{"type":"tool_result","tool_use_id":"toolu_f","is_error":true,"content":"exit 1"}]}}`,
	)
	byCmd := map[string]*domain.Item{}
	for _, ev := range evs {
		if ev.Item != nil {
			byCmd[inputString(ev.Item.Input, "command")] = ev.Item
		}
	}
	denied, failed := byCmd["rm x"], byCmd["false"]
	if denied == nil || denied.ExitCode != nil || denied.Status != domain.ItemCompleted || denied.Text != "nope" {
		t.Fatalf("denied = %+v", denied)
	}
	if failed == nil || failed.ExitCode == nil || *failed.ExitCode != 1 || failed.Status != domain.ItemFailed {
		t.Fatalf("failed = %+v", failed)
	}
	m.Deny("unknown") // no pending request: nothing to remember
	if len(m.denied) != 0 {
		t.Fatalf("denied = %v", m.denied)
	}
}

func TestRuntimeDeniedCommandHasNoExitCode(t *testing.T) {
	rt := startFake(t, app.StartRequest{}, "FAKECLAUDE_MODE=permission")
	if err := rt.Send(context.Background(), "t1", "rm -rf x"); err != nil {
		t.Fatal(err)
	}
	req := waitRequest(t, rt)
	if err := rt.Respond(context.Background(), req.ID, app.RequestAnswer{Allow: false, Message: "nope"}); err != nil {
		t.Fatal(err)
	}
	events := drain(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	var cmd *domain.Item
	for _, ev := range events {
		if ev.Item != nil && ev.Item.Kind == domain.ItemCommand {
			cmd = ev.Item
		}
	}
	if cmd == nil || cmd.ExitCode != nil || cmd.Status != domain.ItemCompleted {
		t.Fatalf("command = %+v", cmd)
	}
}
