package app

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// stepClock is a manager clock that moves a second each time it is read.
type stepClock struct {
	mu sync.Mutex
	at time.Time
}

func (c *stepClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(time.Second)
	return c.at
}

func newSeenManager(t *testing.T) (*Manager, *memRepo, *fakeBus, *fakeFactory) {
	t.Helper()
	repo, bus, factory, ids := newMemRepo(), newFakeBus(), &fakeFactory{}, &counter{}
	clock := &stepClock{at: time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC)}
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: factory, Bus: bus, NewID: ids.next, Now: clock.now})
	t.Cleanup(m.Close)
	return m, repo, bus, factory
}

func lastState(t *testing.T, bus *fakeBus, id domain.SessionID) domain.SessionSnapshot {
	t.Helper()
	events := bus.snapshot()
	for i := len(events) - 1; i >= 0; i-- {
		if ev := events[i]; ev.SessionID == id && ev.Session != nil {
			return *ev.Session
		}
	}
	t.Fatal("no session state published")
	return domain.SessionSnapshot{}
}

func TestMarkSeenSavesAndTellsEveryDevice(t *testing.T) {
	m, repo, bus, _ := newSeenManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)

	got, err := m.MarkSeen(ctx, snap.ID, "i9")
	if err != nil || got.Seen.Item != "i9" || got.Seen.At.IsZero() {
		t.Fatalf("mark = %+v, %v", got.Seen, err)
	}
	if saved, _ := repo.Get(ctx, snap.ID); saved.Seen != got.Seen {
		t.Fatalf("saved %+v", saved.Seen)
	}
	if ev := lastEvent(t, bus); ev.Type != domain.EventSessionState || ev.Session.Seen != got.Seen {
		t.Fatalf("event %+v", ev)
	}
	if _, err := m.MarkSeen(ctx, "nope", "i1"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("unknown session: %v", err)
	}
}

func TestATurnEndIsNewUntilTheOwnerLooks(t *testing.T) {
	m, _, bus, factory := newSeenManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	// Sending is looking: the owner's own message is never news.
	sent := lastState(t, bus, snap.ID)
	if sent.Seen.Item == "" || sent.Seen.At.IsZero() || sent.Unseen() {
		t.Fatalf("after send: %+v", sent)
	}
	var user domain.ItemID
	for _, ev := range bus.snapshot() {
		if ev.Item != nil && ev.Item.Kind == domain.ItemUserMessage {
			user = ev.Item.ID
		}
	}
	if sent.Seen.Item != user {
		t.Fatalf("seen %q, the message is %q", sent.Seen.Item, user)
	}

	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: "done"}}
	eventually(t, "turn end", func() bool { return !lastState(t, bus, snap.ID).EndedAt.IsZero() })
	ended := lastState(t, bus, snap.ID)
	if ended.EndedAt.IsZero() || !ended.Unseen() {
		t.Fatalf("after the turn: %+v", ended)
	}
	looked, err := m.MarkSeen(ctx, snap.ID, "")
	if err != nil || looked.Unseen() || looked.Seen.Item != user {
		t.Fatalf("after a look: %+v, %v", looked, err)
	}
}

func TestACutOffTurnIsNewToo(t *testing.T) {
	m, _, bus, factory := newSeenManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	_ = rt.Close()
	eventually(t, "crash", func() bool { return lastState(t, bus, snap.ID).Status == domain.StatusInterrupted })
	if got := lastState(t, bus, snap.ID); !got.Unseen() {
		t.Fatalf("crashed turn: %+v", got)
	}
}

func TestSteeringAndAnsweringAreLooking(t *testing.T) {
	m, _, bus, factory := newSeenManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	before := lastState(t, bus, snap.ID).Seen

	if err := m.Steer(ctx, snap.ID, "also this"); err != nil {
		t.Fatal(err)
	}
	steered := lastState(t, bus, snap.ID).Seen
	if !steered.At.After(before.At) || steered.Item == before.Item || steered.Item == "" {
		t.Fatalf("steer: %+v after %+v", steered, before)
	}

	rt.events <- requestEvent(snap.ID, "r1")
	eventually(t, "pending", func() bool { return len(m.PendingRequests(ctx)) == 1 })
	if err := m.RespondRequest(ctx, snap.ID, "r1", RequestAnswer{Allow: true}); err != nil {
		t.Fatal(err)
	}
	var decision domain.ItemID
	for _, ev := range bus.snapshot() {
		if ev.Item != nil && ev.Item.Kind == domain.ItemDecision {
			decision = ev.Item.ID
		}
	}
	answered := lastState(t, bus, snap.ID).Seen
	if decision == "" || answered.Item != decision || !answered.At.After(steered.At) {
		t.Fatalf("answer: %+v, decision %q", answered, decision)
	}
}
