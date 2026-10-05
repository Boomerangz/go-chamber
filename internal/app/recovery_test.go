package app

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type fakeHistory map[domain.SessionID][]domain.Event

func (h fakeHistory) History(id domain.SessionID, since domain.Seq) []domain.Event {
	var out []domain.Event
	for _, ev := range h[id] {
		if ev.Seq > since {
			out = append(out, ev)
		}
	}
	return out
}

func (h fakeHistory) Requests(id domain.SessionID) []domain.Event {
	var out []domain.Event
	for _, ev := range h[id] {
		if ev.Type == domain.EventRequestOpened || ev.Type == domain.EventRequestResolved {
			out = append(out, ev)
		}
	}
	return out
}

func TestRestoreClosesRequestsLeftOpen(t *testing.T) {
	repo, bus := newMemRepo(), newFakeBus()
	opened := requestEvent("run", "r1")
	opened.Seq = 1
	answered := requestEvent("run", "r2")
	answered.Seq = 2
	resolved := answered
	resolved.Seq, resolved.Type = 3, domain.EventRequestResolved
	history := fakeHistory{"run": {opened, answered, resolved}}
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: &fakeFactory{}, Bus: bus, History: history})
	ctx := context.Background()
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "run", Agent: domain.AgentClaude, Cwd: "/p", NativeID: "n", Status: domain.StatusRunning})
	if _, err := m.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	var closed []domain.RequestID
	for _, ev := range bus.snapshot() {
		if ev.Type == domain.EventRequestResolved {
			if ev.Request.State != domain.RequestStale {
				t.Fatalf("request state = %s", ev.Request.State)
			}
			closed = append(closed, ev.Request.ID)
		}
	}
	if len(closed) != 1 || closed[0] != "r1" {
		t.Fatalf("closed = %v", closed)
	}
}

// lingerRuntime keeps delivering events after Close, like a process that
// is still flushing output while being killed.
type lingerRuntime struct {
	*fakeRuntime
	closed chan struct{}
	once   sync.Once
}

func newLingerRuntime(native string) *lingerRuntime {
	return &lingerRuntime{fakeRuntime: newFakeRuntime(native), closed: make(chan struct{})}
}

func (r *lingerRuntime) Close() error {
	r.once.Do(func() { close(r.closed) })
	return nil
}

func (r *lingerRuntime) SetModel(context.Context, string, string) error { return ErrRestartRequired }

func TestRetiredRuntimeEventsAreIgnored(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	first := newLingerRuntime("n1")
	// Unbuffered, so a completed send means the previous event was handled.
	first.events = make(chan domain.Event)
	startWith(t, m, factory, snap.ID, first)
	endTurn(t, m, first.fakeRuntime, snap.ID)
	if _, err := m.SetModel(context.Background(), snap.ID, "opus", ""); err != nil {
		t.Fatal(err)
	}
	<-first.closed
	startWith(t, m, factory, snap.ID, newFakeRuntime("n1"))

	first.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	first.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	close(first.events)
	if got := currentStatus(m, snap.ID); got != domain.StatusRunning {
		t.Fatalf("new turn status = %s after a retired runtime ended its turn", got)
	}
}

func TestSendWhileRestartPendingKeepsTheRunningTurn(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	first := newFakeRuntime("n1")
	startWith(t, m, factory, snap.ID, first)
	if _, err := m.SetModel(context.Background(), snap.ID, "opus", ""); err != nil {
		t.Fatal(err)
	}
	if err := m.SendMessage(context.Background(), snap.ID, "more"); !errors.Is(err, domain.ErrInvalidTransition) {
		t.Fatalf("err = %v", err)
	}
	if first.isClosed() {
		t.Fatal("running turn was killed")
	}
	if got := len(factory.requests()); got != 1 {
		t.Fatalf("runtimes started = %d", got)
	}
}

func TestSendFailureLeavesSessionIdle(t *testing.T) {
	m, repo, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	rt.sendErr = errors.New("broken pipe")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(context.Background(), snap.ID, "hi"); err == nil {
		t.Fatal("want send error")
	}
	if got := currentStatus(m, snap.ID); got != domain.StatusIdle {
		t.Fatalf("status = %s", got)
	}
	if stored, _ := repo.Get(context.Background(), snap.ID); stored.Status != domain.StatusIdle {
		t.Fatalf("stored status = %s", stored.Status)
	}
	rt.mu.Lock()
	rt.sendErr = nil
	rt.mu.Unlock()
	if err := m.SendMessage(context.Background(), snap.ID, "again"); err != nil {
		t.Fatal(err)
	}
}

// gateRepo holds Get until two callers are inside it.
type gateRepo struct {
	*memRepo
	arrived sync.WaitGroup
}

