package app

import (
	"context"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func (m *Manager) SetPinned(ctx context.Context, id domain.SessionID, on bool) (domain.SessionSnapshot, error) {
	s, err := m.session(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	snap := s.Snapshot()
	snap.Pinned = on
	snap.PinRevision++
	if err := m.cfg.Repo.Save(ctx, snap); err != nil {
		return domain.SessionSnapshot{}, err
	}
	s.SetPinned(on)
	m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventSessionState, Session: &snap})
	return snap, nil
}
