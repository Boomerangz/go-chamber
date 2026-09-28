package app

import (
	"context"
	"fmt"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// ContinuePrompt is the message that picks a cut-off turn back up.
const ContinuePrompt = "Continue from where you stopped."

// Continue resumes an interrupted or detached conversation by asking the
// agent to carry on where it stopped.
func (m *Manager) Continue(ctx context.Context, id domain.SessionID) error {
	s, err := m.session(ctx, id)
	if err != nil {
		return err
	}
	m.mu.Lock()
	ok, status := s.Continuable(), s.Status()
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("%w: nothing to continue in %s", domain.ErrInvalidTransition, status)
	}
	return m.SendMessage(ctx, id, ContinuePrompt)
}

// SetAutoContinue schedules (or cancels) continuing a quota-interrupted
// session once its limit resets. The timer is server-side and survives a
// restart through the persisted snapshot.
func (m *Manager) SetAutoContinue(ctx context.Context, id domain.SessionID, on bool) (domain.SessionSnapshot, error) {
	s, err := m.session(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	err = s.SetAutoContinue(on)
	snap := s.Snapshot()
	m.mu.Unlock()
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	if err := m.cfg.Repo.Save(ctx, snap); err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.armAutoContinue(id, on, snap.Interruption.ResumeAfter)
	m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventSessionState, Session: &snap})
	return snap, nil
}

func (m *Manager) armAutoContinue(id domain.SessionID, on bool, at time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t := m.resume[id]; t != nil {
		t.Stop()
		delete(m.resume, id)
	}
	if on {
		m.resume[id] = time.AfterFunc(at.Sub(m.cfg.Now()), func() { m.autoContinue(id) })
	}
}

func (m *Manager) autoContinue(id domain.SessionID) {
	ctx := context.Background()
	s, err := m.session(ctx, id)
	if err != nil {
		return
	}
	m.mu.Lock()
	delete(m.resume, id)
	due := s.AutoContinue()
	m.mu.Unlock()
	if due {
		_ = m.Continue(ctx, id)
	}
}

// Fork starts a new session that continues the parent's conversation on a
// branch of its own. The agent process starts at once so the fork's native
// id is known and persisted before the first message.
func (m *Manager) Fork(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	parent, err := m.session(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	fork, err := domain.NewForkSession(domain.SessionID(m.cfg.NewID()), parent)
	native := parent.NativeID()
	m.mu.Unlock()
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	fork.Touch(m.cfg.Now().UTC())
	m.mu.Lock()
	m.sessions[fork.ID()] = fork
	m.mu.Unlock()
	if _, err := m.ensureRuntimeFor(ctx, fork, native, false, true); err != nil {
		m.mu.Lock()
		delete(m.sessions, fork.ID())
		m.mu.Unlock()
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	snap := fork.Snapshot()
	m.mu.Unlock()
	if err := m.cfg.Repo.Save(ctx, snap); err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.cfg.Bus.Publish(domain.Event{SessionID: snap.ID, Type: domain.EventSessionState, Session: &snap})
	return snap, nil
}
