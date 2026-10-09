package domain

import (
	"errors"
	"testing"
	"time"
)

func quotaInterrupted(t *testing.T, resets time.Time) *Session {
	t.Helper()
	s, _ := NewSession("s1", AgentClaude, "/p")
	if err := s.RuntimeAttached("n1"); err != nil {
		t.Fatal(err)
	}
	if err := s.TurnStarted(); err != nil {
		t.Fatal(err)
	}
	if err := s.QuotaExhausted(resets); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestAutoContinueNeedsAQuotaResetTime(t *testing.T) {
	s, _ := NewSession("s1", AgentClaude, "/p")
	if err := s.SetAutoContinue(true); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("detached session: err = %v", err)
	}
	if err := s.SetAutoContinue(false); err != nil {
		t.Fatalf("turning it off is always allowed: %v", err)
	}
	if err := quotaInterrupted(t, time.Time{}).SetAutoContinue(true); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("no reset time: err = %v", err)
	}
}

func TestAutoContinueIsClearedByTheNextTurn(t *testing.T) {
	resets := time.Date(2026, 9, 28, 18, 0, 0, 0, time.UTC)
	s := quotaInterrupted(t, resets)
	if err := s.SetAutoContinue(true); err != nil {
		t.Fatal(err)
	}
	if !s.AutoContinue() || !s.Snapshot().AutoContinue {
		t.Fatal("auto-continue not recorded")
	}
	restored, err := RestoreSession(s.Snapshot())
	if err != nil || !restored.AutoContinue() {
		t.Fatalf("restore lost auto-continue: %v", err)
	}
	if err := s.TurnStarted(); err != nil {
		t.Fatal(err)
	}
	if s.AutoContinue() {
		t.Fatal("a new turn must clear auto-continue")
	}
}

func TestContinuableStatuses(t *testing.T) {
	s, _ := NewSession("s1", AgentClaude, "/p")
	if s.Continuable() {
		t.Fatal("a session with no conversation cannot continue")
	}
	_ = s.RuntimeAttached("n1")
	if s.Continuable() {
		t.Fatal("idle session has nothing to continue")
	}
	_ = s.TurnStarted()
	s.RuntimeExited(ExitCrashed)
	if !s.Continuable() {
		t.Fatal("interrupted session must continue")
	}
	d, _ := RestoreSession(SessionSnapshot{ID: "d", Agent: AgentClaude, Cwd: "/p", NativeID: "n", Status: StatusDetached})
	if !d.Continuable() {
		t.Fatal("detached session with a conversation must continue")
	}
}

func TestForkCopiesTheParentSettings(t *testing.T) {
	p, _ := NewSession("p", AgentCodex, "/proj")
	p.Rename("Refactor")
	_ = p.SetModel("gpt-x", "low")
	_ = p.SetApprovalReviewer(ReviewerUser)
	if _, err := NewForkSession("f", p); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("fork without a conversation: err = %v", err)
	}
	_ = p.RuntimeAttached("thread-1")
	f, err := NewForkSession("f", p)
	if err != nil {
		t.Fatal(err)
	}
	snap := f.Snapshot()
	if snap.ForkOf != "p" || snap.NativeID != "" || snap.Agent != AgentCodex || snap.Cwd != "/proj" ||
		snap.Model != "gpt-x" || snap.Effort != "low" || snap.ApprovalReviewer != ReviewerUser ||
		snap.Title != "Refactor (fork)" || snap.Status != StatusDetached {
		t.Fatalf("fork = %+v", snap)
	}
	if r, _ := RestoreSession(snap); r.ForkOf() != "p" {
		t.Fatal("restore lost the fork link")
	}
}

func TestForkToAnotherAgentResetsProviderSettings(t *testing.T) {
	p, _ := NewSession("p", AgentClaude, "/p")
	_ = p.RuntimeAttached("native")
	_ = p.SetModel("opus", "max")
	_ = p.SetPermissionMode("bypassPermissions")
	f, err := NewForkSession("f", p, AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	s := f.Snapshot()
	if s.Agent != AgentCodex || s.Model != "" || s.Effort != "" || s.PermissionMode != "" || s.ApprovalReviewer != "" || s.ForkOf != "p" {
		t.Fatalf("fork=%+v", s)
	}
	if _, err := NewForkSession("bad", p, AgentKind("unknown")); err == nil {
		t.Fatal("invalid agent accepted")
	}
}
