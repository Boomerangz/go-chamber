package app

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type fakeTranscripts struct {
	list  []ExternalSession
	items []domain.Item
	err   error
	read  []string
}

func (f *fakeTranscripts) Sessions(context.Context) ([]ExternalSession, error) {
	return f.list, f.err
}

func (f *fakeTranscripts) Transcript(_ context.Context, nativeID string, session domain.SessionID) ([]domain.Item, error) {
	f.read = append(f.read, nativeID)
	out := make([]domain.Item, len(f.items))
	for i, it := range f.items {
		it.SessionID = session
		out[i] = it
	}
	return out, f.err
}

type historyRepo struct {
	mu    sync.Mutex
	snaps map[domain.SessionID]domain.SessionSnapshot
	order []domain.SessionID
}

func (r *historyRepo) Save(_ context.Context, s domain.SessionSnapshot) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.snaps == nil {
		r.snaps = map[domain.SessionID]domain.SessionSnapshot{}
	}
	if _, ok := r.snaps[s.ID]; !ok {
		r.order = append(r.order, s.ID)
	}
	r.snaps[s.ID] = s
	return nil
}

func (r *historyRepo) Get(_ context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.snaps[id]
	if !ok {
		return domain.SessionSnapshot{}, ErrSessionNotFound
	}
	return s, nil
}

func (r *historyRepo) List(context.Context) ([]domain.SessionSnapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []domain.SessionSnapshot{}
	for _, id := range r.order {
		out = append(out, r.snaps[id])
	}
	return out, nil
}

type recordingBus struct {
	mu     sync.Mutex
	events []domain.Event
}

func (b *recordingBus) Publish(ev domain.Event) domain.Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, ev)
	return ev
}

func newTestHistory(sources map[domain.AgentKind]TranscriptSource) (*History, *historyRepo, *recordingBus) {
	repo, bus := &historyRepo{}, &recordingBus{}
	h := NewHistory(HistoryConfig{
		Repo:    repo,
		Bus:     bus,
		Sources: sources,
		NewID:   func() string { return "imported" },
		Now:     func() time.Time { return time.Date(2026, 9, 28, 10, 0, 0, 0, time.UTC) },
	})
	return h, repo, bus
}

func TestHistoryListsExternalSessionsNewestFirstSkippingImported(t *testing.T) {
	old := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	claude := &fakeTranscripts{list: []ExternalSession{
		{Agent: domain.AgentClaude, NativeID: "c1", Cwd: "/p", Title: "old", UpdatedAt: old},
		{Agent: domain.AgentClaude, NativeID: "c2", Cwd: "/p", Title: "known", UpdatedAt: old.Add(time.Hour)},
	}}
	codex := &fakeTranscripts{list: []ExternalSession{
		{Agent: domain.AgentCodex, NativeID: "t1", Cwd: "/q", Title: "new", UpdatedAt: old.Add(2 * time.Hour)},
	}}
	h, repo, _ := newTestHistory(map[domain.AgentKind]TranscriptSource{domain.AgentClaude: claude, domain.AgentCodex: codex})
	_ = repo.Save(context.Background(), domain.SessionSnapshot{ID: "s", Agent: domain.AgentClaude, Cwd: "/p", NativeID: "c2", Status: domain.StatusIdle})

	got, err := h.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].NativeID != "t1" || got[1].NativeID != "c1" {
		t.Fatalf("list = %+v", got)
	}
}

func TestHistoryListSkipsAFailingSource(t *testing.T) {
	broken := &fakeTranscripts{err: errors.New("codex is not installed")}
	claude := &fakeTranscripts{list: []ExternalSession{{Agent: domain.AgentClaude, NativeID: "c1", Cwd: "/p"}}}
	h, _, _ := newTestHistory(map[domain.AgentKind]TranscriptSource{domain.AgentClaude: claude, domain.AgentCodex: broken})
	got, err := h.List(context.Background())
	if err != nil || len(got) != 1 {
		t.Fatalf("list = %+v, %v", got, err)
	}
}

