package app

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// ErrHistoryNotFound means the agent has no conversation with that native id.
var ErrHistoryNotFound = errors.New("history session not found")

// ExternalSession is a conversation the agent recorded on its own — started
// in a terminal or another client — that go-chamber can open and continue.
type ExternalSession struct {
	Agent     domain.AgentKind `json:"agent"`
	NativeID  string           `json:"nativeId"`
	Cwd       string           `json:"cwd"`
	Title     string           `json:"title,omitempty"`
	UpdatedAt time.Time        `json:"updatedAt,omitzero"`
}

// TranscriptSource reads one agent's own conversation history.
type TranscriptSource interface {
	Sessions(ctx context.Context) ([]ExternalSession, error)
	// Transcript returns the conversation as items stamped with session.
	Transcript(ctx context.Context, nativeID string, session domain.SessionID) ([]domain.Item, error)
}

type HistoryConfig struct {
	Repo    SessionRepo
	Bus     EventBus
	Sources map[domain.AgentKind]TranscriptSource
	NewID   func() string
	Now     func() time.Time
}

// History lists conversations recorded outside go-chamber and imports them
// as detached sessions; continuing one uses the usual lazy resume.
type History struct {
	cfg HistoryConfig
}

func NewHistory(cfg HistoryConfig) *History {
	if cfg.NewID == nil {
		cfg.NewID = randomID
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &History{cfg: cfg}
}

// List returns every agent's recorded conversations not yet imported,
// newest first. A source that fails (agent not installed) is skipped.
func (h *History) List(ctx context.Context) ([]ExternalSession, error) {
	known, err := h.imported(ctx)
	if err != nil {
		return nil, err
	}
	out := []ExternalSession{}
	for _, src := range h.cfg.Sources {
		list, err := src.Sessions(ctx)
		if err != nil {
			continue // agent not installed or its history unreadable
		}
		for _, s := range list {
			if _, ok := known[historyKey(s.Agent, s.NativeID)]; !ok {
				out = append(out, s)
			}
		}
	}
	slices.SortStableFunc(out, func(a, b ExternalSession) int { return b.UpdatedAt.Compare(a.UpdatedAt) })
	return out, nil
}

// Import creates a detached session for the agent's conversation and
// publishes its transcript as items. Importing one already known returns
// the existing session.
func (h *History) Import(ctx context.Context, agent domain.AgentKind, nativeID string) (domain.SessionSnapshot, error) {
	known, err := h.imported(ctx)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	if snap, ok := known[historyKey(agent, nativeID)]; ok {
		return snap, nil
	}
	src, ok := h.cfg.Sources[agent]
	if !ok {
		return domain.SessionSnapshot{}, fmt.Errorf("%w: %s %s", ErrHistoryNotFound, agent, nativeID)
	}
	list, err := src.Sessions(ctx)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	i := slices.IndexFunc(list, func(s ExternalSession) bool { return s.NativeID == nativeID })
	if i < 0 {
		return domain.SessionSnapshot{}, fmt.Errorf("%w: %s %s", ErrHistoryNotFound, agent, nativeID)
	}
	ext := list[i]
	id := domain.SessionID(h.cfg.NewID())
	items, err := src.Transcript(ctx, nativeID, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	active := ext.UpdatedAt
	if active.IsZero() {
		active = h.cfg.Now().UTC()
	}
	s, err := domain.RestoreSession(domain.SessionSnapshot{
		ID: id, Agent: agent, Cwd: ext.Cwd, NativeID: nativeID, Title: ext.Title,
		Status: domain.StatusDetached, CreatedAt: h.cfg.Now().UTC(), ActiveAt: active,
	})
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	snap := s.Snapshot()
	if err := h.cfg.Repo.Save(ctx, snap); err != nil {
		return domain.SessionSnapshot{}, err
	}
	h.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventSessionState, Session: &snap})
	for i := range items {
		h.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventItemUpdated, Item: &items[i]})
	}
	return snap, nil
}

func (h *History) imported(ctx context.Context) (map[string]domain.SessionSnapshot, error) {
	snaps, err := h.cfg.Repo.List(ctx)
	if err != nil {
		return nil, err
	}
	known := map[string]domain.SessionSnapshot{}
	for _, s := range snaps {
		if s.NativeID != "" {
			known[historyKey(s.Agent, s.NativeID)] = s
		}
	}
	return known, nil
}

func historyKey(agent domain.AgentKind, nativeID string) string {
	return string(agent) + "/" + nativeID
}

// copyItems publishes the final state of every item in from's event log as
// an item of to, so a fork opens showing the conversation it continues.
func (m *Manager) copyItems(from, to domain.SessionID) {
	if m.cfg.History == nil {
		return
	}
	var order []domain.ItemID
	last := map[domain.ItemID]domain.Item{}
	for _, ev := range m.cfg.History.History(from, 0) {
		if ev.Type != domain.EventItemUpdated || ev.Item == nil {
			continue
		}
		if _, ok := last[ev.Item.ID]; !ok {
			order = append(order, ev.Item.ID)
		}
		last[ev.Item.ID] = *ev.Item
	}
	for _, id := range order {
		it := last[id]
		it.SessionID = to
		m.cfg.Bus.Publish(domain.Event{SessionID: to, Type: domain.EventItemUpdated, Item: &it})
	}
}
