// Package hub is the in-process event bus and replay buffer for normalized
// session events. It implements app.EventBus.
package hub

import (
	"sync"

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
func (h *Hub) Publish(ev domain.Event) domain.Event {
	h.mu.Lock()
	h.seq[ev.SessionID]++
	ev.Seq = h.seq[ev.SessionID]
	buf := h.buf[ev.SessionID]
	buf = append(buf, ev)
	if len(buf) > h.bufSize {
		buf = buf[len(buf)-h.bufSize:]
	}
	h.buf[ev.SessionID] = buf
	subs := make([]*Subscriber, 0, len(h.subs))
	for s := range h.subs {
		subs = append(subs, s)
	}
	h.mu.Unlock()

	for _, s := range subs {
		s.deliver(ev)
	}
	return ev
}

// History returns buffered events for a session with Seq greater than since.
func (h *Hub) History(session domain.SessionID, since domain.Seq) []domain.Event {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []domain.Event
	for _, ev := range h.buf[session] {
		if ev.Seq > since {
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
