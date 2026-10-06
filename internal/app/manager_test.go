package app

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type memRepo struct {
	mu    sync.Mutex
	items map[domain.SessionID]domain.SessionSnapshot
	order []domain.SessionID
	// saveErr and eraseErr make Save and EraseSession fail.
	saveErr, eraseErr error
	erased            []domain.SessionID
}

func newMemRepo() *memRepo {
	return &memRepo{items: map[domain.SessionID]domain.SessionSnapshot{}}
}

func (r *memRepo) Save(_ context.Context, s domain.SessionSnapshot) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.saveErr != nil {
		return r.saveErr
	}
	if _, ok := r.items[s.ID]; !ok {
		r.order = append(r.order, s.ID)
	}
	r.items[s.ID] = s
	return nil
}

func (r *memRepo) Get(_ context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.items[id]
	if !ok {
		return domain.SessionSnapshot{}, fmt.Errorf("%w: %s", ErrSessionNotFound, id)
	}
	return s, nil
}

func (r *memRepo) List(_ context.Context) ([]domain.SessionSnapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.SessionSnapshot, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.items[id])
	}
	return out, nil
}

type fakeBus struct {
	mu     sync.Mutex
	events []domain.Event
	seq    map[domain.SessionID]domain.Seq
}

func newFakeBus() *fakeBus {
	return &fakeBus{seq: map[domain.SessionID]domain.Seq{}}
}

func (b *fakeBus) Publish(ev domain.Event) domain.Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.seq[ev.SessionID]++
	ev.Seq = b.seq[ev.SessionID]
	b.events = append(b.events, ev)
	return ev
}

func (b *fakeBus) snapshot() []domain.Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]domain.Event(nil), b.events...)
}

type sentMsg struct {
	turn domain.TurnID
	text string
}

type fakeRuntime struct {
	native       string
	events       chan domain.Event
	mu           sync.Mutex
	sent         []sentMsg
	interrupts   int
	closed       bool
	sendErr      error
	respondErr   error
	responses    []fakeResponse
	steers       []string
	stoppedTasks []string
}

type fakeResponse struct {
	id     domain.RequestID
	answer RequestAnswer
}

func newFakeRuntime(native string) *fakeRuntime {
	return &fakeRuntime{native: native, events: make(chan domain.Event, 32)}
}

func (f *fakeRuntime) NativeID() string            { return f.native }
func (f *fakeRuntime) Events() <-chan domain.Event { return f.events }
func (f *fakeRuntime) Send(_ context.Context, turn domain.TurnID, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sendErr != nil {
		return f.sendErr
	}
	f.sent = append(f.sent, sentMsg{turn, text})
	return nil
}
func (f *fakeRuntime) Interrupt(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.interrupts++
	return nil
}

func (f *fakeRuntime) Steer(_ context.Context, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.steers = append(f.steers, text)
	return nil
}

func (f *fakeRuntime) StopTask(_ context.Context, taskID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stoppedTasks = append(f.stoppedTasks, taskID)
	return nil
}

func (f *fakeRuntime) Respond(_ context.Context, id domain.RequestID, answer RequestAnswer) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.respondErr != nil {
		return f.respondErr
	}
	f.responses = append(f.responses, fakeResponse{id, answer})
	return nil
}

func (f *fakeRuntime) responded() []fakeResponse {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeResponse(nil), f.responses...)
}
func (f *fakeRuntime) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		close(f.events)
	}
	return nil
}
func (f *fakeRuntime) sentMessages() []sentMsg {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sentMsg(nil), f.sent...)
}

type fakeFactory struct {
	mu       sync.Mutex
	reqs     []StartRequest
	runtimes []*fakeRuntime
	// next, when set, is returned instead of a queued fakeRuntime.
	next AgentRuntime
	err  error
}

func (f *fakeFactory) Start(_ context.Context, req StartRequest) (AgentRuntime, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reqs = append(f.reqs, req)
	if f.err != nil {
		return nil, f.err
	}
	if f.next != nil {
		rt := f.next
		f.next = nil
		return rt, nil
	}
	if len(f.runtimes) == 0 {
		return nil, errors.New("no runtime queued")
	}
	rt := f.runtimes[0]
	f.runtimes = f.runtimes[1:]
	return rt, nil
}

