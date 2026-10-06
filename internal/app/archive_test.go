package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// EraseSession makes memRepo a SessionEraser for the manager's tests.
func (r *memRepo) EraseSession(_ context.Context, id domain.SessionID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.eraseErr != nil {
		return r.eraseErr
	}
	delete(r.items, id)
	for i, have := range r.order {
		if have == id {
			r.order = append(r.order[:i:i], r.order[i+1:]...)
			break
		}
	}
	r.erased = append(r.erased, id)
	return nil
}

func (r *memRepo) erasedIDs() []domain.SessionID {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]domain.SessionID(nil), r.erased...)
}

var archiveClock = time.Date(2026, 10, 6, 9, 30, 0, 0, time.UTC)

func newArchiveManager(t *testing.T) (*Manager, *memRepo, *fakeBus, *fakeFactory) {
	t.Helper()
	repo, bus, factory, ids := newMemRepo(), newFakeBus(), &fakeFactory{}, &counter{}
	m := NewManager(ManagerConfig{
		Repo: repo, Runtimes: factory, Bus: bus, Eraser: repo,
		NewID: ids.next, Now: func() time.Time { return archiveClock },
	})
	t.Cleanup(m.Close)
	return m, repo, bus, factory
}

func lastEvent(t *testing.T, bus *fakeBus) domain.Event {
	t.Helper()
	events := bus.snapshot()
	if len(events) == 0 {
		t.Fatal("no events")
	}
	return events[len(events)-1]
}

func TestArchiveSessionSavesAndPublishes(t *testing.T) {
	m, repo, bus, _ := newArchiveManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)

	got, err := m.ArchiveSession(ctx, snap.ID)
	if err != nil || !got.ArchivedAt.Equal(archiveClock) {
		t.Fatalf("archive = %+v, %v", got, err)
	}
	if saved, _ := repo.Get(ctx, snap.ID); !saved.ArchivedAt.Equal(archiveClock) {
		t.Fatalf("saved %v", saved.ArchivedAt)
	}
	if ev := lastEvent(t, bus); ev.Type != domain.EventSessionState || ev.SessionID != snap.ID || !ev.Session.ArchivedAt.Equal(archiveClock) {
		t.Fatalf("event %+v", ev)
	}

	got, err = m.UnarchiveSession(ctx, snap.ID)
	if err != nil || !got.ArchivedAt.IsZero() {
		t.Fatalf("unarchive = %+v, %v", got, err)
	}
	if saved, _ := repo.Get(ctx, snap.ID); !saved.ArchivedAt.IsZero() {
		t.Fatalf("saved %v", saved.ArchivedAt)
	}
	if ev := lastEvent(t, bus); ev.Type != domain.EventSessionState || !ev.Session.ArchivedAt.IsZero() {
		t.Fatalf("event %+v", ev)
	}
}

func TestArchiveUnknownSession(t *testing.T) {
	m, _, bus, _ := newArchiveManager(t)
	ctx := context.Background()
	if _, err := m.ArchiveSession(ctx, "nope"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("archive: %v", err)
	}
	if _, err := m.UnarchiveSession(ctx, "nope"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("unarchive: %v", err)
	}
	if n := len(bus.snapshot()); n != 0 {
		t.Fatalf("published %d events", n)
	}
}

