package app

import (
	"context"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestSetPinnedPersistsRestoresAndPublishes(t *testing.T) {
	m, repo, bus, _, _ := newTestManager(t)
	ctx := context.Background()
	snap, err := m.CreateSession(ctx, domain.AgentClaude, "/tmp/proj")
	if err != nil {
		t.Fatal(err)
	}
	for _, on := range []bool{true, false} {
		got, err := m.SetPinned(ctx, snap.ID, on)
		if err != nil || got.Pinned != on {
			t.Fatalf("pin = %+v, %v", got, err)
		}
		saved, err := repo.Get(ctx, snap.ID)
		if err != nil || saved.Pinned != on {
			t.Fatalf("saved = %+v, %v", saved, err)
		}
		restored, err := domain.RestoreSession(saved)
		if err != nil || restored.Snapshot().Pinned != on {
			t.Fatalf("restore = %v", err)
		}
		events := bus.snapshot()
		last := events[len(events)-1]
		if last.Type != domain.EventSessionState || last.Session.Pinned != on {
			t.Fatalf("event = %+v", last)
		}
	}
	repo.saveErr = errors.New("disk full")
	before := len(bus.snapshot())
	if _, err := m.SetPinned(ctx, snap.ID, true); err == nil {
		t.Fatal("want save error")
	}
	got, _ := m.GetSession(ctx, snap.ID)
	if got.Pinned || len(bus.snapshot()) != before {
		t.Fatal("failed save changed state")
	}
	if _, err := m.SetPinned(ctx, "missing", true); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("missing = %v", err)
	}
}