func (f *fakeFactory) requests() []StartRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]StartRequest(nil), f.reqs...)
}

func newTestManager(t *testing.T) (*Manager, *memRepo, *fakeBus, *fakeFactory, *counter) {
	t.Helper()
	repo, bus, factory, ids := newMemRepo(), newFakeBus(), &fakeFactory{}, &counter{}
	m := NewManager(ManagerConfig{
		Repo: repo, Runtimes: factory, Bus: bus,
		NewID: func() string { return ids.next() },
	})
	return m, repo, bus, factory, ids
}

type counter struct {
	mu sync.Mutex
	n  int
}

func (c *counter) next() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n++
	return fmt.Sprintf("id-%d", c.n)
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func createClaude(t *testing.T, m *Manager) domain.SessionSnapshot {
	t.Helper()
	snap, err := m.CreateSession(context.Background(), domain.AgentClaude, "/tmp/proj")
	if err != nil {
		t.Fatal(err)
	}
	return snap
}

func TestCreateSessionPersistsDetached(t *testing.T) {
	m, repo, _, _, _ := newTestManager(t)
	snap := createClaude(t, m)
	if snap.Agent != domain.AgentClaude || snap.Cwd != "/tmp/proj" || snap.Status != domain.StatusDetached {
		t.Fatalf("snapshot = %+v", snap)
	}
	stored, err := repo.Get(context.Background(), snap.ID)
	if err != nil || stored.ID != snap.ID {
		t.Fatalf("stored = %+v, %v", stored, err)
	}
}

func TestCreateSessionRejectsInvalid(t *testing.T) {
	m, _, _, _, _ := newTestManager(t)
	if _, err := m.CreateSession(context.Background(), domain.AgentKind("x"), "/p"); !errors.Is(err, domain.ErrInvalidSession) {
		t.Fatalf("want ErrInvalidSession, got %v", err)
	}
}

func TestListAndGetSessions(t *testing.T) {
	m, _, _, _, _ := newTestManager(t)
	a := createClaude(t, m)
	b := createClaude(t, m)
	list, err := m.ListSessions(context.Background())
	if err != nil || len(list) != 2 || list[0].ID != a.ID || list[1].ID != b.ID {
		t.Fatalf("list = %+v, %v", list, err)
	}
	got, err := m.GetSession(context.Background(), a.ID)
	if err != nil || got.ID != a.ID {
		t.Fatalf("get = %+v, %v", got, err)
	}
	if _, err := m.GetSession(context.Background(), "nope"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("want ErrSessionNotFound, got %v", err)
	}
}

func TestRestoreNormalizesAndPersists(t *testing.T) {
	m, repo, _, _, _ := newTestManager(t)
	ctx := context.Background()
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "run", Agent: domain.AgentClaude, Cwd: "/p", NativeID: "n", Status: domain.StatusRunning})
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "idle", Agent: domain.AgentClaude, Cwd: "/p", NativeID: "n", Status: domain.StatusIdle})

	got, err := m.Restore(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("restored %d sessions", len(got))
	}
	run, _ := repo.Get(ctx, "run")
	idle, _ := repo.Get(ctx, "idle")
	if run.Status != domain.StatusInterrupted || run.Interruption.Reason != domain.ExitServerRestart {
		t.Fatalf("running session = %+v", run)
	}
	if idle.Status != domain.StatusDetached {
		t.Fatalf("idle session = %+v", idle)
	}
}

func TestNewManagerGeneratesRandomIDs(t *testing.T) {
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: &fakeFactory{}, Bus: newFakeBus()})
	snap, err := m.CreateSession(context.Background(), domain.AgentClaude, "/p")
	if err != nil {
		t.Fatal(err)
	}
	if snap.ID == "" || len(snap.ID) != 32 {
		t.Fatalf("id = %q", snap.ID)
	}
}

