package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// ErrDeleteUnsupported is returned when no SessionEraser is configured.
var ErrDeleteUnsupported = errors.New("deleting sessions is not supported")

// SessionEraser removes go-chamber's own record of a session: the session,
// its event log and its search index. The agent's transcript on disk is not
// go-chamber's and stays. Erasing a session that is gone is not an error.
type SessionEraser interface {
	EraseSession(ctx context.Context, id domain.SessionID) error
}

// ArchiveSession puts a session away from the list; it keeps working when
// opened.
func (m *Manager) ArchiveSession(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	return m.changeArchive(ctx, id, func(s *domain.Session) error { return s.Archive(m.cfg.Now()) })
}

// UnarchiveSession brings an archived session back to the list.
func (m *Manager) UnarchiveSession(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	return m.changeArchive(ctx, id, func(s *domain.Session) error {
		s.Unarchive()
		return nil
	})
}

func (m *Manager) changeArchive(ctx context.Context, id domain.SessionID, change func(*domain.Session) error) (domain.SessionSnapshot, error) {
	s, err := m.session(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	was := s.Snapshot().ArchivedAt
	err = change(s)
	snap := s.Snapshot()
	m.mu.Unlock()
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	if err := m.cfg.Repo.Save(ctx, snap); err != nil {
		m.mu.Lock()
		restoreArchive(s, was)
		m.mu.Unlock()
		return domain.SessionSnapshot{}, err
	}
	m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventSessionState, Session: &snap})
	return snap, nil
}

func restoreArchive(s *domain.Session, at time.Time) {
	s.Unarchive()
	if !at.IsZero() {
		_ = s.Archive(at)
	}
}

// DeleteSession removes go-chamber's record of a session and of the
// subagents it spawned. A running turn must be stopped first; an idle agent
// process is closed. The agent's own transcript stays on disk.
func (m *Manager) DeleteSession(ctx context.Context, id domain.SessionID) error {
	if m.cfg.Eraser == nil {
		return ErrDeleteUnsupported
	}
	doomed, err := m.subtree(ctx, id)
	if err != nil {
		return err
	}
	m.mu.Lock()
	for _, s := range doomed {
		if err := s.Deletable(); err != nil {
			m.mu.Unlock()
			return fmt.Errorf("%s: %w", s.ID(), err)
		}
	}
	for _, s := range doomed {
		m.forget(s)
	}
	m.mu.Unlock()
	// Announce before erasing: the bus logs the announcement too, and
	// erasing takes it along with the rest of the session's events.
	for _, s := range doomed {
		m.cfg.Bus.Publish(domain.Event{SessionID: s.ID(), Type: domain.EventSessionRemoved})
	}
	// Subagents go first, so a failure never leaves one without its parent.
	for i := len(doomed) - 1; i >= 0; i-- {
		if err := m.cfg.Eraser.EraseSession(ctx, doomed[i].ID()); err != nil {
			m.keep(doomed[:i+1])
			return err
		}
	}
	return nil
}

// subtree returns the session followed by every subagent below it.
func (m *Manager) subtree(ctx context.Context, id domain.SessionID) ([]*domain.Session, error) {
	root, err := m.session(ctx, id)
	if err != nil {
		return nil, err
	}
	all, err := m.cfg.Repo.List(ctx)
	if err != nil {
		return nil, err
	}
	children := map[domain.SessionID][]domain.SessionID{}
	for _, snap := range all {
		if snap.ParentID != "" {
			children[snap.ParentID] = append(children[snap.ParentID], snap.ID)
		}
	}
	out := []*domain.Session{root}
	for i := 0; i < len(out); i++ {
		for _, child := range children[out[i].ID()] {
			s, err := m.session(ctx, child)
			if err != nil {
				return nil, err
			}
			out = append(out, s)
		}
	}
	return out, nil
}

// forget drops a session from memory and closes its agent process, so
// nothing writes its record back. Callers hold m.mu.
func (m *Manager) forget(s *domain.Session) {
	id := s.ID()
	if t := m.idle[id]; t != nil {
		t.Stop()
		delete(m.idle, id)
	}
	if t := m.resume[id]; t != nil {
		t.Stop()
		delete(m.resume, id)
	}
	m.retire(s)
	delete(m.pending, id)
	delete(m.sessions, id)
}

// keep puts back sessions whose record could not be erased and tells
// clients they are still there.
func (m *Manager) keep(sessions []*domain.Session) {
	ctx := context.Background()
	for _, s := range sessions {
		m.mu.Lock()
		m.sessions[s.ID()] = s
		snap := s.Snapshot()
		m.mu.Unlock()
		_ = m.cfg.Repo.Save(ctx, snap)
		m.cfg.Bus.Publish(domain.Event{SessionID: snap.ID, Type: domain.EventSessionState, Session: &snap})
	}
}
