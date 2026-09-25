package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestQuotaSnapshotValidate(t *testing.T) {
	good := QuotaSnapshot{Agent: AgentClaude, Windows: []QuotaWindow{
		{Name: "five_hour", UsedPct: 42.5, ResetsAt: time.Now()},
	}}
	if err := good.Validate(); err != nil {
		t.Fatalf("valid snapshot rejected: %v", err)
	}
	cases := []QuotaSnapshot{
		{Agent: AgentKind("gemini")},
		{Agent: AgentClaude, Windows: []QuotaWindow{{UsedPct: 1}}},
		{Agent: AgentClaude, Windows: []QuotaWindow{{Name: "x", UsedPct: 101}}},
		{Agent: AgentClaude, Windows: []QuotaWindow{{Name: "x", UsedPct: -1}}},
	}
	for _, tc := range cases {
		if err := tc.Validate(); !errors.Is(err, ErrInvalidQuota) {
			t.Fatalf("want ErrInvalidQuota for %+v, got %v", tc, err)
		}
	}
}

func TestQuotaEventsValidate(t *testing.T) {
	if err := (Event{SessionID: "s", Type: EventQuota}).Valid(); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("quota without snapshot: %v", err)
	}
	if err := (Event{SessionID: "s", Type: EventUsage}).Valid(); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("usage without payload: %v", err)
	}
	if err := (Event{SessionID: "s", Type: EventQuota, Quota: &QuotaSnapshot{Agent: AgentCodex}}).Valid(); err != nil {
		t.Fatalf("valid quota: %v", err)
	}
	if err := (Event{SessionID: "s", Type: EventUsage, Usage: &Usage{TotalTokens: 5}}).Valid(); err != nil {
		t.Fatalf("valid usage: %v", err)
	}
}

// A window without a known reset must not serialize Go's zero time: the UI
// rendered it as "resets 1/1/1".
func TestZeroTimesAreOmittedFromJSON(t *testing.T) {
	raw, err := json.Marshal(QuotaSnapshot{Agent: AgentCodex, Windows: []QuotaWindow{{Name: "primary"}}})
	if err != nil {
		t.Fatal(err)
	}
	if s := string(raw); strings.Contains(s, "resetsAt") || strings.Contains(s, "updatedAt") {
		t.Fatalf("zero times serialized: %s", s)
	}
	raw, err = json.Marshal(SessionSnapshot{ID: "s", Agent: AgentClaude, Cwd: "/", Status: StatusIdle})
	if err != nil {
		t.Fatal(err)
	}
	if s := string(raw); strings.Contains(s, "interruption") || strings.Contains(s, "resumeAfter") {
		t.Fatalf("empty interruption serialized: %s", s)
	}
}