func TestGetSessionLazilyRestoresFromRepo(t *testing.T) {
	m, repo, _, _, _ := newTestManager(t)
	ctx := context.Background()
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "lazy", Agent: domain.AgentClaude, Cwd: "/p", NativeID: "n", Status: domain.StatusRunning})

	got, err := m.GetSession(ctx, "lazy")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != domain.StatusInterrupted || got.Interruption.Reason != domain.ExitServerRestart {
		t.Fatalf("restored = %+v", got)
	}
	// Second call is served from memory and keeps the same snapshot.
	again, err := m.GetSession(ctx, "lazy")
	if err != nil || again.Status != got.Status {
		t.Fatalf("cached = %+v, %v", again, err)
	}
}

func TestRestoreSkipsInvalidSnapshots(t *testing.T) {
	m, repo, _, _, _ := newTestManager(t)
	ctx := context.Background()
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "bad", Agent: domain.AgentKind("bogus"), Cwd: "/p"})
	got, err := m.Restore(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("restored = %+v", got)
	}
}

type flakyRepo struct {
	*memRepo
	failAt int
	saves  int
}

func (r *flakyRepo) Save(ctx context.Context, s domain.SessionSnapshot) error {
	r.saves++
	if r.saves == r.failAt {
		return errors.New("save failed")
	}
	return r.memRepo.Save(ctx, s)
}

func TestRestoreReportsSaveError(t *testing.T) {
	base := newMemRepo()
	ctx := context.Background()
	_ = base.Save(ctx, domain.SessionSnapshot{ID: "run", Agent: domain.AgentClaude, Cwd: "/p", Status: domain.StatusRunning})
	repo := &flakyRepo{memRepo: base, failAt: 1}
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: &fakeFactory{}, Bus: newFakeBus(), NewID: func() string { return "x" }})
	if _, err := m.Restore(ctx); err == nil {
		t.Fatal("want save error")
	}
}

func TestSendMessageReportsSaveError(t *testing.T) {
	base := newMemRepo()
	repo := &flakyRepo{memRepo: base, failAt: 2}
	factory := &fakeFactory{runtimes: []*fakeRuntime{newFakeRuntime("n1")}}
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: factory, Bus: newFakeBus(), NewID: func() string { return "id" }})
	ctx := context.Background()
	snap, err := m.CreateSession(ctx, domain.AgentClaude, "/p")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err == nil {
		t.Fatal("want save error")
	}
}

func TestSendMessageStartsTurnAndRuntime(t *testing.T) {
	m, repo, bus, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(context.Background(), snap.ID, "hello"); err != nil {
		t.Fatal(err)
	}
	reqs := factory.requests()
	if len(reqs) != 1 || reqs[0].NativeID != "" || reqs[0].Cwd != "/tmp/proj" {
		t.Fatalf("start requests = %+v", reqs)
	}
	if rt.sentMessages()[0].text != "hello" {
		t.Fatalf("sent = %+v", rt.sentMessages())
	}
	stored, _ := repo.Get(context.Background(), snap.ID)
	if stored.Status != domain.StatusRunning || stored.NativeID != "native-1" {
		t.Fatalf("stored = %+v", stored)
	}
	events := bus.snapshot()
	if len(events) != 2 || events[0].Type != domain.EventTurnStarted || events[1].Type != domain.EventItemUpdated {
		t.Fatalf("events = %+v", events)
	}
	if events[1].Item.Kind != domain.ItemUserMessage || events[1].Item.Text != "hello" {
		t.Fatalf("user item = %+v", events[1].Item)
	}
}

func TestTurnEndedReturnsToIdleWithSeq(t *testing.T) {
	m, repo, bus, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(context.Background(), snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: "ok"}}
	eventually(t, "idle session", func() bool {
		s, _ := repo.Get(context.Background(), snap.ID)
		return s.Status == domain.StatusIdle
	})
	events := bus.snapshot()
	if events[len(events)-1].Type != domain.EventSessionState {
		t.Fatalf("last event = %+v", events[len(events)-1])
	}
	for i, ev := range events {
		if ev.Seq != domain.Seq(i+1) {
			t.Fatalf("event %d seq = %d, want %d", i, ev.Seq, i+1)
		}
	}
}

