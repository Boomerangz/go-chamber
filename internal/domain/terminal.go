package domain

import (
	"errors"
	"fmt"
	"path/filepath"
	"time"
)

var (
	ErrInvalidTerminal = errors.New("invalid terminal")
	ErrTerminalExited  = errors.New("terminal has exited")
)

type TerminalID string

type TerminalStatus string

const (
	TerminalRunning TerminalStatus = "running"
	TerminalExited  TerminalStatus = "exited"
)

// Terminal is an interactive shell. It lives independently of sessions:
// SessionID only records that it was opened in a session's directory.
type Terminal struct {
	ID        TerminalID     `json:"id"`
	Cwd       string         `json:"cwd"`
	Shell     string         `json:"shell"`
	Title     string         `json:"title"`
	SessionID SessionID      `json:"sessionId,omitempty"`
	Status    TerminalStatus `json:"status"`
	ExitCode  int            `json:"exitCode"`
	CreatedAt time.Time      `json:"createdAt"`
}

func NewTerminal(id TerminalID, cwd, shell string, session SessionID, now time.Time) (Terminal, error) {
	switch {
	case id == "":
		return Terminal{}, fmt.Errorf("%w: empty id", ErrInvalidTerminal)
	case !filepath.IsAbs(cwd):
		return Terminal{}, fmt.Errorf("%w: cwd %q is not absolute", ErrInvalidTerminal, cwd)
	case shell == "":
		return Terminal{}, fmt.Errorf("%w: empty shell", ErrInvalidTerminal)
	}
	return Terminal{
		ID: id, Cwd: cwd, Shell: shell, Title: filepath.Base(cwd),
		SessionID: session, Status: TerminalRunning, CreatedAt: now,
	}, nil
}

// UniqueTitle numbers a repeated title: several shells in one folder read
// "repo", "repo 2", "repo 3" rather than the same name over and over.
func UniqueTitle(base string, taken []string) string {
	used := make(map[string]bool, len(taken))
	for _, t := range taken {
		used[t] = true
	}
	title := base
	for n := 2; used[title]; n++ {
		title = fmt.Sprintf("%s %d", base, n)
	}
	return title
}

// Exit records the shell's exit code; a terminal exits only once.
func (t *Terminal) Exit(code int) error {
	if t.Status == TerminalExited {
		return ErrTerminalExited
	}
	t.Status = TerminalExited
	t.ExitCode = code
	return nil
}
