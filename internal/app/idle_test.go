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

func TestIdleTimeoutWaitsForBackgroundWork(t *testing.T) {
	m, _, factory := newIdleManager(t, 80*time.Millisecond)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(context.Background(), snap.ID, "work"); err != nil {
		t.Fatal(err)
	}
	item := domain.Item{ID: "task", SessionID: snap.ID, Kind: domain.ItemSubagent, Status: domain.ItemStreaming, OutlivesTurn: true}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventItemUpdated, Item: &item}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	time.Sleep(200 * time.Millisecond)
	if rt.isClosed() {
		t.Fatal("closed while background work was running")
	}
	finished := item
	finished.Status = domain.ItemCompleted
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventItemUpdated, Item: &finished}
	time.Sleep(40 * time.Millisecond)
	if rt.isClosed() {
		t.Fatal("closed before a full idle interval after background work")
	}
	eventually(t, "runtime closes after background work and idle interval", rt.isClosed)
}

func TestIdleTimeoutWaitsForBackgroundSnapshot(t *testing.T) {
	m, _, factory := newIdleManager(t, 80*time.Millisecond)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(context.Background(), snap.ID, "work"); err != nil {
		t.Fatal(err)
	}
	active, empty := 1, 0
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventBackgroundWork, BackgroundCount: &active}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "background count visible", func() bool {
		current, err := m.GetSession(context.Background(), snap.ID)
		list, listErr := m.ListSessions(context.Background())
		return err == nil && current.BackgroundTasks == 1 && listErr == nil && len(list) == 1 && list[0].BackgroundTasks == 1
	})
	time.Sleep(200 * time.Millisecond)
	if rt.isClosed() {
		t.Fatal("closed with background tasks")
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventBackgroundWork, BackgroundCount: &empty}
	eventually(t, "runtime closes after background tasks", rt.isClosed)
}

func TestRuntimeCanStartTurnAfterBackgroundNotification(t *testing.T) {
	m, repo, factory := newIdleManager(t, 80*time.Millisecond)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{rt}
	ctx := context.Background()
	if err := m.SendMessage(ctx, snap.ID, "work"); err != nil {
		t.Fatal(err)
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle", func() bool { s, _ := repo.Get(ctx, snap.ID); return s.Status == domain.StatusIdle })
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnStarted}
	eventually(t, "running again", func() bool { s, _ := repo.Get(ctx, snap.ID); return s.Status == domain.StatusRunning })
	time.Sleep(120 * time.Millisecond)
	if rt.isClosed() {
		t.Fatal("closed during resumed turn")
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "closed after resumed turn", rt.isClosed)
}

func TestModelChangeDoesNotRetireBackgroundWork(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := &modelRuntime{fakeRuntime: newFakeRuntime("native-1"), err: ErrRestartRequired}
	ctx := context.Background()
	startWith(t, m, factory, snap.ID, rt)
	active := 1
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventBackgroundWork, BackgroundCount: &active}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle with work", func() bool {
		s, _ := m.GetSession(ctx, snap.ID)
		return s.Status == domain.StatusIdle && s.BackgroundTasks == 1
	})
	if _, err := m.SetModel(ctx, snap.ID, "new-model", ""); err != nil {
		t.Fatal(err)
	}
	if rt.isClosed() {
		t.Fatal("model change closed background work")
	}
	if err := m.SendMessage(ctx, snap.ID, "next"); err != nil {
		t.Fatal(err)
	}
	if rt.isClosed() {
		t.Fatal("next message closed background work")
	}
}

func TestPermissionChangeDoesNotRetireBackgroundWork(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	ctx := context.Background()
	startWith(t, m, factory, snap.ID, rt)
	active := 1
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventBackgroundWork, BackgroundCount: &active}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle with work", func() bool {
		s, _ := m.GetSession(ctx, snap.ID)
		return s.Status == domain.StatusIdle && s.BackgroundTasks == 1
	})
	if _, err := m.SetPermissionMode(ctx, snap.ID, "plan"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if rt.isClosed() {
		t.Fatal("permission change closed background work")
	}
}

func TestRetiredRuntimeFailsBackgroundItems(t *testing.T) {
	m, _, bus, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	ctx := context.Background()
	startWith(t, m, factory, snap.ID, rt)
	item := domain.Item{ID: "bash", SessionID: snap.ID, Kind: domain.ItemCommand, Status: domain.ItemStreaming, OutlivesTurn: true}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventItemUpdated, Item: &item}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle", func() bool { s, _ := m.GetSession(ctx, snap.ID); return s.Status == domain.StatusIdle })
	m.mu.Lock()
	m.retire(m.sessions[snap.ID])
	m.mu.Unlock()
	eventually(t, "background item failed", func() bool {
		for _, ev := range bus.snapshot() {
			if ev.Type == domain.EventItemUpdated && ev.Item.ID == "bash" && ev.Item.Status == domain.ItemFailed {
				return true
			}
		}
		return false
	})
}

func TestEmptyBackgroundSnapshotOverridesUnfinishedItems(t *testing.T) {
	m, _, factory := newIdleManager(t, 40*time.Millisecond)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{rt}
	ctx := context.Background()
	if err := m.SendMessage(ctx, snap.ID, "work"); err != nil {
		t.Fatal(err)
	}
	item := domain.Item{ID: "bash", SessionID: snap.ID, Kind: domain.ItemCommand, Status: domain.ItemStreaming, OutlivesTurn: true}
	active, empty := 1, 0
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventItemUpdated, Item: &item}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventBackgroundWork, BackgroundCount: &active}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventBackgroundWork, BackgroundCount: &empty}
	eventually(t, "count cleared", func() bool { s, _ := m.GetSession(ctx, snap.ID); return s.BackgroundTasks == 0 })
	eventually(t, "idle runtime closed", rt.isClosed)
}

// slowCloseRuntime blocks Close until released.
type slowCloseRuntime struct {
	*fakeRuntime
	started chan struct{}
	release chan struct{}
}

func (r *slowCloseRuntime) Close() error {
	r.started <- struct{}{}
	<-r.release
	return r.fakeRuntime.Close()
}

func TestCloseClosesRuntimesConcurrently(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	started, release := make(chan struct{}, 2), make(chan struct{})
	for _, native := range []string{"one", "two"} {
		snap := createClaude(t, m)
		startWith(t, m, factory, snap.ID, &slowCloseRuntime{fakeRuntime: newFakeRuntime(native), started: started, release: release})
	}
	done := make(chan struct{})
	go func() { m.Close(); close(done) }()
	for range 2 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("runtimes closed one after another")
		}
	}
	close(release)
	<-done
}
