package domain

import (
	"errors"
	"fmt"
	"slices"
	"time"
)

var ErrInvalidQuota = errors.New("invalid quota snapshot")

// QuotaWindow is one subscription rate-limit window (e.g. five-hour, weekly,
// or Codex primary/secondary).
type QuotaWindow struct {
	Name     string    `json:"name"`
	UsedPct  float64   `json:"usedPct"`
	ResetsAt time.Time `json:"resetsAt,omitzero"`
	Status   string    `json:"status,omitempty"`
}

// QuotaSnapshot is the latest known rate-limit state for one agent.
type QuotaSnapshot struct {
	Agent     AgentKind     `json:"agent"`
	Windows   []QuotaWindow `json:"windows"`
	Plan      string        `json:"plan,omitempty"`
	Reached   bool          `json:"reached,omitempty"`
	UpdatedAt time.Time     `json:"updatedAt,omitzero"`
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

// Merge returns the snapshot updated with next. Agents report windows one at
// a time, so windows next doesn't mention are kept.
func (q QuotaSnapshot) Merge(next QuotaSnapshot) QuotaSnapshot {
	if q.Agent != next.Agent {
		return next
	}
	merged := next
	merged.Windows = append([]QuotaWindow(nil), q.Windows...)
	for _, w := range next.Windows {
		i := slices.IndexFunc(merged.Windows, func(old QuotaWindow) bool { return old.Name == w.Name })
		if i < 0 {
			merged.Windows = append(merged.Windows, w)
		} else {
			merged.Windows[i] = w
		}
	}
	if merged.Plan == "" {
		merged.Plan = q.Plan
	}
	// A kept window whose reset passed by the time of this report no longer
	// holds the agent back.
	merged.Reached = next.Reached || slices.ContainsFunc(merged.Windows, func(w QuotaWindow) bool {
		return w.exhausted() && (w.ResetsAt.IsZero() || !w.ResetsAt.Before(next.UpdatedAt))
	})
	return merged
}

func (w QuotaWindow) exhausted() bool { return w.Status == "rejected" || w.UsedPct >= 100 }

// ResetsAt is when a reached limit lifts: the latest reset among exhausted
// windows, or among all windows when none is marked exhausted.
func (q QuotaSnapshot) ResetsAt() time.Time {
	var all, exhausted time.Time
	for _, w := range q.Windows {
		if w.ResetsAt.After(all) {
			all = w.ResetsAt
		}
		if w.exhausted() && w.ResetsAt.After(exhausted) {
			exhausted = w.ResetsAt
		}
	}
	if !exhausted.IsZero() {
		return exhausted
	}
	return all
}

// Usage is token/cost accounting for a session or turn.
type Usage struct {
	InputTokens  int64   `json:"inputTokens,omitempty"`
	OutputTokens int64   `json:"outputTokens,omitempty"`
	TotalTokens  int64   `json:"totalTokens,omitempty"`
	CostUSD      float64 `json:"costUsd,omitempty"`
}
