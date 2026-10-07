package app

import (
	"context"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// A worktree folder that goes takes the shells working in it, and in any
// folder below it; shells elsewhere, even in a folder sharing the prefix,
// stay.
func TestCloseWithinClosesShellsInTheFolder(t *testing.T) {
	f := newTermFixture(t)
	ctx := context.Background()
	open := func(cwd string) domain.Terminal {
		term, err := f.terms.Open(ctx, OpenTerminal{Cwd: cwd})
		if err != nil {
			t.Fatal(err)
		}
		return term
	}
	in := open("/wt/app/fix")
	below := open("/wt/app/fix/web")
	beside := open("/wt/app/fix-2")
	att, err := f.terms.Attach(in.ID)
	if err != nil {
		t.Fatal(err)
	}

	if n := f.terms.CloseWithin("/wt/app/fix"); n != 2 {
		t.Fatalf("closed %d, want 2", n)
	}
	waitClosed(t, att.Output)
	if _, err := f.terms.Get(in.ID); !errors.Is(err, ErrTerminalNotFound) {
		t.Fatalf("shell in the folder: err = %v", err)
	}
	if _, err := f.terms.Get(below.ID); !errors.Is(err, ErrTerminalNotFound) {
		t.Fatalf("shell below the folder: err = %v", err)
	}
	if got := f.terms.List(); len(got) != 1 || got[0].ID != beside.ID {
		t.Fatalf("left = %+v", got)
	}
	f.factory.mu.Lock()
	ptys := append([]*fakePTY(nil), f.factory.ptys...)
	f.factory.mu.Unlock()
	for i, want := range []bool{true, true, false} {
		if _, _, closed := ptys[i].snapshot(); closed != want {
			t.Errorf("pty %d closed = %v, want %v", i, closed, want)
		}
	}
	if n := f.terms.CloseWithin("/wt/app/fix"); n != 0 {
		t.Fatalf("closed again %d", n)
	}
}

// A deleted session's shells stay, as ordinary terminals: they no longer
// name the session.
func TestUnbindForgetsTheSession(t *testing.T) {
	f := newTermFixture(t)
	ctx := context.Background()
	for _, id := range []domain.SessionID{"s1", "s2", "s3"} {
		_ = f.repo.Save(ctx, domain.SessionSnapshot{ID: id, Agent: domain.AgentClaude, Cwd: "/work/" + string(id)})
	}
	var ids []domain.TerminalID
	for _, id := range []domain.SessionID{"s1", "s2", "s3"} {
		term, err := f.terms.Open(ctx, OpenTerminal{SessionID: id})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, term.ID)
	}
	f.terms.Unbind("s1", "s3")
	want := map[domain.TerminalID]domain.SessionID{ids[0]: "", ids[1]: "s2", ids[2]: ""}
	for _, term := range f.terms.List() {
		if term.SessionID != want[term.ID] || term.Status != domain.TerminalRunning {
			t.Errorf("terminal %s = %+v", term.ID, term)
		}
	}
}