func TestHistoryImportCreatesADetachedSessionWithItsItems(t *testing.T) {
	src := &fakeTranscripts{
		list: []ExternalSession{{Agent: domain.AgentClaude, NativeID: "c1", Cwd: "/p", Title: "fix tests", UpdatedAt: time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC)}},
		items: []domain.Item{
			{ID: "u1", TurnID: "t1", Kind: domain.ItemUserMessage, Status: domain.ItemCompleted, Text: "fix tests"},
			{ID: "a1", TurnID: "t1", Kind: domain.ItemAssistantMessage, Status: domain.ItemCompleted, Text: "done"},
		},
	}
	h, repo, bus := newTestHistory(map[domain.AgentKind]TranscriptSource{domain.AgentClaude: src})

	snap, err := h.Import(context.Background(), domain.AgentClaude, "c1")
	if err != nil {
		t.Fatal(err)
	}
	if snap.ID != "imported" || snap.NativeID != "c1" || snap.Cwd != "/p" || snap.Title != "fix tests" || snap.Status != domain.StatusDetached {
		t.Fatalf("snapshot = %+v", snap)
	}
	if !snap.ActiveAt.Equal(time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("activeAt = %v", snap.ActiveAt)
	}
	if _, err := repo.Get(context.Background(), "imported"); err != nil {
		t.Fatalf("not saved: %v", err)
	}
	if len(bus.events) != 3 || bus.events[0].Type != domain.EventSessionState {
		t.Fatalf("events = %+v", bus.events)
	}
	for _, ev := range bus.events[1:] {
		if ev.Type != domain.EventItemUpdated || ev.SessionID != "imported" || ev.Item.SessionID != "imported" {
			t.Fatalf("item event = %+v", ev)
		}
	}
}

func TestHistoryImportOfAKnownSessionReturnsIt(t *testing.T) {
	src := &fakeTranscripts{list: []ExternalSession{{Agent: domain.AgentClaude, NativeID: "c1", Cwd: "/p"}}}
	h, repo, bus := newTestHistory(map[domain.AgentKind]TranscriptSource{domain.AgentClaude: src})
	_ = repo.Save(context.Background(), domain.SessionSnapshot{ID: "s", Agent: domain.AgentClaude, Cwd: "/p", NativeID: "c1", Status: domain.StatusIdle})
	snap, err := h.Import(context.Background(), domain.AgentClaude, "c1")
	if err != nil || snap.ID != "s" || len(bus.events) != 0 || len(src.read) != 0 {
		t.Fatalf("snap = %+v, err = %v, events = %d, reads = %v", snap, err, len(bus.events), src.read)
	}
}

func TestHistoryImportErrors(t *testing.T) {
	src := &fakeTranscripts{list: []ExternalSession{{Agent: domain.AgentClaude, NativeID: "c1", Cwd: "/p"}}}
	h, _, _ := newTestHistory(map[domain.AgentKind]TranscriptSource{domain.AgentClaude: src})
	if _, err := h.Import(context.Background(), domain.AgentCodex, "t1"); !errors.Is(err, ErrHistoryNotFound) {
		t.Fatalf("unknown agent: %v", err)
	}
	if _, err := h.Import(context.Background(), domain.AgentClaude, "missing"); !errors.Is(err, ErrHistoryNotFound) {
		t.Fatalf("unknown session: %v", err)
	}
	src.err = errors.New("unreadable")
	if _, err := h.Import(context.Background(), domain.AgentClaude, "c1"); err == nil {
		t.Fatal("expected a source error")
	}
}

func TestClaudeForkShowsTheParentConversation(t *testing.T) {
	repo, bus, factory, ids := newMemRepo(), newFakeBus(), &fakeFactory{}, &counter{}
	history := fakeHistory{}
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: factory, Bus: bus, History: history, NewID: ids.next})
	parent := createClaude(t, m)
	startWith(t, m, factory, parent.ID, newFakeRuntime("native-1"))
	item := func(id domain.ItemID, kind domain.ItemKind, text string) *domain.Item {
		return &domain.Item{ID: id, SessionID: parent.ID, TurnID: "t1", Kind: kind, Status: domain.ItemCompleted, Text: text}
	}
	history[parent.ID] = []domain.Event{
		{Seq: 1, SessionID: parent.ID, Type: domain.EventItemUpdated, Item: item("u1", domain.ItemUserMessage, "hi")},
		{Seq: 2, SessionID: parent.ID, Type: domain.EventItemUpdated, Item: item("a1", domain.ItemAssistantMessage, "hel")},
		{Seq: 3, SessionID: parent.ID, Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "a1", Text: "lo"}},
		{Seq: 4, SessionID: parent.ID, Type: domain.EventItemUpdated, Item: item("a1", domain.ItemAssistantMessage, "hello")},
	}
	factory.next = newFakeRuntime("native-2")
	fork, err := m.Fork(context.Background(), parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	var copied []domain.Item
	for _, ev := range bus.snapshot() {
		if ev.SessionID == fork.ID && ev.Type == domain.EventItemUpdated {
			copied = append(copied, *ev.Item)
		}
	}
	if len(copied) != 2 || copied[0].Text != "hi" || copied[1].Text != "hello" || copied[1].SessionID != fork.ID {
		t.Fatalf("copied = %+v", copied)
	}
	if history[parent.ID][3].Item.SessionID != parent.ID {
		t.Fatal("the parent's items were changed")
	}
}
