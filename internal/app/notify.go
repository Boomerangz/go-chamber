package app

import (
	"context"
	"strings"
	"sync"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// Notification is a push message for the owner's devices. Tag lets a newer
// notification replace an older one about the same thing.
type Notification struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag"`
	// Close takes back what is shown under Tag on every device: a request
	// answered elsewhere no longer needs the owner.
	Close bool `json:"close,omitempty"`
}

// Pusher delivers a notification to every subscribed device.
type Pusher interface {
	Push(ctx context.Context, n Notification) error
}

// SessionTitles looks up the session a notification is about.
type SessionTitles interface {
	Get(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error)
}

// Watchers tells whether the owner is looking at a session right now.
type Watchers interface {
	Watching(id domain.SessionID) bool
}

// Notifications turns session events into push notifications: the agent
// asks for a decision, or a top-level turn finished. A session the owner is
// watching needs none, and an answered request takes its own back.
type Notifications struct {
	sessions SessionTitles
	watchers Watchers
	mu       sync.Mutex
	// asked holds the requests pushed and not yet answered.
	asked map[domain.RequestID]bool
}

func NewNotifications(sessions SessionTitles) *Notifications {
	return &Notifications{sessions: sessions, asked: map[domain.RequestID]bool{}}
}

// SkipWatched stops pushes about the sessions w says the owner watches.
func (n *Notifications) SkipWatched(w Watchers) *Notifications {
	n.watchers = w
	return n
}

const notificationBodyLimit = 140

// For returns the notification an event deserves, or nil.
func (n *Notifications) For(ctx context.Context, ev domain.Event) *Notification {
	switch ev.Type {
	case domain.EventRequestOpened, domain.EventTurnEnded:
		if n.watchers != nil && n.watchers.Watching(ev.SessionID) {
			return nil // the owner sees it happen
		}
	case domain.EventRequestResolved:
		if ev.Request == nil || !n.answered(ev.Request.ID) {
			return nil
		}
	default:
		return nil
	}
	snap, err := n.sessions.Get(ctx, ev.SessionID)
	if err == nil && snap.ParentID != "" {
		return nil // subagents report to their parent's turn
	}
	name := "Session"
	if err == nil {
		name = snap.Title
		if name == "" {
			name = agentName(snap.Agent) + " session"
		}
	}
	url := "/s/" + string(ev.SessionID)
	if ev.Type == domain.EventRequestResolved {
		return &Notification{Title: name + ": answered", URL: url, Tag: "request-" + string(ev.Request.ID), Close: true}
	}
	if ev.Type == domain.EventRequestOpened {
		if ev.Request == nil {
			return nil
		}
		body := ev.Request.Title
		if body == "" {
			body = ev.Request.Prompt
		}
		n.mu.Lock()
		n.asked[ev.Request.ID] = true
		n.mu.Unlock()
		return &Notification{Title: name + " needs you", Body: clip(body), URL: url, Tag: "request-" + string(ev.Request.ID)}
	}
	out := &Notification{Title: name + " finished", URL: url, Tag: "turn-" + string(ev.SessionID)}
	if r := ev.Result; r != nil {
		out.Body = clip(r.Text)
		switch {
		case r.InterruptionReason == domain.ExitServerRestart:
			return nil // the owner restarted go-chamber and knows
		case r.InterruptionReason == domain.ExitCrashed && !r.IsError:
			out.Title, out.Body = name+" was interrupted", "the agent exited"
		case r.IsError:
			out.Title, out.Body = name+" failed", clip(r.Error)
		}
	}
	return out
}

// answered forgets a pushed request, telling whether it was one.
func (n *Notifications) answered(id domain.RequestID) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	was := n.asked[id]
	delete(n.asked, id)
	return was
}

// Watch pushes notifications for events until the channel closes or ctx ends.
// Delivery errors are dropped: a missed notification is not worth a retry.
func (n *Notifications) Watch(ctx context.Context, events <-chan domain.Event, p Pusher) {
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return
			}
			if note := n.For(ctx, ev); note != nil {
				_ = p.Push(ctx, *note)
			}
		case <-ctx.Done():
			return
		}
	}
}

func agentName(a domain.AgentKind) string {
	if a == domain.AgentCodex {
		return "Codex"
	}
	return "Claude"
}

func clip(s string) string {
	s = strings.TrimSpace(s)
	if len(s) <= notificationBodyLimit {
		return s
	}
	return strings.ToValidUTF8(s[:notificationBodyLimit], "") + "…"
}
