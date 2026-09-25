package claude

import (
	"os"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// TestGoldenToolTurn maps a recorded stream-json transcript. It mirrors the
// message shapes of @anthropic-ai/claude-agent-sdk (0.3.x); re-record it from
// the real CLI whenever the installed version changes.
func TestGoldenToolTurn(t *testing.T) {
	raw, err := os.ReadFile("testdata/tool_turn.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	m := NewMapper("s1")
	m.SetTurn("t1")

	var events []domain.Event
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		evs, err := m.Map([]byte(line))
		if err != nil {
			t.Fatalf("Map: %v", err)
		}
		events = append(events, evs...)
	}

	var assistant, command *domain.Item
	var result *domain.TurnResult
	for _, ev := range events {
		if err := ev.Valid(); err != nil {
			t.Fatalf("invalid event %+v: %v", ev, err)
		}
		switch {
		case ev.Item != nil && ev.Item.Kind == domain.ItemAssistantMessage:
			assistant = ev.Item
		case ev.Item != nil && ev.Item.Kind == domain.ItemCommand:
			command = ev.Item
		case ev.Type == domain.EventTurnEnded:
			result = ev.Result
		}
	}
	if assistant == nil || assistant.Text != "Let me check." || assistant.Status != domain.ItemCompleted {
		t.Fatalf("assistant = %+v", assistant)
	}
	if command == nil || command.Name != "Bash" || command.Text != "a.txt" || command.Status != domain.ItemCompleted {
		t.Fatalf("command = %+v", command)
	}
	if result == nil || result.Text != "done" || result.InputTokens != 100 || result.OutputTokens != 20 {
		t.Fatalf("result = %+v", result)
	}
}
