package app

import (
	"context"
	"fmt"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type pausedQuotaBus struct {
	*fakeBus
	entered chan struct{}
	release chan struct{}
}

func (b *pausedQuotaBus) Publish(ev domain.Event) domain.Event {
	if ev.Type == domain.EventQuota && ev.SessionID == "s1" {
		close(b.entered)
		<-b.release
	}
	return b.fakeBus.Publish(ev)
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
	eventually(t, "second quota published", func() bool {
		for _, ev := range bus.snapshot() {
			if ev.Type == domain.EventQuota && ev.SessionID != "s1" {
				return true
			}
		}
		return false
	})
	eventually(t, "quota saved while first publish paused", func() bool { return repo.count() >= 1 })
	close(bus.release)
	eventually(t, "both reports saved", func() bool { return repo.count() == 2 })
	q, _, err := repo.GetQuota(ctx, domain.AgentCodex)
	if err != nil || len(q.Windows) != 2 {
		t.Fatalf("concurrent quota reports lost a window: %+v, %v", q, err)
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
