package app

import (
	"context"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type fakeShells struct {
	within   []string
	unbound  [][]domain.SessionID
	onClose  func()
	onUnbind func()
}

func (s *fakeShells) CloseWithin(dir string) int {
	s.within = append(s.within, dir)
	if s.onClose != nil {
		s.onClose()
	}
	return 1
}

func (s *fakeShells) Unbind(ids ...domain.SessionID) {
	s.unbound = append(s.unbound, ids)
	if s.onUnbind != nil {
		s.onUnbind()
	}
}

// Removing a worktree closes the shells in its folder, once the folder is
// gone; a refused removal leaves them.
func TestRemoveWorktreeClosesItsShells(t *testing.T) {
	m, _, _, _ := newArchiveManager(t)
	git := &fakeGit{top: "/src/app"}
	shells := &fakeShells{}
	w := NewWorktrees(WorktreesConfig{Sessions: m, Git: git, Root: "/data/worktrees", Terminals: shells})
	ctx := context.Background()
	snap, err := w.Create(ctx, domain.AgentClaude, "/src/app", "x")
	if err != nil {
		t.Fatal(err)
	}
	git.removeEr = ErrWorktreeDirty
	if _, err := w.Remove(ctx, snap.ID, false); !errors.Is(err, ErrWorktreeDirty) {
		t.Fatalf("dirty: err = %v", err)
	}
	if len(shells.within) != 0 {
		t.Fatalf("a refused removal closed shells in %v", shells.within)
	}
	// The shells are gone by the time the removal is announced, so a
	// client refreshing its terminals then doesn't find them.
	marked := true
	shells.onClose = func() {
		got, _ := m.GetSession(ctx, snap.ID)
		marked = got.Worktree.Removed
	}
	if _, err := w.Remove(ctx, snap.ID, true); err != nil {
		t.Fatal(err)
	}
	if len(shells.within) != 1 || shells.within[0] != "/data/worktrees/app/x" {
		t.Fatalf("closed shells in %v", shells.within)
	}
	if marked {
		t.Fatal("shells closed after the removal was recorded")
	}
}

// Deleting a session together with its worktree folder closes the shells
// in the folder too.
func TestDeleteWithTheFolderClosesItsShells(t *testing.T) {
	m, _, _, _ := newArchiveManager(t)
	shells := &fakeShells{}
	w := NewWorktrees(WorktreesConfig{Sessions: m, Git: &fakeGit{top: "/src/app"}, Root: "/data/worktrees", Terminals: shells})
	ctx := context.Background()
	snap, _ := w.Create(ctx, domain.AgentClaude, "/src/app", "x")
	if err := w.Delete(ctx, snap.ID, true); err != nil {
		t.Fatal(err)
	}
	if len(shells.within) != 1 || shells.within[0] != "/data/worktrees/app/x" {
		t.Fatalf("closed shells in %v", shells.within)
	}
}

// A deleted session's shells, and its subagents', are let go of before
// the deletion is announced, so a client refreshing its terminals then
// finds them unbound: they keep running as ordinary terminals instead of
// naming a session that is gone. A refused delete keeps them bound.
func TestDeleteSessionUnbindsItsShells(t *testing.T) {
	repo, bus, factory, ids := newMemRepo(), newFakeBus(), &fakeFactory{}, &counter{}
	shells := &fakeShells{}
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: factory, Bus: bus, Eraser: repo, NewID: ids.next, Terminals: shells})
	t.Cleanup(m.Close)
	ctx := context.Background()
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	busy := createClaude(t, m)
	if err := m.SendMessage(ctx, busy.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	if err := m.DeleteSession(ctx, busy.ID); !errors.Is(err, domain.ErrSessionBusy) {
		t.Fatalf("delete running: %v", err)
	}
	if len(shells.unbound) != 0 {
		t.Fatalf("a refused delete unbound %v", shells.unbound)
	}

	parent := createClaude(t, m)
	child := domain.SessionSnapshot{ID: "child", Agent: domain.AgentClaude, Cwd: "/tmp/proj", ParentID: parent.ID, Status: domain.StatusDetached}
	if err := repo.Save(ctx, child); err != nil {
		t.Fatal(err)
	}
	announced := -1
	shells.onUnbind = func() {
		announced = 0
		for _, ev := range bus.snapshot() {
			if ev.Type == domain.EventSessionRemoved {
				announced++
			}
		}
	}
	if err := m.DeleteSession(ctx, parent.ID); err != nil {
		t.Fatal(err)
	}
	if len(shells.unbound) != 1 || len(shells.unbound[0]) != 2 || shells.unbound[0][0] != parent.ID || shells.unbound[0][1] != "child" {
		t.Fatalf("unbound = %v", shells.unbound)
	}
	if announced != 0 {
		t.Fatalf("unbound after %d removals were announced", announced)
	}
}
