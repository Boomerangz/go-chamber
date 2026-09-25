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
	if got := h.Publish(ev("a", domain.EventTurnStarted)); got.Seq != 1 {
		t.Fatalf("seq = %d", got.Seq)
	}
	if got := h.History("a", 0); len(got) != 1 {
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
