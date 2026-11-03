package app

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type persistentPTY struct {
	*fakePTY
	mu       sync.Mutex
	detached bool
	saved    []domain.Terminal
}

func (p *persistentPTY) Detach() error {
	p.mu.Lock()
	p.detached = true
	p.mu.Unlock()
	p.exit(0)
	return nil
}

func (p *persistentPTY) Remember(t domain.Terminal) {
	p.mu.Lock()
	p.saved = append(p.saved, t)
	p.mu.Unlock()
}

func (p *persistentPTY) last() domain.Terminal {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.saved[len(p.saved)-1]
}

type persistentFactory struct {
	fakePTYFactory
	survivors []RestoredTerminal
	cols      uint16
}

func (f *persistentFactory) Start(spec PTYSpec) (PTY, error) {
	p, err := f.fakePTYFactory.Start(spec)
	if err != nil {
		return nil, err
	}
	return &persistentPTY{fakePTY: p.(*fakePTY)}, nil
}

func (f *persistentFactory) Restore(cols, rows uint16) ([]RestoredTerminal, error) {
	f.cols = cols
	return f.survivors, nil
}

func newPersistentFixture(t *testing.T) (termFixture, *persistentFactory) {
	pf := &persistentFactory{}
	f := newTermFixture(t, func(c *TerminalsConfig) { c.PTYs = pf })
	return f, pf
}

func TestOpenRenameAndUnbindAreRemembered(t *testing.T) {
	f, _ := newPersistentFixture(t)
	ctx := context.Background()
	_ = f.repo.Save(ctx, domain.SessionSnapshot{ID: "s1", Agent: domain.AgentClaude, Cwd: "/wt/app"})
	term, err := f.terms.Open(ctx, OpenTerminal{SessionID: "s1"})
	if err != nil {
		t.Fatal(err)
	}
	rt, _ := f.terms.find(term.ID)
	p := rt.pty.(*persistentPTY)
	if got := p.last(); got.ID != term.ID || got.Title != "app" || got.SessionID != "s1" {
		t.Fatalf("after open: %+v", got)
	}
	if _, err := f.terms.Rename(term.ID, "build"); err != nil {
		t.Fatal(err)
	}
	if got := p.last().Title; got != "build" {
		t.Fatalf("after rename: %q", got)
	}
	f.terms.Unbind("s1")
	if got := p.last().SessionID; got != "" {
		t.Fatalf("after unbind: %q", got)
	}
}

func TestOpenPassesTheIDToTheFactory(t *testing.T) {
	f, pf := newPersistentFixture(t)
	term, err := f.terms.Open(context.Background(), OpenTerminal{Cwd: "/wt/app"})
	if err != nil {
		t.Fatal(err)
	}
	if got := pf.specs[0].ID; got != string(term.ID) {
		t.Fatalf("spec ID = %q, want %q", got, term.ID)
	}
}

func TestCloseAllDetachesPersistentShells(t *testing.T) {
	f, _ := newPersistentFixture(t)
	term, err := f.terms.Open(context.Background(), OpenTerminal{Cwd: "/wt/app"})
	if err != nil {
		t.Fatal(err)
	}
	rt, _ := f.terms.find(term.ID)
	p := rt.pty.(*persistentPTY)
	f.terms.CloseAll()
	p.mu.Lock()
	detached := p.detached
	p.mu.Unlock()
	if !detached {
		t.Fatal("shell was not detached")
	}
	if _, _, closed := p.snapshot(); closed {
		t.Fatal("shell was closed instead of detached")
	}
}

func TestRestoreAdoptsSurvivingShells(t *testing.T) {
	f, pf := newPersistentFixture(t)
	old := domain.Terminal{
		ID: "old1", Cwd: "/wt/app", Shell: "/bin/zsh", Title: "build",
		SessionID: "s1", Status: domain.TerminalRunning,
		CreatedAt: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
	}
	pty := &persistentPTY{fakePTY: newFakePTY()}
	pf.survivors = []RestoredTerminal{{Term: old, PTY: pty}}
	if err := f.terms.Restore(); err != nil {
		t.Fatal(err)
	}
	if pf.cols != defaultCols {
		t.Fatalf("restored at %d cols", pf.cols)
	}
	got, err := f.terms.Get("old1")
	if err != nil || got.Title != "build" || got.SessionID != "s1" {
		t.Fatalf("Get = %+v, %v", got, err)
	}
	if err := f.terms.Write("old1", []byte("ls\n")); err != nil {
		t.Fatal(err)
	}
	if in, _, _ := pty.snapshot(); in != "ls\n" {
		t.Fatalf("input = %q", in)
	}
}

func TestRestoreWithoutRestorerIsANoop(t *testing.T) {
	f := newTermFixture(t)
	if err := f.terms.Restore(); err != nil {
		t.Fatal(err)
	}
	if len(f.terms.List()) != 0 {
		t.Fatal("unexpected terminals")
	}
}
