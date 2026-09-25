package hub

import (
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func ev(session domain.SessionID, kind domain.EventType) domain.Event {
	return domain.Event{SessionID: session, Type: kind}
}

func TestPublishAssignsPerSessionSeq(t *testing.T) {
	h := New()
	a1 := h.Publish(ev("a", domain.EventTurnStarted))
	a2 := h.Publish(ev("a", domain.EventTurnEnded))
	b1 := h.Publish(ev("b", domain.EventTurnStarted))
	if a1.Seq != 1 || a2.Seq != 2 || b1.Seq != 1 {
		t.Fatalf("seq = %d %d %d", a1.Seq, a2.Seq, b1.Seq)
	}
}

func TestHistorySinceSeq(t *testing.T) {
	h := New()
	for i := 0; i < 5; i++ {
		h.Publish(ev("a", domain.EventTurnStarted))
	}
	got := h.History("a", 3)
	if len(got) != 2 || got[0].Seq != 4 || got[1].Seq != 5 {
		t.Fatalf("history = %+v", got)
	}
	if len(h.History("b", 0)) != 0 {
		t.Fatal("history of unknown session must be empty")
	}
}

func TestBufferEvictsOldEvents(t *testing.T) {
	h := NewWithBuffer(3)
	for i := 0; i < 5; i++ {
		h.Publish(ev("a", domain.EventTurnStarted))
	}
	got := h.History("a", 0)
	if len(got) != 3 || got[0].Seq != 3 || got[2].Seq != 5 {
		t.Fatalf("history = %+v", got)
	}
}

func TestSubscriberReceivesAndUnsubscribes(t *testing.T) {
	h := New()
	sub := h.Subscribe()
	h.Publish(ev("a", domain.EventTurnStarted))
	select {
	case got := <-sub.Events():
		if got.SessionID != "a" {
			t.Fatalf("event = %+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("no event delivered")
	}
	sub.Close()
	h.Publish(ev("a", domain.EventTurnEnded))
	select {
	case <-sub.Done():
	case <-time.After(time.Second):
		t.Fatal("Done not closed")
	}
}

func TestSlowSubscriberDoesNotBlockPublish(t *testing.T) {
	h := New()
	sub := h.Subscribe()
	defer sub.Close()
	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			h.Publish(ev("a", domain.EventTurnStarted))
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Publish blocked on a slow subscriber")
	}
}

func TestDefaultBufferSize(t *testing.T) {
	if h := NewWithBuffer(0); h.bufSize != DefaultBufferSize {
		t.Fatalf("bufSize = %d", h.bufSize)
	}
}
