package app

import (
	"context"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func newIdleManager(t *testing.T, idle time.Duration) (*Manager, *memRepo, *fakeFactory) {
	t.Helper()
	repo, bus, factory, ids := newMemRepo(), newFakeBus(), &fakeFactory{}, &counter{}
	m := NewManager(ManagerConfig{
		Repo: repo, Runtimes: factory, Bus: bus,
		NewID:       func() string { return ids.next() },
		IdleTimeout: idle,
	})
	return m, repo, factory
}

func TestIdleClaudeRuntimeIsDetachedAndResumed(t *testing.T) {
	m, repo, factory := newIdleManager(t, 20*time.Millisecond)
	snap := createClaude(t, m)
	first, second := newFakeRuntime("native-1"), newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{first, second}
	ctx := context.Background()
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	first.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle runtime closed and session detached", func() bool {
		s, _ := repo.Get(ctx, snap.ID)
		return first.isClosed() && s.Status == domain.StatusDetached
	})
	if err := m.SendMessage(ctx, snap.ID, "again"); err != nil {
		t.Fatal(err)
	}
	reqs := factory.requests()
	if len(reqs) != 2 || reqs[1].NativeID != "native-1" {
		t.Fatalf("start requests = %+v", reqs)
	}
}

func TestIdleTimerRestartsWithEachTurn(t *testing.T) {
	m, _, factory := newIdleManager(t, 80*time.Millisecond)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{rt}
	ctx := context.Background()
	if err := m.SendMessage(ctx, snap.ID, "one"); err != nil {
		t.Fatal(err)
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	time.Sleep(50 * time.Millisecond)
	eventually(t, "second turn accepted", func() bool { return m.SendMessage(ctx, snap.ID, "two") == nil })
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	time.Sleep(50 * time.Millisecond)
	if rt.isClosed() {
		t.Fatal("runtime closed by the timer of an earlier turn")
	}
	eventually(t, "runtime closed after idling", rt.isClosed)
}

func TestIdleTimeoutSparesRunningAndCodexSessions(t *testing.T) {
	m, repo, factory := newIdleManager(t, 10*time.Millisecond)
	ctx := context.Background()
	claude := createClaude(t, m)
	codex, err := m.CreateSession(ctx, domain.AgentCodex, "/tmp/proj")
	if err != nil {
		t.Fatal(err)
	}
	busy, cx := newFakeRuntime("native-1"), newFakeRuntime("thread-1")
	factory.runtimes = []*fakeRuntime{busy, cx}
	if err := m.SendMessage(ctx, claude.ID, "long"); err != nil {
		t.Fatal(err)
	}
	if err := m.SendMessage(ctx, codex.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	cx.events <- domain.Event{SessionID: codex.ID, Type: domain.EventTurnEnded}
	eventually(t, "codex idle", func() bool {
		s, _ := repo.Get(ctx, codex.ID)
		return s.Status == domain.StatusIdle
	})
	time.Sleep(40 * time.Millisecond)
	if busy.isClosed() || cx.isClosed() {
		t.Fatalf("closed: running claude %v, idle codex %v", busy.isClosed(), cx.isClosed())
	}
}
