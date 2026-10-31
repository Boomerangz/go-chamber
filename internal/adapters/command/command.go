// Package command runs bounded, one-shot local commands for the opt-in MCP tool.
package command

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
)

const maxOutput = 64 << 10

type Runner struct{}

type limitedOutput struct {
	data      []byte
	truncated bool
}

func (o *limitedOutput) Write(p []byte) (int, error) {
	n := len(p)
	remaining := maxOutput - len(o.data)
	if n > remaining {
		o.data = append(o.data, p[:remaining]...)
		o.truncated = true
	} else {
		o.data = append(o.data, p...)
	}
	return n, nil
}

func (Runner) Run(ctx context.Context, program string, args []string, cwd string) (app.CommandResult, error) {
	if program == "" || !filepath.IsAbs(cwd) {
		return app.CommandResult{}, errors.New("program and absolute cwd are required")
	}
	cmd := exec.CommandContext(ctx, program, args...)
	cmd.Dir = cwd
	// A timeout must stop descendants as well as the direct shell/process.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 2 * time.Second
	var stdout, stderr limitedOutput
	cmd.Stdout, cmd.Stderr = io.Writer(&stdout), io.Writer(&stderr)
	err := cmd.Run()
	out := app.CommandResult{Stdout: string(stdout.data), Stderr: string(stderr.data), StdoutTruncated: stdout.truncated, StderrTruncated: stderr.truncated}
	if cmd.ProcessState != nil {
		out.ExitCode = cmd.ProcessState.ExitCode()
	}
	if ctx.Err() != nil {
		return out, ctx.Err()
	}
	var exit *exec.ExitError
	if err != nil && !errors.As(err, &exit) {
		return out, fmt.Errorf("execute %q: %w", program, err)
	}
	return out, nil
}
