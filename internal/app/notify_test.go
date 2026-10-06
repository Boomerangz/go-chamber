package app

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type titleRepo map[domain.SessionID]domain.SessionSnapshot

func (r titleRepo) Get(_ context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	if s, ok := r[id]; ok {
		return s, nil
	}
	return domain.SessionSnapshot{}, errors.New("not found")
}

func TestNotificationFor(t *testing.T) {
	repo := titleRepo{
		"s1":    {ID: "s1", Agent: domain.AgentClaude, Title: "Fix the build"},
		"child": {ID: "child", Agent: domain.AgentCodex, ParentID: "s1"},
		"bare":  {ID: "bare", Agent: domain.AgentCodex},
	}
	n := NewNotifications(repo)
	ctx := context.Background()
	long := strings.Repeat("x", 300)

	cases := []struct {
		name string
		ev   domain.Event
		want *Notification
	}{
		{"permission request", domain.Event{SessionID: "s1", Type: domain.EventRequestOpened,
			Request: &domain.Request{ID: "r1", Kind: domain.RequestPermission, Title: "Run command", Prompt: "ls"}},
			&Notification{Title: "Fix the build needs you", Body: "Run command", URL: "/s/s1", Tag: "request-r1"}},
		{"question uses the prompt", domain.Event{SessionID: "bare", Type: domain.EventRequestOpened,
			Request: &domain.Request{ID: "r2", Kind: domain.RequestQuestion, Prompt: "Red or blue?"}},
			&Notification{Title: "Codex session needs you", Body: "Red or blue?", URL: "/s/bare", Tag: "request-r2"}},
		{"turn done", domain.Event{SessionID: "s1", Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: long}},
			&Notification{Title: "Fix the build finished", Body: long[:140] + "…", URL: "/s/s1", Tag: "turn-s1"}},
		{"turn failed", domain.Event{SessionID: "s1", Type: domain.EventTurnEnded, Result: &domain.TurnResult{IsError: true, Error: "boom"}},
			&Notification{Title: "Fix the build failed", Body: "boom", URL: "/s/s1", Tag: "turn-s1"}},
		{"turn cut off by the agent's exit", domain.Event{SessionID: "s1", Type: domain.EventTurnEnded, Result: &domain.TurnResult{InterruptionReason: domain.ExitCrashed}},
			&Notification{Title: "Fix the build was interrupted", Body: "the agent exited", URL: "/s/s1", Tag: "turn-s1"}},
		{"a restart's interrupted turns stay quiet", domain.Event{SessionID: "s1", Type: domain.EventTurnEnded, Result: &domain.TurnResult{InterruptionReason: domain.ExitServerRestart}}, nil},
		{"subagent turns stay quiet", domain.Event{SessionID: "child", Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: "x"}}, nil},
		{"deltas stay quiet", domain.Event{SessionID: "s1", Type: domain.EventTextDelta}, nil},
		{"unknown session still notifies", domain.Event{SessionID: "gone", Type: domain.EventTurnEnded},
			&Notification{Title: "Session finished", Body: "", URL: "/s/gone", Tag: "turn-gone"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := n.For(ctx, c.ev)
			if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

type recordPusher struct{ got []Notification }

func (p *recordPusher) Push(_ context.Context, n Notification) error {
	p.got = append(p.got, n)
	return nil
}

func TestNotificationsWatchForwardsUntilClosed(t *testing.T) {
	events := make(chan domain.Event, 3)
	events <- domain.Event{SessionID: "s1", Type: domain.EventTextDelta}
	events <- domain.Event{SessionID: "s1", Type: domain.EventTurnEnded}
	close(events)
	p := &recordPusher{}
	NewNotifications(titleRepo{}).Watch(context.Background(), events, p)
	if len(p.got) != 1 || p.got[0].Tag != "turn-s1" {
		t.Fatalf("pushed %+v", p.got)
	}
}
