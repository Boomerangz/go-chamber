package pty

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
)

var _ app.PTYFactory = Factory{}

// reader collects PTY output in the background.
type reader struct {
	chunks chan []byte
	buf    bytes.Buffer
}

func startReader(p app.PTY) *reader {
	r := &reader{chunks: make(chan []byte, 64)}
	go func() {
		defer close(r.chunks)
		b := make([]byte, 4096)
		for {
			n, err := p.Read(b)
			if n > 0 {
				r.chunks <- append([]byte(nil), b[:n]...)
			}
			if err != nil {
				return
			}
		}
	}()
	return r
}

func (r *reader) waitFor(t *testing.T, want string) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for !strings.Contains(r.buf.String(), want) {
		select {
		case c, ok := <-r.chunks:
			if !ok {
				t.Fatalf("pty closed before %q; got %q", want, r.buf.String())
			}
			r.buf.Write(c)
		case <-deadline:
			t.Fatalf("timeout waiting for %q; got %q", want, r.buf.String())
		}
	}
}

func (r *reader) waitForMatch(t *testing.T, re *regexp.Regexp) []string {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		if m := re.FindStringSubmatch(r.buf.String()); m != nil {
			return m
		}
		select {
		case c, ok := <-r.chunks:
			if !ok {
				t.Fatalf("pty closed before %v; got %q", re, r.buf.String())
			}
			r.buf.Write(c)
		case <-deadline:
			t.Fatalf("timeout waiting for %v; got %q", re, r.buf.String())
		}
	}
}

func (r *reader) drain() {
	for c := range r.chunks {
		r.buf.Write(c)
	}
}

func start(t *testing.T, spec app.PTYSpec) (app.PTY, *reader) {
	t.Helper()
	if spec.Shell == "" {
		spec.Shell = "/bin/sh"
	}
	if spec.Cols == 0 {
		spec.Cols, spec.Rows = 80, 24
	}
	p, err := Factory{}.Start(spec)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p, startReader(p)
}

func TestShellRunsInCwdWithTerm(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	p, r := start(t, app.PTYSpec{Cwd: dir})
	if _, err := io.WriteString(p, "echo \"cwd=$(pwd) term=$TERM\"\n"); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "cwd="+dir+" term=xterm-256color")
}

func TestSizeAndResize(t *testing.T) {
	p, r := start(t, app.PTYSpec{Cwd: t.TempDir(), Cols: 100, Rows: 30})
	_, _ = io.WriteString(p, "stty size\n")
	r.waitFor(t, "30 100")
	if err := p.Resize(120, 40); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	_, _ = io.WriteString(p, "stty size\n")
	r.waitFor(t, "40 120")
}

func TestWaitReturnsExitCode(t *testing.T) {
	p, r := start(t, app.PTYSpec{Cwd: t.TempDir()})
	_, _ = io.WriteString(p, "exit 3\n")
	r.drain()
	code, err := p.Wait()
	if err != nil || code != 3 {
		t.Fatalf("Wait = %d, %v; want 3", code, err)
	}
}

func TestCloseKillsShell(t *testing.T) {
	p, r := start(t, app.PTYSpec{Cwd: t.TempDir()})
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	r.drain()
	done := make(chan int)
	go func() { code, _ := p.Wait(); done <- code }()
	select {
	case code := <-done:
		if code == 0 {
			t.Fatalf("killed shell exit code = 0")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shell still running after Close")
	}
}

func TestStartFailsForMissingShell(t *testing.T) {
	_, err := Factory{}.Start(app.PTYSpec{Cwd: t.TempDir(), Shell: "/nonexistent/shell", Cols: 80, Rows: 24})
	if err == nil {
		t.Fatal("want error for missing shell")
	}
}

func TestStartFailsForMissingCwd(t *testing.T) {
	_, err := Factory{}.Start(app.PTYSpec{Cwd: filepath.Join(os.TempDir(), "no-such-dir-go-chamber"), Shell: "/bin/sh", Cols: 80, Rows: 24})
	if err == nil {
		t.Fatal("want error for missing cwd")
	}
}

func TestCloseHangsUpBackgroundJobs(t *testing.T) {
	p, r := start(t, app.PTYSpec{Cwd: t.TempDir()})
	_, _ = io.WriteString(p, "sleep 300 & echo JOB=$!\n")
	pid, _ := strconv.Atoi(r.waitForMatch(t, regexp.MustCompile(`JOB=(\d+)`))[1])
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	go func() { r.drain(); _, _ = p.Wait() }()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		if time.Now().After(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Fatalf("background job %d survived Close", pid)
		}
	}
}

