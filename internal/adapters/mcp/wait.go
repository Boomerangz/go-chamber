package mcpapi

import (
	"cmp"
	"context"
	"encoding/json"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/igorzygin/go-chamber/internal/adapters/hub"
	"github.com/igorzygin/go-chamber/internal/domain"
)

const defaultWait = 2 * time.Minute

type waitIn struct {
	SessionID      string     `json:"session_id"`
	SinceSeq       domain.Seq `json:"since_seq,omitempty" jsonschema:"seq returned by send_message or the previous wait"`
	TimeoutSeconds int        `json:"timeout_seconds,omitempty" jsonschema:"how long to block; 120 when omitted"`
}

type requestView struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Title  string `json:"title,omitempty"`
	Prompt string `json:"prompt,omitempty"`
	// Payload is what the agent asked with: questions and their options.
	Payload any `json:"payload,omitempty"`
}

type waitOut struct {
	Status   string        `json:"status" jsonschema:"idle, needs_answer, running, interrupted or detached"`
	Seq      domain.Seq    `json:"seq" jsonschema:"pass as since_seq to the next wait"`
	Final    string        `json:"final,omitempty" jsonschema:"the agent's last message"`
	Error    string        `json:"error,omitempty"`
	Requests []requestView `json:"requests,omitempty"`
	Activity []string      `json:"activity,omitempty" jsonschema:"recent tool calls, one line each"`
}

func (s *Server) wait(ctx context.Context, req *sdk.CallToolRequest, in waitIn) (*sdk.CallToolResult, waitOut, error) {
	id := domain.SessionID(in.SessionID)
	timeout := time.Duration(in.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = defaultWait
	}
	// Subscribe before looking, so nothing lands between the look and the
	// subscription.
	sub := s.cfg.Events.Subscribe()
	defer sub.Close()
	deadline := time.NewTimer(min(timeout, s.cfg.MaxWait))
	defer deadline.Stop()
	recheck := time.NewTicker(s.cfg.Recheck)
	defer recheck.Stop()
	p := &progress{req: req}
	for {
		out, done, err := s.check(ctx, id, in.SinceSeq)
		if err != nil || done {
			return nil, out, err
		}
		if !s.sleep(ctx, sub, id, deadline.C, recheck.C, p) {
			out, _, err := s.check(ctx, id, in.SinceSeq)
			return nil, out, err
		}
	}
}

// sleep waits for a reason to look again; false means time is up.
func (s *Server) sleep(ctx context.Context, sub *hub.Subscriber, id domain.SessionID, deadline, recheck <-chan time.Time, p *progress) bool {
	for {
		select {
		case <-ctx.Done():
			return false
		case <-s.done:
			return false
		case <-deadline:
			return false
		case <-recheck:
			return true
		case ev := <-sub.Events():
			if ev.SessionID != id {
				continue
			}
			p.report(ctx, ev)
			switch ev.Type {
			case domain.EventTurnEnded, domain.EventRequestOpened, domain.EventSessionState, domain.EventSessionRemoved:
				return true
			}
		}
	}
}

// check reads the session as it is now: done when it waits for an answer or
// no longer runs.
func (s *Server) check(ctx context.Context, id domain.SessionID, since domain.Seq) (waitOut, bool, error) {
	snap, err := s.cfg.Sessions.GetSession(ctx, id)
	if err != nil {
		return waitOut{}, true, err
	}
	// ponytail: rereads the history since since_seq on every look; fold
	// incrementally from the subscription if long turns make it slow.
	events := s.cfg.Events.History(id, since)
	t := fold(events)
	out := waitOut{Status: string(snap.Status), Seq: lastSeq(events, since), Activity: t.activity(20)}
	if reqs := s.pending(ctx, id); len(reqs) > 0 {
		out.Status = "needs_answer"
		for _, r := range reqs {
			out.Requests = append(out.Requests, requestOf(r))
		}
		return out, true, nil
	}
	if snap.Status == domain.StatusRunning {
		return out, false, nil
	}
	out.Final = t.final()
	if r := t.result; r != nil && r.IsError {
		out.Error = r.Error
	}
	if snap.Status == domain.StatusInterrupted {
		out.Error = cmp.Or(out.Error, string(snap.Interruption.Reason))
	}
	return out, true, nil
}

func requestOf(r domain.Request) requestView {
	v := requestView{ID: string(r.ID), Kind: string(r.Kind), Title: r.Title, Prompt: r.Prompt}
	if len(r.Payload) > 0 {
		_ = json.Unmarshal(r.Payload, &v.Payload)
	}
	return v
}

// progress tells a client that asked for it what the session is doing
// while wait blocks.
type progress struct {
	req *sdk.CallToolRequest
	n   float64
}

func (p *progress) report(ctx context.Context, ev domain.Event) {
	token := p.req.Params.GetProgressToken()
	if token == nil {
		return
	}
	var msg string
	switch {
	case ev.Type == domain.EventItemUpdated && ev.Item != nil && ev.Item.Status.Terminal():
		msg = line(*ev.Item, 160)
	case ev.Type == domain.EventRequestOpened && ev.Request != nil:
		msg = "needs an answer: " + cmp.Or(ev.Request.Title, string(ev.Request.Kind))
	}
	if msg == "" {
		return
	}
	p.n++
	_ = p.req.Session.NotifyProgress(ctx, &sdk.ProgressNotificationParams{ProgressToken: token, Progress: p.n, Message: msg})
}
