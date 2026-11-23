package domain

import (
	"errors"
	"fmt"
	"strings"
)

type GoalStatus string

const (
	GoalActive        GoalStatus = "active"
	GoalPaused        GoalStatus = "paused"
	GoalBlocked       GoalStatus = "blocked"
	GoalBudgetLimited GoalStatus = "budgetLimited"
	GoalComplete      GoalStatus = "complete"
)

// GoalVerdict is the auditor's reading of the turn that just ended.
type GoalVerdict string

const (
	GoalVerdictContinue GoalVerdict = "continue"
	GoalVerdictComplete GoalVerdict = "complete"
	GoalVerdictBlocked  GoalVerdict = "blocked"
)

const (
	GoalObjectiveLimit = 5000
	// GoalMaxAutoTurns caps continuations per run; the audit is the intended
	// stop, this only prevents a runaway loop.
	GoalMaxAutoTurns = 20
	// GoalBlockedStreakLimit is how many audits in a row must report a blocker
	// before the goal settles as blocked.
	GoalBlockedStreakLimit = 3
	// GoalAuditFailLimit is how many audits in a row may fail before the
	// pursuit stops rather than continue unaudited.
	GoalAuditFailLimit = 2
)

// Goal is an objective the agent pursues across continuations until an
// independent audit settles it or a limit stops it.
type Goal struct {
	Objective     string
	Status        GoalStatus
	TokenBudget   int64
	TokensUsed    int64
	TurnsUsed     int
	BlockedStreak int
	AuditFailures int
	Note          string
}

func NewGoal(objective string) (*Goal, error) {
	objective = strings.TrimSpace(objective)
	if objective == "" {
		return nil, errors.New("goal objective is empty")
	}
	if len(objective) > GoalObjectiveLimit {
		return nil, fmt.Errorf("goal objective exceeds %d characters", GoalObjectiveLimit)
	}
	return &Goal{Objective: objective, Status: GoalActive}, nil
}

func (g *Goal) Active() bool { return g != nil && g.Status == GoalActive }

// Spend charges usage to an active goal and stops it at its budget.
func (g *Goal) Spend(tokens int64) {
	if !g.Active() {
		return
	}
	g.TokensUsed += tokens
	if g.TokenBudget > 0 && g.TokensUsed >= g.TokenBudget {
		g.Status = GoalBudgetLimited
		g.Note = "token budget reached"
	}
}

func (g *Goal) SetBudget(tokens int64) { g.TokenBudget = max(tokens, 0) }

func (g *Goal) Judge(verdict GoalVerdict, note string) {
	if !g.Active() {
		return
	}
	g.AuditFailures = 0
	g.Note = note
	switch verdict {
	case GoalVerdictComplete:
		g.Status = GoalComplete
	case GoalVerdictBlocked:
		g.BlockedStreak++
		if g.BlockedStreak >= GoalBlockedStreakLimit {
			g.Status = GoalBlocked
		}
	default:
		g.BlockedStreak = 0
	}
}

func (g *Goal) AuditFailed() {
	if !g.Active() {
		return
	}
	g.AuditFailures++
	if g.AuditFailures >= GoalAuditFailLimit {
		g.Status = GoalPaused
		g.Note = "audit unavailable; progress cannot be verified"
	}
}

// Continue claims one more continuation, pausing the goal at the cap.
func (g *Goal) Continue() bool {
	if !g.Active() {
		return false
	}
	if g.TurnsUsed >= GoalMaxAutoTurns {
		g.Status = GoalPaused
		g.Note = fmt.Sprintf("reached %d continuations without settling", GoalMaxAutoTurns)
		return false
	}
	g.TurnsUsed++
	return true
}

func (g *Goal) Pause(note string) {
	if g.Active() {
		g.Status = GoalPaused
		g.Note = note
	}
}

// Resume starts a fresh run of continuations toward the same objective.
func (g *Goal) Resume() error {
	if g.TokenBudget > 0 && g.TokensUsed >= g.TokenBudget {
		return errors.New("token budget reached; raise it before resuming")
	}
	g.Status = GoalActive
	g.TurnsUsed, g.BlockedStreak, g.AuditFailures, g.Note = 0, 0, 0, ""
	return nil
}

// Progress is the one-line state shown after each audit.
func (g *Goal) Progress() string {
	tokens := fmt.Sprintf("%d tokens", g.TokensUsed)
	if g.TokenBudget > 0 {
		tokens = fmt.Sprintf("%d of %d tokens", g.TokensUsed, g.TokenBudget)
	}
	text := fmt.Sprintf("**Goal %s** · continuation %d of %d · %s", g.Status, g.TurnsUsed, GoalMaxAutoTurns, tokens)
	if g.Note != "" {
		text += " — " + g.Note
	}
	return text
}

func (g *Goal) Summary() string { return g.Progress() + "\n\n" + g.Objective }