func TestRuntimeExitDuringTurnInterrupts(t *testing.T) {
	m, repo, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(context.Background(), snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	_ = rt.Close()
	eventually(t, "interrupted session", func() bool {
		s, _ := repo.Get(context.Background(), snap.ID)
		return s.Status == domain.StatusInterrupted && s.Interruption.Reason == domain.ExitCrashed
	})
}

func TestResumeUsesNativeID(t *testing.T) {
	m, repo, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	first := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{first}
	if err := m.SendMessage(context.Background(), snap.ID, "one"); err != nil {
		t.Fatal(err)
	}
	first.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle", func() bool { s, _ := repo.Get(context.Background(), snap.ID); return s.Status == domain.StatusIdle })
	_ = first.Close()
	eventually(t, "detached", func() bool { s, _ := repo.Get(context.Background(), snap.ID); return s.Status == domain.StatusDetached })

	second := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{second}
	if err := m.SendMessage(context.Background(), snap.ID, "two"); err != nil {
		t.Fatal(err)
	}
	reqs := factory.requests()
	if len(reqs) != 2 || reqs[1].NativeID != "native-1" {
		t.Fatalf("resume requests = %+v", reqs)
	}
}

func TestSendMessageUnknownSession(t *testing.T) {
	m, _, _, _, _ := newTestManager(t)
	if err := m.SendMessage(context.Background(), "nope", "x"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("want ErrSessionNotFound, got %v", err)
	}
}

func TestSendMessageRunsWhileAttached(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(context.Background(), snap.ID, "one"); err != nil {
		t.Fatal(err)
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle", func() bool { return currentStatus(m, snap.ID) == domain.StatusIdle })
	if err := m.SendMessage(context.Background(), snap.ID, "two"); err != nil {
		t.Fatal(err)
	}
	if len(factory.requests()) != 1 {
		t.Fatalf("runtime restarted: %+v", factory.requests())
	}
	if msgs := rt.sentMessages(); len(msgs) != 2 || msgs[1].text != "two" {
		t.Fatalf("sent = %+v", msgs)
	}
}

func TestInterruptDelegatesAndMissingIsNoop(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.Interrupt(context.Background(), snap.ID); err != nil {
		t.Fatalf("interrupt without runtime: %v", err)
	}
	if err := m.SendMessage(context.Background(), snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	if err := m.Interrupt(context.Background(), snap.ID); err != nil {
		t.Fatal(err)
	}
	rt.mu.Lock()
	got := rt.interrupts
	rt.mu.Unlock()
	if got != 1 {
		t.Fatalf("interrupts = %d", got)
	}
	if err := m.Interrupt(context.Background(), "nope"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("want ErrSessionNotFound, got %v", err)
	}
}

func TestStartFailureLeavesDetached(t *testing.T) {
	m, repo, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	factory.err = errors.New("boom")
	if err := m.SendMessage(context.Background(), snap.ID, "hi"); err == nil {
		t.Fatal("want error")
	}
	s, _ := repo.Get(context.Background(), snap.ID)
	if s.Status != domain.StatusDetached {
		t.Fatalf("status = %s", s.Status)
	}
}

func TestAttachRejectsNativeIDMismatch(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	first := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{first}
	if err := m.SendMessage(context.Background(), snap.ID, "one"); err != nil {
		t.Fatal(err)
	}
	first.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle", func() bool { return currentStatus(m, snap.ID) == domain.StatusIdle })
	_ = first.Close()
	eventually(t, "detached", func() bool { return currentStatus(m, snap.ID) == domain.StatusDetached })

	wrong := newFakeRuntime("native-2")
	factory.runtimes = []*fakeRuntime{wrong}
	if err := m.SendMessage(context.Background(), snap.ID, "two"); !errors.Is(err, domain.ErrNativeIDMismatch) {
		t.Fatalf("want ErrNativeIDMismatch, got %v", err)
	}
}

func TestSendErrorPropagates(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	rt.sendErr = errors.New("write failed")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(context.Background(), snap.ID, "hi"); err == nil {
		t.Fatal("want send error")
	}
}

func TestCloseClosesRuntimes(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(context.Background(), snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	m.Close()
	rt.mu.Lock()
	closed := rt.closed
	rt.mu.Unlock()
	if !closed {
		t.Fatal("runtime not closed")
	}
}

func TestMalformedEventIsIgnored(t *testing.T) {
	m, _, bus, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(context.Background(), snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	before := len(bus.snapshot())
	rt.events <- domain.Event{} // invalid: no session/type
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "turn end", func() bool { return currentStatus(m, snap.ID) == domain.StatusIdle })
	if got := len(bus.snapshot()); got != before+2 {
		t.Fatalf("malformed event reached the bus: %d -> %d", before, got)
	}
}

func currentStatus(m *Manager, id domain.SessionID) domain.SessionStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[id]; s != nil {
		return s.Status()
	}
	return domain.SessionStatus("")
}

func requestEvent(session domain.SessionID, id domain.RequestID) domain.Event {
	return domain.Event{
		SessionID: session, Type: domain.EventRequestOpened,
		Request: &domain.Request{ID: id, SessionID: session, Kind: domain.RequestPermission, State: domain.RequestPending},
	}
}

func TestRequestLifecycle(t *testing.T) {
	m, _, bus, factory, _ := newTestManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	rt.events <- requestEvent(snap.ID, "r1")
	eventually(t, "pending request", func() bool { return len(m.PendingRequests(ctx)) == 1 })

	if err := m.RespondRequest(ctx, snap.ID, "r1", RequestAnswer{Allow: true}); err != nil {
		t.Fatal(err)
	}
	got := rt.responded()
	if len(got) != 1 || got[0].id != "r1" || !got[0].answer.Allow {
		t.Fatalf("responses = %+v", got)
	}
	if len(m.PendingRequests(ctx)) != 0 {
		t.Fatal("request not removed from pending")
	}
	events := bus.snapshot()
	if events[len(events)-1].Type != domain.EventRequestResolved {
		t.Fatalf("last event = %+v", events[len(events)-1])
	}
}

func TestRespondRequestRecordsDecision(t *testing.T) {
	cases := []struct {
		name     string
		kind     domain.RequestKind
		answer   RequestAnswer
		decision domain.Decision
		text     string
	}{
		{"approve", domain.RequestPermission, RequestAnswer{Allow: true}, domain.DecisionApproved, ""},
		{"approve for session", domain.RequestPermission, RequestAnswer{Allow: true, AllowForSession: true}, domain.DecisionApproved, "for this session"},
		{"deny", domain.RequestPermission, RequestAnswer{Message: "not now"}, domain.DecisionDenied, "not now"},
		{"answer", domain.RequestQuestion, RequestAnswer{Allow: true, Answers: map[string][]string{"Pick?": {"Alpha", "Beta"}, "Also?": {"Yes"}}}, domain.DecisionAnswered, "Also? Yes\nPick? Alpha, Beta"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, _, bus, factory, _ := newTestManager(t)
			ctx := context.Background()
			snap := createClaude(t, m)
			rt := newFakeRuntime("n1")
			factory.runtimes = []*fakeRuntime{rt}
			if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
				t.Fatal(err)
			}
			ev := requestEvent(snap.ID, "r1")
			ev.Request.Kind = c.kind
			ev.Request.Title = "Run command"
			ev.Request.TurnID = "t7"
			rt.events <- ev
			eventually(t, "pending", func() bool { return len(m.PendingRequests(ctx)) == 1 })

			if err := m.RespondRequest(ctx, snap.ID, "r1", c.answer); err != nil {
				t.Fatal(err)
			}
			events := bus.snapshot()
			if len(events) < 2 {
				t.Fatalf("events = %+v", events)
			}
			rec := events[len(events)-2]
			if rec.Type != domain.EventItemUpdated || rec.Item == nil {
				t.Fatalf("decision not recorded before resolution: %+v", rec)
			}
			it := rec.Item
			if it.Kind != domain.ItemDecision || it.Decision != c.decision || it.Name != "Run command" ||
				it.Text != c.text || it.TurnID != "t7" || it.SessionID != snap.ID || it.Status != domain.ItemCompleted || it.ID == "" {
				t.Fatalf("decision item = %+v", it)
			}
			if events[len(events)-1].Type != domain.EventRequestResolved {
				t.Fatalf("last event = %+v", events[len(events)-1])
			}
		})
	}
}

func TestFailedRespondRecordsNoDecision(t *testing.T) {
	m, _, bus, factory, _ := newTestManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	rt.events <- requestEvent(snap.ID, "r1")
	eventually(t, "pending", func() bool { return len(m.PendingRequests(ctx)) == 1 })
	rt.respondErr = errors.New("boom")
	_ = m.RespondRequest(ctx, snap.ID, "r1", RequestAnswer{Allow: true})
	for _, ev := range bus.snapshot() {
		if ev.Item != nil && ev.Item.Kind == domain.ItemDecision {
			t.Fatalf("decision recorded for a failed answer: %+v", ev.Item)
		}
	}
}

func TestRespondRequestErrors(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	if err := m.RespondRequest(ctx, snap.ID, "missing", RequestAnswer{}); !errors.Is(err, ErrRequestNotFound) {
		t.Fatalf("want ErrRequestNotFound, got %v", err)
	}
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	rt.events <- requestEvent(snap.ID, "r2")
	eventually(t, "pending", func() bool { return len(m.PendingRequests(ctx)) == 1 })

	rt.respondErr = errors.New("boom")
	if err := m.RespondRequest(ctx, snap.ID, "r2", RequestAnswer{Allow: true}); err == nil {
		t.Fatal("want respond error")
	}
	if len(m.PendingRequests(ctx)) != 1 {
		t.Fatal("failed respond must keep the request pending")
	}
	if err := m.RespondRequest(ctx, "other-session", "r2", RequestAnswer{}); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("want ErrSessionNotFound, got %v", err)
	}
}

