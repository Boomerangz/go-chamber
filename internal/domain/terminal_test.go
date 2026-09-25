package domain

import (
	"errors"
	"testing"
	"time"
)

func TestNewTerminal(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	term, err := NewTerminal("t1", "/home/me/project", "/bin/zsh", "s1", now)
	if err != nil {
		t.Fatalf("NewTerminal: %v", err)
	}
	want := Terminal{
		ID: "t1", Cwd: "/home/me/project", Shell: "/bin/zsh", Title: "project",
		SessionID: "s1", Status: TerminalRunning, CreatedAt: now,
	}
	if term != want {
		t.Fatalf("terminal = %+v, want %+v", term, want)
	}
}

func TestNewTerminalTitleForRoot(t *testing.T) {
	term, err := NewTerminal("t1", "/", "/bin/sh", "", time.Time{})
	if err != nil {
		t.Fatalf("NewTerminal: %v", err)
	}
	if term.Title != "/" {
		t.Fatalf("title = %q, want /", term.Title)
	}
}

func TestNewTerminalRejectsInvalid(t *testing.T) {
	cases := []struct{ id, cwd, shell string }{
		{"", "/tmp", "/bin/sh"},
		{"t", "", "/bin/sh"},
		{"t", "relative/dir", "/bin/sh"},
		{"t", "/tmp", ""},
	}
	for _, tc := range cases {
		if _, err := NewTerminal(TerminalID(tc.id), tc.cwd, tc.shell, "", time.Time{}); !errors.Is(err, ErrInvalidTerminal) {
			t.Fatalf("NewTerminal(%+v) err = %v, want ErrInvalidTerminal", tc, err)
		}
	}
}

func TestTerminalExit(t *testing.T) {
	term, _ := NewTerminal("t1", "/tmp", "/bin/sh", "", time.Time{})
	if err := term.Exit(3); err != nil {
		t.Fatalf("Exit: %v", err)
	}
	if term.Status != TerminalExited || term.ExitCode != 3 {
		t.Fatalf("after exit: %+v", term)
	}
	if err := term.Exit(0); !errors.Is(err, ErrTerminalExited) {
		t.Fatalf("second Exit err = %v, want ErrTerminalExited", err)
	}
	if term.ExitCode != 3 {
		t.Fatalf("second Exit changed code to %d", term.ExitCode)
	}
}
