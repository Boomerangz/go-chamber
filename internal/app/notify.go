package app

import (
	"context"
	"strings"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// Notification is a push message for the owner's devices. Tag lets a newer
// notification replace an older one about the same thing.
type Notification struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag"`
}

// Pusher delivers a notification to every subscribed device.
type Pusher interface {
	Push(ctx context.Context, n Notification) error
}

// SessionTitles looks up the session a notification is about.
type SessionTitles interface {
	Get(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error)
}

// Notifications turns session events into push notifications: the agent
// asks for a decision, or a top-level turn finished.
type Notifications struct{ sessions SessionTitles }

func NewNotifications(sessions SessionTitles) *Notifications {
	return &Notifications{sessions: sessions}
}

const notificationBodyLimit = 140

// For returns the notification an event deserves, or nil.
func (n *Notifications) For(ctx context.Context, ev domain.Event) *Notification {
	switch ev.Type {
	case domain.EventRequestOpened, domain.EventTurnEnded:
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
	if ev.Type == domain.EventRequestOpened {
		if ev.Request == nil {
			return nil
		}
		body := ev.Request.Title
		if body == "" {
			body = ev.Request.Prompt
		}
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
