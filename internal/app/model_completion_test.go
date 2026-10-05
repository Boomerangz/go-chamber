package app

import (
	"context"
	"sync"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type completionModelRuntime struct {
	*fakeRuntime
	entered chan struct{}
	release chan struct{}
}

func (r *completionModelRuntime) SetModel(context.Context, string, string) error {
	close(r.entered)
	<-r.release
	return nil
}

func TestModelSwitchPreservesTurnCompletion(t *testing.T) {
	m, repo, bus, factory, _ := newTestManager(t)
	defer m.Close()
	snap := createClaude(t, m)
	rt := &completionModelRuntime{newFakeRuntime("n1"), make(chan struct{}), make(chan struct{})}
	unblock := sync.OnceFunc(func() { close(rt.release) })
	defer unblock()
	startWith(t, m, factory, snap.ID, rt)
	type result struct {
		snap domain.SessionSnapshot
		err  error
	}
	done := make(chan result, 1)
	go func() {
		s, err := m.SetModel(context.Background(), snap.ID, "opus", "")
		done <- result{s, err}
	}()
	eventually(t, "model switch waiting", func() bool {
		select {
		case <-rt.entered:
			return true
		default:
			return false
		}
	})
	endTurn(t, m, rt.fakeRuntime, snap.ID)
	eventually(t, "idle published", func() bool {
		events := bus.snapshot()
		last := events[len(events)-1].Session
		return last != nil && last.Status == domain.StatusIdle
	})
	unblock()
	r := <-done
	if r.err != nil {
		t.Fatal(r.err)
	}
	stored, err := repo.Get(context.Background(), snap.ID)
	if err != nil {
		t.Fatal(err)
	}
	events := bus.snapshot()
	published := events[len(events)-1].Session
	if r.snap.Status != domain.StatusIdle || stored.Status != domain.StatusIdle || published.Status != domain.StatusIdle {
		t.Fatalf("returned=%s stored=%s published=%s, want idle", r.snap.Status, stored.Status, published.Status)
	}
	if stored.Model != "opus" {
		t.Fatalf("model = %q, want opus", stored.Model)
	}
}
