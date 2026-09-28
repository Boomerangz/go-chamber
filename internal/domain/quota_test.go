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

func TestQuotaMergeKeepsWindowsNotReported(t *testing.T) {
	prev := QuotaSnapshot{Agent: AgentClaude, Plan: "max", Windows: []QuotaWindow{
		{Name: "five_hour", UsedPct: 10}, {Name: "seven_day", UsedPct: 50},
	}}
	got := prev.Merge(QuotaSnapshot{Agent: AgentClaude, Reached: true, Windows: []QuotaWindow{{Name: "seven_day", UsedPct: 100}}})
	if len(got.Windows) != 2 || got.Windows[0].UsedPct != 10 || got.Windows[1].UsedPct != 100 {
		t.Fatalf("windows = %+v", got.Windows)
	}
	if got.Plan != "max" || !got.Reached {
		t.Fatalf("merged = %+v", got)
	}
	if prev.Windows[1].UsedPct != 50 {
		t.Fatal("merge mutated the previous snapshot")
	}
	added := prev.Merge(QuotaSnapshot{Agent: AgentClaude, Plan: "pro", Windows: []QuotaWindow{{Name: "opus", UsedPct: 5}}})
	if len(added.Windows) != 3 || added.Windows[2].Name != "opus" || added.Plan != "pro" {
		t.Fatalf("added = %+v", added)
	}
	other := prev.Merge(QuotaSnapshot{Agent: AgentCodex, Windows: []QuotaWindow{{Name: "primary"}}})
	if len(other.Windows) != 1 || other.Agent != AgentCodex {
		t.Fatalf("other agent = %+v", other)
	}
}

func TestQuotaResetsAt(t *testing.T) {
	early, late := time.Unix(100, 0), time.Unix(200, 0)
	exhausted := QuotaSnapshot{Windows: []QuotaWindow{
		{Name: "a", UsedPct: 20, ResetsAt: late},
		{Name: "b", Status: "rejected", ResetsAt: early},
	}}
	if got := exhausted.ResetsAt(); !got.Equal(early) {
		t.Fatalf("exhausted resets = %v", got)
	}
	full := QuotaSnapshot{Windows: []QuotaWindow{{Name: "a", UsedPct: 100, ResetsAt: early}, {Name: "b", ResetsAt: late}}}
	if got := full.ResetsAt(); !got.Equal(early) {
		t.Fatalf("full resets = %v", got)
	}
	unmarked := QuotaSnapshot{Windows: []QuotaWindow{{Name: "a", ResetsAt: early}, {Name: "b", ResetsAt: late}}}
	if got := unmarked.ResetsAt(); !got.Equal(late) {
		t.Fatalf("unmarked resets = %v", got)
	}
	if !(QuotaSnapshot{}).ResetsAt().IsZero() {
		t.Fatal("empty snapshot resets")
	}
}

func TestQuotaMergeReachedFollowsAllWindows(t *testing.T) {
	blocked := QuotaSnapshot{Agent: AgentClaude, Reached: true, Windows: []QuotaWindow{
		{Name: "five_hour", UsedPct: 100, Status: "rejected"}, {Name: "seven_day", UsedPct: 40},
	}}
	if got := blocked.Merge(QuotaSnapshot{Agent: AgentClaude, Windows: []QuotaWindow{{Name: "seven_day", UsedPct: 41, Status: "allowed"}}}); !got.Reached {
		t.Fatalf("a report on another window cleared the limit: %+v", got)
	}
	if got := blocked.Merge(QuotaSnapshot{Agent: AgentClaude, Windows: []QuotaWindow{{Name: "five_hour", UsedPct: 3, Status: "allowed"}}}); got.Reached {
		t.Fatalf("limit stays reached after its window lifted: %+v", got)
	}
}

func TestQuotaMergeIgnoresALimitThatHasReset(t *testing.T) {
	now := time.Unix(1000, 0)
	old := QuotaSnapshot{Agent: AgentClaude, Reached: true, Windows: []QuotaWindow{
		{Name: "five_hour", UsedPct: 100, Status: "rejected", ResetsAt: now.Add(-time.Minute)},
	}}
	got := old.Merge(QuotaSnapshot{Agent: AgentClaude, UpdatedAt: now, Windows: []QuotaWindow{{Name: "seven_day", UsedPct: 10}}})
	if got.Reached {
		t.Fatalf("a limit that already reset still counts: %+v", got)
	}
}
