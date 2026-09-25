// Package pty implements app.PTYFactory with login shells in
// pseudo-terminals (creack/pty).
package pty

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"

	"github.com/igorzygin/go-chamber/internal/app"
)

type Factory struct {
	// KillAfter is how long Close waits after SIGHUP before SIGKILL;
	// 2s when zero.
	KillAfter time.Duration
}

func (fa Factory) Start(spec app.PTYSpec) (app.PTY, error) {
	cmd := exec.Command(spec.Shell, "-l")
	cmd.Dir = spec.Cwd
	// For duplicate keys exec uses the last value, so these override ours.
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: spec.Cols, Rows: spec.Rows})
	if err != nil {
		return nil, err
	}
	killAfter := fa.KillAfter
	if killAfter == 0 {
		killAfter = 2 * time.Second
	}
	return &shell{f: f, cmd: cmd, killAfter: killAfter, members: sessionMembers, exited: make(chan struct{})}, nil
}

type shell struct {
	f         *os.File
	cmd       *exec.Cmd
	killAfter time.Duration
	members   func(sid int) ([]int, error)

	exited    chan struct{}
	exitOnce  sync.Once
	closeOnce sync.Once
	closeErr  error
}

func (s *shell) Read(p []byte) (int, error)  { return s.f.Read(p) }
func (s *shell) Write(p []byte) (int, error) { return s.f.Write(p) }

func (s *shell) Resize(cols, rows uint16) error {
	return pty.Setsize(s.f, &pty.Winsize{Cols: cols, Rows: rows})
}

func (s *shell) Wait() (int, error) {
	err := s.cmd.Wait()
	s.exitOnce.Do(func() { close(s.exited) })
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

// Close releases the terminal. Closing a live terminal hangs up its whole
// session, as a terminal emulator closing its window does: interactive
// shells are meant to pass SIGHUP on to their jobs but don't reliably (bash
// sometimes dies first), so every process of the session gets it directly;
// nohup'd ones ignore it and survive. A shell still running after killAfter
// is killed; that needs Wait to be running. A shell that already exited on
// its own leaves its background jobs alone, as in a real terminal.
func (s *shell) Close() error {
	s.closeOnce.Do(func() {
		if !s.hasExited() {
			s.hangup()
		}
		s.closeErr = s.f.Close()
		go func() {
			select {
			case <-s.exited:
			case <-time.After(s.killAfter):
				_ = s.cmd.Process.Kill()
			}
		}()
	})
	return s.closeErr
}

func (s *shell) hasExited() bool {
	select {
	case <-s.exited:
		return true
	default:
		return false
	}
}

// hangup sends SIGHUP to the shell and every process in its session. The
// shell leads the session (pty starts it with setsid), so the session id is
// its pid.
func (s *shell) hangup() {
	sid := s.cmd.Process.Pid
	_ = syscall.Kill(sid, syscall.SIGHUP)
	pids, _ := s.members(sid)
	for _, pid := range pids {
		// Checked again right before signalling: a wrong member list must
		// never hang up processes outside this terminal.
		if got, err := unix.Getsid(pid); err == nil && got == sid {
			_ = syscall.Kill(pid, syscall.SIGHUP)
		}
	}
}