func TestRequestsGoStaleOnRuntimeExit(t *testing.T) {
	m, _, bus, factory, _ := newTestManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	rt.events <- requestEvent(snap.ID, "r1")
	eventually(t, "pending", func() bool { return len(m.PendingRequests(ctx)) == 1 })

	_ = rt.Close()
	eventually(t, "stale resolution", func() bool {
		for _, ev := range bus.snapshot() {
			if ev.Type == domain.EventRequestResolved && ev.Request.ID == "r1" && ev.Request.State == domain.RequestStale {
				return true
			}
		}
		return false
	})
	if len(m.PendingRequests(ctx)) != 0 {
		t.Fatal("stale request still pending")
	}
}

func TestRequestsAreScopedPerSession(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	ctx := context.Background()
	a := createClaude(t, m)
	b := createClaude(t, m)
	rtA := newFakeRuntime("n1")
	rtB := newFakeRuntime("n2")
	factory.runtimes = []*fakeRuntime{rtA, rtB}
	if err := m.SendMessage(ctx, a.ID, "one"); err != nil {
		t.Fatal(err)
	}
	if err := m.SendMessage(ctx, b.ID, "two"); err != nil {
		t.Fatal(err)
	}
	// The agent may reuse a request id across sessions (the fake CLI does).
	rtA.events <- requestEvent(a.ID, "shared")
	rtB.events <- requestEvent(b.ID, "shared")
	eventually(t, "two pending", func() bool { return len(m.PendingRequests(ctx)) == 2 })

	if err := m.RespondRequest(ctx, a.ID, "shared", RequestAnswer{Allow: true}); err != nil {
		t.Fatal(err)
	}
	got := rtA.responded()
	if len(got) != 1 || got[0].id != "shared" {
		t.Fatalf("runtime A responses = %+v", got)
	}
	pending := m.PendingRequests(ctx)
	if len(pending) != 1 || pending[0].SessionID != b.ID {
		t.Fatalf("pending = %+v", pending)
	}
	if len(rtB.responded()) != 0 {
		t.Fatal("runtime B must not be answered")
	}
}

