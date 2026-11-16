package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type fakeTitler struct {
	mu    sync.Mutex
	calls [][2]string
	title string
	err   error
}

func (f *fakeTitler) Title(_ context.Context, first, reply string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, [2]string{first, reply})
	return f.title, f.err
}

func (f *fakeTitler) called() [][2]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][2]string(nil), f.calls...)
}

func titleManager(t *testing.T, titlers map[domain.AgentKind]Titler) (*Manager, *fakeFactory, *fakeBus) {
	t.Helper()
	repo, bus, factory, ids := newMemRepo(), newFakeBus(), &fakeFactory{}, &counter{}
	m := NewManager(ManagerConfig{
		Repo: repo, Runtimes: factory, Bus: bus, Titlers: titlers,
		NewID: func() string { return ids.next() },
	})
	return m, factory, bus
}

func TestAgentTitleEventNamesSessionOverFirstMessage(t *testing.T) {
	m, factory, bus := titleManager(t, nil)
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	ctx := context.Background()
	snap, _ := m.CreateSession(ctx, domain.AgentCodex, "/tmp/proj")
	if err := m.SendMessage(ctx, snap.ID, "hello there"); err != nil {
		t.Fatal(err)
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTitle, Title: "  Greeting\nthe agent "}
	eventually(t, "agent title", func() bool {
		got, _ := m.GetSession(ctx, snap.ID)
		return got.Title == "Greeting the agent"
	})
	for _, ev := range bus.snapshot() {
		if ev.Type == domain.EventTitle {
			t.Fatal("the raw title event must not reach clients")
		}
	}
	m.RenameSession(ctx, snap.ID, "Mine")
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTitle, Title: "Agent again"}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "turn end", func() bool {
		got, _ := m.GetSession(ctx, snap.ID)
		return got.Status == domain.StatusIdle
	})
	if got, _ := m.GetSession(ctx, snap.ID); got.Title != "Mine" {
		t.Fatalf("owner's name replaced: %q", got.Title)
	}
}

func TestTitlerNamesSessionAfterFirstTurn(t *testing.T) {
	titler := &fakeTitler{title: "Session names"}
	m, factory, _ := titleManager(t, map[domain.AgentKind]Titler{domain.AgentClaude: titler})
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	ctx := context.Background()
	snap, _ := m.CreateSession(ctx, domain.AgentClaude, "/tmp/proj")
	if err := m.SendMessage(ctx, snap.ID, "rename my sessions"); err != nil {
		t.Fatal(err)
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: "done"}}
	eventually(t, "generated title", func() bool {
		got, _ := m.GetSession(ctx, snap.ID)
		return got.Title == "Session names"
	})
	if c := titler.called(); len(c) != 1 || c[0] != [2]string{"rename my sessions", "done"} {
		t.Fatalf("titler calls %v", c)
	}
}

func TestTitlerRunsOnceAndSkipsFailedTurns(t *testing.T) {
	titler := &fakeTitler{err: errors.New("offline")}
	m, factory, _ := titleManager(t, map[domain.AgentKind]Titler{domain.AgentClaude: titler})
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	ctx := context.Background()
	snap, _ := m.CreateSession(ctx, domain.AgentClaude, "/tmp/proj")
	m.SendMessage(ctx, snap.ID, "first")
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded, Result: &domain.TurnResult{IsError: true, Error: "boom"}}
	eventually(t, "idle", func() bool {
		got, _ := m.GetSession(ctx, snap.ID)
		return got.Status == domain.StatusIdle
	})
	if len(titler.called()) != 0 {
		t.Fatal("a failed turn must not be titled")
	}
	m.SendMessage(ctx, snap.ID, "second")
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: "ok"}}
	eventually(t, "titler call", func() bool { return len(titler.called()) == 1 })
	if got, _ := m.GetSession(ctx, snap.ID); got.Title != "first" {
		t.Fatalf("a failing titler must leave the first message: %q", got.Title)
	}
	m.SendMessage(ctx, snap.ID, "third")
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: "ok"}}
	eventually(t, "third turn", func() bool {
		got, _ := m.GetSession(ctx, snap.ID)
		return got.Status == domain.StatusIdle
	})
	if len(titler.called()) != 1 {
		t.Fatal("the titler must be asked once per session")
	}
}

func TestTitlerNamesACodexSessionToo(t *testing.T) {
	titler := &fakeTitler{title: "Fibonacci"}
	m, factory, _ := titleManager(t, map[domain.AgentKind]Titler{domain.AgentCodex: titler})
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	ctx := context.Background()
	snap, _ := m.CreateSession(ctx, domain.AgentCodex, "/tmp/proj")
	m.SendMessage(ctx, snap.ID, "write fibonacci")
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: "done"}}
	eventually(t, "generated title", func() bool {
		got, _ := m.GetSession(ctx, snap.ID)
		return got.Title == "Fibonacci"
	})
}

func TestTitlerFailureIsLogged(t *testing.T) {
	titler := &fakeTitler{err: errors.New("offline")}
	var mu sync.Mutex
	var logged []string
	repo, bus, factory, ids := newMemRepo(), newFakeBus(), &fakeFactory{}, &counter{}
	m := NewManager(ManagerConfig{
		Repo: repo, Runtimes: factory, Bus: bus, NewID: func() string { return ids.next() },
		Titlers: map[domain.AgentKind]Titler{domain.AgentCodex: titler},
		Logf: func(format string, args ...any) {
			mu.Lock()
			defer mu.Unlock()
			logged = append(logged, fmt.Sprintf(format, args...))
		},
	})
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	ctx := context.Background()
	snap, _ := m.CreateSession(ctx, domain.AgentCodex, "/tmp/proj")
	m.SendMessage(ctx, snap.ID, "hi")
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: "ok"}}
	eventually(t, "logged", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(logged) == 1 && strings.Contains(logged[0], "offline") && strings.Contains(logged[0], string(snap.ID))
	})
}
