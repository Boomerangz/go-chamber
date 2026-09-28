package app

import (
	"context"
	"errors"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// PermissionModeSetter is implemented by runtimes that can change the
// permission mode while running; ErrRestartRequired asks for a restart.
type PermissionModeSetter interface {
	SetPermissionMode(ctx context.Context, mode string) error
}

// SetPermissionMode chooses how the agent asks before acting. A runtime
// that can switch does so at once; otherwise the agent is restarted (resuming
// the conversation) now if idle, or before the next turn. A switch the agent
// refuses leaves the old mode in place.
func (m *Manager) SetPermissionMode(ctx context.Context, id domain.SessionID, mode string) (domain.SessionSnapshot, error) {
	s, err := m.session(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	old := s.PermissionMode()
	err = s.SetPermissionMode(mode)
	rt := m.runtimes[id]
	m.mu.Unlock()
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	if rt != nil {
		err := ErrRestartRequired
		if setter, ok := rt.(PermissionModeSetter); ok {
			err = setter.SetPermissionMode(ctx, mode)
		}
		m.mu.Lock()
		switch {
		case errors.Is(err, ErrRestartRequired):
			if s.Status() == domain.StatusRunning {
				m.restart[id] = true
			} else {
				m.retire(s)
			}
		case err != nil:
			_ = s.SetPermissionMode(old)
			m.mu.Unlock()
			return domain.SessionSnapshot{}, err
		}
		m.mu.Unlock()
	}
	m.mu.Lock()
	snap := s.Snapshot()
	m.mu.Unlock()
	if err := m.cfg.Repo.Save(ctx, snap); err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventSessionState, Session: &snap})
	return snap, nil
}