type fakeAccounts struct {
	info      AccountInfo
	challenge LoginChallenge
	err       error
}

func (f *fakeAccounts) Account(context.Context, domain.AgentKind) (AccountInfo, error) {
	return f.info, f.err
}
func (f *fakeAccounts) StartLogin(context.Context, domain.AgentKind) (LoginChallenge, error) {
	return f.challenge, f.err
}

func TestAccountDelegation(t *testing.T) {
	m, _, _, _, _ := newTestManager(t)
	ctx := context.Background()
	if _, err := m.Account(ctx, domain.AgentCodex); !errors.Is(err, ErrAccountsUnsupported) {
		t.Fatalf("want ErrAccountsUnsupported, got %v", err)
	}
	if _, err := m.StartLogin(ctx, domain.AgentCodex); !errors.Is(err, ErrAccountsUnsupported) {
		t.Fatalf("want ErrAccountsUnsupported, got %v", err)
	}

	accounts := &fakeAccounts{
		info:      AccountInfo{Agent: domain.AgentCodex, LoggedIn: true, Email: "a@b.c", Plan: "plus"},
		challenge: LoginChallenge{LoginID: "l1", UserCode: "CODE", URL: "https://example"},
	}
	base := newMemRepo()
	m = NewManager(ManagerConfig{Repo: base, Runtimes: &fakeFactory{}, Bus: newFakeBus(), NewID: func() string { return "x" }, Accounts: accounts})
	info, err := m.Account(ctx, domain.AgentCodex)
	if err != nil || !info.LoggedIn || info.Email != "a@b.c" {
		t.Fatalf("info = %+v, %v", info, err)
	}
	ch, err := m.StartLogin(ctx, domain.AgentCodex)
	if err != nil || ch.UserCode != "CODE" {
		t.Fatalf("challenge = %+v, %v", ch, err)
	}
}

