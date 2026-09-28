package app

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// ErrTitleTooLong rejects names longer than maxTitle characters.
var ErrTitleTooLong = errors.New("title is too long")

const maxTitle = 200

func cleanTitle(title string) (string, error) {
	title = strings.TrimSpace(title)
	if utf8.RuneCountInString(title) > maxTitle {
		return "", ErrTitleTooLong
	}
	return title, nil
}

// RenameSession names a session. A blank title clears it, and the UI falls
// back to the agent's name; the first message no longer overrides a name.
func (m *Manager) RenameSession(ctx context.Context, id domain.SessionID, title string) (domain.SessionSnapshot, error) {
	title, err := cleanTitle(title)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	s, err := m.session(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	s.Rename(title)
	snap := s.Snapshot()
	m.mu.Unlock()
	if err := m.cfg.Repo.Save(ctx, snap); err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventSessionState, Session: &snap})
	return snap, nil
}

// Rename names a terminal; a blank title restores its folder name.
func (t *Terminals) Rename(id domain.TerminalID, title string) (domain.Terminal, error) {
	title, err := cleanTitle(title)
	if err != nil {
		return domain.Terminal{}, err
	}
	rt, err := t.find(id)
	if err != nil {
		return domain.Terminal{}, err
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if title == "" {
		title = filepath.Base(rt.term.Cwd)
	}
	rt.term.Title = title
	return rt.term, nil
}
