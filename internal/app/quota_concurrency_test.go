package app

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type pausedQuotaBus struct {
	*fakeBus
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *pausedQuotaBus) unblock() { b.once.Do(func() { close(b.release) }) }

func (b *pausedQuotaBus) Publish(ev domain.Event) domain.Event {
	if ev.Type == domain.EventQuota && ev.SessionID == "s1" {
		close(b.entered)
		<-b.release
	}
	ev = b.fakeBus.Publish(ev)
	if ev.Type == domain.EventQuota && ev.SessionID != "s1" {
		b.unblock()
	}
	return ev
}

func TestConcurrentQuotaReportsKeepBothWindows(t *testing.T) {
	ctx := context.Background()
	repo := &fakeQuotaRepo{}
	bus := &pausedQuotaBus{fakeBus: newFakeBus(), entered: make(chan struct{}), release: make(chan struct{})}
	rt1, rt2 := newFakeRuntime("n1"), newFakeRuntime("n2")
	factory := &fakeFactory{runtimes: []*fakeRuntime{rt1, rt2}}
	n := 0
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: factory, Bus: bus, Quotas: repo, NewID: func() string {
		n++
		return fmt.Sprintf("s%d", n)
	}})
	for range 2 {
		s, err := m.CreateSession(ctx, domain.AgentCodex, "/p")
		if err != nil {
			t.Fatal(err)
		}
		if err := m.SendMessage(ctx, s.ID, "hi"); err != nil {
			t.Fatal(err)
		}
	}
	defer m.Close()
	quota := func(name string) domain.Event {
		return domain.Event{SessionID: "native", Type: domain.EventQuota, Quota: &domain.QuotaSnapshot{
			Agent: domain.AgentCodex, Windows: []domain.QuotaWindow{{Name: name, UsedPct: 20}},
		}}
	}
	rt1.events <- quota("primary")
	eventually(t, "first quota publish paused", func() bool {
		select {
		case <-bus.entered:
			return true
		default:
			return false
		}
	})
	rt2.events <- quota("secondary")
	// An unsynchronized second publisher releases the first only after
	// publishing its newer snapshot. With ordered publishers the timer lets
	// the first finish before the second can enter.
	timer := time.AfterFunc(100*time.Millisecond, bus.unblock)
	defer timer.Stop()
	defer bus.unblock()
	eventually(t, "both reports saved", func() bool { return repo.count() == 2 })
	q, _, err := repo.GetQuota(ctx, domain.AgentCodex)
	if err != nil || len(q.Windows) != 2 {
		t.Fatalf("concurrent quota reports lost a window: %+v, %v", q, err)
	}
	eventually(t, "both reports published", func() bool {
		n := 0
		for _, ev := range bus.snapshot() {
			if ev.Type == domain.EventQuota {
				n++
			}
		}
		return n == 2
	})
	var last *domain.QuotaSnapshot
	for _, ev := range bus.snapshot() {
		if ev.Type == domain.EventQuota {
			last = ev.Quota
		}
	}
	if len(last.Windows) != 2 {
		t.Fatalf("last published quota is stale: %+v", last)
	}
}

func TestRefreshQuotaKeepsUnreportedWindows(t *testing.T) {
	ctx := context.Background()
	repo := &fakeQuotaRepo{}
	_ = repo.SaveQuota(ctx, domain.QuotaSnapshot{Agent: domain.AgentCodex, Windows: []domain.QuotaWindow{{Name: "secondary", UsedPct: 100}}})
	m := NewManager(ManagerConfig{Quotas: repo, QuotaProvider: &fakeQuotaProvider{quota: domain.QuotaSnapshot{
		Agent: domain.AgentCodex, Windows: []domain.QuotaWindow{{Name: "primary", UsedPct: 20}},
	}}})
	q, err := m.RefreshQuota(ctx, domain.AgentCodex)
	if err != nil || len(q.Windows) != 2 || !q.Reached {
		t.Fatalf("refresh erased exhausted secondary window: %+v, %v", q, err)
	}
}