func (r *gateRepo) Get(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	r.arrived.Done()
	r.arrived.Wait()
	return r.memRepo.Get(ctx, id)
}

func TestConcurrentLoadsShareOneSession(t *testing.T) {
	repo := &gateRepo{memRepo: newMemRepo()}
	repo.arrived.Add(2)
	_ = repo.Save(context.Background(), domain.SessionSnapshot{ID: "s", Agent: domain.AgentClaude, Cwd: "/p"})
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: &fakeFactory{}, Bus: newFakeBus()})
	got := make([]*domain.Session, 2)
	var wg sync.WaitGroup
	for i := range got {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got[i], _ = m.session(context.Background(), "s")
		}()
	}
	wg.Wait()
	if got[0] == nil || got[0] != got[1] {
		t.Fatalf("sessions = %p %p", got[0], got[1])
	}
}

// slowRespondRuntime blocks Respond until released.
type slowRespondRuntime struct {
	*fakeRuntime
	entered chan struct{}
	release chan struct{}
}

func (r *slowRespondRuntime) Respond(ctx context.Context, id domain.RequestID, a RequestAnswer) error {
	r.entered <- struct{}{}
	<-r.release
	return r.fakeRuntime.Respond(ctx, id, a)
}

func TestConcurrentAnswersReachTheAgentOnce(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	rt := &slowRespondRuntime{fakeRuntime: newFakeRuntime("n1"), entered: make(chan struct{}, 2), release: make(chan struct{})}
	startWith(t, m, factory, snap.ID, rt)
	rt.events <- requestEvent(snap.ID, "r1")
	eventually(t, "pending", func() bool { return len(m.PendingRequests(ctx)) == 1 })

	errs := make(chan error, 2)
	go func() { errs <- m.RespondRequest(ctx, snap.ID, "r1", RequestAnswer{Allow: true}) }()
	<-rt.entered
	if err := m.RespondRequest(ctx, snap.ID, "r1", RequestAnswer{Allow: true}); !errors.Is(err, ErrRequestNotFound) {
		t.Fatalf("second answer err = %v", err)
	}
	close(rt.release)
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
	if got := rt.responded(); len(got) != 1 {
		t.Fatalf("responses = %+v", got)
	}
}

func TestFailedAnswerCanBeRetried(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	rt.respondErr = errors.New("write failed")
	startWith(t, m, factory, snap.ID, rt)
	rt.events <- requestEvent(snap.ID, "r1")
	eventually(t, "pending", func() bool { return len(m.PendingRequests(ctx)) == 1 })
	if err := m.RespondRequest(ctx, snap.ID, "r1", RequestAnswer{Allow: true}); err == nil {
		t.Fatal("want respond error")
	}
	if len(m.PendingRequests(ctx)) != 1 {
		t.Fatal("failed answer dropped the request")
	}
	rt.mu.Lock()
	rt.respondErr = nil
	rt.mu.Unlock()
	if err := m.RespondRequest(ctx, snap.ID, "r1", RequestAnswer{Allow: true}); err != nil {
		t.Fatal(err)
	}
}

func TestCrashFailsUnfinishedItems(t *testing.T) {
	m, _, bus, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	startWith(t, m, factory, snap.ID, rt)
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventItemUpdated,
		Item: &domain.Item{ID: "open", SessionID: snap.ID, Kind: domain.ItemToolCall, Status: domain.ItemStreaming}}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventItemUpdated,
		Item: &domain.Item{ID: "done", SessionID: snap.ID, Kind: domain.ItemAssistantMessage, Status: domain.ItemCompleted}}
	_ = rt.Close()
	eventually(t, "interrupted", func() bool { return currentStatus(m, snap.ID) == domain.StatusInterrupted })

	failed := map[domain.ItemID]bool{}
	for _, ev := range bus.snapshot() {
		if ev.Type == domain.EventItemUpdated && ev.Item.Status == domain.ItemFailed {
			failed[ev.Item.ID] = true
		}
	}
	if !failed["open"] || failed["done"] {
		t.Fatalf("failed items = %v", failed)
	}
}

func newQuotaManager(t *testing.T) (*Manager, *fakeQuotaRepo, *fakeBus, *fakeFactory, domain.SessionSnapshot) {
	t.Helper()
	quotas, bus, factory := &fakeQuotaRepo{}, newFakeBus(), &fakeFactory{}
	ids := &counter{}
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: factory, Bus: bus, Quotas: quotas, NewID: ids.next})
	snap, err := m.CreateSession(context.Background(), domain.AgentClaude, "/p")
	if err != nil {
		t.Fatal(err)
	}
	return m, quotas, bus, factory, snap
}

func quotaEvent(id domain.SessionID, q domain.QuotaSnapshot) domain.Event {
	return domain.Event{SessionID: id, Type: domain.EventQuota, Quota: &q}
}

