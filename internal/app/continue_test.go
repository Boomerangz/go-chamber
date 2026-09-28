package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func sentTexts(rt *fakeRuntime) []string {
	var out []string
	for _, m := range rt.sentMessages() {
		out = append(out, m.text)
	}
	return out
}

func sent(rt *fakeRuntime, text string) bool {
	for _, s := range sentTexts(rt) {
		if s == text {
			return true
		}
	}
	return false
}

func TestContinueResumesAnInterruptedTurn(t *testing.T) {
	m, repo, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	first, second := newFakeRuntime("native-1"), newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{first, second}
	ctx := context.Background()
	if err := m.SendMessage(ctx, snap.ID, "long job"); err != nil {
		t.Fatal(err)
	}
	_ = first.Close()
	eventually(t, "interrupted", func() bool {
		s, _ := repo.Get(ctx, snap.ID)
		return s.Status == domain.StatusInterrupted
	})
	if err := m.Continue(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	reqs := factory.requests()
	if len(reqs) != 2 || reqs[1].NativeID != "native-1" || reqs[1].Fork {
		t.Fatalf("start requests = %+v", reqs)
	}
	if !sent(second, ContinuePrompt) {
		t.Fatalf("sent = %v", sentTexts(second))
	}
}

func TestContinueRejectsSessionsWithNothingToContinue(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	ctx := context.Background()
	if err := m.Continue(ctx, snap.ID); !errors.Is(err, domain.ErrInvalidTransition) {
		t.Fatalf("fresh session: err = %v", err)
	}
	startWith(t, m, factory, snap.ID, newFakeRuntime("native-1"))
	if err := m.Continue(ctx, snap.ID); !errors.Is(err, domain.ErrInvalidTransition) {
		t.Fatalf("running session: err = %v", err)
	}
	if err := m.Continue(ctx, "missing"); err == nil {
		t.Fatal("unknown session must fail")
	}
}

func quotaStop(t *testing.T, m *Manager, rt *fakeRuntime, id domain.SessionID, resets time.Time) {
	t.Helper()
	rt.events <- quotaEvent(id, domain.QuotaSnapshot{Agent: domain.AgentClaude, Reached: true,
		Windows: []domain.QuotaWindow{{Name: "five_hour", Status: "rejected", UsedPct: 100, ResetsAt: resets}}})
	eventually(t, "quota interruption", func() bool { return currentStatus(m, id) == domain.StatusInterrupted })
}

func TestAutoContinueAfterTheQuotaResets(t *testing.T) {
	m, _, _, factory, snap := newQuotaManager(t)
	rt := newFakeRuntime("n1")
	startWith(t, m, factory, snap.ID, rt)
	quotaStop(t, m, rt, snap.ID, time.Now().Add(30*time.Millisecond))
	got, err := m.SetAutoContinue(context.Background(), snap.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if !got.AutoContinue {
		t.Fatalf("snapshot = %+v", got)
	}
	eventually(t, "continued after the reset", func() bool { return sent(rt, ContinuePrompt) })
	if s, _ := m.GetSession(context.Background(), snap.ID); s.AutoContinue || s.Status != domain.StatusRunning {
		t.Fatalf("after continuing: %+v", s)
	}
}

func TestAutoContinueCanBeCanceled(t *testing.T) {
	m, _, _, factory, snap := newQuotaManager(t)
	rt := newFakeRuntime("n1")
	startWith(t, m, factory, snap.ID, rt)
	quotaStop(t, m, rt, snap.ID, time.Now().Add(40*time.Millisecond))
	ctx := context.Background()
	if _, err := m.SetAutoContinue(ctx, snap.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetAutoContinue(ctx, snap.ID, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(80 * time.Millisecond)
	if sent(rt, ContinuePrompt) {
		t.Fatal("canceled auto-continue still fired")
	}
	if _, err := m.SetAutoContinue(ctx, "missing", false); err == nil {
		t.Fatal("unknown session must fail")
	}
}

func TestAutoContinueNeedsAQuotaInterruption(t *testing.T) {
	m, _, _, _, snap := newQuotaManager(t)
	if _, err := m.SetAutoContinue(context.Background(), snap.ID, true); !errors.Is(err, domain.ErrInvalidTransition) {
		t.Fatalf("err = %v", err)
	}
}

func TestRestoreArmsAutoContinue(t *testing.T) {
	repo, bus, factory := newMemRepo(), newFakeBus(), &fakeFactory{}
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	ctx := context.Background()
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "q", Agent: domain.AgentClaude, Cwd: "/p", NativeID: "n1",
		Status: domain.StatusInterrupted, AutoContinue: true,
		Interruption: domain.Interruption{Reason: domain.ExitQuota, ResumeAfter: time.Now().Add(-time.Minute)}})
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: factory, Bus: bus})
	t.Cleanup(m.Close)
	if _, err := m.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	eventually(t, "continued after restart", func() bool { return sent(rt, ContinuePrompt) })
}

func TestForkStartsANewSessionFromTheParent(t *testing.T) {
	m, repo, bus, factory, _ := newTestManager(t)
	parent := createClaude(t, m)
	ctx := context.Background()
	if _, err := m.Fork(ctx, parent.ID); !errors.Is(err, domain.ErrInvalidTransition) {
		t.Fatalf("fork before the first turn: err = %v", err)
	}
	startWith(t, m, factory, parent.ID, newFakeRuntime("native-1"))
	forked := newFakeRuntime("native-2")
	factory.next = forked
	fork, err := m.Fork(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fork.ID == parent.ID || fork.ForkOf != parent.ID || fork.NativeID != "native-2" || fork.Status != domain.StatusIdle {
		t.Fatalf("fork = %+v", fork)
	}
	reqs := factory.requests()
	last := reqs[len(reqs)-1]
	if !last.Fork || last.NativeID != "native-1" || last.SessionID != fork.ID {
		t.Fatalf("start request = %+v", last)
	}
	if saved, _ := repo.Get(ctx, fork.ID); saved.NativeID != "native-2" || saved.ForkOf != parent.ID {
		t.Fatalf("saved = %+v", saved)
	}
	published := false
	for _, ev := range bus.snapshot() {
		if ev.SessionID == fork.ID && ev.Type == domain.EventSessionState {
			published = true
		}
	}
	if !published {
		t.Fatal("fork not announced")
	}
	if err := m.SendMessage(ctx, fork.ID, "go on"); err != nil {
		t.Fatal(err)
	}
	if !sent(forked, "go on") {
		t.Fatal("fork does not take messages")
	}
	if _, err := m.Fork(ctx, "missing"); err == nil {
		t.Fatal("unknown session must fail")
	}
}

func TestForkStartFailureKeepsNoSession(t *testing.T) {
	m, repo, _, factory, _ := newTestManager(t)
	parent := createClaude(t, m)
	startWith(t, m, factory, parent.ID, newFakeRuntime("native-1"))
	factory.err = errors.New("boom")
	if _, err := m.Fork(context.Background(), parent.ID); err == nil {
		t.Fatal("start failure must be reported")
	}
	if all, _ := repo.List(context.Background()); len(all) != 1 {
		t.Fatalf("sessions = %+v", all)
	}
}
