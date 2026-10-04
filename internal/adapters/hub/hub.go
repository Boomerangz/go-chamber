// Package hub is the in-process event bus and replay buffer for normalized
// session events. It implements app.EventBus.
package hub

import (
	"cmp"
	"context"
	"slices"
	"sync"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// DefaultBufferSize is how many recent events per session are kept for
// replay.
const DefaultBufferSize = 2048

// Hub fans out events to subscribers and keeps a bounded replay buffer per
// session.
type Hub struct {
	mu      sync.Mutex
	bufSize int
	seq     map[domain.SessionID]domain.Seq
	buf     map[domain.SessionID][]domain.Event
	subs    map[*Subscriber]struct{}

	// log persists events when set; seq numbering then continues from it.
	log     app.EventLog
	onError func(error)
	loaded  map[domain.SessionID]bool
	// lost marks sessions with events the log failed to store; their history
	// fills the gaps from the buffer.
	lost map[domain.SessionID]bool
}

func New() *Hub { return NewWithBuffer(DefaultBufferSize) }

func NewWithBuffer(bufSize int) *Hub {
	if bufSize <= 0 {
		bufSize = DefaultBufferSize
	}
	return &Hub{
		bufSize: bufSize,
		seq:     map[domain.SessionID]domain.Seq{},
		buf:     map[domain.SessionID][]domain.Event{},
		subs:    map[*Subscriber]struct{}{},
	}
}

// Publish assigns the next sequence number for the session, stores the event
// for replay and delivers it to current subscribers.
// NewLogged returns a hub that persists every event to log and serves
// history from it, so replay survives restarts. onError receives log
// failures; the in-memory buffer keeps working without the log.
func NewLogged(log app.EventLog, onError func(error)) *Hub {
	h := New()
	h.log = log
	h.onError = onError
	h.loaded = map[domain.SessionID]bool{}
	h.lost = map[domain.SessionID]bool{}
	return h
}

func (h *Hub) fail(err error) {
	if err != nil && h.onError != nil {
		h.onError(err)
	}
}

func (h *Hub) Publish(ev domain.Event) domain.Event {
	// The publisher may keep mutating its item; stored and sent copies must not change.
	ev = domain.DetachItems([]domain.Event{ev})[0]
	if ev.Request != nil {
		req := *ev.Request
		ev.Request = &req
	}
	h.mu.Lock()
	if h.log != nil && !h.loaded[ev.SessionID] {
		last, err := h.log.LastSeq(context.Background(), ev.SessionID)
		if err != nil {
			h.fail(err)
			// The stored numbering is unknown, and reusing a stored seq would
			// lose the event. Continue above anything the log can hold.
			// ponytail: assumes the log never averaged more than one event per
			// millisecond; persist a high-water mark if that ever breaks.
			last = domain.Seq(time.Now().UnixMilli())
		}
		if last > h.seq[ev.SessionID] {
			h.seq[ev.SessionID] = last
		}
		h.loaded[ev.SessionID] = true
	}
	h.seq[ev.SessionID]++
	ev.Seq = h.seq[ev.SessionID]
	buf := h.buf[ev.SessionID]
	buf = append(buf, ev)
	if len(buf) > h.bufSize {
		buf = buf[len(buf)-h.bufSize:]
	}
	h.buf[ev.SessionID] = buf
	if h.log != nil {
		// Under the lock so events are stored in seq order.
		if err := h.log.Append(context.Background(), ev); err != nil {
			h.lost[ev.SessionID] = true
			h.fail(err)
		}
	}
	// Delivery is nonblocking; keep it under the sequence lock so concurrent
	// publishers cannot send a later event before this one.
	for sub := range h.subs {
		sub.deliver(ev)
	}
	h.mu.Unlock()
	return ev
}

// History returns buffered events for a session with Seq greater than since.
func (h *Hub) History(session domain.SessionID, since domain.Seq) []domain.Event {
	if h.log != nil {
		events, err := h.log.History(context.Background(), session, since)
		if err == nil {
			return h.fillLost(session, since, events)
		}
		h.fail(err)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.buffered(session, since, nil)
}

// fillLost adds buffered events the log failed to store to its history.
func (h *Hub) fillLost(session domain.SessionID, since domain.Seq, events []domain.Event) []domain.Event {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.lost[session] {
		return events
	}
	stored := make(map[domain.Seq]bool, len(events))
	for _, ev := range events {
		stored[ev.Seq] = true
	}
	events = append(events, h.buffered(session, since, stored)...)
	slices.SortFunc(events, func(a, b domain.Event) int { return cmp.Compare(a.Seq, b.Seq) })
	return events
}

// buffered returns buffered events after since that are not in skip.
// Callers hold h.mu.
func (h *Hub) buffered(session domain.SessionID, since domain.Seq, skip map[domain.Seq]bool) []domain.Event {
	var out []domain.Event
	for _, ev := range h.buf[session] {
		if ev.Seq > since && !skip[ev.Seq] {
			out = append(out, ev)
		}
	}
	return out
}

// Subscribe returns a subscriber that receives newly published events.
func (h *Hub) Subscribe() *Subscriber {
	s := &Subscriber{hub: h, ch: make(chan domain.Event, 256), done: make(chan struct{})}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s
}

// Subscribers is the number of live subscribers.
func (h *Hub) Subscribers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

func (h *Hub) unsubscribe(s *Subscriber) {
	h.mu.Lock()
	delete(h.subs, s)
	h.mu.Unlock()
}

// Subscriber is one live event stream. Call Close when done.
type Subscriber struct {
	hub       *Hub
	ch        chan domain.Event
	done      chan struct{}
	closeOnce sync.Once
}

func (s *Subscriber) Events() <-chan domain.Event { return s.ch }

// Done is closed when the subscriber is closed.
func (s *Subscriber) Done() <-chan struct{} { return s.done }

// Close stops delivery and unregisters the subscriber. Safe to call twice.
func (s *Subscriber) Close() {
	s.closeOnce.Do(func() {
		s.hub.unsubscribe(s)
		close(s.done)
	})
}

func (s *Subscriber) deliver(ev domain.Event) {
	select {
	case s.ch <- ev:
	case <-s.done:
	default:
		// Slow consumer: drop the event. The client detects the sequence gap
		// and refetches the backlog.
	}
}

var _ app.EventBus = (*Hub)(nil)
