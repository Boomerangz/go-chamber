package domain

import (
	"errors"
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
