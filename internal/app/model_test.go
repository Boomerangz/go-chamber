package app

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// modelRuntime is a runtime that can switch models live.
type modelRuntime struct {
	*fakeRuntime
	mu  sync.Mutex
	set [][2]string
	err error
}

func (r *modelRuntime) SetModel(_ context.Context, model, effort string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.set = append(r.set, [2]string{model, effort})
	return r.err
}

func (r *modelRuntime) calls() [][2]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][2]string(nil), r.set...)
}

func (f *fakeRuntime) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

func TestSetModelIsSavedPublishedAndUsedOnStart(t *testing.T) {
	m, repo, bus, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	ctx := context.Background()
	got, err := m.SetModel(ctx, snap.ID, "opus", "high")
	if err != nil || got.Model != "opus" || got.Effort != "high" {
		t.Fatalf("SetModel = %+v, %v", got, err)
	}
	if stored, _ := repo.Get(ctx, snap.ID); stored.Model != "opus" {
		t.Fatalf("stored = %+v", stored)
	}
	if last := bus.snapshot(); last[len(last)-1].Session.Effort != "high" {
		t.Fatalf("last event = %+v", last[len(last)-1])
	}
	factory.runtimes = []*fakeRuntime{newFakeRuntime("n1")}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	if req := factory.requests()[0]; req.Model != "opus" || req.Effort != "high" {
		t.Fatalf("start request = %+v", req)
	}
}

func TestSetModelRejectsInvalidChoice(t *testing.T) {
	m, _, _, _, _ := newTestManager(t)
	snap := createClaude(t, m)
	if _, err := m.SetModel(context.Background(), snap.ID, "bad model", ""); !errors.Is(err, domain.ErrInvalidModel) {
		t.Fatalf("err = %v", err)
	}
	if _, err := m.SetModel(context.Background(), "nope", "x", ""); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("unknown session err = %v", err)
	}
}

func startWith(t *testing.T, m *Manager, factory *fakeFactory, id domain.SessionID, rt AgentRuntime) {
	t.Helper()
	factory.next = rt
	if err := m.SendMessage(context.Background(), id, "hi"); err != nil {
		t.Fatal(err)
	}
}

func endTurn(t *testing.T, m *Manager, rt *fakeRuntime, id domain.SessionID) {
	t.Helper()
	rt.events <- domain.Event{SessionID: id, Type: domain.EventTurnEnded}
	eventually(t, "idle", func() bool {
		s, _ := m.GetSession(context.Background(), id)
		return s.Status == domain.StatusIdle
	})
}

func TestSetModelSwitchesLiveWhenTheRuntimeCan(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := &modelRuntime{fakeRuntime: newFakeRuntime("n1")}
	startWith(t, m, factory, snap.ID, rt)
	if _, err := m.SetModel(context.Background(), snap.ID, "haiku", ""); err != nil {
		t.Fatal(err)
	}
	if calls := rt.calls(); len(calls) != 1 || calls[0] != [2]string{"haiku", ""} {
		t.Fatalf("calls = %v", calls)
	}
	if rt.isClosed() {
		t.Fatal("runtime restarted although it switched live")
	}
}

func TestSetModelRestartsAnIdleRuntimeThatCannotSwitch(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	first := &modelRuntime{fakeRuntime: newFakeRuntime("n1"), err: ErrRestartRequired}
	startWith(t, m, factory, snap.ID, first)
	endTurn(t, m, first.fakeRuntime, snap.ID)

	if _, err := m.SetModel(context.Background(), snap.ID, "opus", "max"); err != nil {
		t.Fatal(err)
	}
	eventually(t, "idle runtime closed", first.isClosed)
	second := newFakeRuntime("n1")
	startWith(t, m, factory, snap.ID, second)
	reqs := factory.requests()
	if last := reqs[len(reqs)-1]; last.NativeID != "n1" || last.Model != "opus" || last.Effort != "max" {
		t.Fatalf("restart request = %+v", last)
	}
}

func TestSetModelDefersTheRestartOfARunningTurn(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	first := newFakeRuntime("n1") // cannot switch models at all
	startWith(t, m, factory, snap.ID, first)

	if _, err := m.SetModel(context.Background(), snap.ID, "opus", ""); err != nil {
		t.Fatal(err)
	}
	if first.isClosed() {
		t.Fatal("running turn was killed")
	}
	endTurn(t, m, first, snap.ID)
	second := newFakeRuntime("n1")
	startWith(t, m, factory, snap.ID, second)
	eventually(t, "old runtime closed", first.isClosed)
	reqs := factory.requests()
	if last := reqs[len(reqs)-1]; last.Model != "opus" {
		t.Fatalf("restart request = %+v", last)
	}
	if got := second.sentMessages(); len(got) != 1 {
		t.Fatalf("new runtime got %v", got)
	}
}

func TestSetModelReportsLiveSwitchErrors(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	boom := errors.New("boom")
	startWith(t, m, factory, snap.ID, &modelRuntime{fakeRuntime: newFakeRuntime("n1"), err: boom})
	if _, err := m.SetModel(context.Background(), snap.ID, "opus", ""); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
}

type fakeCatalog struct{ agent domain.AgentKind }

func (c *fakeCatalog) Models(_ context.Context, agent domain.AgentKind) ([]ModelInfo, error) {
	c.agent = agent
	return []ModelInfo{{ID: "opus", Name: "Opus"}}, nil
}

func TestModelsComeFromTheCatalog(t *testing.T) {
	catalog := &fakeCatalog{}
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: &fakeFactory{}, Bus: newFakeBus(), Models: catalog})
	models, err := m.Models(context.Background(), domain.AgentCodex)
	if err != nil || len(models) != 1 || catalog.agent != domain.AgentCodex {
		t.Fatalf("models = %+v, %v", models, err)
	}
	bare := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: &fakeFactory{}, Bus: newFakeBus()})
	if _, err := bare.Models(context.Background(), domain.AgentClaude); !errors.Is(err, ErrModelsUnsupported) {
		t.Fatalf("err = %v", err)
	}
}
