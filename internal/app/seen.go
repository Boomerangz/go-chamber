package app

import (
	"context"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// MarkSeen records that the owner looked at a session, on whichever device,
// having read up to item (empty when they looked without reaching the end),
// and tells every device.
func (m *Manager) MarkSeen(ctx context.Context, id domain.SessionID, item domain.ItemID) (domain.SessionSnapshot, error) {
	s, err := m.session(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	err = s.MarkSeen(item, m.cfg.Now())
	snap := s.Snapshot()
	m.mu.Unlock()
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	if err := m.cfg.Repo.Save(ctx, snap); err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventSessionState, Session: &snap})
	return snap, nil
}