func TestCloseKillsShellIgnoringHangup(t *testing.T) {
	p, err := (Factory{KillAfter: 50 * time.Millisecond}).Start(app.PTYSpec{Cwd: t.TempDir(), Shell: "/bin/sh", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	r := startReader(p)
	_, _ = io.WriteString(p, "trap '' HUP; echo trapped\n")
	r.waitFor(t, "trapped\r\n")
	_ = p.Close()
	done := make(chan struct{})
	go func() { r.drain(); _, _ = p.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("shell ignoring SIGHUP still running")
	}
}

func TestCloseIsIdempotentAndWorksAfterExit(t *testing.T) {
	p, r := start(t, app.PTYSpec{Cwd: t.TempDir()})
	_, _ = io.WriteString(p, "exit 0\n")
	r.drain()
	if code, err := p.Wait(); err != nil || code != 0 {
		t.Fatalf("Wait = %d, %v", code, err)
	}
	if err := p.Close(); err != nil {
		t.Fatalf("Close after exit: %v", err)
	}
	if err := p.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if code, err := p.Wait(); err == nil || code != -1 {
		t.Fatalf("second Wait = %d, %v; want -1 and an error", code, err)
	}
}

// Like a real terminal: a shell that exits on its own leaves its background
// jobs running; only closing a live terminal hangs them up.
func TestExitLeavesBackgroundJobsAlone(t *testing.T) {
	p, r := start(t, app.PTYSpec{Cwd: t.TempDir()})
	_, _ = io.WriteString(p, "sleep 300 & echo JOB=$!\n")
	pid, _ := strconv.Atoi(r.waitForMatch(t, regexp.MustCompile(`JOB=(\d+)`))[1])
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	_, _ = io.WriteString(p, "exit\n")
	r.drain()
	_, _ = p.Wait()
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	time.Sleep(200 * time.Millisecond)
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("background job %d gone after exit: %v", pid, err)
	}
}

// A shell that is slow to exit on SIGHUP gets a grace period before SIGKILL.
func TestCloseGivesTheShellTimeToCleanUp(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "cleaned")
	script := filepath.Join(dir, "slowshell")
	body := "#!/bin/sh\ntrap '' HUP\necho ready\nsleep 0.5\ntouch '" + marker + "'\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	p, err := Factory{}.Start(app.PTYSpec{Cwd: dir, Shell: script, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	r := startReader(p)
	r.waitFor(t, "ready")
	_ = p.Close()
	go r.drain()
	_, _ = p.Wait()
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("shell was killed before it could finish: %v", err)
	}
}

// hangup must re-check the session of every pid it signals, so a wrong
// member list can never reach processes outside the terminal.
func TestHangupSkipsProcessesOutsideTheSession(t *testing.T) {
	outsider := exec.Command("sleep", "30")
	if err := outsider.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = outsider.Wait(); close(exited) }()
	t.Cleanup(func() { _ = outsider.Process.Kill(); <-exited })

	p, r := start(t, app.PTYSpec{Cwd: t.TempDir()})
	sh := p.(*shell)
	sh.members = func(sid int) ([]int, error) {
		return []int{outsider.Process.Pid, sid}, nil
	}
	_ = p.Close()
	go r.drain()
	_, _ = p.Wait()
	select {
	case <-exited:
		t.Fatal("process outside the session was hung up")
	case <-time.After(300 * time.Millisecond):
	}
}