func TestQuotaWindowsAccumulate(t *testing.T) {
	m, quotas, bus, factory, snap := newQuotaManager(t)
	rt := newFakeRuntime("n1")
	startWith(t, m, factory, snap.ID, rt)
	rt.events <- quotaEvent(snap.ID, domain.QuotaSnapshot{Agent: domain.AgentClaude, Windows: []domain.QuotaWindow{{Name: "five_hour", UsedPct: 10}}})
	rt.events <- quotaEvent(snap.ID, domain.QuotaSnapshot{Agent: domain.AgentClaude, Windows: []domain.QuotaWindow{{Name: "seven_day", UsedPct: 40}}})
	eventually(t, "two quota saves", func() bool { return quotas.count() == 2 })
	last, _, _ := quotas.GetQuota(context.Background(), domain.AgentClaude)
	if len(last.Windows) != 2 {
		t.Fatalf("saved windows = %+v", last.Windows)
	}
	var published *domain.QuotaSnapshot
	for _, ev := range bus.snapshot() {
		if ev.Type == domain.EventQuota {
			published = ev.Quota
		}
	}
	if published == nil || len(published.Windows) != 2 {
		t.Fatalf("published = %+v", published)
	}
}

func TestReachedQuotaInterruptsTheTurn(t *testing.T) {
	m, _, _, factory, snap := newQuotaManager(t)
	rt := newFakeRuntime("n1")
	startWith(t, m, factory, snap.ID, rt)
	resets := time.Date(2026, 9, 28, 18, 0, 0, 0, time.UTC)
	rt.events <- quotaEvent(snap.ID, domain.QuotaSnapshot{Agent: domain.AgentClaude, Reached: true,
		Windows: []domain.QuotaWindow{{Name: "five_hour", Status: "rejected", UsedPct: 100, ResetsAt: resets}}})
	eventually(t, "quota interruption", func() bool { return currentStatus(m, snap.ID) == domain.StatusInterrupted })
	got, _ := m.GetSession(context.Background(), snap.ID)
	if got.Interruption.Reason != domain.ExitQuota || !got.Interruption.ResumeAfter.Equal(resets) {
		t.Fatalf("interruption = %+v", got.Interruption)
	}
	// The agent still reports the end of the cut-short turn.
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	time.Sleep(20 * time.Millisecond)
	if got := currentStatus(m, snap.ID); got != domain.StatusInterrupted {
		t.Fatalf("status after turn end = %s", got)
	}
	if err := m.SendMessage(context.Background(), snap.ID, "continue"); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreClosesRequestsLeftOpenInAnyStatus(t *testing.T) {
	repo, bus := newMemRepo(), newFakeBus()
	opened := requestEvent("idle", "r1")
	opened.Seq = 1
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: &fakeFactory{}, Bus: bus, History: fakeHistory{"idle": {opened}}})
	ctx := context.Background()
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "idle", Agent: domain.AgentClaude, Cwd: "/p", NativeID: "n", Status: domain.StatusIdle})
	if _, err := m.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	for _, ev := range bus.snapshot() {
		if ev.Type == domain.EventRequestResolved && ev.Request.ID == "r1" && ev.Request.State == domain.RequestStale {
			return
		}
	}
	t.Fatalf("request left open in an idle session was not closed: %+v", bus.snapshot())
}

// dyingRuntime crashes while an answer to it is in flight.
type dyingRuntime struct {
	*fakeRuntime
	died func()
}

func (r *dyingRuntime) Respond(context.Context, domain.RequestID, RequestAnswer) error {
	_ = r.Close()
	r.died()
	return errors.New("broken pipe")
}

func TestAnswerInFlightWhenTheRuntimeDiesGoesStale(t *testing.T) {
	m, repo, bus, factory, _ := newTestManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	rt := &dyingRuntime{fakeRuntime: newFakeRuntime("n1")}
	rt.died = func() {
		eventually(t, "crash handled", func() bool {
			s, _ := repo.Get(ctx, snap.ID)
			return s.Status == domain.StatusInterrupted
		})
	}
	startWith(t, m, factory, snap.ID, rt)
	rt.events <- requestEvent(snap.ID, "r1")
	eventually(t, "request pending", func() bool { return len(m.PendingRequests(ctx)) == 1 })
	if err := m.RespondRequest(ctx, snap.ID, "r1", RequestAnswer{Allow: true}); err == nil {
		t.Fatal("answer to a dead runtime succeeded")
	}
	for _, ev := range bus.snapshot() {
		if ev.Type == domain.EventRequestResolved && ev.Request.ID == "r1" && ev.Request.State == domain.RequestStale {
			return
		}
	}
	t.Fatal("claimed request never went stale")
}