func TestSteerRunningDelegates(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	if err := m.Steer(ctx, snap.ID, "more"); err != nil {
		t.Fatal(err)
	}
	rt.mu.Lock()
	steers := append([]string(nil), rt.steers...)
	rt.mu.Unlock()
	if len(steers) != 1 || steers[0] != "more" {
		t.Fatalf("steers = %+v", steers)
	}
}

func TestSteerIdleStartsTurn(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.Steer(ctx, snap.ID, "first"); err != nil {
		t.Fatal(err)
	}
	if msgs := rt.sentMessages(); len(msgs) != 1 || msgs[0].text != "first" {
		t.Fatalf("sent = %+v", msgs)
	}
}

func TestStopTaskDelegates(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	if err := m.StopTask(ctx, snap.ID, "task-1"); err != nil {
		t.Fatal(err)
	}
	rt.mu.Lock()
	stopped := append([]string(nil), rt.stoppedTasks...)
	rt.mu.Unlock()
	if len(stopped) != 1 || stopped[0] != "task-1" {
		t.Fatalf("stopped = %+v", stopped)
	}
	if err := m.StopTask(ctx, "missing", "task-1"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("want ErrSessionNotFound, got %v", err)
	}
}

func TestSubagentSpawnCreatesChildSession(t *testing.T) {
	m, repo, bus, factory, _ := newTestManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	parentRt := newFakeRuntime("n1")
	childRt := newFakeRuntime("child-thread")
	factory.runtimes = []*fakeRuntime{parentRt, childRt}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	parentRt.events <- domain.Event{
		SessionID: snap.ID, Type: domain.EventSubagentSpawned,
		Subagent: &domain.SubagentSpawn{ThreadID: "child-thread", Title: "triage"},
	}
	var childID domain.SessionID
	eventually(t, "child session", func() bool {
		sessions, _ := repo.List(ctx)
		for _, s := range sessions {
			if s.ParentID == snap.ID && s.NativeID == "child-thread" {
				childID = s.ID
				return true
			}
		}
		return false
	})
	child, err := repo.Get(ctx, childID)
	if err != nil || child.NativeID != "child-thread" || child.Title != "triage" {
		t.Fatalf("child = %+v, %v", child, err)
	}
	reqs := factory.requests()
	if len(reqs) != 2 || !reqs[1].Passive || reqs[1].NativeID != "child-thread" {
		t.Fatalf("requests = %+v", reqs)
	}
	// Child runtime events are tagged with the child session id.
	childRt.events <- domain.Event{SessionID: childID, Type: domain.EventTurnStarted}
	eventually(t, "child event", func() bool {
		for _, ev := range bus.snapshot() {
			if ev.SessionID == childID && ev.Type == domain.EventTurnStarted {
				return true
			}
		}
		return false
	})
}

