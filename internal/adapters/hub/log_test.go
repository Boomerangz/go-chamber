package hub

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type memLog struct {
	mu        sync.Mutex
	events    []domain.Event
	appendErr error
	readErr   error
}

func (l *memLog) Append(_ context.Context, ev domain.Event) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.appendErr != nil {
		return l.appendErr
	}
	// Like SQLite's INSERT OR IGNORE: a seq already stored is dropped silently.
	for _, old := range l.events {
		if old.SessionID == ev.SessionID && old.Seq == ev.Seq {
			return nil
		}
	}
	l.events = append(l.events, ev)
	return nil
}

func (l *memLog) History(_ context.Context, s domain.SessionID, since domain.Seq) ([]domain.Event, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.readErr != nil {
		return nil, l.readErr
	}
	var out []domain.Event
	for _, ev := range l.events {
		if ev.SessionID == s && ev.Seq > since {
			out = append(out, ev)
		}
	}
	return out, nil
}

func (l *memLog) LastSeq(_ context.Context, s domain.SessionID) (domain.Seq, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.readErr != nil {
		return 0, l.readErr
	}
	var last domain.Seq
	for _, ev := range l.events {
		if ev.SessionID == s && ev.Seq > last {
			last = ev.Seq
		}
	}
	return last, nil
}

func TestLoggedHubPersistsAndContinuesNumbering(t *testing.T) {
	log := &memLog{}
	first := NewLogged(log, nil)
	first.Publish(ev("a", domain.EventTurnStarted))
	first.Publish(ev("a", domain.EventTurnEnded))

	// A restarted process keeps numbering and serves the old history.
	second := NewLogged(log, nil)
	if got := second.Publish(ev("a", domain.EventSessionState)); got.Seq != 3 {
		t.Fatalf("seq after restart = %d", got.Seq)
	}
	history := second.History("a", 1)
	if len(history) != 2 || history[0].Type != domain.EventTurnEnded || history[1].Seq != 3 {
		t.Fatalf("history = %+v", history)
	}
}

func TestLoggedHubReportsErrorsAndFallsBackToBuffer(t *testing.T) {
	boom := errors.New("disk full")
	log := &memLog{appendErr: boom, readErr: boom}
	var reported []error
	h := NewLogged(log, func(err error) { reported = append(reported, err) })
	first := h.Publish(ev("a", domain.EventTurnStarted))
	if got := h.History("a", 0); len(got) != 1 || got[0].Seq != first.Seq {
		t.Fatalf("fallback history = %+v", got)
	}
	// LastSeq, Append and History failed.
	if len(reported) != 3 {
		t.Fatalf("reported = %v", reported)
	}
}

func TestLoggedHubWithoutErrorHandler(t *testing.T) {
	boom := errors.New("x")
	h := NewLogged(&memLog{appendErr: boom, readErr: boom}, nil)
	h.Publish(ev("a", domain.EventTurnStarted))
	if len(h.History("a", 0)) != 1 {
		t.Fatal("buffer history expected")
	}
}

func TestPublishDetachesItem(t *testing.T) {
	h := New()
	sub := h.Subscribe()
	defer sub.Close()
	item := &domain.Item{ID: "i", SessionID: "a", Kind: domain.ItemAssistantMessage, Text: "he"}
	h.Publish(domain.Event{SessionID: "a", Type: domain.EventItemUpdated, Item: item})
	item.Text = "hello" // a mapper keeps appending streamed text
	if got := (<-sub.Events()).Item.Text; got != "he" {
		t.Fatalf("delivered text = %q", got)
	}
	if got := h.History("a", 0)[0].Item.Text; got != "he" {
		t.Fatalf("buffered text = %q", got)
	}

	req := &domain.Request{ID: "r", SessionID: "a", Kind: domain.RequestPermission, State: domain.RequestPending}
	h.Publish(domain.Event{SessionID: "a", Type: domain.EventRequestOpened, Request: req})
	req.State = domain.RequestResolved // the manager resolves it later
	if got := (<-sub.Events()).Request.State; got != domain.RequestPending {
		t.Fatalf("delivered request state = %s", got)
	}
}

func TestHistoryKeepsEventsTheLogLost(t *testing.T) {
	log := &memLog{}
	h := NewLogged(log, nil)
	h.Publish(ev("a", domain.EventTurnStarted))
	log.mu.Lock()
	log.appendErr = errors.New("busy")
	log.mu.Unlock()
	h.Publish(ev("a", domain.EventItemUpdated))
	log.mu.Lock()
	log.appendErr = nil
	log.mu.Unlock()
	h.Publish(ev("a", domain.EventTurnEnded))

	got := h.History("a", 0)
	if len(got) != 3 || got[0].Seq != 1 || got[1].Seq != 2 || got[1].Type != domain.EventItemUpdated || got[2].Seq != 3 {
		t.Fatalf("history = %+v", got)
	}
	if got := h.History("a", 2); len(got) != 1 || got[0].Seq != 3 {
		t.Fatalf("history since 2 = %+v", got)
	}
}

func TestLastSeqFailureNeverReusesStoredSeqs(t *testing.T) {
	log := &memLog{}
	prev := NewLogged(log, nil)
	prev.Publish(ev("a", domain.EventTurnStarted))
	prev.Publish(ev("a", domain.EventTurnEnded))

	log.readErr = errors.New("locked")
	h := NewLogged(log, nil)
	first := h.Publish(ev("a", domain.EventSessionState))
	log.mu.Lock()
	log.readErr = nil
	log.mu.Unlock()
	second := h.Publish(ev("a", domain.EventItemUpdated))
	if first.Seq <= 2 || second.Seq <= first.Seq {
		t.Fatalf("seqs after a failed LastSeq = %d, %d", first.Seq, second.Seq)
	}
	got := h.History("a", 0)
	if len(got) != 4 || got[2].Seq != first.Seq || got[3].Seq != second.Seq {
		t.Fatalf("history = %+v", got)
	}
}
