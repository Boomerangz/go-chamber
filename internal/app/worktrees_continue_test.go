package app

import (
	"context"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// A kept branch goes on in a new worktree and session, from the same
// slug a new branch would get.
func TestContinueOnAnExistingBranch(t *testing.T) {
	w, m, git, _ := newTestWorktrees(t)
	ctx := context.Background()
	snap, err := w.Continue(ctx, domain.AgentCodex, "/src/app/sub", "chamber/Checkout fix")
	if err != nil {
		t.Fatal(err)
	}
	if len(git.added) != 0 || len(git.continued) != 1 || git.continued[0] != "/src/app|/data/worktrees/app/checkout-fix|chamber/checkout-fix" {
		t.Fatalf("added %v, continued %v", git.added, git.continued)
	}
	got, _ := m.GetSession(ctx, snap.ID)
	if got.Agent != domain.AgentCodex || got.Cwd != "/data/worktrees/app/checkout-fix" || got.Worktree == nil || got.Worktree.Base != "fork1" || got.Worktree.Branch != "chamber/checkout-fix" {
		t.Fatalf("session = %+v, worktree %+v", got, got.Worktree)
	}
}

func TestContinueRefusals(t *testing.T) {
	w, _, git, _ := newTestWorktrees(t)
	ctx := context.Background()
	if _, err := w.Continue(ctx, domain.AgentClaude, "/src/app", "!!"); !errors.Is(err, ErrInvalidBranch) {
		t.Fatalf("empty slug: err = %v", err)
	}
	git.continueErr = &BranchInUseError{Branch: "chamber/x", Path: "/data/worktrees/app/x"}
	_, err := w.Continue(ctx, domain.AgentClaude, "/src/app", "x")
	var used *BranchInUseError
	if !errors.Is(err, ErrBranchCheckedOut) || !errors.As(err, &used) || used.Path != "/data/worktrees/app/x" {
		t.Fatalf("checked out: err = %v", err)
	}
	if err.Error() != "branch chamber/x is checked out at /data/worktrees/app/x" {
		t.Fatalf("message = %q", err)
	}
	if errors.Is(errors.New("other"), ErrBranchCheckedOut) || errors.Is(err, ErrBranchExists) {
		t.Fatal("BranchInUseError matches the wrong errors")
	}
}