func TestArchiveFailsWhenTheSaveFails(t *testing.T) {
	m, repo, bus, _ := newArchiveManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	repo.saveErr = errors.New("disk full")
	if _, err := m.ArchiveSession(ctx, snap.ID); err == nil {
		t.Fatal("archive should fail")
	}
	if _, err := m.UnarchiveSession(ctx, snap.ID); err == nil {
		t.Fatal("unarchive should fail")
	}
	if n := len(bus.snapshot()); n != 0 {
		t.Fatalf("published %d events", n)
	}
	if got, _ := m.GetSession(ctx, snap.ID); !got.ArchivedAt.IsZero() {
		t.Fatalf("failed archive kept %v", got.ArchivedAt)
	}
	repo.saveErr = nil
	if _, err := m.ArchiveSession(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	repo.saveErr = errors.New("disk full")
	if _, err := m.UnarchiveSession(ctx, snap.ID); err == nil {
		t.Fatal("unarchive should fail")
	}
	if got, _ := m.GetSession(ctx, snap.ID); !got.ArchivedAt.Equal(archiveClock) {
		t.Fatalf("failed unarchive left %v", got.ArchivedAt)
	}
}

func TestDeleteStopsTheSessionTimers(t *testing.T) {
	repo, bus, factory, ids := newMemRepo(), newFakeBus(), &fakeFactory{}, &counter{}
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: factory, Bus: bus, Eraser: repo, NewID: ids.next, IdleTimeout: time.Hour})
	t.Cleanup(m.Close)
	ctx := context.Background()
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	snap := createClaude(t, m)
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle timer", func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.idle[snap.ID] != nil
	})
	m.armAutoContinue(snap.ID, true, time.Now().Add(time.Hour))
	if err := m.DeleteSession(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.idle) != 0 || len(m.resume) != 0 {
		t.Fatalf("timers left: idle %d, resume %d", len(m.idle), len(m.resume))
	}
}

func TestDeleteSessionErasesAndAnnounces(t *testing.T) {
	m, repo, bus, _ := newArchiveManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	keep := createClaude(t, m)

	if err := m.DeleteSession(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	if got := repo.erasedIDs(); len(got) != 1 || got[0] != snap.ID {
		t.Fatalf("erased %v", got)
	}
	if ev := lastEvent(t, bus); ev.Type != domain.EventSessionRemoved || ev.SessionID != snap.ID {
		t.Fatalf("event %+v", ev)
	}
	if _, err := m.GetSession(ctx, snap.ID); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("deleted session still found: %v", err)
	}
	if _, err := m.GetSession(ctx, keep.ID); err != nil {
		t.Fatalf("other session: %v", err)
	}
	if err := m.DeleteSession(ctx, snap.ID); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestDeleteRefusesARunningTurn(t *testing.T) {
	m, repo, bus, factory := newArchiveManager(t)
	ctx := context.Background()
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	snap := createClaude(t, m)
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	before := len(bus.snapshot())
	if err := m.DeleteSession(ctx, snap.ID); !errors.Is(err, domain.ErrSessionBusy) {
		t.Fatalf("delete running: %v", err)
	}
	if len(repo.erasedIDs()) != 0 || len(bus.snapshot()) != before {
		t.Fatalf("erased %v, events %d -> %d", repo.erasedIDs(), before, len(bus.snapshot()))
	}
	rt.mu.Lock()
	closed := rt.closed
	rt.mu.Unlock()
	if closed {
		t.Fatal("runtime closed")
	}
}

func TestDeleteStopsAnIdleAgent(t *testing.T) {
	m, repo, _, factory := newArchiveManager(t)
	ctx := context.Background()
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	snap := createClaude(t, m)
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle", func() bool {
		got, _ := m.GetSession(ctx, snap.ID)
		return got.Status == domain.StatusIdle
	})
	if err := m.DeleteSession(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	eventually(t, "runtime closed", func() bool {
		rt.mu.Lock()
		defer rt.mu.Unlock()
		return rt.closed
	})
	if len(repo.erasedIDs()) != 1 {
		t.Fatalf("erased %v", repo.erasedIDs())
	}
	// The exit of the retired process must not bring the record back.
	time.Sleep(20 * time.Millisecond)
	if _, err := repo.Get(ctx, snap.ID); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("record came back: %v", err)
	}
}