type fakeQuotaRepo struct {
	mu    sync.Mutex
	saved []domain.QuotaSnapshot
}

func (r *fakeQuotaRepo) SaveQuota(_ context.Context, q domain.QuotaSnapshot) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.saved = append(r.saved, q)
	return nil
}
func (r *fakeQuotaRepo) GetQuota(_ context.Context, agent domain.AgentKind) (domain.QuotaSnapshot, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.saved) - 1; i >= 0; i-- {
		if r.saved[i].Agent == agent {
			return r.saved[i], true, nil
		}
	}
	return domain.QuotaSnapshot{}, false, nil
}
func (r *fakeQuotaRepo) ListQuotas(context.Context) ([]domain.QuotaSnapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]domain.QuotaSnapshot(nil), r.saved...), nil
}

func (r *fakeQuotaRepo) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.saved)
}

type fakeQuotaProvider struct {
	quota domain.QuotaSnapshot
	err   error
}

func (p *fakeQuotaProvider) RateLimits(context.Context, domain.AgentKind) (domain.QuotaSnapshot, error) {
	return p.quota, p.err
}

func TestQuotaEventIsCached(t *testing.T) {
	repo := &fakeQuotaRepo{}
	base := newMemRepo()
	factory := &fakeFactory{}
	m := NewManager(ManagerConfig{Repo: base, Runtimes: factory, Bus: newFakeBus(), NewID: func() string { return "id" }, Quotas: repo})
	ctx := context.Background()
	snap, err := m.CreateSession(ctx, domain.AgentClaude, "/p")
	if err != nil {
		t.Fatal(err)
	}
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventQuota,
		Quota: &domain.QuotaSnapshot{Agent: domain.AgentClaude, Windows: []domain.QuotaWindow{{Name: "five_hour", UsedPct: 10}}}}
	eventually(t, "quota cached", func() bool { return repo.count() == 1 })
	list, err := m.Quotas(ctx)
	if err != nil || len(list) != 1 || list[0].Windows[0].Name != "five_hour" {
		t.Fatalf("quotas = %+v, %v", list, err)
	}
}

func TestRefreshQuota(t *testing.T) {
	m, _, _, _, _ := newTestManager(t)
	if _, err := m.RefreshQuota(context.Background(), domain.AgentCodex); !errors.Is(err, ErrQuotasUnsupported) {
		t.Fatalf("want ErrQuotasUnsupported, got %v", err)
	}

	repo := &fakeQuotaRepo{}
	provider := &fakeQuotaProvider{quota: domain.QuotaSnapshot{Agent: domain.AgentCodex, Windows: []domain.QuotaWindow{{Name: "primary", UsedPct: 20}}}}
	m = NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: &fakeFactory{}, Bus: newFakeBus(), NewID: func() string { return "x" }, Quotas: repo, QuotaProvider: provider})
	got, err := m.RefreshQuota(context.Background(), domain.AgentCodex)
	if err != nil || got.Windows[0].UsedPct != 20 || repo.count() != 1 {
		t.Fatalf("refresh = %+v, %v, saved=%d", got, err, repo.count())
	}
}

func TestQuotasWithoutRepo(t *testing.T) {
	m, _, _, _, _ := newTestManager(t)
	list, err := m.Quotas(context.Background())
	if err != nil || list != nil {
		t.Fatalf("quotas = %+v, %v", list, err)
	}
}
