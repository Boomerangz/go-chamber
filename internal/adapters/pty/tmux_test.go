package pty

import (
	"context"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func newTmux(t *testing.T) Tmux {
	t.Helper()
	bin, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not installed")
	}
	tx := Tmux{Bin: bin, Socket: "gc-test-" + strings.ReplaceAll(t.Name(), "/", "-")}
	t.Cleanup(func() { _ = tx.command("kill-server").Run() })
	return tx
}

func startTmux(t *testing.T, tx Tmux, id, cwd string) (*tmuxPTY, *reader) {
	t.Helper()
	p, err := tx.Start(app.PTYSpec{ID: id, Cwd: cwd, Shell: "/bin/sh", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	return p.(*tmuxPTY), startReader(p)
}

func TestTmuxShellRunsInCwdAndResizes(t *testing.T) {
	tx := newTmux(t)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	p, r := startTmux(t, tx, "a1", dir)
	defer func() { _ = p.Close() }()
	_, _ = io.WriteString(p, "echo \"cwd=$(pwd) term=$TERM\"; stty size\n")
	r.waitFor(t, "cwd="+dir+" term=xterm-256color")
	r.waitFor(t, "24 80")
	if err := p.Resize(100, 30); err != nil {
		t.Fatal(err)
	}
	// tmux passes the new size on asynchronously.
	_, _ = io.WriteString(p, "until [ \"$(stty size)\" = \"30 100\" ]; do sleep 0.1; done; echo size$((6*7))\n")
	r.waitFor(t, "size42")
}

func TestTmuxShellOutlivesDetachAndIsRestored(t *testing.T) {
	tx := newTmux(t)
	dir := t.TempDir()
	p, r := startTmux(t, tx, "a2", dir)
	want := domain.Terminal{ID: "a2", Cwd: dir, Shell: "/bin/sh", Title: "build", SessionID: "s1", Status: domain.TerminalRunning,
		CreatedAt: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)}
	p.Remember(want)
	_, _ = io.WriteString(p, "MARK=kept; echo r$((6*7))\n")
	r.waitFor(t, "r42")
	if err := p.Detach(); err != nil {
		t.Fatal(err)
	}
	r.drain()
	_, _ = p.Wait()
	_ = p.Close() // pump's Close after the client left must not end the session

	got, err := tx.Restore(80, 24)
	if err != nil || len(got) != 1 {
		t.Fatalf("Restore = %v, %v", got, err)
	}
	if !got[0].Term.CreatedAt.Equal(want.CreatedAt) || got[0].Term.Title != "build" || got[0].Term.SessionID != "s1" {
		t.Fatalf("term = %+v", got[0].Term)
	}
	r2 := startReader(got[0].PTY)
	_, _ = io.WriteString(got[0].PTY, "echo \"mark=$MARK\"\n")
	r2.waitFor(t, "mark=kept")
	_ = got[0].PTY.Close()
}

func TestTmuxCloseKillsTheSession(t *testing.T) {
	tx := newTmux(t)
	p, r := startTmux(t, tx, "a3", t.TempDir())
	p.Remember(domain.Terminal{ID: "a3"})
	_, _ = io.WriteString(p, "echo u$((6*7))\n")
	r.waitFor(t, "u42")
	go func() { _, _ = p.Wait() }()
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if got, _ := tx.Restore(80, 24); len(got) != 0 {
		t.Fatalf("session survived Close: %v", got)
	}
}

func TestTmuxExitedShellEndsTheSession(t *testing.T) {
	tx := newTmux(t)
	p, r := startTmux(t, tx, "a4", t.TempDir())
	p.Remember(domain.Terminal{ID: "a4"})
	_, _ = io.WriteString(p, "exit 0\n")
	r.drain()
	if _, err := p.Wait(); err != nil {
		t.Fatal(err)
	}
	_ = p.Close()
	if got, _ := tx.Restore(80, 24); len(got) != 0 {
		t.Fatalf("exited shell restored: %v", got)
	}
}

func TestTmuxRestoreDropsSessionsWithoutDescription(t *testing.T) {
	tx := newTmux(t)
	p, _ := startTmux(t, tx, "a5", t.TempDir())
	_ = p.Detach()
	if got, err := tx.Restore(80, 24); err != nil || len(got) != 0 {
		t.Fatalf("Restore = %v, %v", got, err)
	}
	if out, _ := tx.command("list-sessions").CombinedOutput(); strings.Contains(string(out), "gc-a5") {
		t.Fatalf("undescribed session left: %s", out)
	}
}

func TestTmuxPassesPromptMarkersThrough(t *testing.T) {
	if _, err := exec.LookPath("zsh"); err != nil {
		t.Skip("zsh not installed")
	}
	tx := newTmux(t)
	p, err := tx.Start(app.PTYSpec{ID: "a6", Cwd: t.TempDir(), Shell: "/bin/zsh", Cols: 80, Rows: 24, PromptHooks: true})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = p.Close() }()
	r := startReader(p)
	r.waitFor(t, "\x1b]133;A\a")
}

// The whole path a server restart takes: open, shut down, start anew.
func TestTerminalsSurviveARestart(t *testing.T) {
	tx := newTmux(t)
	cfg := app.TerminalsConfig{PTYs: tx, Home: t.TempDir(), Shell: "/bin/sh"}
	first := app.NewTerminals(cfg)
	term, err := first.Open(context.Background(), app.OpenTerminal{Cwd: cfg.Home})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Rename(term.ID, "build"); err != nil {
		t.Fatal(err)
	}
	if err := first.Write(term.ID, []byte("MARK=kept; echo r$((6*7))\n")); err != nil {
		t.Fatal(err)
	}
	att, err := first.Attach(term.ID)
	if err != nil {
		t.Fatal(err)
	}
	waitOutput(t, att, "r42")
	att.Detach()
	first.CloseAll()

	second := app.NewTerminals(cfg)
	t.Cleanup(second.CloseAll)
	if err := second.Restore(); err != nil {
		t.Fatal(err)
	}
	got, err := second.Get(term.ID)
	if err != nil || got.Title != "build" || got.Status != domain.TerminalRunning {
		t.Fatalf("restored = %+v, %v", got, err)
	}
	att, err = second.Attach(term.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer att.Detach()
	if err := second.Write(term.ID, []byte("echo \"mark=$MARK\"\n")); err != nil {
		t.Fatal(err)
	}
	waitOutput(t, att, "mark=kept")
	if err := second.Close(term.ID); err != nil {
		t.Fatal(err)
	}
}

func waitOutput(t *testing.T, att *app.TerminalAttachment, want string) {
	t.Helper()
	seen := string(att.Scrollback)
	deadline := time.After(outputWait)
	for !strings.Contains(seen, want) {
		select {
		case o, ok := <-att.Output:
			if !ok {
				t.Fatalf("output closed before %q; got %q", want, seen)
			}
			seen += string(o.Data)
		case <-deadline:
			t.Fatalf("timeout waiting for %q; got %q", want, seen)
		}
	}
}
