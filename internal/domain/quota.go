package domain

import (
	"errors"
	"fmt"
	"time"
)

var ErrInvalidQuota = errors.New("invalid quota snapshot")

// QuotaWindow is one subscription rate-limit window (e.g. five-hour, weekly,
// or Codex primary/secondary).
type QuotaWindow struct {
	Name     string    `json:"name"`
	UsedPct  float64   `json:"usedPct"`
	ResetsAt time.Time `json:"resetsAt,omitempty"`
	Status   string    `json:"status,omitempty"`
}

// QuotaSnapshot is the latest known rate-limit state for one agent.
type QuotaSnapshot struct {
	Agent     AgentKind     `json:"agent"`
	Windows   []QuotaWindow `json:"windows"`
	Plan      string        `json:"plan,omitempty"`
	Reached   bool          `json:"reached,omitempty"`
	UpdatedAt time.Time     `json:"updatedAt,omitempty"`
}

func (q QuotaSnapshot) Validate() error {
	if !q.Agent.Valid() {
		return fmt.Errorf("%w: unknown agent %q", ErrInvalidQuota, q.Agent)
	}
	for _, w := range q.Windows {
		if w.Name == "" {
			return fmt.Errorf("%w: window without name", ErrInvalidQuota)
		}
		if w.UsedPct < 0 || w.UsedPct > 100 {
			return fmt.Errorf("%w: window %s used %.1f%%", ErrInvalidQuota, w.Name, w.UsedPct)
		}
	}
	return nil
}

// Usage is token/cost accounting for a session or turn.
type Usage struct {
	InputTokens  int64   `json:"inputTokens,omitempty"`
	OutputTokens int64   `json:"outputTokens,omitempty"`
	TotalTokens  int64   `json:"totalTokens,omitempty"`
	CostUSD      float64 `json:"costUsd,omitempty"`
}
