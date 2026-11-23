package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNewGoalRequiresABoundedObjective(t *testing.T) {
	if _, err := NewGoal("  \n"); err == nil {
		t.Fatal("empty objective accepted")
	}
	if _, err := NewGoal(strings.Repeat("x", GoalObjectiveLimit+1)); err == nil {
		t.Fatal("oversized objective accepted")
	}
	g, err := NewGoal("  ship it ")
	if err != nil || g.Objective != "ship it" || g.Status != GoalActive {
		t.Fatalf("%+v %v", g, err)
	}
}

func TestGoalContinuesOnlyWhileActiveAndUnderTheTurnCap(t *testing.T) {
	g, _ := NewGoal("ship it")
	for i := 0; i < GoalMaxAutoTurns; i++ {
		if !g.Continue() {
			t.Fatalf("stopped early at %d", i)
		}
	}
	if g.Continue() || g.Status != GoalPaused || g.Note == "" {
		t.Fatalf("turn cap not enforced: %+v", g)
	}
	if err := g.Resume(); err != nil || g.Status != GoalActive || g.TurnsUsed != 0 || g.Note != "" {
		t.Fatalf("resume did not grant a fresh run: %+v %v", g, err)
	}
	g.Pause("stopped")
	if g.Continue() || g.Note != "stopped" {
		t.Fatalf("paused goal continued: %+v", g)
	}
}

func TestGoalBudgetStopsThePursuitUntilRaised(t *testing.T) {
	g, _ := NewGoal("ship it")
	g.SetBudget(100)
	g.Spend(60)
	if g.Status != GoalActive {
		t.Fatalf("stopped under budget: %+v", g)
	}
	g.Spend(40)
	if g.Status != GoalBudgetLimited || g.Continue() {
		t.Fatalf("budget not enforced: %+v", g)
	}
	if err := g.Resume(); err == nil {
		t.Fatal("resumed past the budget")
	}
	g.SetBudget(500)
	if err := g.Resume(); err != nil || g.Status != GoalActive {
		t.Fatalf("raised budget did not allow resuming: %+v %v", g, err)
	}
	g.Pause("stopped")
	g.Spend(1000)
	if g.Status != GoalPaused || g.TokensUsed != 100 {
		t.Fatalf("usage outside the pursuit was charged: %+v", g)
	}
}

func TestGoalVerdictsSettleOnlyOnEvidenceOrARepeatedBlocker(t *testing.T) {
	g, _ := NewGoal("ship it")
	g.Judge(GoalVerdictContinue, "half done")
	if g.Status != GoalActive || g.Note != "half done" {
		t.Fatalf("%+v", g)
	}
	for i := 1; i < GoalBlockedStreakLimit; i++ {
		g.Judge(GoalVerdictBlocked, "needs a key")
		if g.Status != GoalActive {
			t.Fatalf("one-off blocker ended the goal at %d", i)
		}
	}
	g.Judge(GoalVerdictContinue, "moving")
	if g.BlockedStreak != 0 {
		t.Fatal("progress did not reset the blocker streak")
	}
	for i := 0; i < GoalBlockedStreakLimit; i++ {
		g.Judge(GoalVerdictBlocked, "needs a key")
	}
	if g.Status != GoalBlocked || g.Note != "needs a key" {
		t.Fatalf("repeated blocker did not settle: %+v", g)
	}
	_ = g.Resume()
	g.Judge(GoalVerdictComplete, "verified")
	if g.Status != GoalComplete || g.Continue() {
		t.Fatalf("%+v", g)
	}
}

func TestGoalStopsWhenTheAuditorStaysUnavailable(t *testing.T) {
	g, _ := NewGoal("ship it")
	g.AuditFailed()
	if g.Status != GoalActive {
		t.Fatal("one audit failure stopped the goal")
	}
	g.Judge(GoalVerdictContinue, "")
	g.AuditFailed()
	if g.Status != GoalActive {
		t.Fatal("a successful audit did not reset the failure count")
	}
	g.AuditFailed()
	if g.Status != GoalPaused || !strings.Contains(g.Note, "audit") {
		t.Fatalf("blind pursuit not stopped: %+v", g)
	}
}

func TestGoalSummaryNamesStateAndUsage(t *testing.T) {
	g, _ := NewGoal("ship it")
	g.SetBudget(1000)
	g.Spend(250)
	g.Continue()
	g.Judge(GoalVerdictContinue, "half done")
	got := g.Summary()
	for _, want := range []string{"Goal active", "ship it", "1 of 20", "250 of 1000", "half done"} {
		if !strings.Contains(got, want) {
			t.Errorf("summary lacks %q: %s", want, got)
		}
	}
	if progress := g.Progress(); strings.Contains(progress, "ship it") || !strings.Contains(progress, "half done") {
		t.Errorf("progress line repeats the objective or drops the note: %s", progress)
	}
	g.SetBudget(0)
	if !strings.Contains(g.Progress(), "· 250 tokens") {
		t.Errorf("unbudgeted usage: %s", g.Progress())
	}
}

func TestGoalReachesTheSessionSnapshotAsItsOwnCopy(t *testing.T) {
	s, err := NewSession("s", AgentNative, "/tmp")
	if err != nil {
		t.Fatal(err)
	}
	g, _ := NewGoal("ship it")
	s.SetGoal(g)
	g.Pause("later change")
	if got := s.Snapshot().Goal; got == nil || got.Status != GoalActive || got.Objective != "ship it" {
		t.Fatalf("snapshot follows the runtime's goal: %+v", got)
	}
	raw, _ := json.Marshal(s.Snapshot())
	if !strings.Contains(string(raw), `"goal":{"objective":"ship it","status":"active"}`) {
		t.Fatalf("goal wire form: %s", raw)
	}
	s.SetGoal(nil)
	if s.Snapshot().Goal != nil {
		t.Fatal("cleared goal kept")
	}
	for _, ev := range []Event{{SessionID: "s", Type: EventGoal, Goal: g}, {SessionID: "s", Type: EventGoal}} {
		if err := ev.Valid(); err != nil {
			t.Fatalf("goal event rejected: %v", err)
		}
	}
}