func TestDeleteTakesSubagentsAlong(t *testing.T) {
	m, repo, bus, _ := newArchiveManager(t)
	ctx := context.Background()
	parent := createClaude(t, m)
	other := createClaude(t, m)
	child := domain.SessionSnapshot{ID: "child", Agent: domain.AgentClaude, Cwd: "/tmp/proj", ParentID: parent.ID, Status: domain.StatusDetached}
	grandchild := domain.SessionSnapshot{ID: "grandchild", Agent: domain.AgentClaude, Cwd: "/tmp/proj", ParentID: "child", Status: domain.StatusDetached}
	stranger := domain.SessionSnapshot{ID: "stranger", Agent: domain.AgentClaude, Cwd: "/tmp/proj", ParentID: other.ID, Status: domain.StatusDetached}
	for _, s := range []domain.SessionSnapshot{child, grandchild, stranger} {
		_ = repo.Save(ctx, s)
	}
	if err := m.DeleteSession(ctx, parent.ID); err != nil {
		t.Fatal(err)
	}
	erased := map[domain.SessionID]bool{}
	for _, id := range repo.erasedIDs() {
		erased[id] = true
	}
	if len(erased) != 3 || !erased[parent.ID] || !erased["child"] || !erased["grandchild"] {
		t.Fatalf("erased %v", repo.erasedIDs())
	}
	removed := map[domain.SessionID]bool{}
	for _, ev := range bus.snapshot() {
		if ev.Type == domain.EventSessionRemoved {
			removed[ev.SessionID] = true
		}
	}
	if len(removed) != 3 || !removed["grandchild"] {
		t.Fatalf("removed %v", removed)
	}
	if _, err := repo.Get(ctx, "stranger"); err != nil {
		t.Fatalf("unrelated subagent: %v", err)
	}
}

func TestDeleteRefusesWhileASubagentRuns(t *testing.T) {
	m, repo, _, factory := newArchiveManager(t)
	ctx := context.Background()
	factory.runtimes = []*fakeRuntime{newFakeRuntime("n1")}
	parent := createClaude(t, m)
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "child", Agent: domain.AgentClaude, Cwd: "/tmp/proj", ParentID: parent.ID, Status: domain.StatusDetached})
	if err := m.SendMessage(ctx, "child", "go"); err != nil {
		t.Fatal(err)
	}
	if err := m.DeleteSession(ctx, parent.ID); !errors.Is(err, domain.ErrSessionBusy) {
		t.Fatalf("delete: %v", err)
	}
	if len(repo.erasedIDs()) != 0 {
		t.Fatalf("erased %v", repo.erasedIDs())
	}
}

func TestDeleteRestoresTheSessionWhenErasingFails(t *testing.T) {
	m, repo, bus, _ := newArchiveManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	repo.eraseErr = errors.New("disk full")
	if err := m.DeleteSession(ctx, snap.ID); err == nil {
		t.Fatal("delete should fail")
	}
	events := bus.snapshot()
	if len(events) != 2 || events[0].Type != domain.EventSessionRemoved || events[1].Type != domain.EventSessionState || events[1].Session.ID != snap.ID {
		t.Fatalf("events %+v", events)
	}
	if _, err := m.GetSession(ctx, snap.ID); err != nil {
		t.Fatalf("session lost: %v", err)
	}
}

func TestDeleteDropsPendingRequests(t *testing.T) {
	m, _, _, _ := newArchiveManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	m.mu.Lock()
	m.pending[snap.ID] = map[domain.RequestID]*domain.Request{"r1": {ID: "r1", SessionID: snap.ID}}
	m.mu.Unlock()
	if err := m.DeleteSession(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	if got := m.PendingRequests(ctx); len(got) != 0 {
		t.Fatalf("pending %+v", got)
	}
}

func TestDeleteWithoutAnEraser(t *testing.T) {
	m, _, bus, _, _ := newTestManager(t)
	snap := createClaude(t, m)
	if err := m.DeleteSession(context.Background(), snap.ID); !errors.Is(err, ErrDeleteUnsupported) {
		t.Fatalf("delete: %v", err)
	}
	if n := len(bus.snapshot()); n != 0 {
		t.Fatalf("published %d events", n)
	}
}
