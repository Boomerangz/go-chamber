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
