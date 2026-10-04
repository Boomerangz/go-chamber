package hub

import (
	"errors"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestStatsCountsPublishedEvents(t *testing.T) {
	h := New()
	if h.Stats() != (Stats{}) {
		t.Fatal("nonempty initial stats")
	}
	h.Publish(domain.Event{SessionID: "a", Type: domain.EventTurnStarted})
	h.Publish(domain.Event{SessionID: "b", Type: domain.EventTurnEnded})
	stats := h.Stats()
	if stats.Published != 2 || stats.PersistCalls != 0 || stats.PersistMeanMs != 0 {
		t.Fatalf("stats: %+v", stats)
	}
	if stats.LockWaitMaxMs < stats.LockWaitMeanMs {
		t.Fatal(stats)
	}
}

func TestStatsReportsMilliseconds(t *testing.T) {
	h := New()
	h.timings = timings{published: 2, calls: 2, persistTotal: 3 * time.Millisecond, persistMax: 2 * time.Millisecond, waitTotal: 4 * time.Millisecond, waitMax: 3 * time.Millisecond}
	stats := h.Stats()
	if stats.PersistMeanMs != 1.5 || stats.PersistMaxMs != 2 || stats.LockWaitMeanMs != 2 || stats.LockWaitMaxMs != 3 {
		t.Fatalf("durations in milliseconds: %+v", stats)
	}
}

func TestStatsMeasuresPersistenceAndErrors(t *testing.T) {
	log := &memLog{}
	h := NewLogged(log, nil)
	h.Publish(ev("s1", domain.EventTurnStarted))
	log.appendErr = errors.New("disk unavailable")
	h.Publish(ev("s1", domain.EventTurnEnded))
	stats := h.Stats()
	if stats.Published != 2 || stats.PersistCalls != 2 || stats.PersistErrors != 1 || stats.PersistMeanMs <= 0 || stats.PersistMaxMs < stats.PersistMeanMs {
		t.Fatalf("stats: %+v", stats)
	}
}
