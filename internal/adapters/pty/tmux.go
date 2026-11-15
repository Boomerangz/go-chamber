package pty

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

const (
	tmuxPrefix = "gc-"
	// tmuxMeta is the session option holding the terminal as JSON.
	tmuxMeta = "@gc"
)

// Tmux runs every shell in a tmux session on a private socket and talks to
// it through a tmux client in a pty. The sessions outlive this process:
// Detach on shutdown leaves them running, Restore reattaches them. Needs
// tmux 3.2+ (new-session -e).
type Tmux struct {
	Bin       string // tmux binary
	Socket    string // private socket name; "go-chamber" when empty
	KillAfter time.Duration
}

var (
	_ app.PTYFactory  = Tmux{}
	_ app.PTYRestorer = Tmux{}
)

func (tx Tmux) socket() string {
	if tx.Socket == "" {
		return "go-chamber"
	}
	return tx.Socket
}

// command runs tmux on the private socket without the user's config, and
// outside any tmux the server itself runs in (tmux refuses to nest). -u:
// the web terminal is UTF-8 whatever the server's locale; without it tmux
// draws every non-ASCII character as "_".
func (tx Tmux) command(args ...string) *exec.Cmd {
	cmd := exec.Command(tx.Bin, append([]string{"-u", "-L", tx.socket(), "-f", "/dev/null"}, args...)...)
	cmd.Env = tmuxEnv(os.Environ())
	return cmd
}

// tmuxEnv also gives the shells a UTF-8 locale when the server has none
// (launchd starts it without one), so they read and edit non-ASCII input.
func tmuxEnv(env []string) []string {
	out := make([]string, 0, len(env)+2)
	locale := false
	for _, kv := range env {
		if strings.HasPrefix(kv, "TMUX=") || strings.HasPrefix(kv, "TMUX_PANE=") {
			continue
		}
		for _, k := range []string{"LANG=", "LC_ALL=", "LC_CTYPE="} {
			if strings.HasPrefix(kv, k) && len(kv) > len(k) {
				locale = true
			}
		}
		out = append(out, kv)
	}
	if !locale {
		out = append(out, "LANG=en_US.UTF-8")
	}
	return append(out, "TERM=xterm-256color")
}

func (tx Tmux) Start(spec app.PTYSpec) (app.PTY, error) {
	if spec.ID == "" {
		return nil, errors.New("tmux: terminal id required")
	}
	args, env, cleanup, err := shellHooks(spec)
	if err != nil {
		return nil, err
	}
	name := tmuxPrefix + spec.ID
	// The options come first so they hold before the shell prints anything.
	// No alternate screen: the web terminal keeps its own scrollback.
	argv := []string{
		"set-option", "-g", "status", "off", ";",
		"set-option", "-g", "allow-passthrough", "on", ";",
		"set-option", "-g", "default-terminal", "xterm-256color", ";",
		"set-option", "-s", "escape-time", "0", ";",
		"set-option", "-sa", "terminal-overrides", ",xterm*:smcup@:rmcup@", ";",
		"set-option", "-sa", "terminal-features", ",xterm*:RGB", ";",
		"new-session", "-d", "-s", name, "-c", spec.Cwd,
		"-x", strconv.Itoa(int(spec.Cols)), "-y", strconv.Itoa(int(spec.Rows)), "-e", "COLORTERM=truecolor",
	}
	for _, kv := range env {
		argv = append(argv, "-e", kv)
	}
	argv = append(argv, spec.Shell)
	argv = append(argv, args...)
	if out, err := tx.command(argv...).CombinedOutput(); err != nil {
		cleanup()
		return nil, errors.New("tmux new-session: " + strings.TrimSpace(string(out)))
	}
	p, err := tx.attach(name, spec.Cols, spec.Rows, cleanup)
	if err != nil {
		_ = tx.command("kill-session", "-t", "="+name).Run()
		cleanup()
		return nil, err
	}
	return p, nil
}

func (tx Tmux) attach(name string, cols, rows uint16, cleanup func()) (*tmuxPTY, error) {
	sh, err := startShell(tx.command("attach-session", "-t", "="+name), cols, rows, tx.KillAfter, nil)
	if err != nil {
		return nil, err
	}
	return &tmuxPTY{shell: sh, tx: tx, name: name, cleanup: cleanup}, nil
}

// Restore reattaches the sessions left by an earlier run. A session without
// a description was never fully opened and is removed.
func (tx Tmux) Restore(cols, rows uint16) ([]app.RestoredTerminal, error) {
	out, err := tx.command("list-sessions", "-F", "#{session_name}|#{"+tmuxMeta+"}").Output()
	if err != nil {
		return nil, nil // ponytail: no server running reads the same as any list failure
	}
	var restored []app.RestoredTerminal
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name, meta, _ := strings.Cut(line, "|")
		if !strings.HasPrefix(name, tmuxPrefix) {
			continue
		}
		var term domain.Terminal
		if json.Unmarshal([]byte(meta), &term) != nil || term.ID == "" {
			_ = tx.command("kill-session", "-t", "="+name).Run()
			continue
		}
		p, err := tx.attach(name, cols, rows, nil)
		if err != nil {
			return restored, err
		}
		restored = append(restored, app.RestoredTerminal{Term: term, PTY: p})
	}
	return restored, nil
}

// tmuxPTY is a shell in a tmux session, seen through an attached client.
// Close ends the session; Detach only drops the client.
type tmuxPTY struct {
	*shell
	tx       Tmux
	name     string
	cleanup  func()
	detached atomic.Bool
}

func (p *tmuxPTY) Remember(t domain.Terminal) {
	meta, err := json.Marshal(t)
	if err != nil {
		return
	}
	_ = p.tx.command("set-option", "-t", "="+p.name+":", tmuxMeta, string(meta)).Run()
}

func (p *tmuxPTY) Detach() error {
	p.detached.Store(true)
	return p.shell.Close()
}

// Close ends the session unless the shell is already gone or Detach left it
// running. The shell's exit code is not available through tmux: Wait
// reports 0.
func (p *tmuxPTY) Close() error {
	if !p.detached.Load() {
		if !p.hasExited() {
			_ = p.tx.command("kill-session", "-t", "="+p.name).Run()
		}
		if p.cleanup != nil {
			p.cleanup()
		}
	}
	return p.shell.Close()
}
