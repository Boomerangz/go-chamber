package app

import (
	"context"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type forkedWorktree struct {
	w            *Worktrees
	m            *Manager
	git          *fakeGit
	parent, fork domain.SessionSnapshot
	forkRT       *fakeRuntime
}

// forkInWorktree creates a worktree session, runs a turn to the end and
// forks it while the worktree is there.
func forkInWorktree(t *testing.T) forkedWorktree {
	t.Helper()
	m, _, _, factory := newArchiveManager(t)
	git := &fakeGit{top: "/src/app"}
	w := NewWorktrees(WorktreesConfig{Sessions: m, Git: git, Root: "/data/worktrees"})
	ctx := context.Background()
	parent, err := w.Create(ctx, domain.AgentClaude, "/src/app", "short")
	if err != nil {
		t.Fatal(err)
	}
	prt := newFakeRuntime("native-1")
	startWith(t, m, factory, parent.ID, prt)
	endTurn(t, m, prt, parent.ID)
	frt := newFakeRuntime("native-2")
	factory.next = frt
	fork, err := m.Fork(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	return forkedWorktree{w: w, m: m, git: git, parent: parent, fork: fork, forkRT: frt}
}

func TestForkOfAWorktreeSessionSharesTheWorktree(t *testing.T) {
	f := forkInWorktree(t)
	if f.fork.Cwd != f.parent.Cwd || f.fork.Worktree == nil || *f.fork.Worktree != *f.parent.Worktree {
		t.Fatalf("fork = %+v worktree %+v, parent worktree %+v", f.fork, f.fork.Worktree, f.parent.Worktree)
	}
	if got, _ := f.m.GetSession(context.Background(), f.fork.ID); got.Worktree == nil || got.Worktree.Branch != "chamber/short" {
		t.Fatalf("stored = %+v", got.Worktree)
	}
}

// Removing a worktree two sessions share takes the folder once and marks
// both removed, whichever of them asked.
func TestRemovingASharedWorktreeMarksEverySessionInIt(t *testing.T) {
	f := forkInWorktree(t)
	ctx := context.Background()
	other, _ := f.w.Create(ctx, domain.AgentClaude, "/src/app", "other")
	if _, err := f.w.Remove(ctx, f.fork.ID, true); err != nil {
		t.Fatal(err)
	}
	if len(f.git.removed) != 1 || f.git.removed[0].Path != f.parent.Cwd {
		t.Fatalf("removed = %+v", f.git.removed)
	}
	for _, id := range []domain.SessionID{f.parent.ID, f.fork.ID} {
		if got, _ := f.m.GetSession(ctx, id); got.Worktree == nil || !got.Worktree.Removed {
			t.Fatalf("%s: worktree = %+v", id, got.Worktree)
		}
	}
	if got, _ := f.m.GetSession(ctx, other.ID); got.Worktree.Removed {
		t.Fatal("another worktree was marked removed")
	}
	if _, err := f.w.Remove(ctx, f.parent.ID, true); !errors.Is(err, ErrNoWorktree) {
		t.Fatalf("second remove: err = %v", err)
	}
}

// A turn running in any session of the worktree keeps its folder.
func TestASharedWorktreeStaysWhileASessionInItRuns(t *testing.T) {
	f := forkInWorktree(t)
	ctx := context.Background()
	if err := f.m.SendMessage(ctx, f.fork.ID, "go"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.w.Remove(ctx, f.parent.ID, true); !errors.Is(err, domain.ErrSessionBusy) {
		t.Fatalf("err = %v", err)
	}
	if err := f.w.Delete(ctx, f.parent.ID, true); !errors.Is(err, domain.ErrSessionBusy) {
		t.Fatalf("delete: err = %v", err)
	}
	if len(f.git.removed) != 0 {
		t.Fatal("git removed the folder under a running turn")
	}
	if got, _ := f.m.GetSession(ctx, f.parent.ID); got.Worktree.Removed {
		t.Fatal("a refused removal marked the worktree removed")
	}
	endTurn(t, f.m, f.forkRT, f.fork.ID)
	if err := f.w.Delete(ctx, f.parent.ID, true); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.m.GetSession(ctx, f.fork.ID); got.Worktree == nil || !got.Worktree.Removed {
		t.Fatalf("fork after its worktree went with the parent: %+v", got.Worktree)
	}
}
