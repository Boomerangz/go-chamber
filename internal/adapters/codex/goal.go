package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// Codex pursues a thread goal itself: setting or resuming one starts a turn
// at once and further turns follow without a turn/start (verified on
// app-server 0.160.1). The adapter only forwards commands and state.

type rpcGoal struct {
	Objective   string `json:"objective"`
	Status      string `json:"status"`
	TokenBudget *int64 `json:"tokenBudget"`
	TokensUsed  int64  `json:"tokensUsed"`
}

func (g rpcGoal) domain() *domain.Goal {
	goal := &domain.Goal{Objective: g.Objective, Status: domain.GoalStatus(g.Status), TokensUsed: g.TokensUsed}
	if g.TokenBudget != nil {
		goal.TokenBudget = *g.TokenBudget
	}
	return goal
}

// goalTurnStart is how long a set or resumed goal may take to start its turn.
var goalTurnStart = 3 * time.Second

var goalCommand = app.Command{Name: "goal", Insert: "/goal ", ArgumentHint: "<objective> | pause | resume | clear | budget <tokens>", Description: "Pursue an objective across turns until Codex marks it complete"}

func goalSummary(g *domain.Goal) string {
	if g == nil {
		return "No goal is set.\n" + app.GoalUsage
	}
	tokens := fmt.Sprintf("%d tokens", g.TokensUsed)
	if g.TokenBudget > 0 {
		tokens = fmt.Sprintf("%d of %d tokens", g.TokensUsed, g.TokenBudget)
	}
	return fmt.Sprintf("**Goal %s** · %s\n\n%s", g.Status, tokens, g.Objective)
}

// goal applies a /goal command to the thread. A command that starts no turn
// answers in the transcript and ends the turn the session opened for it.
func (r *Runtime) goal(ctx context.Context, turn domain.TurnID, command app.GoalCommand) error {
	client := r.current().client
	params := map[string]any{"threadId": r.threadID}
	method := "thread/goal/set"
	switch command.Kind {
	case "show":
		method = "thread/goal/get"
	case "clear":
		method = "thread/goal/clear"
	case "set":
		params["objective"], params["status"] = command.Objective, domain.GoalActive
	case "resume":
		params["status"] = domain.GoalActive
	case "pause":
		params["status"] = domain.GoalPaused
	case "budget":
		if command.Budget == 0 {
			return r.answer(turn, "Codex cannot remove a goal's budget; set a larger one.")
		}
		params["tokenBudget"] = command.Budget
	}
	r.mu.Lock()
	before := r.turnsStarted
	r.mu.Unlock()
	res, err := client.Call(ctx, method, params)
	if err != nil {
		return fmt.Errorf("codex: %s: %w", method, err)
	}
	if command.Kind == "clear" {
		return r.answer(turn, "Goal cleared.")
	}
	var out struct {
		Goal *rpcGoal `json:"goal"`
	}
	_ = json.Unmarshal(res, &out)
	var goal *domain.Goal
	if out.Goal != nil {
		goal = out.Goal.domain()
	}
	if command.Kind == "set" || command.Kind == "resume" {
		deadline := time.NewTimer(goalTurnStart)
		defer deadline.Stop()
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		started := func() bool { r.mu.Lock(); defer r.mu.Unlock(); return r.turnsStarted > before }
		for !started() {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-deadline.C:
				return r.answer(turn, goalSummary(goal))
			case <-tick.C:
			}
		}
		return nil // Codex's own turn ends the one the session opened.
	}
	return r.answer(turn, goalSummary(goal))
}

func (r *Runtime) answer(turn domain.TurnID, text string) error {
	r.mapMu.Lock()
	session := r.mapper.session
	r.mapMu.Unlock()
	r.emit(domain.Event{SessionID: session, Type: domain.EventItemUpdated, Item: &domain.Item{ID: domain.ItemID("goal-" + string(turn)), SessionID: session, TurnID: turn, Kind: domain.ItemAssistantMessage, Status: domain.ItemCompleted, Text: text}})
	r.emit(domain.Event{SessionID: session, Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: text}})
	return nil
}

// noteGoal tracks the goal Codex reports and tells the session when Codex
// starts a goal turn on its own.
func (r *Runtime) noteGoal(method string, events []domain.Event) []domain.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, ev := range events {
		if ev.Type == domain.EventGoal {
			r.goalActive = ev.Goal.Active()
		}
	}
	if method == "turn/started" && r.goalActive {
		events = append(events, domain.Event{SessionID: r.mapper.session, Type: domain.EventTurnStarted})
	}
	return events
}
