package domain

import (
	"errors"
	"testing"
)

func TestWorktreeSurvivesSnapshotAndRestore(t *testing.T) {
	s, _ := NewSession("s1", AgentClaude, "/wt/app/fix")
	wt := Worktree{Repo: "/src/app", Path: "/wt/app/fix", Branch: "chamber/fix", Base: "abc123"}
	if err := s.SetWorktree(&wt); err != nil {
		t.Fatal(err)
	}
	snap := s.Snapshot()
	if snap.Worktree == nil || *snap.Worktree != wt {
		t.Fatalf("snapshot worktree = %+v", snap.Worktree)
	}
	snap.Worktree.Branch = "mutated"
	if s.Worktree().Branch != "chamber/fix" {
		t.Fatal("snapshot shares the session's worktree")
	}
	r, err := RestoreSession(s.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	if got := r.Worktree(); got == nil || *got != wt {
		t.Fatalf("restored worktree = %+v", got)
	}
}

func TestWorktreeMustBeTheSessionFolder(t *testing.T) {
	s, _ := NewSession("s1", AgentClaude, "/src/app")
	err := s.SetWorktree(&Worktree{Repo: "/src/app", Path: "/wt/app/fix", Branch: "chamber/fix", Base: "abc"})
	if !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("err = %v", err)
	}
	if err := s.SetWorktree(&Worktree{Path: "/src/app"}); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("incomplete worktree: err = %v", err)
	}
	if s.Worktree() != nil {
		t.Fatal("rejected worktree was kept")
	}
}

func TestWorktreeCanBeCleared(t *testing.T) {
	s, _ := NewSession("s1", AgentClaude, "/wt")
	_ = s.SetWorktree(&Worktree{Repo: "/r", Path: "/wt", Branch: "b", Base: "c"})
	if err := s.SetWorktree(nil); err != nil {
		t.Fatal(err)
	}
	if s.Worktree() != nil || s.Snapshot().Worktree != nil {
		t.Fatal("worktree not cleared")
	}
}

func removableSession(t *testing.T) *Session {
	t.Helper()
	s, _ := NewSession("s1", AgentClaude, "/wt/app/fix")
	mustNoErr(t, s.SetWorktree(&Worktree{Repo: "/src/app", Path: "/wt/app/fix", Branch: "chamber/fix", Base: "abc"}))
	return s
}

func TestRemovedWorktreeIsRemembered(t *testing.T) {
	s := removableSession(t)
	mustNoErr(t, s.RemoveWorktree())
	wt := s.Worktree()
	if wt == nil || !wt.Removed || wt.Repo != "/src/app" || wt.Branch != "chamber/fix" {
		t.Fatalf("worktree after removal = %+v", wt)
	}
	if !s.WorktreeRemoved() {
		t.Fatal("WorktreeRemoved = false")
	}
	r, err := RestoreSession(s.Snapshot())
	mustNoErr(t, err)
	if !r.WorktreeRemoved() || r.Worktree().Branch != "chamber/fix" {
		t.Fatalf("restored = %+v", r.Worktree())
	}
}

func TestRemoveWorktreeRefusals(t *testing.T) {
	plain, _ := NewSession("s1", AgentClaude, "/src/app")
	if err := plain.RemoveWorktree(); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("no worktree: err = %v", err)
	}
	if plain.WorktreeRemoved() {
		t.Fatal("plain session reads as removed")
	}
	s := removableSession(t)
	mustNoErr(t, s.RuntimeAttached("n"))
	mustNoErr(t, s.TurnStarted())
	if err := s.WorktreeRemovable(); !errors.Is(err, ErrSessionBusy) {
		t.Fatalf("running: removable = %v", err)
	}
	if err := s.RemoveWorktree(); !errors.Is(err, ErrSessionBusy) {
		t.Fatalf("running: err = %v", err)
	}
	if s.WorktreeRemoved() {
		t.Fatal("removed while running")
	}
	mustNoErr(t, s.TurnCompleted())
	mustNoErr(t, s.WorktreeRemovable())
	mustNoErr(t, s.RemoveWorktree())
	if err := s.RemoveWorktree(); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("twice: err = %v", err)
	}
}

func TestRemovedWorktreeTakesNoTurns(t *testing.T) {
	s := removableSession(t)
	mustNoErr(t, s.Workable())
	mustNoErr(t, s.RemoveWorktree())
	if err := s.Workable(); !errors.Is(err, ErrWorktreeRemoved) {
		t.Fatalf("Workable = %v", err)
	}
	mustNoErr(t, s.RuntimeAttached("n"))
	if err := s.TurnStarted(); !errors.Is(err, ErrWorktreeRemoved) {
		t.Fatalf("TurnStarted = %v", err)
	}
	if s.Status() == StatusRunning {
		t.Fatal("turn started in a removed worktree")
	}
}

func TestForkOfRemovedWorktreeLandsInTheRepo(t *testing.T) {
	s := removableSession(t)
	mustNoErr(t, s.RuntimeAttached("n"))
	live, err := NewForkSession("f1", s)
	mustNoErr(t, err)
	if live.Cwd() != "/wt/app/fix" {
		t.Fatalf("live fork cwd = %s", live.Cwd())
	}
	mustNoErr(t, s.RemoveWorktree())
	f, err := NewForkSession("f2", s)
	mustNoErr(t, err)
	if f.Cwd() != "/src/app" || f.Worktree() != nil {
		t.Fatalf("fork cwd = %s worktree = %+v", f.Cwd(), f.Worktree())
	}
}
