package codex

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

const goalJSON = `{"threadId":"th","objective":"ship it","status":"%s","tokenBudget":%s,"tokensUsed":120,"timeUsedSeconds":3,"createdAt":1,"updatedAt":2}`

func goalBody(status, budget string) string {
	return strings.Replace(strings.Replace(goalJSON, "%s", status, 1), "%s", budget, 1)
}

// serve answers the runtime's next request and returns it.
func serve(t *testing.T, peer *testPeer, method, result string) map[string]any {
	t.Helper()
	request := peer.read()
	if request.Method != method {
		t.Fatalf("method = %s, want %s", request.Method, method)
	}
	var params map[string]any
	_ = json.Unmarshal(request.Params, &params)
	peer.send(rpcMessage{JSONRPC: "2.0", ID: request.ID, Result: json.RawMessage(result)})
	return params
}

func goalRuntime(t *testing.T) (*Server, *testPeer, *Runtime, <-chan domain.Event) {
	t.Helper()
	s, peer := newPipeServer(t)
	rt := s.newRuntime("th", NewMapper("s"))
	s.register(rt)
	seen := make(chan domain.Event, 64)
	go func() {
		for ev := range rt.Events() {
			seen <- ev
		}
	}()
	return s, peer, rt, seen
}

func next(t *testing.T, seen <-chan domain.Event, kind domain.EventType) domain.Event {
	t.Helper()
	for {
		select {
		case ev := <-seen:
			if ev.Type == kind {
				return ev
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("no %s event", kind)
		}
	}
}

func TestGoalIsSetOnTheThreadAndCodexStartsItsTurns(t *testing.T) {
	s, peer, rt, seen := goalRuntime(t)
	sent := make(chan error, 1)
	go func() { sent <- rt.Send(context.Background(), "turn", "/goal ship it") }()
	params := serve(t, peer, "thread/goal/set", `{"goal":`+goalBody("active", "null")+`}`)
	if params["objective"] != "ship it" || params["status"] != "active" || params["threadId"] != "th" {
		t.Fatalf("params %+v", params)
	}
	s.handleNotification("thread/goal/updated", json.RawMessage(`{"threadId":"th","turnId":null,"goal":`+goalBody("active", "9000")+`}`))
	s.handleNotification("turn/started", json.RawMessage(`{"threadId":"th","turn":{"id":"turn-1","status":"inProgress"}}`))
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	if goal := next(t, seen, domain.EventGoal).Goal; goal == nil || goal.Objective != "ship it" || !goal.Active() || goal.TokensUsed != 120 || goal.TokenBudget != 9000 {
		t.Fatalf("goal %+v", goal)
	}
	// The session opened the first turn itself; later ones Codex starts.
	next(t, seen, domain.EventTurnStarted)
	s.handleNotification("turn/completed", json.RawMessage(`{"threadId":"th","turn":{"id":"turn-1","status":"completed"}}`))
	next(t, seen, domain.EventTurnEnded)
	s.handleNotification("turn/started", json.RawMessage(`{"threadId":"th","turn":{"id":"turn-2","status":"inProgress"}}`))
	next(t, seen, domain.EventTurnStarted)
	s.handleNotification("thread/goal/updated", json.RawMessage(`{"threadId":"th","goal":`+goalBody("complete", "null")+`}`))
	if goal := next(t, seen, domain.EventGoal).Goal; goal.Status != domain.GoalComplete {
		t.Fatalf("goal %+v", goal)
	}
	s.handleNotification("turn/completed", json.RawMessage(`{"threadId":"th","turn":{"id":"turn-2","status":"completed"}}`))
	next(t, seen, domain.EventTurnEnded)
	s.handleNotification("turn/started", json.RawMessage(`{"threadId":"th","turn":{"id":"turn-3","status":"inProgress"}}`))
	s.handleNotification("thread/goal/cleared", json.RawMessage(`{"threadId":"th"}`))
	for {
		ev := <-seen
		if ev.Type == domain.EventTurnStarted {
			t.Fatal("a turn without an active goal was announced as self-started")
		}
		if ev.Type == domain.EventGoal {
			if ev.Goal != nil {
				t.Fatalf("cleared goal %+v", ev.Goal)
			}
			return
		}
	}
}

func TestGoalCommandsThatStartNoTurnAnswerAndEndIt(t *testing.T) {
	for text, tc := range map[string]struct {
		method, result, shown string
		check                 func(map[string]any) bool
	}{
		"/goal":             {"thread/goal/get", `{"goal":` + goalBody("paused", "500") + `}`, "Goal paused** · 120 of 500 tokens", func(p map[string]any) bool { return len(p) == 1 }},
		"/goal pause":       {"thread/goal/set", `{"goal":` + goalBody("paused", "null") + `}`, "Goal paused** · 120 tokens", func(p map[string]any) bool { return p["status"] == "paused" && p["objective"] == nil }},
		"/goal budget 7000": {"thread/goal/set", `{"goal":` + goalBody("active", "7000") + `}`, "120 of 7000 tokens", func(p map[string]any) bool { return p["tokenBudget"] == float64(7000) && p["status"] == nil }},
		"/goal clear":       {"thread/goal/clear", `{"cleared":true}`, "Goal cleared.", func(p map[string]any) bool { return len(p) == 1 }},
	} {
		t.Run(text, func(t *testing.T) {
			_, peer, rt, seen := goalRuntime(t)
			sent := make(chan error, 1)
			go func() { sent <- rt.Send(context.Background(), "turn", text) }()
			if params := serve(t, peer, tc.method, tc.result); !tc.check(params) {
				t.Fatalf("params %+v", params)
			}
			if err := <-sent; err != nil {
				t.Fatal(err)
			}
			if item := next(t, seen, domain.EventItemUpdated).Item; item.Kind != domain.ItemAssistantMessage || item.TurnID != "turn" || !strings.Contains(item.Text, tc.shown) {
				t.Fatalf("answer %+v", item)
			}
			next(t, seen, domain.EventTurnEnded)
		})
	}
	_, peer, rt, seen := goalRuntime(t)
	sent := make(chan error, 1)
	go func() { sent <- rt.Send(context.Background(), "turn", "/goal") }()
	serve(t, peer, "thread/goal/get", `{"goal":null}`)
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	if item := next(t, seen, domain.EventItemUpdated).Item; !strings.Contains(item.Text, "No goal is set") || !strings.Contains(item.Text, app.GoalUsage) {
		t.Fatalf("answer %+v", item)
	}
}

func TestResumedGoalThatStartsNoTurnStillEndsTheSessionTurn(t *testing.T) {
	old := goalTurnStart
	goalTurnStart = 30 * time.Millisecond
	t.Cleanup(func() { goalTurnStart = old })
	_, peer, rt, seen := goalRuntime(t)
	sent := make(chan error, 1)
	go func() { sent <- rt.Send(context.Background(), "turn", "/goal resume") }()
	if params := serve(t, peer, "thread/goal/set", `{"goal":`+goalBody("active", "null")+`}`); params["status"] != "active" || params["objective"] != nil {
		t.Fatalf("params %+v", params)
	}
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	next(t, seen, domain.EventTurnEnded)
}

func TestFailedGoalCommandIsReportedToTheSender(t *testing.T) {
	_, peer, rt, _ := goalRuntime(t)
	sent := make(chan error, 1)
	go func() { sent <- rt.Send(context.Background(), "turn", "/goal pause") }()
	request := peer.read()
	peer.send(rpcMessage{JSONRPC: "2.0", ID: request.ID, Error: &rpcError{Code: -32600, Message: "no goal"}})
	if err := <-sent; err == nil || !strings.Contains(err.Error(), "no goal") {
		t.Fatalf("err = %v", err)
	}
}

func TestStoppingAGoalTurnPausesTheGoal(t *testing.T) {
	s, peer, rt, _ := goalRuntime(t)
	s.handleNotification("thread/goal/updated", json.RawMessage(`{"threadId":"th","goal":`+goalBody("active", "null")+`}`))
	s.handleNotification("turn/started", json.RawMessage(`{"threadId":"th","turn":{"id":"turn-1","status":"inProgress"}}`))
	done := make(chan error, 1)
	go func() { done <- rt.Interrupt(context.Background()) }()
	serve(t, peer, "turn/interrupt", `{}`)
	if params := serve(t, peer, "thread/goal/set", `{"goal":`+goalBody("paused", "null")+`}`); params["status"] != "paused" {
		t.Fatalf("params %+v", params)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
